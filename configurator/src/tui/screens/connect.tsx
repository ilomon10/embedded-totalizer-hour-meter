// connect.tsx: the first screen when `hour-meter` starts without a port. Pick the board's port, type one (a path
// or tcp://host:port), or the demo device. The list is read again every second: a board plugged in shows up by
// itself and is selected. The port opens here, so a port that does not open says why, with the fix.
//
//   ↑↓ select   Enter connect   e type a port   d demo   q quit        typing: Enter connect, Esc back
import type { KeyEvent } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';

import type { Target } from '../../cli.ts';
import type { DeviceClient } from '../../device.ts';
import { newPorts, type PortInfo, preferredPort } from '../../ports.ts';
import { charOf, useRefState } from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import { bold, dim, editLine, FieldLine, Line, ok, type Seg, Spread } from '../ui.tsx';

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
  const extra: PortInfo[] =
    last && !ports.some((p) => p.path === last)
      ? [
          {
            path: last,
            label: last.startsWith('tcp://') ? 'TCP · simulator or serial bridge' : 'serial port',
            kind: 'serial',
            boardLike: false,
          },
        ]
      : [];
  return [
    ...[...ports, ...extra].map((port): Item => ({ key: port.path, port, kind: 'port' })),
    { key: 'other', kind: 'other' },
    { key: 'demo', kind: 'demo' },
  ];
}

