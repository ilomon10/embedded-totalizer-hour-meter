// esp-rom.ts: talk to the ESP32's ROM serial bootloader (the protocol esptool speaks), over any Link.
//
//   const rom = new EspRom(link);   // after a reset into download mode (reset.ts bootloaderSteps)
//   await rom.sync();
//   await rom.detectChip();         // classic ESP32 only
//   await rom.flashDeflBegin(size, packed.length, offset); await rom.flashDeflData(block, seq); ...
//   await rom.flashMd5(offset, size);
//
// Packets are SLIP-framed: 0xC0 ... 0xC0, with 0xDB 0xDC for 0xC0 and 0xDB 0xDD for 0xDB inside.
//   command   [0x00, op, size u16, checksum u32, data...]
//   answer    [0x01, op, size u16, value u32, data...]; the ESP32 ROM ends data with 4 status bytes (status, error)
// Only the ROM loader is used (no flasher stub), so nothing third-party is uploaded to the chip.
// Pure protocol over a Link (no FFI): test/esp-rom.test.ts runs it against a fake loader (test/fake-rom.ts).
import type { Link } from './links.ts';

export const OP = Object.freeze({
  SYNC: 0x08,
  READ_REG: 0x0a,
  SPI_SET_PARAMS: 0x0b,
  SPI_ATTACH: 0x0d,
  CHANGE_BAUDRATE: 0x0f,
  FLASH_DEFL_BEGIN: 0x10,
  FLASH_DEFL_DATA: 0x11,
  SPI_FLASH_MD5: 0x13,
});

/** The error byte of a failed command (esptool docs, "Serial Protocol"). */
export const ROM_ERRORS: Readonly<Record<number, string>> = Object.freeze({
  0x05: 'invalid message',
  0x06: 'failed to act on the message',
  0x07: 'bad checksum',
  0x08: 'flash write error',
  0x09: 'flash read error',
  0x0a: 'flash read length error',
  0x0b: 'deflate error',
});

export const ROM_BAUD = 115200; // the ROM always starts at 115200
export const FLASH_BLOCK = 0x400; // compressed bytes per FLASH_DEFL_DATA for the ROM loader
export const CHIP_MAGIC_REG = 0x40001000;
export const ESP32_MAGIC = 0x00f01d83;
const EFUSE_MAC_LOW = 0x3ff5a004;
const EFUSE_MAC_HIGH = 0x3ff5a008;

const DEFAULT_TIMEOUT_MS = 3000;
const SYNC_TIMEOUT_MS = 100;
const ERASE_MIN_MS = 10000; // a few sector erases can take seconds on a slow flash chip
// esptool's timeouts per MB: erase 30 s, erase+write 40 s, MD5 8 s.
const ERASE_MS_PER_MB = 30000;
const WRITE_MS_PER_MB = 40000;
const MD5_MS_PER_MB = 8000;

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;
const MAX_PACKET = 4096; // the ROM's answers are tiny: anything longer is noise without an END

/** The bootloader answered with a failure, or not at all. A failing port throws a plain Error instead. */
export class RomError extends Error {}

/** The bootloader did not answer in time. */
export class RomTimeout extends RomError {}

export interface RomAnswer {
  op: number;
  value: number;
  data: Uint8Array;
}

/** One SLIP frame: END, the packet with END and ESC escaped, END. */
export function slipEncode(packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(packet.length * 2 + 2);
  let n = 0;
  out[n++] = SLIP_END;
  for (const b of packet) {
    if (b === SLIP_END) {
      out[n++] = SLIP_ESC;
      out[n++] = SLIP_ESC_END;
    } else if (b === SLIP_ESC) {
      out[n++] = SLIP_ESC;
      out[n++] = SLIP_ESC_ESC;
    } else {
      out[n++] = b;
    }
  }
  out[n++] = SLIP_END;
  return out.slice(0, n);
}

/** Bytes -> SLIP packets. Bytes between packets (boot messages, the firmware's frames) are ignored. */
export class SlipDecoder {
  private packet: number[] | undefined; // undefined = between packets
  private escaped = false;

  constructor(private readonly onPacket: (packet: Uint8Array) => void) {}

  reset(): void {
    this.packet = undefined;
    this.escaped = false;
  }

  push(bytes: Uint8Array): void {
    for (const b of bytes) {
      if (this.packet === undefined) {
        if (b === SLIP_END) this.packet = [];
        continue;
      }
      if (b === SLIP_END) {
        if (this.packet.length === 0) continue; // END END: the second END opens the packet
        const packet = Uint8Array.from(this.packet);
        this.reset();
        this.onPacket(packet);
      } else if (this.escaped) {
        this.escaped = false;
        if (b === SLIP_ESC_END) this.packet.push(SLIP_END);
        else if (b === SLIP_ESC_ESC) this.packet.push(SLIP_ESC);
        else this.reset(); // invalid escape: drop the packet
      } else if (b === SLIP_ESC) {
        this.escaped = true;
      } else if (this.packet.length < MAX_PACKET) {
        this.packet.push(b);
      } else {
        this.reset();
      }
    }
  }
}

