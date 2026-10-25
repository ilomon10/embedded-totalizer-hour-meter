// main.tsx: start the full-screen configurator + live viewer.
//
//   hour-meter                               connect screen: pick a port, type one, or the demo
//   hour-meter [port | tcp://host:port]      straight to that port (waits for it if it is not there yet)
//   hour-meter --demo                        simulated device, no hardware needed
//   hour-meter /dev/rfcomm0 --pin 1234       over Bluetooth SPP (session is PIN-locked)
//   options: --no-time-sync                  do not auto-send the PC clock when the device time is unknown
//
// The device is held by a Connection (connection.ts): an unplugged board is waited for and reconnected, and
// `p` in the TUI goes back to the connect screen.
import { useMemo, useState } from 'react';
import { render, useApp } from 'ink';

import { connect, env, takeFlag, takeOption, type Target } from '../cli.ts';
import { Connection } from '../connection.ts';
import type { DeviceClient } from '../device.ts';
import {
  fileImage,
  flashPortProblem,
  releaseImage,
  REOPEN_READY_MS,
  saveBackup,
  snapshot,
  updateDevice,
} from '../firmware.ts';
import { OS } from '../platform.ts';
import { listPorts, loadLastPort, openProblem, type PortInfo, saveLastPort } from '../ports.ts';
import { listFirmware } from '../releases.ts';
import { hardReset, isLocalSerial } from '../reset.ts';
import { TOOL_VERSION } from '../version.ts';
import { App } from './App.tsx';
import { ConnectView } from './ConnectView.tsx';
import type { FirmwareActions } from './FirmwareView.tsx';
import { initialState } from './state.ts';

const READY_MS = 2500; // the first frame after opening (an ESP32 board restarts when its port opens)

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
  const start = demo.value || port
    ? newConnection({ demo: demo.value, port: demo.value ? 'demo' : port!, pin: pinValue }).start()
    : undefined;
  const preselect = await loadLastPort(env) ?? env('HOUR_METER_PORT');

  const session: { conn?: Connection } = { conn: start }; // closed at the end
  const app = render(
    <Root
      start={start}
      preselect={preselect}
      pin={pinValue}
      open={open}
      newConnection={newConnection}
      onConnection={(conn) => (session.conn = conn)}
    />,
    { exitOnCtrlC: false }, // App handles Ctrl+C: it must not cut a firmware update short
  );
  await app.waitUntilExit();
  session.conn?.close();
  return 0;
}

/** The connect screen until a port is open, then the configurator; `p` there comes back here. */
function Root({ start, preselect, pin, open, newConnection, onConnection }: {
  start?: Connection;
  preselect?: string;
  pin?: string;
  open: (target: Target) => Promise<DeviceClient>;
  newConnection: (target: Target, client?: DeviceClient, portId?: string) => Connection;
  onConnection: (conn: Connection | undefined) => void;
}) {
  const { exit } = useApp();
  const [conn, setConn] = useState(start);
  const [last, setLast] = useState(preselect);
  const firmware = useMemo(() => conn && firmwareActions(conn), [conn]);

  const use = (next: Connection | undefined) => {
    onConnection(next);
    setConn(next);
  };

  if (!conn || !firmware) {
    return (
      <ConnectView
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
          use(newConnection(target, client, port?.id));
        }}
        onQuit={exit}
      />
    );
  }
  const wired = isLocalSerial(conn.port, conn.demo) && OS !== 'windows';
  return (
    <App
      conn={conn}
      initial={initialState(conn.demo ? 'simulated' : conn.port, conn.demo)}
      hardReset={wired ? () => hardReset(conn.port) : undefined}
      hardResetNote={wired
        ? undefined
        : 'Hard reset needs a local USB serial port (not the demo, tcp:// or Bluetooth).'}
      firmware={firmware}
      onSwitchPort={() => {
        conn.close();
        use(undefined);
      }}
    />
  );
}

/**
 * Tab 6's work. A flash backs up first, pauses the connection (the flasher needs the port), and gives the
 * connection the new client afterwards (or lets it reconnect).
 */
function firmwareActions(conn: Connection): FirmwareActions {
  const github = { token: env('GITHUB_TOKEN') };
  const problem = flashPortProblem({ demo: conn.demo, port: conn.port });
  // No time sync on this client: the connection turns it on when it takes the client back.
  const reopen = () => connect({ demo: false, port: conn.port }, REOPEN_READY_MS);
  return {
    list: () => listFirmware(github),
    image: (release) => releaseImage(release, github),
    file: (path) => fileImage(path.replace(/^~(?=\/)/, env('HOME') ?? '~')),
    flashNote: problem && `${problem[0].toUpperCase()}${problem.slice(1)}.`,
    flash: problem ? undefined : async (image, onProgress, note) => {
      const before = conn.client && await snapshot(conn.client).catch(() => undefined);
      if (!before) note({ level: 'warn', text: 'the device does not answer: no backup (flashing still works)' });
      else {
        await saveBackup(before).then(
          (file) => note({ level: 'info', text: `backup: ${file}` }),
          (err) => note({ level: 'warn', text: `backup not saved (${(err as Error).message}); kept in memory` }),
        );
      }
      await conn.pause(); // also waits for a reconnect that is opening the port right now
      const { dev, ok } = await updateDevice({ port: conn.port, image, onProgress, note, reopen }, before);
      conn.resume(dev);
      return { ok };
    },
  };
}
