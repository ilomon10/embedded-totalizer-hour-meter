// App.tsx: the hour-meter configurator & live viewer (Ink = React for terminals).
//
//   [1] Dashboard  [2] IMU  [3] Settings  [4] Actions  [5] Log      q = quit
//
// All device I/O goes through the DeviceClient passed in; the screen is a pure
// function of DeviceState (see state.ts).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

import {
  ACK_STATUS,
  BT_STATE,
  hoursToSeconds,
  RESET_MAGIC,
  SETTINGS,
  STREAM_MODE,
  tags,
  unitsToPulses,
} from '../tags.ts';
import { causeText } from '../restart.ts';
import {
  activeFlags,
  addLog,
  applyMessage,
  confirmSettings,
  type DecodedMessage,
  devicesPresent,
  type DeviceState,
  formatFirmware,
  type Level,
  noDataBanner,
  type Value,
} from './state.ts';

// EventEmitter's listener type (DeviceClient extends node:events EventEmitter).
// deno-lint-ignore no-explicit-any
type Listener = (...args: any[]) => void;

export interface Client {
  request(values: Record<string, number | boolean>): Promise<DecodedMessage>;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
}

const TABS = ['Dashboard', 'IMU', 'Settings', 'Actions', 'Log'] as const;
type Tab = (typeof TABS)[number];
const LEVEL_COLOR: Record<Level, string> = { info: 'white', ok: 'green', warn: 'yellow', error: 'red' };
const SERIOUS = new Set([
  'eepromMissing',
  'storageError',
  'timeInvalid',
  'rtcBatteryLost',
  'imuStuck',
  'i2cErrors',
  'safeMode',
]);

// ------------------------------------------------------------------ helpers --

function num(v: Value | undefined, digits = 2): string {
  return typeof v === 'number' ? v.toFixed(digits) : '-';
}

function fmtEpoch(v: Value | undefined, withLocal = true): string {
  if (typeof v !== 'number' || v < 946684800) return 'unknown';
  const d = new Date(v * 1000);
  const utc = d.toISOString().replace('.000', '');
  return withLocal ? `${utc}  (local ${d.toLocaleString()})` : utc;
}

function fmtSetting(name: string, v: Value | undefined): string {
  if (v === undefined) return '?';
  const spec = SETTINGS[name as keyof typeof SETTINGS];
  const named = spec?.options && Object.entries(spec.options).find(([, n]) => n === Number(v))?.[0];
  if (named) return named;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return typeof v === 'number' && !Number.isInteger(v) ? String(Number(v.toPrecision(4))) : String(v);
}

/** Parse what the user typed for a setting; returns an error text or the value. */
export function parseSetting(name: string, text: string): { value?: number | boolean; error?: string } {
  const spec = SETTINGS[name as keyof typeof SETTINGS];
  if (!spec) return { error: 'unknown setting' };
  const fmt = tags[spec.tag].fmt; // wire type decides: bool / f32 / integer
  const t = text.trim().toLowerCase();
  if (spec.options && t in spec.options) return { value: spec.options[t as keyof typeof spec.options] };
  if (fmt === 'bool') {
    if (t === 'true' || t === '1') return { value: true };
    if (t === 'false' || t === '0') return { value: false };
    return { error: 'true or false' };
  }
  const n = Number(t);
  if (t === '' || Number.isNaN(n)) {
    return { error: spec.options ? `one of ${Object.keys(spec.options).join(', ')}` : 'not a number' };
  }
  if (fmt !== 'f32' && !Number.isInteger(n)) return { error: 'must be a whole number' };
  if (n < spec.min || n > spec.max) return { error: `range ${spec.min}..${spec.max}` };
  if (spec.values && !spec.values.includes(n)) return { error: `one of ${spec.values.join(', ')}` };
  return { value: n };
}

// --------------------------------------------------------------- components --

