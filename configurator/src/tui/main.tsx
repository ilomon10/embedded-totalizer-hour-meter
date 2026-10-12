// main.tsx: start the full-screen configurator + live viewer.
//
//   hour-meter [port | tcp://host:port]      real device (USB, UART adapter) or a TCP bridge
//   hour-meter --demo                        simulated device, no hardware needed
//   hour-meter /dev/rfcomm0 --pin 1234       over Bluetooth SPP (session is PIN-locked)
//   options: --no-time-sync                  do not auto-send the PC clock when the device time is unknown
import { render } from 'ink';

import { connect, connectHelp, DEFAULT_PORT, env, takeFlag, takeOption } from '../cli.ts';
import { hardReset, isLocalSerial } from '../reset.ts';
import { App, type Client } from './App.tsx';
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
  const app = render(
    <App
      client={client as Client}
      initial={initialState(demo.value ? 'simulated' : port, demo.value)}
      hardReset={wired ? () => hardReset(port) : undefined}
      hardResetNote={wired ? undefined : 'Hard reset needs a local USB serial port (not --demo, tcp:// or Bluetooth).'}
    />,
  );
  await app.waitUntilExit();
  client.close();
  return 0;
}
