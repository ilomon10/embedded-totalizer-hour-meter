#!/usr/bin/env -S npx tsx
// main.tsx: start the hour-meter TUI.
//
//   npm run tui -- /dev/ttyUSB0        real device (USB or UART adapter)
//   npm run tui -- --demo              simulated device, no hardware needed
//   npm run tui -- /dev/rfcomm0 --pin 1234   over Bluetooth SPP (session is PIN-locked)
//   options: --no-time-sync            do not auto-send the PC clock when the device time is unknown
import React from 'react';
import { render } from 'ink';

import deviceCjs from '../device.js';
import { App, type Client } from './App.js';
import { createDemoDevice } from './demo-device.js';
import { initialState } from './state.js';

const { DeviceClient } = deviceCjs;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const pinIdx = args.indexOf('--pin');
  const pin = pinIdx >= 0 ? args[pinIdx + 1] : process.env.HOUR_METER_PIN;
  const path = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pin') ?? process.env.HOUR_METER_PORT ?? '/dev/ttyUSB0';

  const client = demo ? new DeviceClient(createDemoDevice()) : await DeviceClient.open(path, { readyTimeoutMs: 2500, pin });
  const initial = initialState(demo ? 'simulated' : path, demo);
  if (!args.includes('--no-time-sync')) {
    client.enableAutoTimeSync();  // RTC without battery: device asks, we answer with UTC
  }

  const app = render(<App client={client as unknown as Client} initial={initial} />);
  await app.waitUntilExit();
  client.close();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(`hour-meter TUI: ${err.message}`);
  console.error('Is the device plugged in? Try: npm run tui -- /dev/ttyUSB0   or   npm run tui -- --demo');
  console.error('Over Bluetooth: npm run tui -- /dev/rfcomm0 --pin <PIN>   (BadPin = wrong PIN, Locked = too many tries, wait 60 s)');
  process.exit(1);
});