function Header({ state, tab }: { state: DeviceState; tab: Tab }) {
  const age = state.lastFrameMs ? (Date.now() - state.lastFrameMs) / 1000 : Infinity;
  const live = age < 5;
  const conn = state.connection === 'demo' ? 'DEMO' : live ? 'connected' : state.frames ? 'no data' : 'waiting';
  return (
    <Box flexDirection='column' borderStyle='round' borderColor={live ? 'green' : 'yellow'} paddingX={1}>
      <Box justifyContent='space-between'>
        <Text bold>HOUR METER</Text>
        <Text color={live ? 'green' : 'yellow'}>● {conn} {state.port}</Text>
        <Text>dev {state.deviceId?.toString(16) ?? '-'} fw {formatFirmware(state.values.fwVersion)}</Text>
      </Box>
      <Box gap={2}>
        {TABS.map((t, i) => <Text key={t} inverse={t === tab} bold={t === tab}>{` ${i + 1} ${t} `}</Text>)}
      </Box>
    </Box>
  );
}

function Panel({ title, children, width }: { title: string; children: React.ReactNode; width?: number | string }) {
  return (
    <Box flexDirection='column' borderStyle='single' paddingX={1} width={width}>
      <Text bold color='cyan'>{title}</Text>
      {children}
    </Box>
  );
}

function Dashboard({ state }: { state: DeviceState }) {
  const v = state.values;
  const flags = activeFlags(state);
  const lastRestart = causeText(v);
  return (
    <Box flexDirection='column'>
      <Box>
        <Panel title='Hour meter' width='50%'>
          <Text>
            Run hours <Text bold color='green'>{num(v.runHours)} h</Text> ({String(v.runSeconds ?? '-')} s)
          </Text>
          <Text>
            Engine {v.alternator === undefined
              ? '-'
              : v.alternator
              ? <Text color='green' bold>RUNNING</Text>
              : <Text color='gray'>stopped</Text>}
          </Text>
          <Text>Totalizer {String(v.totalCount ?? '-')} pulses = {num(v.totalUnits)} units</Text>
          <Text color='gray'>Last save {fmtEpoch(v.lastSavedEpoch, false)} #{String(v.journalSeq ?? '-')}</Text>
        </Panel>
        <Panel title='Motion' width='50%'>
          <Text>Roll / pitch {num(v.roll)}° / {num(v.pitch)}°</Text>
          <Text>Heading {v.heading === undefined ? 'no compass' : `${num(v.heading, 1)}°`}</Text>
          <Text>Vibration RMS {String(v.vibRms ?? '-')} mg peak {String(v.vibPeak ?? '-')} mg</Text>
        </Panel>
      </Box>
      <Box>
        <Panel title='Time (device is UTC)' width='50%'>
          <Text>
            {v.timeValid === false
              ? <Text color='red'>unknown: send "Set time" (auto-sync is on)</Text>
              : fmtEpoch(v.epoch ?? v.timestamp)}
          </Text>
          <Text color='gray'>
            Uptime {String(v.uptime ?? '-')} s RTC {v.rtcTemp === undefined ? '-' : `${num(v.rtcTemp, 2)} °C`}
          </Text>
        </Panel>
        <Panel title='Modules' width='50%'>
          <Box gap={2}>
            {devicesPresent(v.devices as number | undefined).map(([name, ok]) => (
              <Text key={name} color={ok ? 'green' : 'red'}>{ok ? '✔' : '✘'} {name}</Text>
            ))}
          </Box>
          <Text color='gray'>
            I2C errors {String(v.i2cErrors ?? '-')} overruns {String(v.overruns ?? '-')} frames {state.frames}
          </Text>
          <Text color='gray'>Bluetooth {typeof v.btState === 'number' ? BT_STATE[v.btState] : '-'}</Text>
        </Panel>
      </Box>
      <Panel title='Status'>
        {flags.length === 0 ? <Text color='green'>all OK</Text> : (
          <Box flexWrap='wrap' gap={2}>
            {flags.map((f) => <Text key={f} color={SERIOUS.has(f) ? 'red' : 'yellow'}>▲ {f}</Text>)}
          </Box>
        )}
        {lastRestart ? <Text color='gray'>Last restart: {lastRestart}</Text> : null}
        {flags.includes('safeMode')
          ? <Text color='red'>Safe mode: I2C is off after repeated restarts. Power-cycle or reboot to leave it.</Text>
          : null}
      </Panel>
    </Box>
  );
}

