#!/usr/bin/env node
// Command-line tool for the hour meter. Examples:
//   node commands.js get status
//   node commands.js get hour --port /dev/ttyUSB0
//   node commands.js set telemetryIntervalMs=500 output=both
//   node commands.js set-time                 # sends the PC clock as UTC epoch
//   node commands.js set-hours 1234.5         # set the hour meter to any value (e.g. machine already has hours)
//   node commands.js set-units 5230.75        # set the totalizer in units (litres...), uses pulsesPerUnit
//   node commands.js set-count 1000           # set the totalizer in raw pulses
//   node commands.js reset-hours --yes        # hour meter only -> 0
//   node commands.js reset-totalizer --yes    # totalizer only -> 0
//   node commands.js calibrate gyro|mag
//   node commands.js reset-counters --yes
//   node commands.js reboot
//   node commands.js set bluetooth=true btPin=4821   # enable Bluetooth (do this over USB)
//   node commands.js get status --port /dev/rfcomm0 --pin 4821   # then use it over Bluetooth
const { DeviceClient } = require('./device');
const {
  tags, GET, CALIB, OUTPUT, STREAM_MODE, RESET_MAGIC, ACK_STATUS, decodeStatusFlags, hoursToSeconds, unitsToPulses,
} = require('./tags');

const SETTING_NAMES = Object.entries(tags).filter(([t]) => t >= 110 && t <= 126).map(([, d]) => d.name);
const ENUM_SETTINGS = { output: OUTPUT, streamMode: STREAM_MODE };

/** Commands that change the counters: show the value before and after. */
const COUNTER_COMMANDS = new Set(['set-hours', 'set-count', 'set-units', 'reset-hours', 'reset-totalizer', 'reset-counters']);

/**
 * Turn CLI words into { values, waitEvent } (pure: unit-tested in test/commands.test.js).
 * `device` carries values read from the device first (pulsesPerUnit for set-units).
 */
function buildRequest(args, device = {}) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'get': {
      const what = GET[rest[0]];
      if (!what) throw new Error(`get what? one of: ${Object.keys(GET).join(', ')}`);
      return { values: { get: what } };
    }
    case 'set': {
      if (rest.length === 0) throw new Error(`set name=value ... (settings: ${SETTING_NAMES.join(', ')})`);
      const values = {};
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
      if (!rest.includes('--yes')) throw new Error('this sets the hour meter AND the totalizer to 0. Add --yes to confirm.');
      return { values: { resetCounters: RESET_MAGIC } };
    case 'reboot':
      return { values: { reboot: 1 } };
    default:
      throw new Error('usage: get|set|set-time|set-hours|set-units|set-count|reset-hours|reset-totalizer|reset-counters|calibrate|reboot (see header of commands.js)');
  }
}

function printAck(ack) {
  const { ackSeq, ackStatus, ...data } = ack.values;
  console.log(`ACK #${ackSeq}: ${ACK_STATUS[ackStatus]}`);
  if (data.statusFlags !== undefined) data.statusFlags = decodeStatusFlags(data.statusFlags);
  if (data.epoch) data.epochIso = new Date(data.epoch * 1000).toISOString(); // shown in UTC
  if (Object.keys(data).length) console.log(data);
}

/** Remove `--name value` from argv. */
function takeOption(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return { value: undefined, rest: argv };
  return { value: argv[i + 1], rest: argv.filter((_, j) => j !== i && j !== i + 1) };
}

async function main(argv) {
  const { value: path = process.env.HOUR_METER_PORT || '/dev/ttyUSB0', rest: afterPort } = takeOption(argv, '--port');
  const { value: pin = process.env.HOUR_METER_PIN, rest: args } = takeOption(afterPort, '--pin');
  buildRequest(args, { pulsesPerUnit: 1 });  // validate the words before touching the device

  const dev = await DeviceClient.open(path, { pin });
  try {
    const counters = COUNTER_COMMANDS.has(args[0]);
    const settings = args[0] === 'set-units' ? (await dev.request({ get: GET.settings })).values : {};
    const req = buildRequest(args, { pulsesPerUnit: settings.pulsesPerUnit });
    const before = counters ? (await dev.request({ get: GET.hour })).values : null;
    if (req.waitEvent) console.log('calibrating... keep the board flat and still (gyro) or rotate it in all directions (mag)');
    const eventPromise = req.waitEvent ? dev.waitForEvent(req.waitEvent.kind, req.waitEvent.timeoutMs) : null;
    printAck(await dev.request(req.values));
    if (before) {
      const after = (await dev.request({ get: GET.hour })).values;
      console.log(`hour meter: ${before.runHours.toFixed(2)} h -> ${after.runHours.toFixed(2)} h`);
      console.log(`totalizer:  ${before.totalCount} pulses (${before.totalUnits.toFixed(2)} units) -> ${after.totalCount} pulses (${after.totalUnits.toFixed(2)} units)`);
    }
    if (eventPromise) {
      const ev = await eventPromise;
      console.log(`calibration ${ACK_STATUS[ev.values.calibResult]}`, ev.values);
    }
  } finally {
    dev.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { buildRequest };
