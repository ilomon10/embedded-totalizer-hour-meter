// main.ts: hour-meter device simulator. Speaks the real protocol (SensorFrame
// v1, firmware 2.3.0) on a virtual serial port, so drivers can be written and
// tested without hardware.
//
//   deno task start                          # /tmp/ttyHourMeter via socat
//   deno task start --tcp 5555               # TCP instead of a tty
//   deno task start --bt --pin 4821          # behave like a locked Bluetooth session
//   deno task start --scenario no-rtc-battery --scenario corrupt=5
//
// Run with --help for every flag.
import { parseArgs } from 'node:util';

import { createRng, realClock } from './src/clock.ts';
import { type DeviceOptions, ResetReason, SimDevice } from './src/device.ts';
import { FrameLog, type Verbosity } from './src/log.ts';
import { Device, FIRMWARE_VERSION } from './src/protocol.ts';
import { parseScenario, type Scenario, scenarioHelp } from './src/scenarios.ts';
import { FrameSplitter } from './src/splitter.ts';
import { Faults } from './src/faults.ts';
import { startWebServer, WebHub } from './src/web/server.ts';
import type { Transport } from './src/transport/link.ts';
import { PtyTransport } from './src/transport/pty.ts';
import { StdioTransport } from './src/transport/stdio.ts';
import { TcpTransport } from './src/transport/tcp.ts';

/** Simulator release version (tags: simulator-v<version>). The protocol version is FIRMWARE_VERSION. */
export const SIM_VERSION = '1.1.0';
const POLL_MS = 10;
const DEFAULT_WEB_PORT = 8080;

const HELP = `Hour meter simulator: a fake device on a virtual serial port.

Usage: deno task start [options]    (release binary: hour-meter-sim [options])

Port (pick one):
  --pty <path>         virtual tty made by socat (default /tmp/ttyHourMeter)
  --tcp <port>         serve on 127.0.0.1:<port> instead (no socat needed)
  --stdio              frames on stdout, commands on stdin

Device:
  --bt                 act as a Bluetooth SPP session: locked until COMMAND unlock=<PIN>
  --pin <0-9999>       btPin setting (default 1234)
  --engine <on|off>    hold the alternator on or off (default: 40 s on / 40 s off cycle)
  --run-hours <h>      hour meter at power-on (default 1250)
  --total <pulses>     totalizer at power-on (default 15000)
  --pulse-hz <n>       totalizer pulses per second while the engine runs (default 3.5)
  --device-id <n>      deviceId in every header (default 0x1a2b3c4d)
  --no-reset           do not reboot when a client opens the tty (USB DevKits do; never with --bt)
  --seed <n>           random seed for sensor noise and faults (default 1)

Faults (repeatable: --scenario a --scenario b=1,2):
${scenarioHelp()}

Web UI (set every simulated value from the browser):
  --web [port]         serve the web UI on http://127.0.0.1:<port>/ (default 8080)
  --web-host <addr>    listen address (default 127.0.0.1; 0.0.0.0 = whole LAN, no login!)

Output:
  -v, --verbose        log every frame with all its records
  -q, --quiet          log nothing but errors
  --version
  -h, --help
`;

interface Cli {
  transport: Transport;
  resetOnOpen: boolean;
  /** Engine held on/off; undefined = the engine-cycle scenario drives it. */
  engine?: boolean;
  device: DeviceOptions;
  scenarios: Scenario[];
  faults: Faults;
  web?: { port: number; hostname: string };
  verbosity: Verbosity;
}

