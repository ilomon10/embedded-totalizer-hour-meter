// tui-model.test.ts: the TUI's pure models: formats, health, settings, counters, live history, commissioning and
// the service report.
import { test } from 'bun:test';

import { assert, assertEquals, assertMatch } from './assert.ts';
import { checks, emptyProgress, engineVerdict, passed } from '../src/tui/model/commission.ts';
import { counterPrompt, planCounter } from '../src/tui/model/counters.ts';
import { ago, bar, deviceIdText, duration, fit, utcText } from '../src/tui/model/format.ts';
import { ALL_FLAGS, i2cLinesText, issueFor, okAreas, problems, summary } from '../src/tui/model/health.ts';
import { addSample, grownSince, pulseRate, sparkline, suggestThreshold } from '../src/tui/model/history.ts';
import { SCREENS, screenByKey, screenRef } from '../src/tui/model/nav.ts';
import { buildReport, reportFileName, reportSummary } from '../src/tui/model/report.ts';
import {
  changedFromFactory,
  commandFor,
  crossCheck,
  editText,
  parseSettingInput,
  pendingChanges,
  pulseInputOff,
  rangeText,
  reviewNotes,
  SETTING_GROUPS,
  SETTING_UI,
  transportOf,
  valueText,
} from '../src/tui/model/settings.ts';
import { initialState } from '../src/tui/state.ts';
import { SETTINGS, STATUS_FLAGS } from '../src/tags.ts';

/** The statusFlags value with these flags set (by their names in tags.ts). */
const flagBits = (...names: string[]) => names.reduce((n, f) => n | (1 << STATUS_FLAGS.indexOf(f)), 0);

test('formats: durations, ages, ids, dates, bars', () => {
  assertEquals(duration(45), '45 s');
  assertEquals(duration(250), '4 min 10 s');
  assertEquals(duration(4320), '1 h 12 min');
  assertEquals(duration(3 * 86400 + 4 * 3600), '3 d 4 h');
  assertEquals(ago(1000, 1500), 'just now');
  assertEquals(ago(0, 32_000), '32 s ago');
  assertEquals(deviceIdText(0x1a2b3c4d), '1A2B3C4D');
  assertEquals(deviceIdText(0x3c4d), '00003C4D');
  assertEquals(utcText(1_793_000_000), '2026-10-26 07:33:20 UTC');
  assertEquals(utcText(3600), 'unknown'); // uptime, not a date
  assertEquals(bar(75, 150, 8), '████');
  assertEquals(fit('abcdef', 4), 'abc…');
});

test('bar: eighths of a cell, never past the width, never "undefined" (a fraction that rounds up to a whole cell)', () => {
  assertEquals(bar(9.97, 10, 10), '██████████'); // 99.7 % of 10 cells: was "█████████undefined"
  assertEquals(bar(1, 8, 1), '▏');
  assertEquals(bar(7, 8, 1), '▉');
  assertEquals(bar(-5, 10, 4), '');
  assertEquals(bar(50, 10, 4), '████');
  for (let v = 0; v <= 150; v += 0.37) {
    const b = bar(v, 150, 47);
    assert(!b.includes('undefined') && [...b].length <= 47, `bar(${v}) = ${b}`);
  }
});

test('navigation: ten screens, number keys 1-9 and 0, in three groups', () => {
  assertEquals(SCREENS.map((s) => s.key).join(''), '1234567890');
  assertEquals(screenByKey('7')?.id, 'calibrate');
  assertEquals(screenRef('firmware'), '9 Firmware');
  assertEquals([...new Set(SCREENS.map((s) => s.group))], ['MAINTAIN', 'SET UP', 'SERVICE']);
});

