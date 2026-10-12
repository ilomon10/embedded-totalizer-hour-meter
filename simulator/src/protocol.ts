// protocol.ts: the ONLY bridge from the simulator to the shared protocol code.
//
// The codec (../sensorframe/js) and the tag table (../configurator/src/tags.ts) are
// the same files the host tools use, and the tag table is checked against the
// firmware's Protocol.h by esp32/scripts/check-docs.ts. Reusing them means the
// simulator cannot drift from the real device. The codec is CommonJS, so it loads
// through createRequire (and `deno compile` needs --include for it).
import { createRequire } from 'node:module';

import * as tagTable from '../../configurator/src/tags.ts';

const require = createRequire(import.meta.url);
const sensorframe = require('../../sensorframe/js/index.js');

export type Fmt = 'u8' | 'u16' | 'u32' | 'i16' | 'f32' | 'bool';
export type RawValue = number | boolean | bigint | Uint8Array;

/** One record in wire order. `value` is the raw (already scaled) wire value. */
export interface Rec {
  tag: number;
  fmt: Fmt;
  value: number | boolean;
}

/** A frame before the header fields the device fills in (seq, deviceId). */
export interface Message {
  msgType: number;
  timestamp: number;
  records: Rec[];
}

export interface DecodedRecord {
  tag: number;
  name: string;
  fmt: string;
  raw: RawValue;
  value: RawValue;
}

export interface DecodedMessage {
  msgType: number;
  seq: number;
  deviceId: number;
  timestamp: number;
  values: Record<string, RawValue>;
  records: DecodedRecord[];
}

export interface SettingSpec {
  tag: number;
  min: number;
  max: number;
  values?: number[];
}

interface TagDef {
  name: string;
  fmt: string;
  scale?: number;
  unit?: string;
}

interface Codec {
  encode(msg: { msgType: number; seq: number; deviceId: number; timestamp: number; records: Rec[] }): Uint8Array;
  decode(packet: Uint8Array): DecodedMessage;
  decodeFrame(frame: Uint8Array): DecodedMessage;
}

/** Tag number -> definition, including the SensorFrame reserved tags 240..243. */
export const TAGS: Record<number, TagDef> = { ...sensorframe.RESERVED_TAGS, ...tagTable.tags };
export const MSG = tagTable.MSG;
export const ACK_STATUS: readonly string[] = tagTable.ACK_STATUS;
export const STATUS_FLAGS: readonly string[] = tagTable.STATUS_FLAGS;
export const SETTINGS: Record<string, SettingSpec> = tagTable.SETTINGS;
export const RESET_MAGIC: number = tagTable.RESET_MAGIC;
export const codec: Codec = sensorframe.createCodec({ tags: tagTable.tags });
export const frameBytes: (packet: Uint8Array) => Uint8Array = sensorframe.frameBytes;
export const cobsDecode: (data: Uint8Array) => Uint8Array | null = sensorframe.cobsDecode;

const TAG_BY_NAME = new Map(Object.entries(TAGS).map(([tag, def]) => [def.name, Number(tag)]));

/** Build a record by tag name; fmt comes from the shared tag table. */
export function rec(name: string, value: number | boolean): Rec {
  const tag = TAG_BY_NAME.get(name);
  if (tag === undefined) throw new Error(`no tag named '${name}' in configurator/src/tags.ts`);
  return { tag, fmt: TAGS[tag].fmt as Fmt, value };
}

export function tagOf(name: string): number {
  const tag = TAG_BY_NAME.get(name);
  if (tag === undefined) throw new Error(`no tag named '${name}' in configurator/src/tags.ts`);
  return tag;
}

/** ackStatus codes by name (Protocol.h AckStatus). */
export const Ack = Object.freeze(
  Object.fromEntries(ACK_STATUS.map((name, code) => [name, code])) as Record<string, number>,
);

/** statusFlags bits by name (Protocol.h status_flag). */
export const Flag = Object.freeze(
  Object.fromEntries(STATUS_FLAGS.map((name, bit) => [name, 2 ** bit])) as Record<string, number>,
);

/** devices mask bits (Protocol.h device_bit). */
export const Device = Object.freeze({ eeprom: 0x01, rtc: 0x02, imu: 0x04, mag: 0x08 });

export const FIRMWARE_VERSION = 0x00020500; // 2.5.0, Protocol.h kFirmwareVersion