export function ConnectScreen(props: ConnectProps) {
  const { width, height } = useTerminalDimensions();
  const [ports, setPorts, portsRef] = useRefState<PortInfo[] | undefined>(undefined);
  const [selected, setSelected, selectedRef] = useRefState<string | undefined>(undefined);
  const [fresh, setFresh] = useState<string | undefined>(); // the port just plugged in
  const [mode, setMode, modeRef] = useRefState<Mode>('list');
  const [draft, setDraft, draftRef] = useRefState('');
  const [pending, setPending, pendingRef] = useRefState<{ spec: string; port?: PortInfo } | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>();
  const attempt = useRef(0); // a cancelled connect (Esc) is closed when it opens
  const opening = useRef<Promise<unknown>>(Promise.resolve()); // the last open, settled or not

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
  const index = Math.max(
    0,
    list.findIndex((i) => i.key === selected),
  );

  const connect = async (target: Target, port?: PortInfo) => {
    const id = ++attempt.current;
    setMode('connecting');
    setPending({ spec: target.demo ? 'the demo device' : target.port, port });
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
      const words = await props.problem(err, target.port);
      if (id !== attempt.current) return; // cancelled, and maybe another connect started, meanwhile
      setProblem(words);
      setMode('list');
    }
  };

  /** A Bluetooth port asks for the PIN first, unless --pin gave it. */
  const choose = (spec: string, port?: PortInfo) => {
    if (/rfcomm/i.test(spec) && props.pin === undefined) {
      setPending({ spec, port });
      setDraft('');
      setMode('pin');
      return;
    }
    void connect({ demo: false, port: spec, pin: props.pin }, port);
  };

  useKeyboard((key: KeyEvent) => {
    const c = charOf(key);
    const mode = modeRef.current;
    const draft = draftRef.current;
    const pending = pendingRef.current;
    const list = items(portsRef.current ?? [], props.preselect);
    const index = Math.max(
      0,
      list.findIndex((i) => i.key === selectedRef.current),
    );
    if (key.ctrl && key.name === 'c') return props.onQuit();
    if (mode === 'connecting') {
      if (key.name === 'escape') {
        attempt.current++;
        setMode('list');
      }
      return;
    }
    if (mode === 'path' || mode === 'pin') {
      if (key.name === 'escape') return setMode('list');
      if (key.name === 'return') {
        if (mode === 'path') {
          const spec = draft.trim().replace(/^~(?=\/)/, process.env.HOME ?? '~');
          if (!spec) return setMode('list');
          return choose(
            spec,
            portsRef.current?.find((p) => p.path === spec),
          );
        }
        if (pending) void connect({ demo: false, port: pending.spec, pin: draft.trim() || undefined }, pending.port);
        return;
      }
      const next = editLine(draft, key, mode === 'pin' ? (ch) => /\d/.test(ch) && draft.length < 4 : undefined);
      if (next !== undefined) setDraft(next);
      return;
    }
    if (c === 'q') return props.onQuit();
    if (key.name === 'up' || key.name === 'down' || c === 'k' || c === 'j') {
      const next = (index + (key.name === 'up' || c === 'k' ? list.length - 1 : 1)) % list.length;
      setSelected(list[next].key);
      return;
    }
    if (c === 'd') return void connect({ demo: true, port: 'demo' });
    if (c === 'e') {
      setDraft('');
      return setMode('path');
    }
    if (key.name !== 'return') return;
    const item = list[index];
    if (item.kind === 'demo') void connect({ demo: true, port: 'demo' });
    else if (item.kind === 'other') {
      setDraft('');
      setMode('path');
    } else if (item.port) choose(item.port.path, item.port);
  });

  const row = (item: Item, on: boolean): Seg[] => {
    const cursor: Seg = { t: on ? ` ${MARK.select} ` : '   ', fg: C.cyan };
    if (item.kind === 'other')
      return [cursor, { t: 'Type a port or tcp://host:port…', fg: on ? C.cyan : C.fg, bold: on }];
    if (item.kind === 'demo')
      return [
        cursor,
        { t: 'Demo device', fg: on ? C.cyan : C.fg, bold: on },
        dim(': a simulated hour meter, no hardware needed'),
      ];
    const p = item.port!;
    // The adapter's name gives way first: "· ESP32 board" and "· asks for the PIN" must stay readable.
    const suffix = `${p.boardLike ? ' · ESP32 board' : ''}${p.kind === 'bluetooth' && props.pin === undefined ? ' · asks for the PIN' : ''}`;
    const room = Math.max(10, width - 52);
    const fits = room - 2; // a gap before the tag
    const name =
      p.label.length + suffix.length > fits ? `${p.label.slice(0, Math.max(3, fits - suffix.length - 1))}…` : p.label;
    const tag =
      item.key === fresh ? ok(`${MARK.live} just plugged in`) : p.path === props.preselect ? ok('last used') : '';
    return [
      cursor,
      { t: p.path.padEnd(22), fg: on ? C.cyan : C.fg, bold: on },
      dim(`${name}${suffix}`.slice(0, fits).padEnd(room)),
      ' ',
      tag,
    ];
  };

  const hints =
    mode === 'list'
      ? '↑↓ select   Enter connect   e type a port   d demo   q quit'
      : mode === 'connecting'
        ? 'Esc cancel'
        : 'Enter connect   Esc back';
  return (
    <box style={{ flexDirection: 'column', width, height }}>
      <box style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: C.headerBg, height: 1 }}>
        <Line segs={[bold(' HOUR METER', C.fg), dim(`  configurator ${props.version}`)]} bg={C.headerBg} />
        <Line segs={['Connect to a device ']} bg={C.headerBg} />
      </box>
      <box
        border
        borderStyle="rounded"
        borderColor={C.border}
        title=" Ports "
        bottomTitle=" rescans every 1 s "
        bottomTitleAlignment="right"
        style={{ flexDirection: 'column', paddingTop: 1, paddingBottom: 1 }}
      >
        {ports === undefined ? <Line segs={[dim('   looking for serial ports…')]} /> : null}
        {ports?.length === 0 ? (
          <Line segs={[dim('   No serial port yet. Plug in the board: it shows up here by itself.')]} />
        ) : null}
        {list.map((item, i) => (
          <box key={item.key} style={{ flexDirection: 'column' }}>
            {item.kind === 'other' ? <text> </text> : null}
            <Line segs={row(item, i === index)} />
          </box>
        ))}
        {problem && mode !== 'connecting' ? (
          <>
            <text> </text>
            <Line segs={[{ t: `   ${MARK.error} ${problem}`, fg: C.red }]} />
          </>
        ) : null}
        {mode === 'connecting' ? (
          <>
            <text> </text>
            <Line
              segs={[
                {
                  t: `   ${MARK.busy} Connecting to ${pending?.spec}… (an ESP32 board restarts when its port opens)`,
                  fg: C.yellow,
                },
              ]}
            />
          </>
        ) : null}
      </box>
      {mode === 'path' || mode === 'pin' ? (
        <box
          border
          borderStyle="rounded"
          borderColor={C.borderFocus}
          title={mode === 'pin' ? ' Bluetooth PIN ' : ' Port '}
          style={{ flexDirection: 'column', paddingLeft: 1 }}
        >
          {mode === 'pin' ? (
            <>
              <FieldLine
                label={`${pending?.spec} starts locked. PIN:  `}
                text={draft}
                mask
                placeholder="4 digits (Enter: none)"
              />
              <Line segs={[dim('Kept for automatic reconnects. 5 wrong PINs lock unlocking for 60 s.')]} />
            </>
          ) : (
            <FieldLine label="Port:  " text={draft} placeholder="/dev/ttyUSB0 or tcp://127.0.0.1:5555" />
          )}
        </box>
      ) : (
        <box
          border
          borderStyle="rounded"
          borderColor={C.border}
          title=" Tips "
          style={{ flexDirection: 'column', paddingLeft: 1 }}
        >
          <Line segs={[dim('The board restarts when its USB port opens and answers after about 2 s.')]} />
          <Line segs={[dim('No port listed? Try another cable (some only charge) and check you are in the')]} />
          <Line segs={[dim('dialout (Debian/Ubuntu) or uucp (Arch) group.')]} />
        </box>
      )}
      <box style={{ flexGrow: 1 }} />
      <Spread left={[]} right={[dim(`${hints} `)]} />
    </box>
  );
}
