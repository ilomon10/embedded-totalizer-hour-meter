// splitter.ts: bytes from the wire -> decoded frames, the same rules as the
// firmware's SensorFrameReader: split on 0x00, COBS-decode, check the CRC, drop
// bad frames and keep going. PANIC_ZERO_RUN zero bytes in a row are the panic
// signal (SerialLink.cpp): reported through onPanic, never as a frame.
import { PANIC_ZERO_RUN } from '../../configurator/src/tags.ts';
import { codec, type DecodedMessage } from './protocol.ts';

const MAX_FRAME_BYTES = 256; // 250-byte packet + COBS overhead; longer = junk without a delimiter

export type FrameHandler = (msg: DecodedMessage) => void;
export type ErrorHandler = (err: Error) => void;

export class FrameSplitter {
  private pending: number[] = [];
  private zeroRun = 0;

  constructor(
    private readonly onFrame: FrameHandler,
    private readonly onError: ErrorHandler = () => {},
    private readonly onPanic: () => void = () => {},
  ) {}

  push(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.zeroRun = byte === 0 ? this.zeroRun + 1 : 0;
      if (this.zeroRun >= PANIC_ZERO_RUN) {
        this.zeroRun = 0;
        this.pending = [];
        this.onPanic();
        continue;
      }
      if (byte !== 0) {
        if (this.pending.length < MAX_FRAME_BYTES) this.pending.push(byte);
        continue;
      }
      const frame = Uint8Array.from(this.pending);
      this.pending = [];
      if (frame.length > 0) this.decode(frame);
    }
  }

  private decode(frame: Uint8Array): void {
    let msg: DecodedMessage;
    try {
      msg = codec.decodeFrame(frame);
    } catch (err) {
      return this.onError(err as Error);
    }
    this.onFrame(msg);
  }
}
