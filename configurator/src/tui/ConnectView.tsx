// ConnectView.tsx: the first screen when `hour-meter` starts without a port. Pick the board's port, type one
// (a path or tcp://host:port), or try the demo.
//
//   ↑↓ select   Enter connect   q quit         typing a path or PIN: Enter connect, Esc back
//
// The list is read again every second: a board plugged in shows up by itself and is selected. The port opens
// here, so a port that does not open says why on this screen (not there, no permission, in use).
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import type { Target } from '../cli.ts';
import type { DeviceClient } from '../device.ts';
import { newPorts, type PortInfo, preferredPort } from '../ports.ts';

const SCAN_MS = 1000;

type Item = { key: string; port?: PortInfo; kind: 'port' | 'other' | 'demo' };
type Mode = 'list' | 'path' | 'pin' | 'connecting';

export interface ConnectProps {
  version: string;
  /** The port to select first (the last one used, or $HOUR_METER_PORT). */
  preselect?: string;
  /** --pin / $HOUR_METER_PIN: a Bluetooth port then does not ask for it. */
  pin?: string;
  list: () => Promise<PortInfo[]>;
  open: (target: Target) => Promise<DeviceClient>;
  /** Plain words for a port that did not open (ports.ts openProblem()). */
  problem: (err: unknown, spec: string) => Promise<string>;
  onConnected: (target: Target, client: DeviceClient, port?: PortInfo) => void;
  onQuit: () => void;
}

/** The ports found, the last port used when it was not found (a tcp:// address, a typed path), other, demo. */
function items(ports: PortInfo[], last?: string): Item[] {
  const extra: PortInfo[] = last && !ports.some((p) => p.path === last)
    ? [{ path: last, label: last.startsWith('tcp://') ? 'TCP' : 'serial port', kind: 'serial', boardLike: false }]
    : [];
  return [
    ...[...ports, ...extra].map((port): Item => ({ key: port.path, port, kind: 'port' })),
    { key: 'other', kind: 'other' },
    { key: 'demo', kind: 'demo' },
  ];
}

