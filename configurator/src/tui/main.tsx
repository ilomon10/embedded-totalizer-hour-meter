// main.tsx: start the full-screen configurator (OpenTUI).
//
//   hour-meter                               connect screen: pick a port, type one, or the demo
//   hour-meter [port | tcp://host:port]      straight to that port (waits for it if it is not there yet)
//   hour-meter --demo                        simulated device, no hardware needed
//   hour-meter /dev/rfcomm0 --pin 1234       over Bluetooth SPP (session is PIN-locked)
//   options: --no-time-sync                  do not auto-send the PC clock when the device time is unknown
//
// The device is held by a Connection (connection.ts): an unplugged board is waited for and reconnected, and `p`
// goes back to the connect screen. The log and the release list carry over to the next port.
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { useEffect, useMemo, useState } from 'react';

import { connect, env, takeFlag, takeOption, type Target } from '../cli.ts';
import { Connection } from '../connection.ts';
import type { DeviceClient } from '../device.ts';
import { OS } from '../platform.ts';
import { listPorts, loadLastPort, openProblem, type PortInfo, saveLastPort } from '../ports.ts';
import type { FirmwareRelease } from '../releases.ts';
import { hardReset, isLocalSerial } from '../reset.ts';
import { TOOL_VERSION } from '../version.ts';
import { TuiController } from './controller.ts';
import { firmwareActions } from './firmware-actions.ts';
import { transportOf } from './model/settings.ts';
import { ConnectScreen } from './screens/connect.tsx';
import { Shell } from './shell.tsx';
import { initialState, type LogEntry } from './state.ts';

const READY_MS = 2500; // the first frame after opening (an ESP32 board restarts when its port opens)

/** What outlives one port: the log and the release list. */
interface Session {
  conn?: Connection;
  ctrl?: TuiController;
  log: LogEntry[];
  releases?: FirmwareRelease[];
}

export async function run(argv: string[]): Promise<number> {
  const pin = takeOption(argv, '--pin');
  const demo = takeFlag(pin.rest, '--demo');
  const noSync = takeFlag(demo.rest, '--no-time-sync');
  const port = noSync.rest.find((a) => !a.startsWith('--'));
  const timeSync = !noSync.value;
  const pinValue = pin.value ?? env('HOUR_METER_PIN');

  const open = (target: Target) => connect(target, READY_MS);
  const newConnection = (target: Target, client?: DeviceClient, portId?: string) =>
    new Connection({ target, open, client, portId, timeSync, ports: () => listPorts() });
  // A port on the command line (or --demo) skips the connect screen, and waits for the port if it is not there.
  const start =
    demo.value || port
      ? newConnection({ demo: demo.value, port: demo.value ? 'demo' : port!, pin: pinValue }).start()
      : undefined;
  const preselect = (await loadLastPort(env)) ?? env('HOUR_METER_PORT');

  // The shell decides about Ctrl+C (never in the middle of a flash); signals end the session below.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [] });
  const session: Session = { conn: start, log: [] };
  let quit = () => {};
  const done = new Promise<void>((resolve) => (quit = resolve));
  // A closed terminal (SIGHUP), kill or Ctrl+C from outside: leave like q does, so the port is closed.
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.once(signal, () => quit());
  createRoot(renderer).render(
    <Root
      session={session}
      preselect={preselect}
      pin={pinValue}
      timeSync={timeSync}
      open={open}
      newConnection={newConnection}
      onQuit={() => quit()}
    />,
  );
  await done;
  session.ctrl?.stop();
  session.conn?.close();
  renderer.destroy();
  return 0;
}

interface RootProps {
  session: Session;
  preselect?: string;
  pin?: string;
  timeSync: boolean;
  open: (target: Target) => Promise<DeviceClient>;
  newConnection: (target: Target, client?: DeviceClient, portId?: string) => Connection;
  onQuit: () => void;
}

/** The connect screen until a port is open, then the shell; `p` there comes back here. */
function Root({ session, preselect, pin, timeSync, open, newConnection, onQuit }: RootProps) {
  const [conn, setConn] = useState(session.conn);
  const [portLabel, setPortLabel] = useState<string | undefined>();
  const [last, setLast] = useState(preselect);

  const ctrl = useMemo(() => {
    if (!conn) return undefined;
    const wired = isLocalSerial(conn.port, conn.demo) && OS !== 'windows';
    return new TuiController({
      conn,
      initial: { ...initialState(conn.demo ? 'simulated' : conn.port, conn.demo), log: session.log },
      firmware: firmwareActions(conn),
      hardReset: wired ? () => hardReset(conn.port) : undefined,
      releases: session.releases,
    });
  }, [conn]);

  useEffect(() => {
    if (!ctrl) return;
    session.ctrl = ctrl;
    ctrl.start();
    return () => {
      session.log = ctrl.snapshot.device.log;
      session.releases = ctrl.snapshot.releases;
      ctrl.stop();
    };
  }, [ctrl]);

  const use = (next: Connection | undefined) => {
    session.conn = next;
    setConn(next);
  };

  if (!conn || !ctrl) {
    return (
      <ConnectScreen
        version={TOOL_VERSION}
        preselect={last}
        pin={pin}
        list={() => listPorts()}
        open={open}
        problem={openProblem}
        onConnected={(target: Target, client, port?: PortInfo) => {
          if (!target.demo) {
            void saveLastPort(env, target.port);
            setLast(target.port);
          }
          setPortLabel(port?.label);
          use(newConnection(target, client, port?.id));
        }}
        onQuit={onQuit}
      />
    );
  }
  return (
    <Shell
      ctrl={ctrl}
      transport={transportOf(conn.port, conn.demo)}
      portLabel={portLabel}
      canSwitchPort
      onSwitchPort={() => {
        conn.close();
        use(undefined);
      }}
      onQuit={onQuit}
      autoTimeSync={timeSync}
      toolVersion={TOOL_VERSION}
    />
  );
}
