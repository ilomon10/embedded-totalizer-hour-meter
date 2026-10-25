// tui-render.test.tsx: the OpenTUI screens drawn by OpenTUI's test renderer against the demo device: the frame, the
// menu, a screen change, a dialog that refuses an empty value, the narrow layout, the connect screen, and a firmware
// update's checklist through test/fake-rom.ts.
import { test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';

import { assert, assertMatch } from './assert.ts';
import { appImage, fakeIo, fakeRom, type FakeRomOptions } from './fake-rom.ts';
import { connect } from '../src/cli.ts';
import { Connection } from '../src/connection.ts';
import { createDemoLink } from '../src/demo.ts';
import { DeviceClient } from '../src/device.ts';
import { OP } from '../src/esp-rom.ts';
import { TuiController } from '../src/tui/controller.ts';
import { type FirmwareActions, firmwareActions } from '../src/tui/firmware-actions.ts';
import { ConnectScreen } from '../src/tui/screens/connect.tsx';
import { SCREEN_HELP, Shell } from '../src/tui/shell.tsx';
import { initialState } from '../src/tui/state.ts';

// The screens update from a live device, outside React's act(): let React schedule those updates as it does in the
// app (testRender turns act mode on).
const liveUpdates = () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
};

/** The frame once `match` holds. React commits a key's update on a later macrotask and the demo device sends on its
 * own timers, while OpenTUI's waitForFrame stops as soon as nothing is queued, so this polls in real time. */
async function frameWith(s: TestRendererSetup, match: (frame: string) => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let frame = '';
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await s.renderOnce();
    frame = s.captureCharFrame();
    if (match(frame)) return frame;
  }
  throw new Error(`no matching frame after ${timeoutMs} ms; the last one:\n${frame}`);
}

/** A temporary cache folder (commission progress, report fields, backups) in place of the user's. */
async function tempCache() {
  const dir = await mkdtemp(join(tmpdir(), 'hour-meter-tui-'));
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  const restore = async () => {
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, restore };
}

const offline: FirmwareActions = {
  list: () => Promise.resolve([]),
  image: () => Promise.reject(new Error('offline')),
  file: () => Promise.reject(new Error('offline')),
  flashNote: 'Flashing needs the real board on its USB port, not --demo.',
};

async function demoShell(width: number, height: number) {
  const cache = await tempCache();
  const conn = new Connection({ target: { demo: true, port: 'demo' }, open: (t) => connect(t, 1000) }).start();
  const ctrl = new TuiController({ conn, initial: initialState('simulated', true), firmware: offline });
  ctrl.start();
  const setup = await testRender(
    <Shell
      ctrl={ctrl}
      transport="demo"
      canSwitchPort
      onSwitchPort={() => {}}
      onQuit={() => {}}
      autoTimeSync
      toolVersion="2.0.0"
    />,
    { width, height },
  );
  liveUpdates();
  const close = async () => {
    setup.renderer.destroy();
    ctrl.stop();
    conn.close();
    await cache.restore();
  };
  return { ...setup, ctrl, close };
}

test('the shell at 100×30: header, grouped menu, Overview with the counters and the problems', async () => {
  const s = await demoShell(100, 30);
  try {
    const frame = await frameWith(s, (f) => f.includes('1250.') && f.includes('NEEDS ATTENTION'));
    assertMatch(frame, /HOUR METER │ 1A2B3C4D │ fw 2\.6\.0/);
    for (const text of [
      'MAINTAIN',
      'SET UP',
      'SERVICE',
      '▸1 Overview',
      '9 Firmware',
      '▲ IMU not calibrated',
      '→ 7 Calibrate',
    ]) {
      assert(frame.includes(text), `missing "${text}"`);
    }
    await s.mockInput.typeText('?');
    await frameWith(s, (f) => f.includes('─ Keys ─') && f.includes('any key closes'));
    await s.mockInput.typeText('x'); // closes the help, and does nothing else
    await frameWith(s, (f) => !f.includes('─ Keys ─'));
    await s.mockInput.typeText('6');
    const settings = await frameWith(s, (f) => f.includes('ENGINE DETECTION'));
    assertMatch(settings, /Input debounce\s+200 ms\s+default 200 ms/);
    assert(settings.includes('▸6 Settings'));
  } finally {
    await s.close();
  }
});

