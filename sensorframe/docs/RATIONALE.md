# Why SensorFrame? (Design decision record)

**Status:** accepted · **Date:** 2026-10-07 · **Scope:** device ↔ host payload format for the totalizer/hour-meter and future sensor nodes

## Context

The ESP32 must report several kinds of sensor data (run hours, pulse totals, digital states, temperatures, voltages) to a Node.js service. It needs to do this over a raw serial stream today, and later over RS485, MQTT, ESP-NOW or LoRa.

These constraints ruled out the obvious choices:

1. **RAM.** Building JSON with ArduinoJson needs a `JsonDocument` plus the output string. On small MCUs, or when many messages are in flight, this is the largest memory user in the firmware.
2. **Developer friction on Node.** Protobuf needs a schema, and usually a compile step (`protoc`/`pbjs`), every time a field changes.
3. **Many sensor types.** One fixed C struct per message breaks whenever a sensor is added, and needs new decode code each time.
4. **Byte streams.** On UART/RS485 the receiver must find where frames start and end, and must detect corruption.

## Options considered

The size column is for the same 4 readings: run seconds, total count, alternator flag and temperature.

| Option | Size | MCU memory | Node side | Schema / codegen | Verdict |
|---|---:|---|---|---|---|
| JSON (ArduinoJson) | ~120–140 B | JsonDocument + String, heap | `JSON.parse` | none | Too big on the wire and in RAM |
| MessagePack via ArduinoJson `serializeMsgPack` | ~50 B | still needs a JsonDocument | `msgpackr` | none | Smaller on the wire, but the RAM problem remains |
| MessagePack via **mpack** / **CMP** writers | ~35–50 B | fixed buffer, no heap | `msgpackr` | none | Good. Keys cost bytes unless you use positional arrays. |
| CBOR via **TinyCBOR** (bundled with ESP-IDF) | ~35–50 B | fixed buffer, no heap | `cbor-x` | none | Good. Same trade-offs as mpack. |
| Protobuf via **nanopb** | ~25 B | static, small | `protobufjs` (`protobuf.load()` at runtime avoids a JS compile) | nanopb generator on the C side | Smallest, but needs codegen whenever fields change |
| FlatBuffers / Cap'n Proto | larger | larger | needs `flatc` | yes | Built for zero-copy reads of large messages, which we don't need |
| One packed C struct per message | ~25 B | 0 | `Buffer.readUInt32LE…` | none | Tiny, but rigid: every sensor change touches both sides |
| **SensorFrame (header + TLV + CRC16 + COBS)** | **33 B (+2 B framing)** | **0 heap, ~N+8 B static** | **built-in generic decoder** | **none: a tag table** | **Chosen** |

Neither MessagePack nor CBOR covers integrity (CRC) or stream framing. Using either one would still mean adding COBS + CRC around it.

## Decision

Use a small custom format:

- A **12-byte fixed header**: version, message type, sequence number, device id, timestamp. Every message needs these, so they don't pay per-field overhead.
- **TLV records** (`tag u8, fmt u8, value`). Each value describes its own encoding, so one generic decoder handles any mix of sensors, and unknown tags degrade gracefully.
- **CRC16-CCITT-FALSE** in every packet. It is cheap, standard (`binascii.crc_hqx`), and enough for packets of 250 bytes or less.
- **COBS + `0x00`** only on stream transports. It adds a constant 1 byte for packets up to 250 bytes and recovers sync at the next delimiter.

## Consequences

**Good**

- About 4× smaller than JSON, with zero heap use. The libraries fit an Arduino Uno: the BasicSerial example uses 318 B of RAM.
- No codegen on either side. Adding a sensor means one `enum` line in C++ and one object entry in JS.
- Old hosts decode new devices; new sensors appear as `tag_<n>` until the table is updated.
- The same packet works over every transport. Only the framing changes.
- Two independent implementations (C++ and JS) are tested against shared golden vectors.

**Trade-offs**

- Each record costs 2 bytes for tag and fmt, where a fixed struct costs nothing. This is negligible for a few dozen fields.
- The tag table is a convention kept in two files rather than one schema. Keep `tags.h` and `tags.js` side by side and review them together.
- There is no nesting and no arrays of records beyond repeated tags. Values are flat, which suits sensor telemetry.
- It is a custom format, so other tooling (Wireshark, generic decoders) won't recognise it. [SPEC.md](../SPEC.md) is short enough to implement in an afternoon.

## When to choose something else

- You need **nested or document-like data** (configs, lists of objects): use **mpack + msgpackr** inside the same COBS + CRC framing.
- You need **strict, versioned schemas shared across many teams or languages**: use **nanopb + protobufjs** (`protobuf.load()` at runtime, so no JS compile step).
- You have **one fixed message that never changes** and every byte counts (for example LoRa SF12): a packed struct saves the 2 bytes per field. SensorFrame's `bytes` fmt can carry such a struct if you want to keep the same framing.
