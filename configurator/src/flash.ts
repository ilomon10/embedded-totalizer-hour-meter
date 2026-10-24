// flash.ts: write a firmware image to the hour meter over USB, through the ESP32 ROM bootloader (esp-rom.ts).
//
//   inspectImage(bytes)        'merged' (a release image, written from 0x0) or 'app' (firmware.bin, at 0x10000)
//   flashRegions(bytes)        what gets written: a merged image without its first 4 KB (padding) and without the
//                              partitions holding the device's own data (NVS: Bluetooth pairing; hmdata: settings
//                              and counters), found in the image's partition table
//   flashDevice(path, bytes)   reset into the bootloader, sync, write (deflate), verify (MD5), reset into the firmware
//
// Only the ESP32's flash is written. Counters and settings live in the EEPROM chip, which flashing never touches
// (firmware.ts still backs them up: a firmware with another EEPROM layout reformats it at boot).
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { CHIP_MAGIC_REG, EspRom, FLASH_BLOCK, ROM_BAUD, RomError } from './esp-rom.ts';
import { type Link, openLink, setBaud } from './links.ts';
import { bootloaderSteps, hardResetSteps, runModemSteps, type Step } from './reset.ts';

export type ImageKind = 'merged' | 'app';

export interface Region {
  offset: number;
  data: Uint8Array;
}

export interface Partition {
  label: string;
  type: number;
  subtype: number;
  offset: number;
  size: number;
}

export const BOOTLOADER_OFFSET = 0x1000;
export const PARTITION_TABLE_OFFSET = 0x8000;
export const APP_OFFSET = 0x10000;
export const FLASH_SIZE = 4 * 1024 * 1024; // ESP32-WROOM-32(E)-N4, the DevKit's module
export const DEFAULT_BAUD = 460800;
export const BAUDS: readonly number[] = [115200, 230400, 460800, 921600];

const IMAGE_MAGIC = 0xe9; // first byte of every ESP32 image (bootloader and app)
const APP_DESC_MAGIC = 0xabcd5432; // esp_app_desc_t, 0x20 bytes into every app image (a bootloader has none)
const PARTITION_MAGIC = 0x50aa; // bytes AA 50 open every partition table entry
const PARTITION_TABLE_SIZE = 0xc00;
const PARTITION_APP = 0x00;
const PARTITION_DATA = 0x01;
const PARTITION_NVS = 0x02;
const SECTOR = 0x1000; // partitions start and end on 4 KB flash sectors
const SEGMENT = 0x10000; // each 64 KB-aligned piece is its own zlib stream, so one data packet never expands far
const RESET_HOLD_MS = [50, 550]; // esptool's two bootloader timings (the second for a slow EN capacitor)

export const NO_BOOTLOADER = "no answer from the ESP32 bootloader. Use the board's USB port: the UART pins and " +
  'Bluetooth cannot reach the bootloader. Without auto-reset: hold BOOT, tap EN, release BOOT, then use --no-reset.';

function isApp(image: Uint8Array, at: number): boolean {
  if (image.length < at + 0x24 || image[at] !== IMAGE_MAGIC) return false;
  return new DataView(image.buffer, image.byteOffset + at + 0x20, 4).getUint32(0, true) === APP_DESC_MAGIC;
}

/** What `image` is: a merged image (bootloader, partition table, app) or an app alone. Throws for anything else. */
export function inspectImage(image: Uint8Array): ImageKind {
  if (image.length > FLASH_SIZE) throw new Error(`the image is ${image.length} bytes, more than the 4 MB flash`);
  if (isApp(image, 0)) return 'app';
  const table = image.length >= PARTITION_TABLE_OFFSET + 2 &&
    image[PARTITION_TABLE_OFFSET] === (PARTITION_MAGIC & 0xff) &&
    image[PARTITION_TABLE_OFFSET + 1] === PARTITION_MAGIC >> 8;
  if (image[BOOTLOADER_OFFSET] === IMAGE_MAGIC && table && isApp(image, APP_OFFSET)) return 'merged';
  throw new Error(
    'not an ESP32 firmware image: expected a merged image (hour-meter-<version>-esp32dev-merged.bin) ' +
      'or an app image (.pio/build/esp32dev/firmware.bin)',
  );
}