test('health: every status flag has words; severity follows the context', () => {
  for (const flag of STATUS_FLAGS) {
    const issue = issueFor(flag, [flag]);
    assert(issue.why.length > 10 && issue.title !== flag, flag); // an unknown flag is titled with its own name
  }
  assertEquals([...ALL_FLAGS].sort(), [...STATUS_FLAGS].sort());
  // A missing EEPROM is fine once the flash keeps the values (firmware 2.6.0), a fault before that.
  assertEquals(issueFor('eepromMissing', ['eepromMissing'], { fwVersion: 0x00020600 }).severity, 'info');
  assertEquals(issueFor('eepromMissing', ['eepromMissing'], { fwVersion: 0x00020500 }).severity, 'error');
  assertEquals(
    issueFor('eepromMissing', ['eepromMissing', 'flashStoreMissing'], { fwVersion: 0x00020600 }).title,
    'Nothing is saved',
  );
  assertEquals(issueFor('flashStoreMissing', ['flashStoreMissing']).severity, 'warn');
  assertEquals(issueFor('flashStoreMissing', ['flashStoreMissing', 'eepromMissing']).severity, 'error');
  // Wrong colours of the old TUI: settingsNotSaved is a fault, i2cErrors only a warning.
  assertEquals(issueFor('settingsNotSaved', ['settingsNotSaved']).severity, 'error');
  assertEquals(issueFor('i2cErrors', ['i2cErrors']).severity, 'warn');
  assertEquals(issueFor('imuNotCalibrated', ['imuNotCalibrated', 'imuMissing']).severity, 'info');
  assertEquals(issueFor('timeInvalid', ['timeInvalid'], { autoTimeSync: true }).severity, 'info');
  const flags = ['imuNotCalibrated', 'magNotCalibrated', 'settingsDefaults', 'safeMode'];
  assertEquals(
    problems(flags).map((i) => i.flag),
    ['safeMode'], // safe mode skips I2C: the uncalibrated IMU is not a problem of its own then
  );
  assertEquals(summary(flags).text, '✖ 1 fault');
  assertEquals(summary(['imuNotCalibrated', 'magNotCalibrated']).text, '▲ 2 to check');
  assertEquals(summary(['settingsDefaults']).text, '✔ healthy');
  assertEquals(summary(undefined).level, 'unknown');
});

test('health: safe mode is about unplanned restarts, not about the I2C bus', () => {
  const safe = issueFor('safeMode', ['safeMode']);
  assertEquals([safe.severity, safe.title], ['error', 'Safe mode']);
  assertMatch(safe.why, /Three unplanned restarts in a row \(watchdog, crash or USB stall\)/);
  assertMatch(safe.why, /RTC, IMU and EEPROM are skipped until the next restart/);
  assert(!/I2C|bus/i.test(safe.fix!), 'nothing to fix on the bus: reboot, and read the cause');

  // The flags of a 2.6.0 unit in safe mode (a field report): the missing modules follow from safe mode.
  const field = ['eepromMissing', 'rtcMissing', 'imuMissing', 'magMissing', 'imuNotCalibrated', 'settingsDefaults'];
  const names = (fwVersion?: number) =>
    problems([...field, 'timeNotBackedUp', 'safeMode'], { fwVersion }).map((i) => i.flag);
  assertEquals(names(0x00020600), ['safeMode', 'timeNotBackedUp']);
  assertMatch(issueFor('rtcMissing', ['rtcMissing', 'safeMode']).why, /Not a separate problem: safe mode skips I2C/);
  // Safe mode is older than the flash store (2.4.0): it does not prove the flash keeps the values.
  assert(names(0x00020500).includes('eepromMissing'), 'firmware 2.5.0 in safe mode without an EEPROM saves nothing');
  assert(names(undefined).includes('eepromMissing'), 'unknown firmware: the EEPROM warning stays');
});