function ImuView({ state }: { state: DeviceState }) {
  const v = state.values;
  const row = (label: string, rawKey: string, filtKey: string, unit: string, d: number) => (
    <Box key={label}>
      <Box width={14}>
        <Text>{label}</Text>
      </Box>
      {(['X', 'Y', 'Z'] as const).map((ax) => (
        <Box key={ax} width={26}>
          <Text>
            {ax} <Text color='gray'>{num(v[`${rawKey}${ax}`], d).padStart(8)}</Text>{' '}
            <Text color='green'>{num(v[`${filtKey}${ax}`], d).padStart(8)}</Text>
          </Text>
        </Box>
      ))}
      <Text color='gray'>{unit}</Text>
    </Box>
  );
  return (
    <Panel
      title={`IMU stream: mode ${fmtSetting('streamMode', state.settings.streamMode)}, ${
        fmtSetting('imuStreamHz', state.settings.imuStreamHz)
      } Hz   (gray = raw, green = filtered)`}
    >
      {row('Accel', 'rawAccel', 'accel', 'g', 3)}
      {row('Gyro', 'rawGyro', 'gyro', '°/s', 1)}
      {row('Mag', 'rawMag', 'mag', 'µT', 1)}
      <Text></Text>
      <Text color='gray'>keys: r raw f filtered b both o off + / - stream rate</Text>
    </Panel>
  );
}

const SETTING_NAMES = Object.keys(SETTINGS);

function SettingsView({ state, cursor, editing, draft, setDraft, onSubmit, error }: {
  state: DeviceState;
  cursor: number;
  editing: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onSubmit: (s: string) => void;
  error?: string;
}) {
  return (
    <Panel title='Settings   ↑↓ select   Enter edit/apply   Esc cancel   g reload'>
      {SETTING_NAMES.map((name, i) => {
        const spec = SETTINGS[name as keyof typeof SETTINGS];
        const selected = i === cursor;
        return (
          <Box key={name}>
            <Box width={22}>
              <Text inverse={selected}>{name}</Text>
            </Box>
            <Box width={16}>
              {selected && editing
                ? (
                  <TextInput
                    value={draft}
                    onChange={setDraft}
                    onSubmit={onSubmit}
                    placeholder={fmtSetting(name, state.settings[name])}
                  />
                )
                : <Text color='green'>{fmtSetting(name, state.settings[name])} {spec.unit ?? ''}</Text>}
            </Box>
            <Text color='gray'>
              {spec.help}
              {spec.options ? ` (${Object.keys(spec.options).join('/')})` : ` [${spec.min}..${spec.max}]`}
            </Text>
          </Box>
        );
      })}
      {error ? <Text color='red'>{error}</Text> : null}
    </Panel>
  );
}

