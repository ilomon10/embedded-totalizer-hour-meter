# SensorFrame Wire Format — Version 1

This is the normative description of the bytes on the wire. If you only want to use the libraries, start with the [README](README.md). Read this document if you are writing a decoder in another language, debugging a hex dump, or changing the format.

The key words **MUST**, **MUST NOT**, **SHOULD** and **MAY** are used as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Overview

```
 ┌──────────── packet (12 + records + 2 bytes, max 250) ────────────┐
 ┌────────────────────┬──────────┬──────────┬─────┬──────────┬──────┐
 │ HEADER (12 bytes)  │ record 1 │ record 2 │ ... │ record n │ CRC  │
 └────────────────────┴──────────┴──────────┴─────┴──────────┴──────┘
                        tag fmt value                         CRC16 LE

 Stream transports (UART, RS485, USB-CDC, TCP):   COBS(packet) 00
 Packet transports (MQTT, WebSocket, ESP-NOW, LoRa, UDP):  packet
```

- A **packet** is one message: a fixed header, zero or more self-describing records, and a CRC.
- A **frame** is a packet prepared for a byte stream: COBS-encoded, followed by one `0x00` delimiter.
- All multi-byte integers and floats are **little-endian**.

## 2. Header

| Offset | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 1 | u8 | `version` | MUST be `1` for this spec |
| 1 | 1 | u8 | `msgType` | see [§5](#5-message-types) |
| 2 | 2 | u16 | `seq` | sender's sequence number, wraps 65535 → 0 |
| 4 | 4 | u32 | `deviceId` | sender identity; `0` = unspecified |
| 8 | 4 | u32 | `timestamp` | seconds; uptime or Unix epoch (application decides) |

## 3. Records

Each record is a tag, a fmt, and a value. The records follow the header back to back and fill the space up to the CRC. A packet MAY have zero records.

```
 ┌──────┬──────┬──────────────────────┐
 │ tag  │ fmt  │ value (size by fmt)  │
 │  u8  │  u8  │ 1, 2, 4, 8 or 1+len  │
 └──────┴──────┴──────────────────────┘
```

### 3.1 fmt codes

| Code | Name | Value size | C type | JS decoded type |
|---:|---|---:|---|---|
| 1 | `u8` | 1 | `uint8_t` | number |
| 2 | `i8` | 1 | `int8_t` | number |
| 3 | `u16` | 2 | `uint16_t` | number |
| 4 | `i16` | 2 | `int16_t` | number |
| 5 | `u32` | 4 | `uint32_t` | number |
| 6 | `i32` | 4 | `int32_t` | number |
| 7 | `f32` | 4 | `float` (IEEE 754) | number |
| 8 | `bool` | 1 | `0x00` = false, anything else = true | boolean |
| 9 | `bytes` | 1 + len | length byte (0–255), then `len` bytes | Buffer |
| 10 | `u64` | 8 | `uint64_t` | bigint |
| 11 | `i64` | 8 | `int64_t` | bigint |
| 12 | `f64` | 8 | `double` (IEEE 754) | number |
| 0, 13–255 | — | — | reserved | decoder MUST reject the packet |

### 3.2 Tags

| Range | Use |
|---|---|
| `0` | invalid, MUST NOT be sent |
| `1`–`239` | application-defined (your sensors) |
| `240` | `errorCode` (u16): device error code |
| `241` | `fwVersion` (u32): `0x00MMmmpp` |
| `242` | `ackSeq` (u16): `seq` of the packet being acknowledged |
| `243` | `ackStatus` (u8): `0` = OK, anything else = error code |
| `244`–`255` | reserved for future versions of this spec |

Sender and receiver share a **tag table**: tag number → name, fmt, optional scale and unit. The table is not sent on the wire. A tag SHOULD always use the same fmt.

The same tag MAY appear more than once in a packet (for example, several samples). Decoders MUST keep every record in order.

### 3.3 Scaling convention

For fractional values, send a scaled integer rather than a float. Record the scale in the tag table:

| Quantity | fmt | scale | Wire value for 23.4 °C / 12.6 V |
|---|---|---|---|
| temperature | `i16` | 0.1 | `234` (2 bytes instead of 4) |
| voltage | `u16` | 0.001 | `12600` |

Decoders compute `value = raw × scale`. Encoders compute `raw = round(value / scale)`.

## 4. CRC

CRC16-CCITT-FALSE over every byte from offset 0 to the end of the last record, stored **little-endian** in the final 2 bytes.

| Parameter | Value |
|---|---|
| width | 16 |
| poly | `0x1021` |
| init | `0xFFFF` |
| refin / refout | false / false |
| xorout | `0x0000` |
| check (`"123456789"`) | `0x29B1` |

The same CRC is available as Python's `binascii.crc_hqx(data, 0xFFFF)`.

## 5. Message types

| Code | Name | Direction | Typical records |
|---:|---|---|---|
| 1 | `TELEMETRY` | device → host | periodic sensor values |
| 2 | `EVENT` | device → host | alarms, state changes, `errorCode` |
| 3 | `COMMAND` | host → device | application command tags |
| 4 | `ACK` | either | `ackSeq`, `ackStatus` |
| 5 | `HEARTBEAT` | either | none |
| 6–127 | reserved | | |
| 128–255 | application-defined | | |

## 6. Framing for byte streams (COBS)

UART, RS485, USB-CDC and TCP do not mark where messages start and end. On these transports each packet MUST be [COBS](https://en.wikipedia.org/wiki/Consistent_Overhead_Byte_Stuffing)-encoded and followed by one `0x00`:

1. COBS removes every `0x00` from the packet. It adds 1 byte, plus 1 more per 254 bytes, so a packet of at most 250 bytes always grows by exactly 1 byte.
2. `0x00` then appears only as the frame delimiter. A receiver that joins mid-stream, or sees noise, recovers at the next `0x00`.
3. Receivers MUST ignore empty frames (consecutive `0x00` bytes). Senders MAY send a leading `0x00` to flush a receiver's partial buffer.

Worked example, from the `heartbeat` packet in §8.2:

```
packet : 01 05 00 00 00 00 00 00 00 00 00 00 82 0e
frame  : 03 01 05 01 01 01 01 01 01 01 01 01 03 82 0e 00
         │        └─ each 00 becomes a code byte 01 ──┘    │
         └ code: next 00 is 3 bytes ahead            delimiter
```

Packet transports (MQTT, WebSocket, ESP-NOW, LoRa, UDP) already delimit messages. On these, the packet SHOULD be sent as-is, without COBS.

## 7. Decoder rules

A decoder MUST reject the whole packet, and SHOULD report the matching error, when any of these holds:

| Condition | Error code (JS `err.code` / C `SfError`) |
|---|---|
| length < 14 | `TOO_SHORT` / `SF_ERR_TOO_SHORT` |
| CRC mismatch | `CRC` / `SF_ERR_CRC` |
| `version` ≠ 1 | `VERSION` / `SF_ERR_VERSION` |
| a record has an unknown fmt | `FORMAT` / `SF_ERR_FORMAT` |
| a record runs past the CRC | `TRUNCATED` / `SF_ERR_TRUNCATED` |
| invalid COBS in a stream frame | `COBS` / `SF_ERR_COBS` |
| frame larger than the receive buffer | `OVERFLOW` / `SF_ERR_OVERFLOW` |

Checks MUST happen in this order: length, CRC, version, records. The CRC check comes first so that line noise is never parsed.

Unknown **tags** are not an error. A decoder MUST decode them using their fmt (the JS library names them `tag_<n>`). This is how old receivers tolerate new sensors.

Packets SHOULD be at most **250 bytes**, which is the ESP-NOW payload limit. Receivers MAY set a lower limit to fit their RAM.

## 8. Golden vectors

These are the bytes both libraries' tests check against. They come from [`tools/vectors.input.json`](tools/vectors.input.json), and [`test-vectors.json`](test-vectors.json) has the full set, including the `all formats` vector.

### 8.1 hour-meter telemetry (33-byte packet, 35-byte frame)

```
01                version 1
01                msgType TELEMETRY
01 00             seq 1
78 56 34 12       deviceId 0x12345678
10 0e 00 00       timestamp 3600
01 05 10 0e 00 00 tag 1  u32  3600   runSeconds
02 05 d2 04 00 00 tag 2  u32  1234   totalCount
03 08 01          tag 3  bool true   alternator
04 04 ea 00       tag 4  i16  234    temperature ×0.1 = 23.4 °C
18 6c             CRC 0x6C18

frame: 04 01 01 01 07 78 56 34 12 10 0e 01 05 01 05 10 0e 01 05 02 05 d2 04 01 07 03 08 01 04 04 ea 03 18 6c 00
```

The same data as JSON (`{"type":"telemetry","seq":1,"deviceId":"12345678",…}`) takes about 120–140 bytes.

### 8.2 heartbeat (14-byte packet, 16-byte frame)

```
packet: 01 05 00 00 00 00 00 00 00 00 00 00 82 0e
frame : 03 01 05 01 01 01 01 01 01 01 01 01 03 82 0e 00
```

### 8.3 command: set counter (20-byte packet, 22-byte frame)

```
01 03 2a 00       version 1, COMMAND, seq 42
78 56 34 12       deviceId 0x12345678
00 00 00 00       timestamp 0
64 05 00 00 00 00 tag 100  u32  0
e3 10             CRC 0x10E3

frame: 04 01 03 2a 05 78 56 34 12 01 01 01 03 64 05 01 01 01 03 e3 10 00
```

## 9. Versioning

- Adding tags, application message types or application fmts never changes `version`. Old decoders keep working because unknown tags are decoded generically.
- Any change to the header, the CRC, the COBS rules or an existing fmt's encoding MUST increment `version`. A v1 decoder rejects other versions instead of misreading them.
- New fmt codes (13–255) MAY be added in a future version. A v1 decoder rejects packets that contain them, because it cannot know their size.