/** The partition table inside a merged image: 32-byte entries at 0x8000, each starting AA 50. */
export function partitionTable(image: Uint8Array): Partition[] {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const end = Math.min(image.length, PARTITION_TABLE_OFFSET + PARTITION_TABLE_SIZE);
  const out: Partition[] = [];
  for (let at = PARTITION_TABLE_OFFSET; at + 32 <= end; at += 32) {
    if (view.getUint16(at, true) !== PARTITION_MAGIC) break; // 0xFFFF = end, 0xEBEB = the table's MD5
    out.push({
      label: new TextDecoder().decode(image.subarray(at + 12, at + 28)).replace(/\0.*$/s, ''),
      type: image[at + 2],
      subtype: image[at + 3],
      offset: view.getUint32(at + 4, true),
      size: view.getUint32(at + 8, true),
    });
  }
  return out;
}

/** The image's bytes padded with 0xFF to a multiple of 4 (the ROM writes whole words). */
function pad4(data: Uint8Array): Uint8Array {
  if (data.length % 4 === 0) return data;
  const out = new Uint8Array(data.length + 4 - (data.length % 4)).fill(0xff);
  out.set(data);
  return out;
}

/**
 * Partitions holding this device's own data, never written by an update: NVS (the Bluetooth pairing) and, from
 * firmware 2.6.0, `hmdata` (the flash copy of the settings and counters).
 */
function keptPartitions(table: Partition[]): Partition[] {
  return table.filter((p) => p.type === PARTITION_DATA && (p.subtype === PARTITION_NVS || p.label === 'hmdata'));
}

/** The flash areas to write, in address order: a merged image without 0x0..0x1000 and the kept partitions. */
export function flashRegions(image: Uint8Array): Region[] {
  if (inspectImage(image) === 'app') return [{ offset: APP_OFFSET, data: pad4(image) }];
  const table = partitionTable(image);
  const app = table.find((p) => p.type === PARTITION_APP && p.offset === APP_OFFSET);
  const appEnd = app ? app.offset + app.size : image.length;
  const kept = keptPartitions(table).filter((p) => p.offset < image.length).sort((a, b) => a.offset - b.offset);
  for (const p of kept) {
    // Skipping a corrupt entry could leave the app unwritten while the flash still verifies: refuse instead.
    const overlapsApp = p.offset < appEnd && p.offset + p.size > APP_OFFSET;
    if (p.offset % SECTOR || p.size % SECTOR || p.offset < BOOTLOADER_OFFSET || overlapsApp) {
      throw new Error(
        `the image's partition table looks wrong: ${p.label} at 0x${p.offset.toString(16)}, ` +
          `0x${p.size.toString(16)} bytes (expected 4 KB aligned, outside the app at 0x10000)`,
      );
    }
  }
  const ranges: [number, number][] = [];
  let at = BOOTLOADER_OFFSET;
  for (const p of kept) {
    if (p.offset > at) ranges.push([at, p.offset]);
    at = Math.max(at, p.offset + p.size);
  }
  if (image.length > at) ranges.push([at, image.length]);
  return ranges.map(([from, to]) => ({ offset: from, data: pad4(image.subarray(from, to)) }));
}

/** A region cut at every 64 KB boundary of the flash (aligned erases are the fast ones). */
export function segments(region: Region): Region[] {
  const out: Region[] = [];
  const end = region.offset + region.data.length;
  for (let at = region.offset; at < end;) {
    const next = Math.min(end, (Math.floor(at / SEGMENT) + 1) * SEGMENT);
    out.push({ offset: at, data: region.data.subarray(at - region.offset, next - region.offset) });
    at = next;
  }
  return out;
}