/** A command packet, before SLIP framing. */
export function commandPacket(op: number, data: Uint8Array, checksum = 0): Uint8Array {
  const packet = new Uint8Array(8 + data.length);
  const view = new DataView(packet.buffer);
  packet[1] = op;
  view.setUint16(2, data.length, true);
  view.setUint32(4, checksum, true);
  packet.set(data, 8);
  return packet;
}

/** An answer packet (direction byte 0x01), or undefined for anything else. */
export function parseAnswer(packet: Uint8Array): RomAnswer | undefined {
  if (packet.length < 8 || packet[0] !== 0x01) return undefined;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const size = view.getUint16(2, true);
  if (packet.length < 8 + size) return undefined;
  return { op: packet[1], value: view.getUint32(4, true), data: packet.subarray(8, 8 + size) };
}

/** Checksum of a data block: XOR of every byte, seeded with 0xEF. */
export function blockChecksum(data: Uint8Array): number {
  let x = 0xef;
  for (const b of data) x ^= b;
  return x;
}

/** Little-endian u32 words, the argument format of every command. */
export function u32le(...words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w >>> 0, true));
  return out;
}

function timeoutFor(msPerMb: number, bytes: number, minMs = DEFAULT_TIMEOUT_MS): number {
  return Math.max(minMs, Math.ceil((msPerMb * bytes) / 1e6));
}

function opName(op: number): string {
  const name = Object.entries(OP).find(([, code]) => code === op)?.[0];
  return name ? name.toLowerCase().replaceAll('_', ' ') : `command 0x${op.toString(16)}`;
}

