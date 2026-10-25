// tui-model.test.ts: the TUI's pure models: formats, health, settings, counters, live history, commissioning and
// the service report.
import { test } from 'bun:test';

import { assert, assertEquals, assertMatch } from './assert.ts';
import { checks, emptyProgress, engineVerdict, passed } from '../src/tui/model/commission.ts';
import { counterPrompt, planCounter } from '../src/tui/model/counters.ts';
import { ago, bar, deviceIdText, duration, fit, utcText } from '../src/tui/model/format.ts';
import { issueFor, problems, summary } from '../src/tui/model/health.ts';
import { addSample, grownSince, pulseRate, sparkline, suggestThreshold } from '../src/tui/model/history.ts';
import { SCREENS, screenByKey, screenRef } from '../src/tui/model/nav.ts';
import { buildReport, reportFileName, reportSummary } from '../src/tui/model/report.ts';
import {
  commandFor,
  crossCheck,
  editText,
  pendingChanges,
  rangeText,
  reviewNotes,
  SETTING_GROUPS,
  SETTING_UI,
  transportOf,
  valueText,
} from '../src/tui/model/settings.ts';
import { initialState } from '../src/tui/state.ts';
import { SETTINGS, STATUS_FLAGS } from '../src/tags.ts';

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
  for (const flag of STATUS_FLAGS) assert(issueFor(flag, [flag]).why.length > 10, flag);
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
    ['safeMode', 'imuNotCalibrated', 'magNotCalibrated'],
  );
  assertEquals(summary(flags).text, '✖ 1 fault');
  assertEquals(summary(['imuNotCalibrated', 'magNotCalibrated']).text, '▲ 2 to check');
  assertEquals(summary(['settingsDefaults']).text, '✔ healthy');
  assertEquals(summary(undefined).level, 'unknown');
});

test('settings: every device setting has a label, a group and a factory value in range', () => {
  assertEquals(SETTING_UI.map((s) => s.name).sort(), Object.keys(SETTINGS).sort());
  for (const s of SETTING_UI) {
    const spec = SETTINGS[s.name];
    const n = Number(s.factory);
    assert(n >= spec.min && n <= spec.max, `${s.name} factory ${n}`);
  }
  assertEquals(SETTING_GROUPS[0], 'ENGINE DETECTION');
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
    toolVersion: '2.0.0',
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