export function md5Hex(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

export interface FlashProgress {
  stage: 'reset' | 'sync' | 'write' | 'verify' | 'restart';
  done: number; // image bytes written so far
  total: number;
}

export interface FlashOptions {
  baud?: number;
  /** The board is already in download mode (BOOT held while EN was tapped): no DTR/RTS reset before or after. */
  noReset?: boolean;
  onProgress?: (progress: FlashProgress) => void;
  /** One-line notes for the user (chip MAC, a slower baud). */
  note?: (text: string) => void;
}

export interface FlashResult {
  mac: string;
  baud: number;
  bytes: number;
  /** false with noReset, or if the final reset failed: the board waits in the bootloader until EN is pressed. */
  restarted: boolean;
}

/** What flashDevice needs from the system. Tests pass fakes. */
export interface FlashIo {
  open(path: string, baud: number): Promise<Link>;
  modem(path: string, steps: Step[]): Promise<void>;
  setBaud(path: string, baud: number): Promise<void>;
}

export const systemIo: FlashIo = {
  open: openLink,
  modem: (path, steps) => runModemSteps(path, steps, 'USB reset'),
  setBaud,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Write `image` to the ESP32 on serial port `path`: reset into the ROM bootloader, write every region, check each
 * with the chip's MD5, then reset into the new firmware. The port must not be open elsewhere (close the
 * DeviceClient first). An interrupted flash is safe to repeat: the bootloader is in ROM.
 */
export async function flashDevice(
  path: string,
  image: Uint8Array,
  options: FlashOptions = {},
  io: FlashIo = systemIo,
): Promise<FlashResult> {
  const regions = flashRegions(image);
  const total = regions.reduce((sum, r) => sum + r.data.length, 0);
  const progress = (stage: FlashProgress['stage'], done = 0) => options.onProgress?.({ stage, done, total });
  const note = options.note ?? (() => {});
  const noReset = options.noReset ?? false;

  const link = await io.open(path, ROM_BAUD);
  try {
    const rom = new EspRom(link);
    await enterBootloader(rom, path, noReset, io, progress);
    const { mac } = await rom.detectChip();
    note(`ESP32 ${mac}`);
    await rom.spiAttach();
    await rom.spiSetParams(FLASH_SIZE);
    const baud = await raiseBaud(rom, path, options.baud ?? DEFAULT_BAUD, io, note);

    let done = 0;
    for (const region of regions) {
      for (const segment of segments(region)) {
        const packed = deflateSync(segment.data); // zlib format, as the ROM expects
        await rom.flashDeflBegin(segment.data.length, packed.length, segment.offset);
        const blocks = Math.ceil(packed.length / FLASH_BLOCK);
        for (let i = 0; i < blocks; i++) {
          await rom.flashDeflData(packed.subarray(i * FLASH_BLOCK, (i + 1) * FLASH_BLOCK), i);
          progress('write', done + Math.floor((segment.data.length * (i + 1)) / blocks));
        }
        done += segment.data.length;
      }
      progress('verify', done);
      if (await rom.flashMd5(region.offset, region.data.length) !== md5Hex(region.data)) {
        throw new Error(
          `verify failed at 0x${region.offset.toString(16)}: the flash reads back different. Flash again.`,
        );
      }
    }
    progress('restart', total);
    if (noReset) return { mac, baud, bytes: total, restarted: false };
    try {
      await io.modem(path, hardResetSteps());
    } catch (err) {
      // Written and verified all the same: only the restart is missing.
      note(`could not restart the board (${(err as Error).message})`);
      return { mac, baud, bytes: total, restarted: false };
    }
    return { mac, baud, bytes: total, restarted: true };
  } finally {
    link.close();
  }
}

async function enterBootloader(
  rom: EspRom,
  path: string,
  noReset: boolean,
  io: FlashIo,
  progress: (stage: FlashProgress['stage']) => void,
): Promise<void> {
  for (const holdMs of noReset ? [undefined] : RESET_HOLD_MS) {
    if (holdMs !== undefined) {
      progress('reset');
      await io.modem(path, bootloaderSteps(holdMs));
    }
    progress('sync');
    try {
      await rom.sync();
      return;
    } catch (err) {
      if (!(err instanceof RomError)) throw err; // the port failed, not the timing
    }
  }
  throw new Error(NO_BOOTLOADER);
}

/** Switch to `baud` if the port can do it, else stay at 115200. Returns the speed in use. */
async function raiseBaud(rom: EspRom, path: string, baud: number, io: FlashIo, note: (text: string) => void) {
  if (baud === ROM_BAUD) return ROM_BAUD;
  try {
    // Ask the port first: once the chip has switched there is no way back but another reset.
    await io.setBaud(path, baud);
    await io.setBaud(path, ROM_BAUD);
  } catch {
    await io.setBaud(path, ROM_BAUD).catch(() => {});
    note(`this serial port cannot run at ${baud} baud: flashing at ${ROM_BAUD}`);
    return ROM_BAUD;
  }
  await rom.changeBaud(baud);
  await io.setBaud(path, baud);
  await sleep(50); // the switch can leave a byte of noise
  rom.flushInput();
  try {
    await rom.readReg(CHIP_MAGIC_REG);
  } catch {
    throw new Error(`the bootloader stopped answering at ${baud} baud: try --baud ${ROM_BAUD}`);
  }
  return baud;
}
