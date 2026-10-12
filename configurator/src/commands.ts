// commands.ts: one command, one ACK. `hour-meter <command> ...` (see USAGE).
//
// buildRequest() turns the words into command values and is pure (test/commands.test.ts);
// run() connects, sends, prints the ACK, and for counters shows the value before and after.
import { connect, connectHelp, DEFAULT_PORT, env, takeFlag, takeOption } from './cli.ts';
import type { CommandValues } from './device.ts';
import type { DecodedMessage } from './sensorframe.ts';
import {
  ACK_STATUS,
  CALIB,
  decodeStatusFlags,
  GET,
  hoursToSeconds,
  OUTPUT,
  RESET_MAGIC,
  SETTINGS,
  STREAM_MODE,
  unitsToPulses,
} from './tags.ts';

export const USAGE = `Commands (add --port <port|tcp://host:port>, --pin <PIN> for Bluetooth, or --demo):
  hour-meter get hour|settings|status|calib
  hour-meter set telemetryIntervalMs=500 output=both     any setting, see 'get settings'
  hour-meter set bluetooth=true btPin=4821               enable Bluetooth (do this over USB)
  hour-meter set-time                  send the PC clock as UTC
  hour-meter set-hours 1234.5          set the hour meter (e.g. the machine already has hours)
  hour-meter set-units 5230.75         set the totalizer in units (uses pulsesPerUnit)
  hour-meter set-count 1000            set the totalizer in raw pulses
  hour-meter reset-hours --yes         hour meter only -> 0
  hour-meter reset-totalizer --yes     totalizer only -> 0
  hour-meter reset-counters --yes      both -> 0
  hour-meter calibrate gyro|mag
  hour-meter reboot`;

export const COMMANDS = new Set([
  'get',
  'set',
  'set-time',
  'set-hours',
  'set-units',
  'set-count',
  'calibrate',
  'reset-hours',
  'reset-totalizer',
  'reset-counters',
  'reboot',
]);

const SETTING_NAMES = Object.keys(SETTINGS); // all of 110..128, including bluetooth and btPin
const ENUM_SETTINGS: Record<string, Readonly<Record<string, number>>> = { output: OUTPUT, streamMode: STREAM_MODE };

export interface Request {
  values: CommandValues;
  waitEvent?: { kind: number; timeoutMs: number };
}

/** Commands that change the counters: show the value before and after. */
const COUNTER_COMMANDS = new Set([
  'set-hours',
  'set-count',
  'set-units',
  'reset-hours',
  'reset-totalizer',
  'reset-counters',
]);

/**
 * Turn CLI words into { values, waitEvent } (pure: unit-tested in test/commands.test.ts).
 * `device` carries values read from the device first (pulsesPerUnit for set-units).
 */