const ACTIONS = [
  { id: 'time', label: 'Set device time from this PC (UTC)' },
  { id: 'hours', label: 'Set hour meter', prompt: 'new value in hours, e.g. 1250.5' },
  { id: 'units', label: 'Set totalizer in units', prompt: 'new value in units, e.g. 5230.75' },
  { id: 'count', label: 'Set totalizer in pulses', prompt: 'new value in pulses' },
  { id: 'resetHours', label: 'Reset hour meter to 0 (totalizer kept)', prompt: 'type RESET to confirm' },
  { id: 'resetTotal', label: 'Reset totalizer to 0 (hour meter kept)', prompt: 'type RESET to confirm' },
  { id: 'reset', label: 'Reset hour meter AND totalizer to 0', prompt: 'type RESET to confirm' },
  { id: 'calImu', label: 'Calibrate accel + gyro (board flat & still, ~5 s)' },
  { id: 'calMag', label: 'Calibrate magnetometer (rotate in all directions, 20 s)' },
  { id: 'unlock', label: 'Unlock Bluetooth session', prompt: 'PIN' },
  { id: 'reboot', label: 'Reboot device' },
  { id: 'hardReset', label: 'Hard reset (USB)' },
  { id: 'refresh', label: 'Refresh everything (get hour/settings/status/calibration)' },
] as const;

/** Current value shown next to the counter actions, so you see what you are changing. */
function currentValue(id: string, state: DeviceState, hardResetNote?: string): string {
  const v = state.values;
  const ppu = state.settings.pulsesPerUnit ?? 1;
  if (id === 'hours' || id === 'resetHours') return `now ${num(v.runHours)} h`;
  if (id === 'units' || id === 'resetTotal') return `now ${num(v.totalUnits)} units (${String(ppu)} pulses/unit)`;
  if (id === 'count') return `now ${String(v.totalCount ?? '-')} pulses`;
  if (id === 'reset') return `now ${num(v.runHours)} h, ${num(v.totalUnits)} units`;
  if (id === 'hardReset') return hardResetNote ?? 'pulses EN through the USB adapter (key H)';
  return '';
}

function ActionsView({ state, cursor, editing, draft, setDraft, onSubmit, hardResetNote }: {
  state: DeviceState;
  cursor: number;
  editing: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onSubmit: (s: string) => void;
  hardResetNote?: string;
}) {
  return (
    <Panel title='Actions   ↑↓ select   Enter run'>
      {ACTIONS.map((a, i) => (
        <Box key={a.id} gap={1}>
          <Text inverse={i === cursor}>{` ${a.label} `}</Text>
          <Text color='gray'>{currentValue(a.id, state, hardResetNote)}</Text>
          {i === cursor && editing && 'prompt' in a
            ? (
              <Text>
                {a.prompt}: <TextInput value={draft} onChange={setDraft} onSubmit={onSubmit} />
              </Text>
            )
            : null}
        </Box>
      ))}
    </Panel>
  );
}

function LogView({ state }: { state: DeviceState }) {
  return (
    <Panel title='Log (events, commands, errors)'>
      {state.log.slice(-18).map((e, i) => (
        <Text key={i} color={LEVEL_COLOR[e.level]}>{new Date(e.atMs).toLocaleTimeString()} {e.text}</Text>
      ))}
      {state.log.length === 0 ? <Text color='gray'>nothing yet</Text> : null}
    </Panel>
  );
}

// --------------------------------------------------------------------- app --

/**
 * `hardReset` pulses EN through the USB adapter; it is only given for a local serial port.
 * `hardResetNote` says why it is missing (shown instead).
 */
