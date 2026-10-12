// main.ts: `hour-meter`, the host tool for the hour-meter device. One binary:
//
//   hour-meter [port] [--demo] [--pin N]     full-screen configurator + live viewer (TUI)
//   hour-meter read [port] [--imu]           one line per frame
//   hour-meter get hour --port <port>        one command, one ACK (see `hour-meter help`)
//
// A port is a serial device (/dev/ttyUSB0, /dev/rfcomm0, /dev/cu.usbserial-*) or tcp://host:port.
import { COMMANDS, run as runCommand, USAGE } from './src/commands.ts';
import { run as runReader } from './src/reader.ts';
import { run as runTui } from './src/tui/main.tsx';
import { TOOL_VERSION } from './src/version.ts';

const HELP = `hour-meter ${TOOL_VERSION}: configure and watch the hour-meter device.

Usage:
  hour-meter [port] [--demo] [--pin PIN] [--no-time-sync]       full-screen configurator (TUI)
  hour-meter read [port] [--imu] [--demo] [--pin PIN] [--no-time-sync]
  hour-meter <command> [--port port] [--demo] [--pin PIN]

Port: a serial device (default /dev/ttyUSB0, or $HOUR_METER_PORT) or tcp://host:port.
PIN:  only for Bluetooth sessions (or $HOUR_METER_PIN).

${USAGE}
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
  if (first !== undefined && COMMANDS.has(first)) return await runCommand(argv);
  return await runTui(argv); // no subcommand: the TUI (argv may hold a port and flags)
}

if (import.meta.main) {
  const argv = Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args; // `deno task x -- ...` keeps the --
  main(argv).then(
    (code) => Deno.exit(code),
    (err) => {
      console.error(`hour-meter: ${(err as Error).message}`);
      Deno.exit(1);
    },
  );
}