test('health: a parked I2C bus is one fault with its cause; a bus that is off is a choice; modules are not listed', () => {
  const parked = issueFor('i2cParked', ['i2cParked']);
  assertEquals([parked.severity, parked.title, parked.screen], ['error', 'I2C bus parked', 'diagnostics']);
  assertMatch(parked.fix!, /Unplug the modules one at a time/);
  assertMatch(parked.fix!, /AD0 pin is tied to 3\.3 V \(address 0x69, else it clashes with the RTC at 0x68\)/);
  assertMatch(parked.why, /The hour meter keeps counting; the bus is retried automatically\./);
  // The lines it found held low come with a full status (tag 64): bit 0 SDA, bit 1 SCL, 0 both lines free.
  const why = (i2cLines: number) => issueFor('i2cParked', ['i2cParked'], { i2cLines }).why;
  assertMatch(why(1), /^SDA held low\. The bus kept failing/);
  assertMatch(why(2), /^SCL held low\. /);
  assertMatch(why(3), /^SDA and SCL held low\. /);
  assertMatch(why(0), /^Both lines free but transfers time out\. /);
  assertEquals(i2cLinesText(2), 'SCL held low');
  assertEquals(i2cLinesText(0), 'both lines free but transfers time out');
  const off = issueFor('i2cOff', ['i2cOff']);
  assertEquals([off.severity, off.title], ['info', 'I2C off (hour meter only)']);

  // Every module is missing then, and that is expected: the time is the one thing still worth a warning.
  const modules = ['eepromMissing', 'rtcMissing', 'imuMissing', 'magMissing', 'imuNotCalibrated', 'i2cErrors'];
  const names = (flags: string[], ctx = {}) => problems(flags, ctx).map((i) => i.flag);
  assertEquals(names([...modules, 'i2cOff', 'timeNotBackedUp']), ['timeNotBackedUp']); // no firmware version needed
  assertEquals(names([...modules, 'i2cParked', 'timeNotBackedUp']), ['i2cParked', 'timeNotBackedUp']);
  assertEquals(summary([...modules, 'i2cParked']).text, '✖ 1 fault');
  assertEquals(summary([...modules, 'i2cOff']).text, '✔ healthy');
  // What is wrong without those flags is still wrong.
  assertEquals(names(modules), ['eepromMissing', 'rtcMissing', 'i2cErrors']);
  assertEquals(issueFor('rtcMissing', ['rtcMissing']).severity, 'warn');
  assertEquals(issueFor('i2cErrors', ['i2cErrors']).severity, 'warn');
  assertEquals(issueFor('timeNotBackedUp', ['timeNotBackedUp', 'i2cOff']).severity, 'warn');
  // With I2C off and no flash store, nothing keeps the values: that stays a fault.
  assertEquals(issueFor('eepromMissing', ['eepromMissing', 'flashStoreMissing', 'i2cOff']).title, 'Nothing is saved');
  assertEquals(issueFor('eepromMissing', ['eepromMissing', 'flashStoreMissing', 'i2cOff']).severity, 'error');

  assert(okAreas([]).includes('I2C bus'));
  assert(!okAreas(['i2cParked']).includes('I2C bus'));
  assert(!okAreas(['i2cOff']).includes('I2C bus'));
});

