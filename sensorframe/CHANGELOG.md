# Changelog

All notable changes to SensorFrame. Versions follow [Semantic Versioning](https://semver.org/). The wire format has its own `version` byte ([SPEC §9](SPEC.md#9-versioning)).

## [1.0.0] - 2026-10-07

### Added
- Wire format v1: 12-byte header, TLV records (12 fmts), CRC16-CCITT-FALSE, and COBS framing for byte streams ([SPEC.md](SPEC.md)).
- Arduino/PlatformIO library: `SensorFrameWriter`, `SensorFrameReader`, `SensorFrameView`. Header-only, zero heap, builds on ESP32 and AVR.
- npm package `sensorframe`: `createCodec`, `FrameStream`, TypeScript types, CJS + ESM. Zero dependencies.
- Examples: BasicSerial, HourMeter and Bidirectional sketches; serial reader, command sender, MQTT handler and simulator scripts.
- Shared golden vectors (`test-vectors.json`) checked by both test suites.
