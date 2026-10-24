// fake-rom.ts: a fake ESP32 ROM bootloader with 4 MB of flash, on the far end of a link pair.
// It answers like the real ROM (4 status bytes, MD5 as 32 hex digits, 8 answers per SYNC) and inflates
// FLASH_DEFL_DATA into its flash, so tests can compare the flash with the image afterwards.
// Also: test images (appImage) and fake system I/O for flashDevice (fakeIo).
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import { blockChecksum, ESP32_MAGIC, OP, SlipDecoder, slipEncode } from '../src/esp-rom.ts';
import type { FlashIo } from '../src/flash.ts';
import { type Link, linkPair } from '../src/links.ts';
import type { Step } from '../src/reset.ts';

export interface FakeRomOptions {
  /** Answer this op with a failure (status 1, `error`). */
  failOp?: number;
  error?: number;
  /** Never answer (no bootloader on the line). */
  silent?: boolean;
  chipMagic?: number;
}

export interface FakeRom {
  host: Link;
  flash: Uint8Array;
  ops: number[];
  bauds: number[];
}

export function fakeRom(options: FakeRomOptions = {}): FakeRom {
  const [host, chip] = linkPair();
  const flash = new Uint8Array(4 * 1024 * 1024).fill(0xff);
  const ops: number[] = [];
  const bauds: number[] = [];
  let defl: { offset: number; blocks: number; chunks: Uint8Array[] } | undefined;
  let sending = Promise.resolve();

  const answer = (op: number, value = 0, data = new Uint8Array(0), status = 0, error = 0) => {
    const packet = new Uint8Array(8 + data.length + 4);
    const view = new DataView(packet.buffer);
    packet[0] = 0x01;
    packet[1] = op;
    view.setUint16(2, data.length + 4, true);
    view.setUint32(4, value, true);
    packet.set(data, 8);
    packet[8 + data.length] = status;
    packet[9 + data.length] = error;
    sending = sending.then(() => chip.write(slipEncode(packet))).catch(() => {});
  };

  const onCommand = (packet: Uint8Array) => {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const op = packet[1];
    const data = packet.subarray(8);
    const arg = (i: number) => new DataView(data.buffer, data.byteOffset).getUint32(i * 4, true);
    ops.push(op);
    if (options.silent) return;
    if (op === options.failOp) return answer(op, 0, undefined, 1, options.error ?? 0x08);
    switch (op) {
      case OP.SYNC:
        for (let i = 0; i < 8; i++) answer(op, 0x20120707);
        return;
      case OP.READ_REG: {
        const regs: Record<number, number> = {
          0x40001000: options.chipMagic ?? ESP32_MAGIC,
          0x3ff5a004: 0x11223344,
          0x3ff5a008: 0x0000aabb,
        };
        return answer(op, regs[arg(0)] ?? 0);
      }
      case OP.SPI_ATTACH:
      case OP.SPI_SET_PARAMS:
        return answer(op);
      case OP.CHANGE_BAUDRATE:
        bauds.push(arg(0));
        return answer(op);
      case OP.FLASH_DEFL_BEGIN: {
        const [eraseSize, blocks, , offset] = [arg(0), arg(1), arg(2), arg(3)];
        flash.fill(0xff, offset, offset + eraseSize);
        defl = { offset, blocks, chunks: [] };
        return answer(op);
      }
      case OP.FLASH_DEFL_DATA: {
        const [size, seq] = [arg(0), arg(1)];
        const block = data.subarray(16, 16 + size);
        if (!defl || seq !== defl.chunks.length) return answer(op, 0, undefined, 1, 0x05);
        if (view.getUint32(4, true) !== blockChecksum(block)) return answer(op, 0, undefined, 1, 0x07);
        defl.chunks.push(block.slice());
        if (defl.chunks.length === defl.blocks) {
          const packed = new Uint8Array(defl.chunks.reduce((n, c) => n + c.length, 0));
          let at = 0;
          for (const c of defl.chunks) {
            packed.set(c, at);
            at += c.length;
          }
          flash.set(inflateSync(packed), defl.offset);
        }
        return answer(op);
      }
      case OP.SPI_FLASH_MD5: {
        const md5 = createHash('md5').update(flash.subarray(arg(0), arg(0) + arg(1))).digest('hex');
        return answer(op, 0, new TextEncoder().encode(md5));
      }
      default:
        return answer(op, 0, undefined, 1, 0x05);
    }
  };

  const slip = new SlipDecoder((packet) => {
    if (packet[0] === 0x00) onCommand(packet);
  });
  void (async () => {
    for await (const bytes of chip.readable) slip.push(bytes);
  })().catch(() => {});
  return { host, flash, ops, bauds };
}

/** Deterministic bytes that do not compress (xorshift). */
export function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** An app image: magic 0xE9 and the app descriptor magic at 0x20. */
export function appImage(length: number): Uint8Array {
  const app = noise(length, 7);
  app[0] = 0xe9;
  app.set([0x32, 0x54, 0xcd, 0xab], 0x20);
  return app;
}

/** System I/O for flashDevice: the fake ROM's link, recorded modem steps and baud changes (`refuse` fails one). */
export function fakeIo(rom: { host: Link }, refuse?: number) {
  const modem: Step[][] = [];
  const bauds: number[] = [];
  const io: FlashIo = {
    open: () => Promise.resolve(rom.host),
    modem: (_path, steps) => {
      modem.push(steps);
      return Promise.resolve();
    },
    setBaud: (_path, baud) => {
      bauds.push(baud);
      return baud === refuse ? Promise.reject(new Error('stty: invalid argument')) : Promise.resolve();
    },
  };
  return { io, modem, bauds };
}