export function buildRequest(args: string[], device: { pulsesPerUnit?: number } = {}): Request {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'get': {
      const what = GET[rest[0]];
      if (!what) throw new Error(`get what? one of: ${Object.keys(GET).join(', ')}`);
      return { values: { get: what } };
    }
    case 'set': {
      if (rest.length === 0) throw new Error(`set name=value ... (settings: ${SETTING_NAMES.join(', ')})`);
      const values: CommandValues = {};
      for (const pair of rest) {
        const [name, raw] = pair.split('=');
        if (!SETTING_NAMES.includes(name) || raw === undefined) throw new Error(`unknown setting '${pair}'`);
        const named = ENUM_SETTINGS[name]?.[raw];
        const value = named ?? (raw === 'true' ? true : raw === 'false' ? false : Number(raw));
        if (typeof value === 'number' && Number.isNaN(value)) throw new Error(`'${raw}' is not a number`);
        values[name] = value;
      }
      return { values };
    }
    case 'set-time':
      return { values: { setTime: Math.floor(Date.now() / 1000) } }; // UTC epoch, timezone-free
    case 'set-hours':
      if (rest[0] === undefined) throw new Error('set-hours <hours>, e.g. set-hours 1234.5');
      return { values: { setRunSeconds: hoursToSeconds(rest[0]) } };
    case 'set-units':
      if (rest[0] === undefined) throw new Error('set-units <units>, e.g. set-units 5230.75');
      return { values: { setTotalCount: unitsToPulses(rest[0], device.pulsesPerUnit ?? 1) } };
    case 'set-count': {
      const count = Number(rest[0]);
      if (!Number.isInteger(count) || count < 0) throw new Error('set-count <pulses>');
      return { values: { setTotalCount: count } };
    }
    case 'calibrate': {
      const kind = CALIB[rest[0]];
      if (!kind) throw new Error('calibrate gyro|mag');
      return { values: { calibrate: kind }, waitEvent: { kind: 2, timeoutMs: 40000 } };
    }
    case 'reset-hours':
      if (!rest.includes('--yes')) throw new Error('this sets the hour meter to 0. Add --yes to confirm.');
      return { values: { setRunSeconds: 0 } };
    case 'reset-totalizer':
      if (!rest.includes('--yes')) throw new Error('this sets the totalizer to 0. Add --yes to confirm.');
      return { values: { setTotalCount: 0 } };
    case 'reset-counters':
      if (!rest.includes('--yes')) {
        throw new Error('this sets the hour meter AND the totalizer to 0. Add --yes to confirm.');
      }
      return { values: { resetCounters: RESET_MAGIC } };
    case 'reboot':
      return { values: { reboot: 1 } };
    default:
      throw new Error(`unknown command '${cmd}'\n${USAGE}`);
  }
}

function printAck(ack: DecodedMessage): void {
  const { ackSeq, ackStatus, ...data } = ack.values as Record<string, unknown>;
  console.log(`ACK #${ackSeq}: ${ACK_STATUS[Number(ackStatus)]}`);
  if (data.statusFlags !== undefined) data.statusFlags = decodeStatusFlags(Number(data.statusFlags));
  if (data.epoch) data.epochIso = new Date(Number(data.epoch) * 1000).toISOString(); // shown in UTC
  if (Object.keys(data).length) console.log(data);
}

/** `hour-meter <command> ...`: returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  const port = takeOption(argv, '--port');
  const pin = takeOption(port.rest, '--pin');
  const demo = takeFlag(pin.rest, '--demo');
  const args = demo.rest;
  buildRequest(args, { pulsesPerUnit: 1 }); // validate the words before touching the device

  const target = {
    demo: demo.value,
    port: port.value ?? env('HOUR_METER_PORT') ?? DEFAULT_PORT,
    pin: pin.value ?? env('HOUR_METER_PIN'),
  };
  const dev = await connect(target).catch((err) => {
    throw new Error(`${(err as Error).message}\n${connectHelp()}`);
  });
  try {
    const counters = COUNTER_COMMANDS.has(args[0]);
    const settings = args[0] === 'set-units' ? (await dev.request({ get: GET.settings })).values : {};
    const req = buildRequest(args, { pulsesPerUnit: Number(settings.pulsesPerUnit ?? 1) });
    const before = counters ? (await dev.request({ get: GET.hour })).values : null;
    if (req.waitEvent) {
      console.log('calibrating... keep the board flat and still (gyro) or rotate it in all directions (mag)');
    }
    const eventPromise = req.waitEvent ? dev.waitForEvent(req.waitEvent.kind, req.waitEvent.timeoutMs) : null;
    printAck(await dev.request(req.values));
    if (before) {
      const after = (await dev.request({ get: GET.hour })).values;
      const h = (v: typeof before) => Number(v.runHours).toFixed(2);
      const u = (v: typeof before) => Number(v.totalUnits).toFixed(2);
      console.log(`hour meter: ${h(before)} h -> ${h(after)} h`);
      console.log(
        `totalizer:  ${before.totalCount} pulses (${u(before)} units) -> ${after.totalCount} pulses (${
          u(after)
        } units)`,
      );
    }
    if (eventPromise) {
      const ev = await eventPromise;
      console.log(`calibration ${ACK_STATUS[Number(ev.values.calibResult)]}`, ev.values);
    }
    return 0;
  } finally {
    dev.close();
  }
}