export function ConnectView(props: ConnectProps) {
  const [ports, setPorts] = useState<PortInfo[] | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [fresh, setFresh] = useState<string | undefined>(); // the port just plugged in
  const [mode, setMode] = useState<Mode>('list');
  const [draft, setDraft] = useState('');
  const [pendingPort, setPendingPort] = useState<{ spec: string; port?: PortInfo } | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const attempt = useRef(0); // a cancelled connect (Esc) is closed when it opens
  const opening = useRef<Promise<unknown>>(Promise.resolve()); // the last open, settled or not
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    let alive = true;
    let before: PortInfo[] | undefined;
    const scan = async () => {
      const now = await props.list().catch(() => [] as PortInfo[]);
      if (!alive) return;
      if (before === undefined) {
        setSelected(props.preselect ?? items(now)[preferredPort(now)].key); // the last port used is always listed
      } else {
        const plugged = newPorts(before, now)[0];
        if (plugged && modeRef.current === 'list') {
          setSelected(plugged.path); // plugged in while this screen is open: that is the board
          setFresh(plugged.path);
        }
      }
      before = now;
      setPorts(now);
    };
    void scan();
    const timer = setInterval(scan, SCAN_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const list = items(ports ?? [], props.preselect);
  const index = Math.max(0, list.findIndex((i) => i.key === selected));

  const connect = async (target: Target, port?: PortInfo) => {
    const id = ++attempt.current;
    setMode('connecting');
    setPendingPort({ spec: target.demo ? 'the demo device' : target.port, port });
    setProblem(undefined);
    // A cancelled open may still hold the port (an ESP32 restarts when it opens): let it finish and close first.
    await opening.current.catch(() => {});
    if (id !== attempt.current) return;
    const open = props.open(target);
    opening.current = open;
    try {
      const dev = await open;
      if (id !== attempt.current) return dev.close(); // cancelled meanwhile
      props.onConnected(target, dev, port);
    } catch (err) {
      if (id !== attempt.current) return;
      const problem = await props.problem(err, target.port);
      if (id !== attempt.current) return; // cancelled, and maybe another connect started, meanwhile
      setProblem(problem);
      setMode('list');
    }
  };

  /** A Bluetooth port asks for the PIN first, unless --pin gave it. */
  const choose = (spec: string, port?: PortInfo) => {
    if (/rfcomm/i.test(spec) && props.pin === undefined) {
      setPendingPort({ spec, port });
      setDraft('');
      setMode('pin');
      return;
    }
    void connect({ demo: false, port: spec, pin: props.pin }, port);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return props.onQuit();
    if (mode === 'connecting') {
      if (key.escape) {
        attempt.current++;
        setMode('list');
      }
      return;
    }
    if (mode === 'path' || mode === 'pin') {
      if (key.escape) setMode('list');
      return; // TextInput owns the keyboard
    }
    if (input === 'q') return props.onQuit();
    if (key.upArrow || key.downArrow) {
      const next = (index + (key.upArrow ? list.length - 1 : 1)) % list.length;
      setSelected(list[next].key);
      return;
    }
    if (!key.return) return;
    const item = list[index];
    if (item.kind === 'demo') void connect({ demo: true, port: 'demo' });
    else if (item.kind === 'other') {
      setDraft('');
      setMode('path');
    } else if (item.port) choose(item.port.path, item.port);
  });

  const submitPath = (text: string) => {
    const spec = text.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
    if (!spec) return setMode('list');
    choose(spec, ports?.find((p) => p.path === spec));
  };

  const submitPin = (text: string) => {
    if (!pendingPort) return setMode('list');
    void connect({ demo: false, port: pendingPort.spec, pin: text.trim() || undefined }, pendingPort.port);
  };

  const hints = mode === 'list'
    ? '↑↓ select · Enter connect · q quit'
    : mode === 'connecting'
    ? 'Esc cancel'
    : 'Enter connect · Esc back';
  return (
    <Box flexDirection='column'>
      <Box flexDirection='column' borderStyle='round' borderColor='cyan' paddingX={1}>
        <Box justifyContent='space-between'>
          <Text bold>HOUR METER</Text>
          <Text color='gray'>configurator {props.version}</Text>
        </Box>
        <Text>Connect to a device</Text>
      </Box>
      <Box flexDirection='column' borderStyle='single' paddingX={1}>
        <Text bold color='cyan'>Ports</Text>
        {ports === undefined ? <Text color='gray'>looking for serial ports...</Text> : null}
        {ports?.length === 0
          ? <Text color='gray'>No serial port yet. Plug in the board: it shows up here by itself.</Text>
          : null}
        {list.map((item, i) => {
          const on = i === index;
          const last = item.port && item.port.path === props.preselect;
          return (
            <Box key={item.key}>
              <Box width={2} flexShrink={0}>
                <Text color='cyan'>{on ? '▸' : ' '}</Text>
              </Box>
              {item.kind === 'port' && item.port
                ? (
                  <>
                    <Box width={18} flexShrink={0} marginRight={1}>
                      <Text inverse={on} bold={on} wrap='truncate-middle'>{item.port.path}</Text>
                    </Box>
                    <Text color='gray' wrap='truncate-end'>
                      {item.port.label}
                      {item.port.kind === 'bluetooth' && props.pin === undefined ? ' (asks for the PIN)' : ''}
                    </Text>
                    {item.key === fresh
                      ? (
                        <Box marginLeft={2}>
                          <Text color='green'>just plugged in</Text>
                        </Box>
                      )
                      : null}
                    {last && item.key !== fresh
                      ? (
                        <Box marginLeft={2}>
                          <Text color='green'>last used</Text>
                        </Box>
                      )
                      : null}
                  </>
                )
                : item.kind === 'other'
                ? <Text inverse={on} bold={on}>Other port or tcp://host:port...</Text>
                : (
                  <>
                    <Box width={18} flexShrink={0}>
                      <Text inverse={on} bold={on}>Demo</Text>
                    </Box>
                    <Text color='gray'>a simulated device, no hardware needed</Text>
                  </>
                )}
            </Box>
          );
        })}
      </Box>
      {mode === 'path'
        ? (
          <Box paddingX={1} gap={1}>
            <Text>Port:</Text>
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={submitPath}
              placeholder='/dev/ttyUSB0 or tcp://127.0.0.1:5555'
            />
          </Box>
        )
        : null}
      {mode === 'pin'
        ? (
          <Box paddingX={1} gap={1}>
            <Text>Bluetooth PIN for {pendingPort?.spec} (Enter: none):</Text>
            <TextInput value={draft} onChange={setDraft} onSubmit={submitPin} mask='*' />
          </Box>
        )
        : null}
      {mode === 'connecting'
        ? (
          <Text color='yellow'>
            {` ◌ Connecting to ${pendingPort?.spec}... (an ESP32 board restarts when its port opens)`}
          </Text>
        )
        : null}
      {problem && mode !== 'connecting' ? <Text color='red'>{` ✘ ${problem}`}</Text> : null}
      <Text color='gray'>{` ${hints}`}</Text>
    </Box>
  );
}
