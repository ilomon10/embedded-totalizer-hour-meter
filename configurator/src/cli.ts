// cli.ts: argument helpers shared by every subcommand, and the one way to connect.
//
//   port:  --port <spec> (commands) or the first positional word (tui, read),
//          else $HOUR_METER_PORT, else /dev/ttyUSB0. A spec is a serial path or tcp://host:port.
//   pin:   --pin <PIN>, else $HOUR_METER_PIN (Bluetooth sessions only)
//   demo:  --demo talks to a simulated device instead of a port
import { createDemoLink } from './demo.ts';
import { DeviceClient } from './device.ts';

export const DEFAULT_PORT = '/dev/ttyUSB0';

/** Remove `--name value` from argv. */
export function takeOption(argv: string[], name: string): { value: string | undefined; rest: string[] } {
  const i = argv.indexOf(name);
  if (i < 0) return { value: undefined, rest: argv };
  if (argv[i + 1] === undefined) throw new Error(`${name} needs a value`);
  return { value: argv[i + 1], rest: argv.filter((_, j) => j !== i && j !== i + 1) };
}

/** Remove `--name` from argv. */
export function takeFlag(argv: string[], name: string): { value: boolean; rest: string[] } {
  return { value: argv.includes(name), rest: argv.filter((a) => a !== name) };
}

export function env(name: string): string | undefined {
  return process.env[name];
}

export interface Target {
  demo: boolean;
  port: string;
  pin?: string;
}

/** Open the device the target names. `readyTimeoutMs` bounds the wait for its first frame. */
export async function connect(target: Target, readyTimeoutMs?: number): Promise<DeviceClient> {
  if (target.demo) return await DeviceClient.connect(createDemoLink(), { readyTimeoutMs, pin: target.pin });
  return await DeviceClient.open(target.port, { readyTimeoutMs, pin: target.pin });
}

/** Hint printed after a failed connection. */
export function connectHelp(): string {
  return [
    'Is the device plugged in? Try: hour-meter /dev/ttyUSB0   or   hour-meter --demo',
    'Over Bluetooth: hour-meter /dev/rfcomm0 --pin <PIN>   (BadPin = wrong PIN, Locked = too many tries, wait 60 s)',
    'Simulator over TCP: hour-meter tcp://127.0.0.1:5555',
  ].join('\n');
}