/** `--web` may come without a port: give it the default so parseArgs sees a value. */
function withWebPort(argv: string[]): string[] {
  return argv.flatMap((arg, i) => {
    const next = argv[i + 1];
    return arg === '--web' && (next === undefined || next.startsWith('-')) ? [arg, String(DEFAULT_WEB_PORT)] : [arg];
  });
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: withWebPort(argv),
    options: {
      pty: { type: 'string' },
      tcp: { type: 'string' },
      stdio: { type: 'boolean' },
      bt: { type: 'boolean' },
      pin: { type: 'string' },
      engine: { type: 'string' },
      'run-hours': { type: 'string' },
      total: { type: 'string' },
      'pulse-hz': { type: 'string' },
      'device-id': { type: 'string' },
      'no-reset': { type: 'boolean' },
      web: { type: 'string' },
      'web-host': { type: 'string' },
      seed: { type: 'string' },
      scenario: { type: 'string', multiple: true },
      verbose: { type: 'boolean', short: 'v' },
      quiet: { type: 'boolean', short: 'q' },
      version: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.version) {
    const fw = [16, 8, 0].map((shift) => (FIRMWARE_VERSION >> shift) & 0xff).join('.');
    console.log(`hour-meter-sim ${SIM_VERSION} (speaks firmware ${fw} protocol)`);
    Deno.exit(0);
  }
  if (values.help) {
    console.log(HELP);
    Deno.exit(0);
  }
  const random = createRng(int(values.seed, 1, 0, 0xffffffff, '--seed'));
  const device: DeviceOptions = {
    deviceId: int(values['device-id'], 0x1a2b3c4d, 0, 0xffffffff, '--device-id'),
    runSeconds: Math.round(Number(values['run-hours'] ?? 1250) * 3600),
    totalCount: int(values.total, 15000, 0, 0xffffffff, '--total'),
    pulsesPerSecond: Number(values['pulse-hz'] ?? 3.5),
    fitted: Device.eeprom | Device.rtc | Device.imu | Device.mag,
    rtcBattery: true,
    bluetoothSession: values.bt ?? false,
    btPin: int(values.pin, 1234, 0, 9999, '--pin'),
    random,
  };
  const scenarios = (values.scenario ?? []).map((s) => parseScenario(s, random));
  if (values.engine === undefined) scenarios.unshift(parseScenario('engine-cycle', random));
  else if (values.engine !== 'on' && values.engine !== 'off') throw new Error('--engine must be on or off');
  for (const s of scenarios) s.configure?.(device);
  const faults = new Faults(random);
  for (const s of scenarios) if (s.faults) faults.set(s.faults);
  const transport = pickTransport(values.pty, values.tcp, values.stdio);
  const web = values.web === undefined && values['web-host'] === undefined ? undefined : {
    port: int(values.web, DEFAULT_WEB_PORT, 0, 65535, '--web'),
    hostname: values['web-host'] ?? '127.0.0.1',
  };
  return {
    transport,
    resetOnOpen: transport instanceof PtyTransport && !values['no-reset'] && !values.bt, // DTR reset is USB-only
    engine: values.engine === undefined ? undefined : values.engine === 'on',
    device,
    scenarios,
    faults,
    web,
    verbosity: values.quiet ? 'quiet' : values.verbose ? 'verbose' : 'normal',
  };
}

function int(value: string | undefined, fallback: number, min: number, max: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value); // accepts 0x1a2b3c4d too
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer ${min}..${max}`);
  return n;
}

function pickTransport(pty: string | undefined, tcp: string | undefined, stdio: boolean | undefined): Transport {
  if ([pty !== undefined, tcp !== undefined, stdio === true].filter(Boolean).length > 1) {
    throw new Error('pick one of --pty, --tcp, --stdio');
  }
  if (tcp !== undefined) return new TcpTransport(int(tcp, 0, 1, 65535, '--tcp'));
  if (stdio) return new StdioTransport();
  return new PtyTransport(pty ?? '/tmp/ttyHourMeter');
}

async function main(): Promise<void> {
  const cli = parseCli(Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args); // `deno task start -- ...` keeps the --
  const log = new FrameLog(cli.verbosity);
  const { transport, scenarios, faults } = cli;
  let hub: WebHub | undefined;

  const device = new SimDevice(cli.device, realClock, (frame, msg, periodic) => {
    const delivered = transport.connected() && (!periodic || device.liveDataAllowed());
    log.sent(msg, delivered);
    hub?.sent(msg, delivered);
    if (!delivered) return;
    transport.write(faults.mangle(frame));
  });
  if (cli.web) {
    hub = new WebHub({ device, faults, version: SIM_VERSION, deviceId: cli.device.deviceId, transport });
  }
  if (cli.engine !== undefined) device.setEngine(cli.engine);
  const splitter = new FrameSplitter(
    (cmd) => {
      log.received(cmd);
      hub?.received(cmd);
      device.onCommand(cmd);
    },
    (err) => {
      log.info(`<- dropped a bad frame (${err.message})`);
      hub?.info('error', `dropped a bad frame from the host (${err.message})`);
    },
  );

  await transport.start({
    onConnect: () => {
      log.info(`client connected on ${transport.label}`);
      hub?.info('connect', `client connected on ${transport.label}`);
      device.clientConnected();
      if (cli.resetOnOpen) device.reset(ResetReason.powerOn); // DTR/RTS auto-reset, like a real DevKit
    },
    onDisconnect: () => {
      log.info('client disconnected');
      hub?.info('disconnect', 'client disconnected');
    },
    onData: (bytes) => splitter.push(bytes),
  });

  log.info(`hour meter simulator: open ${transport.label} (115200 8N1, any baud works)`);
  log.info(cli.device.bluetoothSession ? `Bluetooth session: send unlock=${cli.device.btPin} first` : 'wired session');
  for (const s of scenarios) log.info(`scenario: ${s.label}`);
  const web = hub && cli.web ? startWebServer(hub, cli.web) : undefined;
  if (web) log.info(`web UI: ${web.url}`);
  device.powerOn();
  setInterval(() => {
    const nowMs = realClock.nowMs();
    for (const s of scenarios) s.tick?.(nowMs, device);
    device.poll();
  }, POLL_MS);

  // Ctrl+C, kill, closed terminal: stop socat too, or it outlives us and keeps the tty link.
  const shutdown = async () => {
    await web?.close();
    await transport.close();
    Deno.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) Deno.addSignalListener(signal, shutdown);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`error: ${(err as Error).message}`);
    Deno.exit(1);
  });
}