test('Counters: the dialog shows now → new, and an empty value cannot be applied', async () => {
  const s = await demoShell(100, 30);
  try {
    await frameWith(s, (f) => f.includes('1250.'));
    await s.mockInput.typeText('2');
    await frameWith(s, (f) => f.includes('Set hour meter…'));
    s.mockInput.pressEnter();
    await frameWith(s, (f) => f.includes('─ Set hour meter ─'));
    s.mockInput.pressEnter(); // nothing typed
    const refused = await frameWith(s, (f) => f.includes('enter the new value in hours'));
    assert(refused.includes('Now        1250.'));
    await s.mockInput.typeText('1310.5');
    const typed = await frameWith(s, (f) => f.includes('→ 1310.50 h'));
    assertMatch(typed, /Change\s+\+\d+\.\d\d h/);
  } finally {
    await s.close();
  }
});

test('80×24: the menu folds into one tab line', async () => {
  const s = await demoShell(80, 24);
  try {
    const frame = await frameWith(s, (f) => f.includes('1250.'));
    assertMatch(frame, /1 Overview 2 Count 3 Report 4 Comm 5 Live/);
    assert(!frame.includes('MAINTAIN'), 'no sidebar below 100 columns');
  } finally {
    await s.close();
  }
});

test('5 Live inputs: the vibration RMS over time with its threshold, and the attitude as gauges', async () => {
  const s = await demoShell(100, 30);
  try {
    await frameWith(s, (f) => f.includes('1250.'));
    assert((await s.ctrl.applySettings([{ name: 'runVibMinMg', from: 0, to: 30 }])).ok, 'threshold set');
    await s.mockInput.typeText('5');
    const frame = await frameWith(
      s,
      (f) => f.includes('VIBRATION RMS') && /min \d+ · avg \d+ · max \d+ mg/.test(f) && f.includes('roll '),
    );
    assert(!frame.includes('undefined'), 'nothing reads "undefined"');
    assertMatch(frame, /\s30┤/); // the threshold on the y axis
    assertMatch(frame, /\s0┤/);
    assertMatch(frame, /2 min ago\s+1 min ago\s+now/);
    assert(frame.includes('on: counts above 30 mg'));
    assertMatch(frame, /ATTITUDE/);
    assertMatch(frame, /roll -?\d+\.\d° +pitch -?\d+\.\d° +\d+\.\d° [NESW]{1,2}/);
    assert(/[\u2801-\u28ff]/.test(frame), 'braille dots');
    await s.mockInput.typeText('+');
    await frameWith(s, (f) => /1 min ago\s+30 s ago\s+now/.test(f) && /1 min: min/.test(f));
  } finally {
    await s.close();
  }
});

test('5 Live inputs at 80×24: the chart keeps its rows, the attitude is one line', async () => {
  const s = await demoShell(80, 24);
  try {
    await frameWith(s, (f) => f.includes('1250.'));
    await s.mockInput.typeText('5');
    const frame = await frameWith(s, (f) => /ATTITUDE {2}roll/.test(f) && f.includes('0┤'));
    assert(!frame.includes('undefined'));
    assert(!frame.includes('⣠⠴'), 'no gauges here');
  } finally {
    await s.close();
  }
});

test('a key typed right after a screen change goes to the new screen, not the old one', async () => {
  const s = await demoShell(100, 30);
  try {
    await frameWith(s, (f) => f.includes('▲ IMU not calibrated')); // Overview: Enter would open 7 Calibrate
    s.renderer.stdin.emit('data', Buffer.from('2\r')); // one read: 2 Counters, then Enter
    const frame = await frameWith(s, (f) => f.includes('─ Set hour meter ─'));
    assert(frame.includes('▸2 Counters'), 'Enter went to Counters');
  } finally {
    await s.close();
  }
});