/** Strip the status bytes; throw if they report a failure. */
function checkStatus(op: number, answer: RomAnswer): RomAnswer {
  const size = answer.data.length >= 4 ? 4 : 2; // ESP32 ROM: 4 status bytes (newer ROMs and stubs: 2)
  if (answer.data.length < size) throw new RomError(`${opName(op)}: short answer from the bootloader`);
  const at = answer.data.length - size;
  const status = answer.data[at];
  const error = answer.data[at + 1];
  if (status !== 0) {
    throw new RomError(`${opName(op)} failed: ${ROM_ERRORS[error] ?? `error 0x${error.toString(16)}`}`);
  }
  return { ...answer, data: answer.data.subarray(0, at) };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The ROM bootloader on the far end of `link`. One command at a time. */
export class EspRom {
  private readonly answers: RomAnswer[] = [];
  private readonly slip = new SlipDecoder((packet) => this.onPacket(packet));
  private wake: (() => void) | undefined;
  private closed = false;
  private deflSize = 0; // bytes the current FLASH_DEFL_BEGIN writes at most: bounds each data packet's work

  constructor(private readonly link: Link) {
    void this.pump();
  }

  /** Forget everything received so far (boot messages, late answers). */
  flushInput(): void {
    this.answers.length = 0;
    this.slip.reset();
  }

  /** Send one command and resolve with its answer (status stripped). Throws RomError on a failure or no answer. */
  async command(
    op: number,
    data: Uint8Array = new Uint8Array(0),
    { checksum = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
  ): Promise<RomAnswer> {
    const deadline = Date.now() + timeoutMs;
    await this.send(op, slipEncode(commandPacket(op, data, checksum)), timeoutMs);
    for (;;) {
      const answer = await this.nextAnswer(deadline - Date.now());
      if (!answer) throw new RomTimeout(`${opName(op)}: no answer from the bootloader within ${timeoutMs} ms`);
      if (answer.op !== op) continue; // a late answer to an earlier command (one SYNC gets up to 8)
      return checkStatus(op, answer);
    }
  }

  /** Wake the loader up after the reset into download mode. Throws RomTimeout if it never answers. */
  async sync(attempts = 7): Promise<void> {
    const data = new Uint8Array(36).fill(0x55);
    data.set([0x07, 0x07, 0x12, 0x20]);
    for (let i = 0; i < attempts; i++) {
      this.flushInput();
      try {
        await this.command(OP.SYNC, data, { timeoutMs: SYNC_TIMEOUT_MS });
      } catch (err) {
        if (err instanceof RomError) continue; // still booting, or noise on the line: again
        throw err; // the port itself failed: say so
      }
      await sleep(SYNC_TIMEOUT_MS); // one SYNC gets up to 8 answers: let them arrive, then drop them
      this.flushInput();
      return;
    }
    throw new RomTimeout('no answer from the ESP32 bootloader');
  }

  async readReg(address: number): Promise<number> {
    return (await this.command(OP.READ_REG, u32le(address))).value;
  }

  /** Refuse anything but a classic ESP32 (the firmware is built for it). Returns its MAC address. */
  async detectChip(): Promise<{ mac: string }> {
    const magic = await this.readReg(CHIP_MAGIC_REG);
    if (magic !== ESP32_MAGIC) {
      throw new RomError(`not an ESP32 (chip magic 0x${magic.toString(16)}): the hour meter firmware is for the ESP32`);
    }
    const low = await this.readReg(EFUSE_MAC_LOW);
    const high = await this.readReg(EFUSE_MAC_HIGH);
    const bytes = [(high >>> 8) & 0xff, high & 0xff, low >>> 24, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff];
    return { mac: bytes.map((b) => b.toString(16).padStart(2, '0')).join(':') };
  }

  /** Attach the SPI flash with the default pins (the module's internal flash). */
  async spiAttach(): Promise<void> {
    await this.command(OP.SPI_ATTACH, new Uint8Array(8));
  }

  /** Tell the ROM the flash geometry: size, 64 KB blocks, 4 KB sectors, 256 B pages. */
  async spiSetParams(totalSize: number): Promise<void> {
    await this.command(OP.SPI_SET_PARAMS, u32le(0, totalSize, 0x10000, 0x1000, 0x100, 0xffff));
  }

  /** Switch the chip's UART to `baud`. The answer still comes at the old speed; then change the port's speed. */
  async changeBaud(baud: number): Promise<void> {
    await this.command(OP.CHANGE_BAUDRATE, u32le(baud, 0));
  }

  /** Start a compressed write of `size` bytes at `offset`: the ROM erases the area first. */
  async flashDeflBegin(size: number, compressedSize: number, offset: number): Promise<void> {
    const blocks = Math.ceil(compressedSize / FLASH_BLOCK);
    const eraseSize = Math.ceil(size / FLASH_BLOCK) * FLASH_BLOCK;
    this.deflSize = size;
    await this.command(OP.FLASH_DEFL_BEGIN, u32le(eraseSize, blocks, FLASH_BLOCK, offset), {
      timeoutMs: timeoutFor(ERASE_MS_PER_MB, eraseSize, ERASE_MIN_MS),
    });
  }

  /** One block (at most FLASH_BLOCK bytes) of the zlib stream; `seq` counts from 0 after each begin. */
  async flashDeflData(block: Uint8Array, seq: number): Promise<void> {
    const data = new Uint8Array(16 + block.length);
    data.set(u32le(block.length, seq, 0, 0));
    data.set(block, 16);
    await this.command(OP.FLASH_DEFL_DATA, data, {
      checksum: blockChecksum(block),
      timeoutMs: timeoutFor(WRITE_MS_PER_MB, this.deflSize),
    });
  }

  /** MD5 of `size` bytes of flash at `offset`, as lowercase hex. */
  async flashMd5(offset: number, size: number): Promise<string> {
    const answer = await this.command(OP.SPI_FLASH_MD5, u32le(offset, size, 0, 0), {
      timeoutMs: timeoutFor(MD5_MS_PER_MB, size),
    });
    // The ROM answers 32 hex digits in ASCII (a stub would send 16 raw bytes).
    if (answer.data.length === 32) return new TextDecoder().decode(answer.data).toLowerCase();
    if (answer.data.length === 16) return Array.from(answer.data, (b) => b.toString(16).padStart(2, '0')).join('');
    throw new RomError(`unexpected MD5 answer (${answer.data.length} bytes)`);
  }

  /**
   * Write, but give up after `timeoutMs`: a port that nothing drains blocks a write forever. A port problem is an
   * Error, never a RomError, so sync() does not mistake it for a bootloader that is not there yet.
   */
  private async send(op: number, bytes: Uint8Array, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stuck = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${opName(op)}: the port takes no data`)), timeoutMs);
    });
    try {
      await Promise.race([this.link.write(bytes), stuck]);
    } finally {
      clearTimeout(timer);
    }
  }

  private onPacket(packet: Uint8Array): void {
    const answer = parseAnswer(packet);
    if (!answer) return; // our own echo or noise
    this.answers.push(answer);
    this.wake?.();
  }

  private async nextAnswer(timeoutMs: number): Promise<RomAnswer | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (this.answers.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0 || this.closed) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.wake?.(), left);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
      });
    }
    return this.answers.shift();
  }

  private async pump(): Promise<void> {
    try {
      for await (const bytes of this.link.readable) this.slip.push(bytes);
    } catch {
      // link closed underneath us
    }
    this.closed = true;
    this.wake?.();
  }
}
