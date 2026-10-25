// flash.test.ts: image checks, the regions written (NVS kept), and whole flashes against test/fake-rom.ts.
import { test } from 'bun:test';

import { assert, assertEquals, assertRejects, assertThrows } from './assert.ts';
import {
  APP_OFFSET,
  flashDevice,
  flashRegions,
  inspectImage,
  md5Hex,
  NO_BOOTLOADER,
  partitionTable,
  segments,
} from '../src/flash.ts';
import { OP } from '../src/esp-rom.ts';
import { bootloaderSteps, hardResetSteps } from '../src/reset.ts';
import { appImage, fakeIo, fakeRom, noise } from './fake-rom.ts';

function partition(label: string, type: number, subtype: number, offset: number, size: number): Uint8Array {
  const entry = new Uint8Array(32);
  const view = new DataView(entry.buffer);
  entry.set([0xaa, 0x50, type, subtype]);
  view.setUint32(4, offset, true);
  view.setUint32(8, size, true);
  entry.set(new TextEncoder().encode(label), 12);
  return entry;
}

/** A merged image laid out like the release's (partitions.csv). The NVS area holds zeros, to prove it is skipped. */
function mergedImage(appLength = 100_001): Uint8Array {
  const image = new Uint8Array(APP_OFFSET + appLength).fill(0xff);
  const bootloader = noise(20_000, 3);
  bootloader[0] = 0xe9;
  image.set(bootloader, 0x1000);
  image.set(partition('nvs', 1, 2, 0x9000, 0x5000), 0x8000);
  image.set(partition('otadata', 1, 0, 0xe000, 0x2000), 0x8020);
  image.set(partition('app0', 0, 0x10, 0x10000, 0x300000), 0x8040);
  image.fill(0x00, 0x9000, 0xe000);
  image.set(noise(32, 5), 0xe000);
  image.set(appImage(appLength), APP_OFFSET);
  return image;
}

test('images: merged and app are recognised, a bootloader or junk is refused', () => {
  const merged = mergedImage();
  assertEquals(inspectImage(merged), 'merged');
  assertEquals(inspectImage(appImage(5000)), 'app');
  assertThrows(() => inspectImage(merged.subarray(0x1000, 0x6000)), /not an ESP32 firmware image/); // bootloader.bin
  assertThrows(() => inspectImage(new TextEncoder().encode('<html>404</html>')), /not an ESP32 firmware image/);
  assertThrows(() => inspectImage(new Uint8Array(5 * 1024 * 1024)), /more than the 4 MB flash/);
});

test('the partition table is read from the image', () => {
  assertEquals(partitionTable(mergedImage()).map((p) => `${p.label} ${p.type}/${p.subtype} ${p.offset.toString(16)}`), [
    'nvs 1/2 9000',
    'otadata 1/0 e000',
    'app0 0/16 10000',
  ]);
});

test('regions: a merged image skips 0x0-0x1000 and NVS; an app goes to 0x10000; both padded to 4 bytes', () => {
  const merged = mergedImage(100_001);
  const regions = flashRegions(merged);
  assertEquals(regions.map((r) => [r.offset, r.data.length]), [[0x1000, 0x8000], [0xe000, merged.length - 0xe000 + 3]]);
  assertEquals(regions[1].data.at(-1), 0xff);
  assertEquals(flashRegions(appImage(1001)).map((r) => [r.offset, r.data.length]), [[APP_OFFSET, 1004]]);
});

test('regions: a partition table whose NVS would hide the app, or is not 4 KB aligned, is refused', () => {
  const huge = mergedImage();
  huge.set(partition('nvs', 1, 2, 0x9000, 0x200000), 0x8000); // reaches over the app at 0x10000
  assertThrows(() => flashRegions(huge), /partition table looks wrong: nvs at 0x9000, 0x200000 bytes/);
  const odd = mergedImage();
  odd.set(partition('nvs', 1, 2, 0x9002, 0x5000), 0x8000);
  assertThrows(() => flashRegions(odd), /partition table looks wrong/);
});

test('regions: a merged image padded to 4 MB still leaves hmdata (settings + counters) alone', () => {
  const image = new Uint8Array(4 * 1024 * 1024).fill(0xff); // esptool merge_bin --pad-to-size 4MB
  image.set(mergedImage(), 0);
  image.set(partition('hmdata', 1, 0x06, 0x310000, 0x10000), 0x8060);
  image.set(partition('spiffs', 1, 0x82, 0x320000, 0xd0000), 0x8080);
  assertEquals(flashRegions(image).map((r) => [r.offset, r.offset + r.data.length]), [
    [0x1000, 0x9000],
    [0xe000, 0x310000],
    [0x320000, 0x400000],
  ]);
});

