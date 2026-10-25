// sensorframe.ts: the ONLY bridge to ../sensorframe/js (the shared codec, CommonJS).
// A static import, so `bun build --compile` bundles the codec into the binary.
import * as sensorframeModule from '../../sensorframe/js/index.js';

import { tags } from './tags.ts';

// The codec's own .d.ts is written for Node (Buffer values, a wider TagDef); this file declares the shapes it uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sensorframe: any = sensorframeModule;

export type Value = number | boolean | bigint | Uint8Array;

export interface DecodedMessage {
  msgType: number;
  seq: number;
  deviceId: number;
  timestamp: number;
  values: Record<string, Value>;
}

export interface SensorFrameError extends Error {
  code: string;
}

export interface Codec {
  frame(msg: { msgType: number; seq?: number; deviceId?: number; timestamp?: number; values: object }): Uint8Array;
  encode(msg: { msgType: number; seq?: number; deviceId?: number; timestamp?: number; values: object }): Uint8Array;
  decodeFrame(frame: Uint8Array): DecodedMessage;
}

/** Codec bound to this device's tag table. */
export const codec: Codec = sensorframe.createCodec({ tags });

const MAX_FRAME_BYTES = 256; // 250-byte packet + COBS overhead; longer = junk without a delimiter

/**
 * Bytes -> decoded frames: split on 0x00, COBS-decode, check the CRC. Bad frames
 * go to onError and never stop the stream (same rules as sensorframe's FrameStream).
 */
export class FrameSplitter {
  private pending: number[] = [];

  constructor(
    private readonly onFrame: (msg: DecodedMessage) => void,
    private readonly onError: (err: SensorFrameError) => void,
  ) {}

  push(bytes: Uint8Array): void {
    for (const byte of bytes) {
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
      return this.onError(err as SensorFrameError);
    }
    this.onFrame(msg);
  }
}