test('4 Commission: Space ticks or unticks a module, Enter goes on; fast keys act in order', async () => {
  const s = await demoShell(100, 30);
  try {
    await frameWith(s, (f) => f.includes('1250.'));
    await s.mockInput.typeText('4');
    await frameWith(s, (f) => f.includes('IDENTIFY DEVICE'));
    s.mockInput.pressArrow('down');
    const modules = await frameWith(s, (f) => f.includes('MODULES & STORAGE') && f.includes('[x] RTC'));
    assert(modules.includes('Space tick or untick'), 'Space ticks');
    assert(!/Enter tick/.test(modules), 'Enter has one meaning');
    // → and Space in one read, before the screen draws again: Space unticks RTC, where the cursor went.
    s.renderer.stdin.emit('data', Buffer.from('\x1b[C '));
    const unticked = await frameWith(s, (f) => f.includes('[ ] RTC'));
    assert(unticked.includes('[x] EEPROM'), 'the module the cursor left stays ticked');
    assert(unticked.includes('MODULES & STORAGE'), 'Space does not leave the step');
    s.mockInput.pressEnter(); // the step passed: next
    await frameWith(s, (f) => f.includes('ENGINE INPUT'));
  } finally {
    await s.close();
  }
});

test('6 Settings: a change waits with its old value; z undoes it', async () => {
  const s = await demoShell(100, 30);
  try {
    await frameWith(s, (f) => f.includes('1250.'));
    await s.mockInput.typeText('6');
    await frameWith(s, (f) => f.includes('ENGINE DETECTION'));
    s.mockInput.pressArrow('down'); // Input debounce
    s.mockInput.pressEnter();
    s.mockInput.pressKey('u', { ctrl: true }); // clear the field
    await s.mockInput.typeText('300');
    s.mockInput.pressEnter();
    await frameWith(s, (f) => /Input debounce\s+300 ms\s+• was 200/.test(f));
    await s.mockInput.typeText('z');
    await frameWith(s, (f) => /Input debounce\s+200 ms/.test(f) && !f.includes('• was'));
  } finally {
    await s.close();
  }
});

test('the palette works on the screen you are on, and its pick does not fire again on a later visit', async () => {
  const s = await demoShell(100, 30);
  try {
    await frameWith(s, (f) => f.includes('1250.'));
    await s.mockInput.typeText('6');
    await frameWith(s, (f) => f.includes('ENGINE DETECTION'));
    await s.mockInput.typeText(':');
    await frameWith(s, (f) => f.includes('─ Go to or do… ─'));
    await s.mockInput.typeText('gyro filter');
    s.mockInput.pressEnter();
    await frameWith(s, (f) => /▸ Gyro filter/.test(f));
    await s.mockInput.typeText('1');
    await frameWith(s, (f) => f.includes('NEEDS ATTENTION'));
    await s.mockInput.typeText('6');
    const again = await frameWith(s, (f) => f.includes('ENGINE DETECTION'));
    assert(!/▸ Gyro filter/.test(again), 'Settings opens at the top again');
  } finally {
    await s.close();
  }
});

test("the help (?) fits each screen's keys: a key in 10 columns, what it does in 20", () => {
  for (const [screen, rows] of Object.entries(SCREEN_HELP)) {
    for (const [key, text] of rows) assert(key.length <= 10 && text.length <= 20, `${screen}: "${key}" "${text}"`);
  }
});

test('the connect screen lists the ports and marks an ESP32 board', async () => {
  const ports = [
    {
      path: '/dev/ttyUSB0',
      label: 'Silicon Labs CP2102 USB to UART Bridge Controller',
      kind: 'usb' as const,
      boardLike: true,
    },
  ];
  const s = await testRender(
    <ConnectScreen
      version="2.0.0"
      list={() => Promise.resolve(ports)}
      open={() => Promise.reject(new Error('not in this test'))}
      problem={() => Promise.resolve('')}
      onConnected={() => {}}
      onQuit={() => {}}
    />,
    { width: 100, height: 24 },
  );
  liveUpdates();
  try {
    const frame = await frameWith(s, (f) => f.includes('/dev/ttyUSB0'));
    assertMatch(frame, /▸ \/dev\/ttyUSB0\s+Silicon Labs CP2102 .* · ESP32 board/);
    assert(frame.includes('Demo device'));
    assert(frame.includes('configurator 2.0.0'));
  } finally {
    s.renderer.destroy();
  }
});

/** The TUI on a board's USB port: the demo device answers there, the fake ROM behind its bootloader. The backup goes
 * to a temporary cache folder. */
