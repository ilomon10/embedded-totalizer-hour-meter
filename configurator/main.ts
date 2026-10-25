// main.ts: `hour-meter`, the host tool for the hour-meter device. One binary:
//
//   hour-meter [port] [--demo] [--pin N]     full-screen configurator + live viewer (TUI); no port: connect screen
//   hour-meter read [port] [--imu]           one line per frame
//   hour-meter get hour --port <port>        one command, one ACK (see `hour-meter help`)
//   hour-meter firmware [version|list|download|flash]   firmware releases, update over USB
//
// A port is a serial device (/dev/ttyUSB0, /dev/rfcomm0, /dev/cu.usbserial-*) or tcp://host:port.
import { COMMANDS, run as runCommand, USAGE } from './src/commands.ts';
import { FIRMWARE_USAGE, run as runFirmware } from './src/firmware.ts';
import { run as runReader } from './src/reader.ts';
import { TOOL_VERSION } from './src/version.ts';

const HELP = `hour-meter ${TOOL_VERSION}: configure and watch the hour-meter device.

Usage:
  hour-meter [port] [--demo] [--pin PIN] [--no-time-sync]       full-screen configurator (TUI)
                                                                 without a port: pick one on the connect screen
  hour-meter read [port] [--imu] [--demo] [--pin PIN] [--no-time-sync]
  hour-meter <command> [--port port] [--demo] [--pin PIN]

Port: a serial device or tcp://host:port. Commands and read default to $HOUR_METER_PORT, else /dev/ttyUSB0.
PIN:  only for Bluetooth sessions (or $HOUR_METER_PIN).

${USAGE}

${FIRMWARE_USAGE}
`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === '--version' || first === 'version') {
    console.log(`hour-meter ${TOOL_VERSION}`);
    return 0;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(HELP);
    return 0;
  }
  if (first === 'read') return await runReader(rest);
  if (first === 'tui') return await runTui(rest);
  if (first === 'firmware') return await runFirmware(rest);
  if (first !== undefined && COMMANDS.has(first)) return await runCommand(argv);
  return await runTui(argv); // no subcommand: the TUI (argv may hold a port and flags)
}

/** The full-screen TUI, loaded only when it is used: a command does not start the renderer and React. */
async function runTui(argv: string[]): Promise<number> {
  const { run } = await import('./src/tui/main.tsx');
  return await run(argv);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const argv = args[0] === '--' ? args.slice(1) : args; // `bun run start -- ...` may pass the -- on
  main(argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`hour-meter: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