export function App({ client, initial, hardReset, hardResetNote }: {
  client: Client;
  initial: DeviceState;
  hardReset?: () => Promise<void>;
  hardResetNote?: string;
}) {
  const { exit } = useApp();
  const [state, setState] = useState(initial);
  const [tab, setTab] = useState<Tab>('Dashboard');
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [, setTick] = useState(0);
  const startMs = useRef(Date.now()).current;

  const log = useCallback((level: Level, text: string) => setState((s) => addLog(s, level, text, Date.now())), []);

  const send = useCallback(async (label: string, values: Record<string, number | boolean>, quiet = false) => {
    try {
      const ack = await client.request(values); // rejects unless ackStatus is Ok
      setState((s) => confirmSettings(applyMessage(s, ack, Date.now()), values));
      if (!quiet) log('ok', `${label}: ${ACK_STATUS[Number(ack.values.ackStatus)] ?? 'Ok'}`);
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      const hint = /Locked|BadPin/.test(msg) ? '  (Bluetooth: Actions > Unlock, or start with --pin)' : '';
      log('error', `${label}: ${msg}${hint}`);
      return false;
    }
  }, [client, log]);

  const refresh = useCallback(async () => {
    for (
      const [what, label] of [[2, 'get settings'], [3, 'get status'], [1, 'get hour meter'], [
        4,
        'get calibration',
      ]] as const
    ) {
      await send(label, { get: what }, true);
    }
    log('info', 'refreshed settings, status, hour meter, calibration');
  }, [send, log]);

  useEffect(() => {
    const onFrame = (msg: DecodedMessage) => setState((s) => applyMessage(s, msg, Date.now()));
    const onSynced = (epoch: number) =>
      log('ok', `auto time sync: device clock set to ${new Date(epoch * 1000).toISOString()}`);
    const onSyncError = (err: Error) => log('error', `auto time sync failed: ${err.message}`);
    client.on('frame', onFrame);
    client.on('timeSynced', onSynced);
    client.on('timeSyncError', onSyncError);
    void refresh();
    const timer = setInterval(() => setTick((t) => t + 1), 1000); // keep "last frame" age fresh
    // Uptime, I2C errors, RTC temperature... only come with a full status: poll it quietly.
    const status = setInterval(() => void send('get status', { get: 3 }, true), 10000);
    return () => {
      client.off('frame', onFrame);
      client.off('timeSynced', onSynced);
      client.off('timeSyncError', onSyncError);
      clearInterval(timer);
      clearInterval(status);
    };
  }, [client, refresh, send, log]);

  // Change a counter, then re-read the hour meter so the dashboard shows the new value at once.
  const setCounter = async (label: string, build: () => Record<string, number>) => {
    let values: Record<string, number>;
    try {
      values = build();
    } catch (err) {
      return log('error', (err as Error).message);
    }
    if (await send(label, values)) await send('get hour meter', { get: 1 }, true);
  };

  const runAction = async (id: string, input = '') => {
    switch (id) {
      case 'time':
        return send('set time', { setTime: Math.floor(Date.now() / 1000) });
      case 'hours':
        return setCounter(`hour meter = ${input} h`, () => ({ setRunSeconds: hoursToSeconds(input) }));
      case 'units':
        return setCounter(
          `totalizer = ${input} units`,
          () => ({ setTotalCount: unitsToPulses(input, Number(state.settings.pulsesPerUnit ?? 1)) }),
        );
      case 'count': {
        const c = Number(input);
        return Number.isInteger(c) && c >= 0
          ? setCounter(`totalizer = ${c} pulses`, () => ({ setTotalCount: c }))
          : log('error', 'pulses must be a whole number >= 0');
      }
      case 'resetHours':
        return input === 'RESET'
          ? setCounter('hour meter = 0', () => ({ setRunSeconds: 0 }))
          : log('warn', 'reset cancelled');
      case 'resetTotal':
        return input === 'RESET'
          ? setCounter('totalizer = 0', () => ({ setTotalCount: 0 }))
          : log('warn', 'reset cancelled');
      case 'calImu':
        return send('calibrate accel+gyro (wait for result in Log)', { calibrate: 1 });
      case 'calMag':
        return send('calibrate magnetometer (rotate now!)', { calibrate: 2 });
      case 'reset':
        return input === 'RESET'
          ? setCounter('reset hour meter + totalizer', () => ({ resetCounters: RESET_MAGIC }))
          : log('warn', 'reset cancelled');
      case 'unlock':
        return (await send('unlock', { unlock: Number(input) })) ? refresh() : undefined;
      case 'reboot':
        return send('reboot', { reboot: 1 });
      case 'hardReset':
        return runHardReset();
      default:
        return refresh();
    }
  };

  const runHardReset = async () => {
    if (!hardReset) return log('warn', `hard reset: ${hardResetNote ?? 'not available'}`);
    log('info', 'hard reset: pulsing EN over USB...');
    try {
      await hardReset();
    } catch (err) {
      log('error', (err as Error).message);
    }
  };

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        setError(undefined);
      }
      return; // TextInput owns the keyboard while editing
    }
    if (input === 'q') return exit();
    const n = Number(input);
    if (n >= 1 && n <= TABS.length) {
      setTab(TABS[n - 1]);
      setCursor(0);
      return;
    }
    if (key.tab) {
      setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]);
      setCursor(0);
      return;
    }
    const count = tab === 'Settings' ? SETTING_NAMES.length : tab === 'Actions' ? ACTIONS.length : 0;
    if (key.upArrow && count) setCursor((c) => (c + count - 1) % count);
    if (key.downArrow && count) setCursor((c) => (c + 1) % count);
    if (input === 'g') void refresh();
    if (input === 'H' || input === 'h') void runHardReset();
    if (tab === 'IMU') {
      const mode = { r: STREAM_MODE.raw, f: STREAM_MODE.filtered, b: STREAM_MODE.both, o: STREAM_MODE.off }[input];
      if (mode !== undefined) void send('stream mode', { streamMode: mode });
      const rates = [0, 1, 2, 5, 10, 20, 50, 100];
      const cur = rates.indexOf(Number(state.settings.imuStreamHz ?? 10));
      if (input === '+' || input === '-') {
        const next = rates[Math.max(0, Math.min(rates.length - 1, (cur < 0 ? 4 : cur) + (input === '+' ? 1 : -1)))];
        void send(`stream ${next} Hz`, { imuStreamHz: next });
      }
    }
    if (key.return && tab === 'Settings') {
      setDraft(''); // placeholder shows the current value; just type the new one
      setError(undefined);
      setEditing(true);
    }
    if (key.return && tab === 'Actions') {
      const a = ACTIONS[cursor];
      if ('prompt' in a) {
        setDraft('');
        setEditing(true);
      } else void runAction(a.id);
    }
  });

  const submitSetting = async (text: string) => {
    const name = SETTING_NAMES[cursor];
    const parsed = parseSetting(name, text);
    if (parsed.error !== undefined || parsed.value === undefined) return setError(`${name}: ${parsed.error}`);
    setError(undefined);
    setEditing(false);
    await send(`set ${name} = ${text}`, { [name]: parsed.value });
  };

  const submitAction = async (text: string) => {
    setEditing(false);
    await runAction(ACTIONS[cursor].id, text.trim());
  };

  const lastLog = state.log[state.log.length - 1];
  const banner = state.connection === 'demo'
    ? undefined
    : noDataBanner(state.lastFrameMs, startMs, Date.now(), hardReset ? undefined : hardResetNote);
  return (
    <Box flexDirection='column'>
      <Header state={state} tab={tab} />
      {banner ? <Text color='yellow' bold>▲ {banner}</Text> : null}
      {tab === 'Dashboard' && <Dashboard state={state} />}
      {tab === 'IMU' && <ImuView state={state} />}
      {tab === 'Settings' && (
        <SettingsView
          state={state}
          cursor={cursor}
          editing={editing}
          draft={draft}
          setDraft={setDraft}
          onSubmit={submitSetting}
          error={error}
        />
      )}
      {tab === 'Actions' && (
        <ActionsView
          state={state}
          cursor={cursor}
          editing={editing}
          draft={draft}
          setDraft={setDraft}
          onSubmit={submitAction}
          hardResetNote={hardReset ? undefined : hardResetNote}
        />
      )}
      {tab === 'Log' && <LogView state={state} />}
      <Box paddingX={1}>
        <Text color='gray'>1-5/Tab switch g refresh H hard reset q quit</Text>
        {lastLog ? <Text color={LEVEL_COLOR[lastLog.level]}>{lastLog.text}</Text> : null}
      </Box>
    </Box>
  );
}