async function boardShell(rom: FakeRomOptions = {}) {
  const cache = await tempCache();
  const image = join(cache.dir, 'firmware.bin');
  await writeFile(image, appImage(40_000));
  const open = () => DeviceClient.connect(createDemoLink(), { readyTimeoutMs: 500 });
  const conn = new Connection({ target: { demo: false, port: '/dev/ttyUSB0' }, open }).start();
  const firmware: FirmwareActions = {
    ...firmwareActions(conn, { io: fakeIo(fakeRom(rom)).io, reopen: open }),
    list: () => Promise.resolve([]),
  };
  const ctrl = new TuiController({ conn, initial: initialState('/dev/ttyUSB0', false), firmware, releases: [] });
  ctrl.start();
  const setup = await testRender(
    <Shell
      ctrl={ctrl}
      transport="serial"
      canSwitchPort
      onSwitchPort={() => {}}
      onQuit={() => {}}
      autoTimeSync
      toolVersion="2.0.0"
    />,
    { width: 100, height: 30 },
  );
  liveUpdates();
  /** 9 Firmware → f → the image → FLASH. */
  const flashFile = async () => {
    await frameWith(setup, (f) => f.includes('1250.'));
    await setup.mockInput.typeText('9');
    await frameWith(setup, (f) => f.includes('ON THE DEVICE'));
    await setup.mockInput.typeText('f');
    await frameWith(setup, (f) => f.includes('─ Flash a file ─'));
    await setup.mockInput.typeText(image);
    setup.mockInput.pressEnter();
    await frameWith(setup, (f) => f.includes('Type FLASH to start'));
    await setup.mockInput.typeText('FLASH');
    setup.mockInput.pressEnter();
  };
  const close = async () => {
    setup.renderer.destroy();
    ctrl.stop();
    conn.close();
    await cache.restore();
  };
  return { ...setup, flashFile, close };
}

test('9 Firmware: an update ticks off the checklist, then Enter goes back to the list', async () => {
  const s = await boardShell();
  try {
    await s.flashFile();
    const done = await frameWith(s, (f) => f.includes('Done.'), 15_000);
    for (const row of [
      /✔ Back up\s+counters \+ \d+ settings → /,
      /✔ Enter bootloader\s+ESP32 aa:bb:11:22:33:44/,
      /✔ Write/,
      /✔ Verify\s+39 KB verified/,
      /✔ Restart & reconnect\s+reconnected/,
      /✔ Check & restore\s+runs \d+\.\d+\.\d+, nothing lost/,
    ]) {
      assertMatch(done, row);
    }
    s.mockInput.pressEnter();
    await frameWith(s, (f) => f.includes('ON THE DEVICE'));
    await s.mockInput.typeText('0'); // the log: the device is read again once the update is done
    const log = await frameWith(
      s,
      (f) =>
        f.lastIndexOf('read settings, status, counters, calibration') > f.indexOf('firmware update done') &&
        f.includes('firmware update done'),
    );
    assert(!log.includes('a firmware update is running'), 'nothing was sent while the flasher had the port');
  } finally {
    await s.close();
  }
});

test('9 Firmware: a failed update says why in full, and the other screens work again', async () => {
  const s = await boardShell({ failOp: OP.FLASH_DEFL_BEGIN });
  try {
    await s.flashFile();
    const failed = await frameWith(s, (f) => f.includes('did not finish'), 15_000);
    assertMatch(failed, /✔ Enter bootloader\s+ESP32 /); // the chip answered: the write failed, not the bootloader
    const lines = failed.split('\n');
    const row = lines.findIndex((l) => l.includes('✖ Write'));
    assertMatch(lines[row], /✖ Write\s+flash failed: flash defl begin failed: flash write/);
    assertMatch(lines[row + 1], /\s{20}error\s+│$/); // wrapped under the step, not cut off
    assertMatch(failed, /Check & restore\s+skipped: the flash did not finish/);
    assert(!failed.includes('✖ flash failed'), 'the reason is not repeated under the checklist');
    await s.mockInput.typeText('1'); // the checklist keeps Enter and Esc only
    await frameWith(s, (f) => f.includes('NEEDS ATTENTION'));
  } finally {
    await s.close();
  }
});