test('settings: every device setting has a label, a group and a factory value in range', () => {
  assertEquals(SETTING_UI.map((s) => s.name).sort(), Object.keys(SETTINGS).sort());
  for (const s of SETTING_UI) {
    const spec = SETTINGS[s.name];
    const n = Number(s.factory);
    assert(n >= spec.min && n <= spec.max, `${s.name} factory ${n}`);
  }
  assertEquals(SETTING_GROUPS[0], 'ENGINE DETECTION');
  assertEquals(SETTING_UI.length, 22);
  assertEquals(SETTING_GROUPS.length, 8); // the two new settings joined groups that were there
  // Firmware 2.7.0: I2C modules on/off (hour meter only) and the pulse input on/off.
  const row = (name: string) => SETTING_UI.find((x) => x.name === name)!;
  assertEquals([row('pulseInput').group, row('pulseInput').factory], ['TOTALIZER', true]);
  assertEquals([row('i2c').group, row('i2c').factory], ['SAVING & CLOCK', true]);
  for (const name of ['i2c', 'pulseInput']) {
    assertEquals(
      row(name).choices?.map((c) => [c.value, c.label]),
      [
        [false, 'off'],
        [true, 'on'],
      ],
    );
    assert(row(name).help.length > 20 && row(name).advice, name);
    assertEquals(rangeText(name), 'off / on');
    assertEquals(parseSettingInput(name, 'off'), { value: false });
    assertEquals(parseSettingInput(name, 'ON'), { value: true });
    assertEquals(changedFromFactory(name, false), true);
    assertEquals(changedFromFactory(name, true), false);
  }
  assertEquals(valueText('i2c', false), 'off');
  assertEquals(valueText('pulseInput', true), 'on');
  assertMatch(row('i2c').help, /the RTC, IMU and EEPROM are never used.*ESP32's flash.*this PC sets the time/);
  assertEquals(
    row('pulseInput').advice,
    'Off when only the engine wire is connected (CH2 unused): nothing on GPIO26 can count.',
  );
  assertEquals(
    [pulseInputOff({ pulseInput: false }), pulseInputOff({ pulseInput: true }), pulseInputOff({})],
    [true, false, false],
  );
  assertEquals(valueText('altActiveHigh', false), 'LOW (817 module)');
  assertEquals(valueText('altDebounceMs', 300), '300 ms');
  assertEquals(valueText('runVibMinMg', 0), 'off');
  assertEquals(valueText('output', 1), 'USB');
  assertEquals(valueText('btPin', 4821), '••••');
  assertEquals(valueText('btPin', 4821, true), '4821');
  assertEquals(valueText('kalmanQAccel', 0.0005000000237), '0.0005');
  assertEquals(valueText('telemetryIntervalMs', undefined), '?');
  assertEquals(editText('altDebounceMs', 300), '300');
  assertEquals(rangeText('altDebounceMs'), '0–5000 ms');
  assertEquals(rangeText('runVibMinMg'), 'off (0) or 1–2000 mg');
  assertEquals(rangeText('output'), 'USB / UART / both');
});

test('settings: staged changes, one command, consequences and link warnings', () => {
  const device = { altDebounceMs: 200, runVibMinMg: 0, pulsesPerUnit: 1, altActiveHigh: false };
  const changes = pendingChanges(device, {
    altDebounceMs: 300,
    runVibMinMg: 24,
    pulsesPerUnit: 10,
    altActiveHigh: false,
  });
  assertEquals(
    changes.map((c) => c.name),
    ['altDebounceMs', 'runVibMinMg', 'pulsesPerUnit'],
  ); // unchanged ones drop
  assertEquals(commandFor(changes), { altDebounceMs: 300, runVibMinMg: 24, pulsesPerUnit: 10 });
  const ctx = { transport: 'serial' as const, values: { totalCount: 15378 }, flags: [] };
  assertEquals(reviewNotes(changes[2], ctx)[0].text, 'totalizer will show 1537.80 units (now 15378.00)');
  assertEquals(reviewNotes(changes[1], ctx)[0].text, 'counts only above 24 mg');
  const uart = reviewNotes({ name: 'output', from: 1, to: 2 }, ctx);
  assertEquals(uart[0].level, 'error');
  assertEquals(reviewNotes({ name: 'output', from: 1, to: 2 }, { ...ctx, transport: 'bluetooth' }), []);
  assertEquals(
    reviewNotes({ name: 'bluetooth', from: true, to: false }, { ...ctx, transport: 'bluetooth' })[0].level,
    'error',
  );
  assertMatch(reviewNotes({ name: 'btPin', from: 4821, to: 1234 }, ctx)[0].text, /factory PIN/);
  assertEquals(
    reviewNotes({ name: 'pulseInput', from: true, to: false }, ctx)[0].text,
    'pulses are ignored; the totalizer keeps its value',
  );
  assertEquals(reviewNotes({ name: 'pulseInput', from: false, to: true }, ctx)[0].text, 'pulses are counted again');
  assertMatch(
    reviewNotes({ name: 'i2c', from: true, to: false }, ctx)[0].text,
    /stop being used; this PC sets the time$/,
  );
  assertMatch(reviewNotes({ name: 'i2c', from: false, to: true }, ctx)[0].text, /the bus starts again/);
  assertMatch(crossCheck({ imuStreamHz: 100, imuSampleHz: 50 })!, /must not be above/);
  assertEquals(crossCheck({ imuStreamHz: 10, imuSampleHz: 100 }), undefined);
  assertEquals(transportOf('/dev/rfcomm0', false), 'bluetooth');
  assertEquals(transportOf('tcp://127.0.0.1:5555', false), 'tcp');
  assertEquals(transportOf('/dev/ttyUSB0', true), 'demo');
});

test('counters: a plan with before → after; empty is an error, never 0; resets need RESET', () => {
  const now = { runSeconds: 4_500_108, totalCount: 15378, pulsesPerUnit: 1 };
  const hours = planCounter('hours', '1310.5', now).plan!;
  assertEquals(hours.command, { setRunSeconds: 4_717_800 });
  assertEquals([hours.now, hours.next, hours.change], ['1250.03 h', '1310.50 h', '+60.47 h']);
  assertMatch(planCounter('hours', '', now).error!, /enter the new value/);
  assertMatch(planCounter('hours', 'abc', now).error!, /hours must be a number/);
  assertEquals(planCounter('units', '100', { ...now, pulsesPerUnit: 10 }).plan!.command, { setTotalCount: 1000 });
  assertMatch(planCounter('pulses', '1.5', now).error!, /whole number/);
  assertEquals(planCounter('pulses', '15000', now).plan!.change, '−378 pulses');
  assertMatch(planCounter('resetHours', 'reset', now).error!, /capitals/);
  assertEquals(planCounter('resetBoth', 'RESET', now).plan!.command, { resetCounters: 0x5245534e });
  assertMatch(counterPrompt('units', { pulsesPerUnit: 10 }), /10 pulses per unit/);
});

test('live history: growth, rate, sparkline and the vibration-threshold suggestion', () => {
  let h = addSample([], { totalCount: 100, vibRms: 9, runSeconds: 10 }, 0);
  h = addSample(h, { totalCount: 135, vibRms: 40, runSeconds: 20 }, 10_000);
  assertEquals(grownSince(h, 'totalCount', 0), 35);
  assertEquals(pulseRate(h, 10_000), 3.5);
  assertEquals(sparkline([0, 75, 150], 3, 150), '▁▅█');
  assertEquals(suggestThreshold(9, 38), { value: 24, why: 'half way, at least 2 × engine off' });
  assertEquals(suggestThreshold(20, 30).value, undefined); // too close to tell apart
  assertEquals(addSample(h, {}, 700_000).length, 1); // older than 10 min drops off
});

test('commission: the engine check catches a wire that is live at key-on', () => {
  const off = [
    { atMs: 0, altInput: true, alternator: false },
    { atMs: 1000, altInput: true, alternator: false },
  ];
  assertMatch(engineVerdict(off, 0, 3000, 'off').detail, /live at key-on/);
  assertEquals(engineVerdict([{ atMs: 0, altInput: false, alternator: false }], 0, 3000, 'off').ok, true);
  assertEquals(engineVerdict([{ atMs: 0, altInput: true, alternator: true }], 0, 3000, 'on').ok, true);
  assertMatch(engineVerdict(off, 0, 3000, 'on').detail, /vibration threshold/);
  assertMatch(engineVerdict([], 0, 3000, 'on').detail, /no readings/);

  const state = {
    ...initialState('/dev/ttyUSB0', false),
    deviceId: 0x1a2b3c4d,
    values: { fwVersion: 0x00020600, statusFlags: 0, devices: 0b0111, timeValid: true },
    settings: { bluetooth: true, btPin: 1234 },
  };
  const progress = emptyProgress();
  assertEquals(checks('identify', { state, progress, latest: '2.7.0' })[1].status, 'fail'); // update available
  const modules = checks('modules', { state, progress });
  assertEquals(
    modules.map((c) => c.label),
    ['EEPROM', 'RTC', 'IMU', 'Storage', 'Safe mode'],
  );
  assert(passed(modules));
  const fitted = checks('modules', {
    state,
    progress: { ...progress, fitted: { eeprom: true, rtc: true, imu: true, mag: true } },
  });
  assertEquals(fitted.find((c) => c.label === 'compass')?.status, 'fail'); // ticked but does not answer
  assertMatch(checks('finish', { state, progress })[0].detail!, /factory PIN/);
});

test('commission: a parked bus fails the modules step, a bus that is off or a pulse input that is off does not block', () => {
  const unit = (flags: string[], values = {}, settings = {}) => ({
    ...initialState('/dev/ttyUSB0', false),
    deviceId: 1,
    values: { fwVersion: 0x00020700, statusFlags: flagBits(...flags), devices: 0, timeValid: true, ...values },
    settings,
  });
  const modules = (flags: string[], values = {}) =>
    checks('modules', { state: unit(flags, values), progress: emptyProgress() });
  const bus = (list: ReturnType<typeof modules>) => list.find((c) => c.label === 'I2C bus');
  const none = ['eepromMissing', 'rtcMissing', 'imuMissing', 'magMissing'];

  // Parked: no module answers, and the step must not pass as if nothing were wrong.
  const parked = modules([...none, 'i2cParked'], { i2cLines: 1 });
  assertEquals([bus(parked)?.status, bus(parked)?.detail], ['fail', 'parked, SDA held low: see 8 Diagnostics']);
  assertEquals(passed(parked), false);
  assertEquals(bus(modules([...none, 'i2cParked']))?.detail, 'parked, cause not read yet: see 8 Diagnostics');
  // A module the technician ticked says why it does not answer.
  const ticked = checks('modules', {
    state: unit([...none, 'i2cParked']),
    progress: { ...emptyProgress(), fitted: { eeprom: false, rtc: true, imu: false, mag: false } },
  });
  assertEquals(ticked.find((c) => c.label === 'RTC')?.detail, 'does not answer: I2C bus parked');
  // Off on purpose: fine for a unit without modules.
  const off = modules([...none, 'i2cOff']);
  assertEquals([bus(off)?.status, bus(off)?.detail], ['ok', 'off in 6 Settings: hour meter only']);
  assert(passed(off));
  assertEquals(bus(modules([])), undefined); // a healthy bus needs no line
  // Safe mode is no I2C fault to fix any more.
  const safe = modules([...none, 'safeMode']).find((c) => c.label === 'Safe mode')!;
  assertEquals(safe.status, 'fail');
  assertMatch(safe.detail!, /^on: modules are skipped; reboot the device \(8 Diagnostics\)$/);
  assert(!/I2C fault/.test(safe.detail!));

  // The clock and the IMU step name the real reason too.
  const clock = checks('clock', { state: unit([...none, 'i2cOff']), progress: emptyProgress() });
  assertEquals(clock.find((c) => c.label === 'RTC')?.detail, 'I2C off: the time is lost at every restart');
  const cal = (flags: string[]) => checks('calibrate', { state: unit(flags), progress: emptyProgress() })[0];
  assertEquals(
    [cal([...none, 'i2cOff']).status, cal([...none, 'i2cOff']).detail],
    ['ok', 'I2C is off: nothing to calibrate'],
  );
  assertEquals(cal([...none, 'i2cParked']).status, 'fail');
  assertMatch(cal([...none, 'i2cParked']).detail!, /not reachable: I2C bus parked/);
  assertEquals(cal(none).detail, 'no IMU fitted: nothing to calibrate');

  // A pulse input that is off has nothing to count: its step passes at once.
  const pulse = checks('pulse', { state: unit([], {}, { pulseInput: false }), progress: emptyProgress() });
  assertEquals([pulse.length, pulse[0].status, passed(pulse)], [1, 'ok', true]);
  assertEquals(
    checks('pulse', { state: unit([], {}, { pulseInput: true }), progress: emptyProgress() })[0].status,
    'todo',
  );
});

test('report: a Markdown file named after the device, with every setting and the raw values', () => {
  const state = {
    ...initialState('/dev/ttyUSB0', false),
    deviceId: 0x1a2b3c4d,
    values: {
      fwVersion: 0x00020600,
      statusFlags: 0b1100000,
      runHours: 1250.03,
      runSeconds: 4_500_108,
      totalUnits: 15378,
      totalCount: 15378,
    },
    settings: { altDebounceMs: 300, pulsesPerUnit: 1 },
  };
  const nowMs = Date.UTC(2026, 9, 25, 14, 32, 5);
  const input = {
    state,
    fields: { technician: 'A', unit: 'DT-07', note: 'preset from the old meter' },
    toolVersion: '2.1.0',
    nowMs,
  };
  assertEquals(reportFileName(0x1a2b3c4d, nowMs), '1A2B3C4D-2026-10-25-1432.md');
  const rows = Object.fromEntries(reportSummary(input));
  assertEquals(rows.Health, '▲ IMU not calibrated, Compass not calibrated');
  assertEquals(rows.Settings, '2 read · 1 differ from factory defaults');
  const md = buildReport(input);
  assertMatch(md, /^# Hour meter service report: 1A2B3C4D/);
  assertMatch(md, /\| Input debounce \(`altDebounceMs`\) \| 300 ms • \| 200 ms \|/);
  assertMatch(md, /## Note\n\npreset from the old meter/);
  assertMatch(md, /"deviceId": 439041101/);
});

test('report: the totalizer says it is off, and a bus that is off or parked reads as that, not as missing modules', () => {
  const none = ['eepromMissing', 'rtcMissing', 'imuMissing', 'magMissing', 'imuNotCalibrated', 'timeNotBackedUp'];
  const unit = (flags: string[], values = {}, settings = {}) => ({
    ...initialState('/dev/ttyUSB0', false),
    deviceId: 0x1a2b3c4d,
    values: {
      fwVersion: 0x00020700,
      statusFlags: flagBits(...flags),
      runHours: 18192.24,
      runSeconds: 65_492_092,
      totalUnits: 0,
      totalCount: 0,
      ...values,
    },
    settings: { pulsesPerUnit: 1, ...settings },
  });
  const nowMs = Date.UTC(2026, 9, 26, 7, 33, 20);
  const input = (state: ReturnType<typeof unit>) => ({
    state,
    fields: { technician: 'A', unit: 'DT-07', note: '' },
    toolVersion: '2.1.0',
    nowMs,
  });
  const rows = (state: ReturnType<typeof unit>) => Object.fromEntries(reportSummary(input(state)));

  // Normal unit: as before.
  assertEquals(rows(unit([])).Totalizer, '0.00 units (0 pulses, 1 per unit)');

  // The pulse input off and I2C off: both are said, and the missing modules are no problem.
  const off = unit([...none, 'i2cOff'], {}, { pulseInput: false, i2c: false });
  assertEquals(rows(off).Totalizer, 'off (pulse input off) · 0.00 units (0 pulses, 1 per unit)');
  assertEquals(rows(off).Health, '▲ Time not backed up · I2C off (hour meter only)');
  assertEquals(rows(off).Calibration, 'IMU and compass not in use (I2C off)');
  const offReport = buildReport(input(off));
  assertMatch(offReport, /\| Totalizer \| off \(pulse input off\) · 0\.00 units/);
  assertMatch(offReport, /\| Pulse input \(`pulseInput`\) \| off • \| on \|/);
  assertMatch(offReport, /\| I2C modules \(`i2c`\) \| off • \| on \|/);
  assertMatch(offReport, /## Needs attention\n\n- \*\*Time not backed up\*\*/);
  assert(!offReport.includes('No RTC'), 'no module is listed as missing');
  assertMatch(offReport, /"i2c": false/);

  // Nothing wrong and I2C off: healthy, with the reason for the missing modules.
  assertEquals(
    rows(unit(['eepromMissing', 'rtcMissing', 'imuMissing', 'magMissing', 'i2cOff'])).Health,
    '✔ no problems · I2C off (hour meter only)',
  );

  // Parked: one fault, with the lines it found held low; the modules are not listed one by one.
  const parked = unit([...none, 'i2cParked', 'i2cErrors'], { i2cLines: 1 });
  assertEquals(rows(parked).Health, '✖ I2C bus parked, Time not backed up');
  assertEquals(rows(parked).Calibration, 'IMU and compass not in use (I2C bus parked)');
  assertMatch(
    buildReport(input(parked)),
    /- \*\*I2C bus parked\*\* \(`i2cParked`\): SDA held low\. The bus kept failing/,
  );

  // A restart caused by firmware 2.6.0 or older, which restarted for a bad bus.
  assertEquals(
    rows(unit([], { lastCause: 2, lastStage: 4 })).Restarts,
    'previous run: i2cStuck (older firmware) while EEPROM',
  );
  assertEquals(rows(unit([], { lastCause: 1, lastStage: 7 })).Restarts, 'previous run: watchdog while IMU');
});
