# Node.js API

```bash
npm install ./sensorframe/js        # Node ≥ 18, zero dependencies
```

```js
const { createCodec, FrameStream, MSG_TYPE, SensorFrameError } = require('sensorframe');
// or: import { createCodec, FrameStream } from 'sensorframe';
```

TypeScript declarations ship in `index.d.ts`. For the wire format see [SPEC.md](../SPEC.md). For a guided start, see the [README](../README.md#quick-start).

**Contents:** [createCodec](#createcodecoptions) · [codec.decode](#codecdecodepacket) · [codec.encode](#codecencodemsg) · [codec.frame / decodeFrame](#codecframemsg--codecdecodeframeframe) · [FrameStream](#framestream) · [Errors](#errors) · [Constants & helpers](#constants--helpers)

---

## `createCodec(options?)`

Creates an encoder/decoder bound to your tag table. Create it once and reuse it.

```js
const codec = createCodec({
  tags: {
    1: { name: 'runSeconds', fmt: 'u32', unit: 's' },
    2: { name: 'totalCount', fmt: 'u32' },
    3: { name: 'alternator', fmt: 'bool' },
    4: { name: 'temperature', fmt: 'i16', scale: 0.1, unit: '°C' },
  },
  maxPacketSize: 250,
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `tags` | `Record<number, TagDef>` | `{}` | Tag number (1–239) → definition. The reserved tags 240–243 (`errorCode`, `fwVersion`, `ackSeq`, `ackStatus`) are built in. |
| `maxPacketSize` | number | 250 | Limit for both `encode` and `FrameStream` |

`TagDef`:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Key used in `values` (must be unique) |
| `fmt` | yes | `'u8' 'i8' 'u16' 'i16' 'u32' 'i32' 'f32' 'bool' 'bytes' 'u64' 'i64' 'f64'` (or the numeric code) |
| `scale` | no | Decode: `value = raw * scale`. Encode: `raw = round(value / scale)`. |
| `unit` | no | Copied to decoded records, for display only |

Throws `SensorFrameError('ENCODE')` for an unknown fmt, an invalid tag number or a duplicate name.

---

## `codec.decode(packet)`

Decodes one **raw packet** (no COBS). Use it for MQTT, WebSocket, UDP, LoRa and ESP-NOW gateways.

```js
const msg = codec.decode(payload);
```

Returns:

```js
{
  version: 1,
  msgType: 1,
  msgTypeName: 'TELEMETRY',      // EVENT | COMMAND | ACK | HEARTBEAT | APP | UNKNOWN
  seq: 1,
  deviceId: 305419896,
  timestamp: 3600,
  values: { runSeconds: 3600, totalCount: 1234, alternator: true, temperature: 23.4 },
  records: [
    { tag: 1, name: 'runSeconds', fmt: 'u32', raw: 3600, value: 3600, unit: 's' },
    // ...
    { tag: 4, name: 'temperature', fmt: 'i16', raw: 234, value: 23.4, unit: '°C' },
  ],
}
```

- `values` is the convenient view. If a tag repeats, the last record wins.
- `records` keeps every record in wire order, with `raw` (before scale) and `value` (after scale).
- Value types: numbers, `true`/`false` for `bool`, `Buffer` for `bytes`, and `bigint` for `u64`/`i64` (unless a `scale` is set).
- Tags missing from your table appear as `tag_<n>`.
- Throws `SensorFrameError` on any invalid packet (see [Errors](#errors)).

---

## `codec.encode(msg)`

Encodes a raw packet and returns a `Buffer`.

```js
const packet = codec.encode({
  msgType: MSG_TYPE.COMMAND,   // default TELEMETRY
  seq: 42,                     // default 0
  deviceId: 0x12345678,        // default 0
  timestamp: 0,                // default 0
  values: { setCounter: 0 },   // by tag name (needs a tags entry)
  records: [                   // or explicit, no tags entry needed
    { tag: 50, fmt: 'u8', value: 7 },
  ],
});
```

`values` are encoded first, then `records`. Integers are range-checked against their fmt, and the packet size is checked against `maxPacketSize`. `bytes` values accept a `Buffer`, a `Uint8Array` or a string (encoded as UTF-8).

---

## `codec.frame(msg)` / `codec.decodeFrame(frame)`

The stream-transport versions: `frame()` returns `encode()` + COBS + `0x00`, ready to pass to `port.write()`. `decodeFrame()` accepts one COBS frame with or without its trailing `0x00`.

```js
port.write(codec.frame({ msgType: MSG_TYPE.COMMAND, seq: 1, values: { setCounter: 500 } }));
```

---

## `FrameStream`

A `Transform` stream. Raw bytes go in, decoded messages come out (in object mode). It handles frames split across chunks, several frames in one chunk, idle `0x00` bytes, and garbage.

```js
port
  .pipe(new FrameStream({ tags }))                 // or { codec }
  .on('data', (msg) => console.log(msg.values))
  .on('frameError', (err, bytes) => console.warn(err.code));
```

| Option | Description |
|---|---|
| `codec` | An existing codec. Otherwise one is built from `tags` and `maxPacketSize`. |
| `tags`, `maxPacketSize` | Passed to `createCodec` |

**Bad frames never break the pipe.** They are reported through the `frameError` event as `(err, frameBytes)` and skipped. The stream's own `error` event is only used for real stream failures.

Works with any readable byte stream: `serialport`, `net.Socket`, `process.stdin`, or a file.

---

## Errors

Every failure throws (or emits) a `SensorFrameError` with a `code`:

| `code` | Meaning |
|---|---|
| `TOO_SHORT` | Packet shorter than 14 bytes |
| `CRC` | Checksum mismatch (noise, a wrong baud rate, or mixed-in debug text) |
| `VERSION` | Packet is not version 1 |
| `FORMAT` | A record has an unknown fmt code |
| `TRUNCATED` | A record runs past the end of the packet |
| `COBS` | Invalid COBS encoding |
| `OVERFLOW` | `FrameStream`: no delimiter within `maxPacketSize` bytes |
| `TOO_LARGE` | `encode`: the result would exceed `maxPacketSize` |
| `ENCODE` | `encode`/`createCodec`: an unknown name or fmt, or a value out of range |

```js
try {
  codec.decode(buf);
} catch (err) {
  if (err instanceof SensorFrameError && err.code === 'CRC') { /* count it */ }
  else throw err;
}
```

---

## Constants & helpers

| Export | Description |
|---|---|
| `MSG_TYPE` | `{ TELEMETRY: 1, EVENT: 2, COMMAND: 3, ACK: 4, HEARTBEAT: 5 }` |
| `FMT` | `{ u8: 1, i8: 2, … f64: 12 }` |
| `RESERVED_TAGS` | Built-in definitions for tags 240–243 |
| `VERSION`, `HEADER_SIZE`, `CRC_SIZE`, `MIN_PACKET`, `MAX_PACKET` | 1, 12, 2, 14, 250 |
| `crc16(data, crc = 0xFFFF)` | CRC16-CCITT-FALSE, usable incrementally |
| `cobsEncode(data)` / `cobsDecode(data)` | COBS without the delimiter. `cobsDecode` returns `null` on error. |
| `frameBytes(packet)` | COBS + `0x00` for an already-encoded packet |
