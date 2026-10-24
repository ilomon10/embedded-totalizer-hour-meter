// main.tsx: start the full-screen configurator + live viewer.
//
//   hour-meter [port | tcp://host:port]      real device (USB, UART adapter) or a TCP bridge
//   hour-meter --demo                        simulated device, no hardware needed
//   hour-meter /dev/rfcomm0 --pin 1234       over Bluetooth SPP (session is PIN-locked)
//   options: --no-time-sync                  do not auto-send the PC clock when the device time is unknown
import { render } from 'ink';

import { connect, connectHelp, DEFAULT_PORT, env, takeFlag, takeOption } from '../cli.ts';
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
import { listFirmware } from '../releases.ts';
import { hardReset, isLocalSerial } from '../reset.ts';
import { App, type Client } from './App.tsx';
import type { FirmwareActions } from './FirmwareView.tsx';
import { initialState } from './state.ts';

export async function run(argv: string[]): Promise<number> {
  const pin = takeOption(argv, '--pin');
  const demo = takeFlag(pin.rest, '--demo');
  const noSync = takeFlag(demo.rest, '--no-time-sync');
  const port = noSync.rest.find((a) => !a.startsWith('--')) ?? env('HOUR_METER_PORT') ?? DEFAULT_PORT;

  const client = await connect({ demo: demo.value, port, pin: pin.value ?? env('HOUR_METER_PIN') }, 2500)
    .catch((err) => {
      throw new Error(`${(err as Error).message}\n${connectHelp()}`);
    });
  if (!noSync.value) client.enableAutoTimeSync(); // RTC without battery: device asks, we answer with UTC

  const wired = isLocalSerial(port, demo.value) && Deno.build.os !== 'windows';
  const session = { client }; // a firmware update replaces the client: close the one open at the end
  const app = render(
    <App
      client={client as Client}
      initial={initialState(demo.value ? 'simulated' : port, demo.value)}
      hardReset={wired ? () => hardReset(port) : undefined}
      hardResetNote={wired ? undefined : 'Hard reset needs a local USB serial port (not --demo, tcp:// or Bluetooth).'}
      firmware={firmwareActions(session, port, demo.value, !noSync.value)}
    />,
    { exitOnCtrlC: false }, // App handles Ctrl+C: it must not cut a firmware update short
  );
  await app.waitUntilExit();
  session.client.close();
  return 0;
}

/**
 * Tab 6's work. A flash backs up first, closes the open client (the flasher needs the port) and ends with a new
 * client on the same port, which goes into `session`.
 */
function firmwareActions(
  session: { client: DeviceClient },
  port: string,
  demo: boolean,
  timeSync: boolean,
): FirmwareActions {
  const github = { token: env('GITHUB_TOKEN') };
  const problem = flashPortProblem({ demo, port });
  const reopen = async () => {
    const dev = await connect({ demo: false, port }, REOPEN_READY_MS);
    if (timeSync) dev.enableAutoTimeSync();
    return dev;
  };
  return {
    list: () => listFirmware(github),
    image: (release) => releaseImage(release, github),
    file: (path) => fileImage(path.replace(/^~(?=\/)/, env('HOME') ?? '~')),
    flashNote: problem && `${problem[0].toUpperCase()}${problem.slice(1)}.`,
    flash: problem ? undefined : async (image, onProgress, note) => {
      const before = await snapshot(session.client).catch(() => undefined);
      if (!before) note({ level: 'warn', text: 'the device does not answer: no backup (flashing still works)' });
      else {
        await saveBackup(before).then(
          (file) => note({ level: 'info', text: `backup: ${file}` }),
          (err) => note({ level: 'warn', text: `backup not saved (${(err as Error).message}); kept in memory` }),
        );
      }
      session.client.close();
      const { dev, ok } = await updateDevice({ port, image, onProgress, note, reopen }, before);
      if (dev) session.client = dev;
      return { client: dev as Client | undefined, ok };
    },
  };
}