test('segments end on 64 KB boundaries of the flash', () => {
  const parts = segments({ offset: 0xe000, data: new Uint8Array(0x20000) });
  assertEquals(parts.map((s) => [s.offset, s.data.length]), [[0xe000, 0x2000], [0x10000, 0x10000], [0x20000, 0xe000]]);
});

test('bootloader reset: EN low, then IO0 low while EN rises, then IO0 released', () => {
  assertEquals(bootloaderSteps(550), [
    { set: 'dtr', on: false },
    { set: 'rts', on: true },
    { wait: 100 },
    { set: 'dtr', on: true },
    { set: 'rts', on: false },
    { wait: 550 },
    { set: 'dtr', on: false },
  ]);
});

test('flashDevice writes every region, keeps NVS, verifies and resets into the new firmware', async () => {
  const rom = fakeRom();
  rom.flash.fill(0x5a, 0x9000, 0xe000); // the Bluetooth pairing
  const image = mergedImage();
  const { io, modem, bauds } = fakeIo(rom);
  const stages: string[] = [];
  const result = await flashDevice('/dev/ttyUSB0', image, { onProgress: (p) => stages.push(p.stage) }, io);

  assertEquals(result, {
    mac: 'aa:bb:11:22:33:44',
    baud: 460800,
    bytes: 0x8000 + image.length - 0xe000 + 3,
    restarted: true,
  });
  assertEquals(modem, [bootloaderSteps(50), hardResetSteps()]);
  assertEquals(bauds, [460800, 115200, 460800]); // probe the port, back, then switch with the chip
  assertEquals(rom.bauds, [460800]);
  assertEquals(md5Hex(rom.flash.subarray(0x1000, 0x9000)), md5Hex(image.subarray(0x1000, 0x9000)));
  assertEquals(md5Hex(rom.flash.subarray(0xe000, image.length)), md5Hex(image.subarray(0xe000)));
  assert(rom.flash.subarray(0x9000, 0xe000).every((b) => b === 0x5a), 'NVS must be kept');
  assertEquals(stages[0], 'reset');
  assertEquals(stages.at(-1), 'restart');
  assert(stages.includes('write') && stages.includes('verify'));
});

test('flashDevice stays at 115200 when the port cannot switch, and --no-reset leaves the lines alone', async () => {
  const rom = fakeRom();
  const { io, modem } = fakeIo(rom, 460800);
  const notes: string[] = [];
  const result = await flashDevice('/dev/ttyUSB0', appImage(3000), { noReset: true, note: (t) => notes.push(t) }, io);
  assertEquals([result.baud, result.restarted], [115200, false]);
  assertEquals(rom.bauds, []);
  assertEquals(modem, []);
  assert(notes.some((n) => /cannot run at 460800 baud/.test(n)));
});

test('flashDevice: a failed restart after a verified write is not a failed flash', async () => {
  const rom = fakeRom();
  const { io } = fakeIo(rom);
  const modem = io.modem;
  io.modem = (path, steps) => steps.length === 4 ? Promise.reject(new Error('ioctl failed')) : modem(path, steps);
  const notes: string[] = [];
  const result = await flashDevice('/dev/ttyUSB0', appImage(3000), { note: (t) => notes.push(t) }, io);
  assertEquals(result.restarted, false);
  assert(notes.some((n) => /could not restart the board \(ioctl failed\)/.test(n)));
});

test('flashDevice: a port that fails during sync reports the port error, not "no bootloader"', async () => {
  const broken = {
    readable: new ReadableStream<Uint8Array>(),
    write: () => Promise.reject(new Error('Input/output error (os error 5)')),
    close() {},
  };
  const { io } = fakeIo({ host: broken });
  await assertRejects(() => flashDevice('/dev/ttyUSB0', appImage(3000), {}, io), /Input\/output error/);
});

test('flashDevice: a ROM write error stops the flash; no bootloader tries both reset timings', async () => {
  const failing = fakeRom({ failOp: OP.FLASH_DEFL_DATA, error: 0x08 });
  await assertRejects(() => flashDevice('/dev/ttyUSB0', appImage(3000), {}, fakeIo(failing).io), /flash write error/);

  const silent = fakeRom({ silent: true });
  const { io, modem } = fakeIo(silent);
  await assertRejects(() => flashDevice('/dev/ttyUSB0', appImage(3000), {}, io), (err: Error) => {
    assertEquals(err.message, NO_BOOTLOADER);
    return true;
  });
  assertEquals(modem, [bootloaderSteps(50), bootloaderSteps(550)]);
});
