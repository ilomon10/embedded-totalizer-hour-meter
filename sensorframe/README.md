# SensorFrame

**Send many kinds of sensor data from an MCU to Node.js in about 35 bytes, using no heap and no schema compiler.**

| Same 4 sensor readings | Bytes on the wire | MCU heap |
|---|---:|---:|
| JSON (ArduinoJson) | ~120–140 | JsonDocument + String |
| **SensorFrame** | **35** (33-byte packet + 2 bytes of framing) | **0** |

- **Header-only C++**: works on ESP32, ESP8266, RP2040, STM32 and AVR. The BasicSerial example uses 318 bytes of RAM on an Arduino Uno.
- **Zero-dependency npm package**: no `.proto` files and no codegen. You describe your sensors in a plain JS object.
- **Self-describing records**: add a sensor on the device and old Node code still decodes it.
- **Built-in integrity**: CRC16 on every packet, and COBS framing that recovers from noise and mid-stream connects.
- **Any transport**: Serial, RS485, USB, TCP, MQTT, WebSocket, ESP-NOW, LoRa.

```
 ┌─────────────── HEADER 12 B ───────────────┬──── records ────┬─ CRC ─┐
 │ ver │ type │  seq  │ deviceId  │ timestamp │ tag fmt value … │ crc16 │
 │  1  │  1   │   2   │     4     │     4     │  1   1  1..8    │   2   │
 └─────┴──────┴───────┴───────────┴───────────┴─────────────────┴───────┘
  on Serial/RS485:  COBS(packet) 0x00      on MQTT/ESP-NOW/LoRa:  packet
```

The wire format is specified in [SPEC.md](SPEC.md).

---

## Quick start

### 1. Device (ESP32 / Arduino)

**PlatformIO**: add the library to `platformio.ini`:

```ini
lib_deps =
  symlink://../sensorframe/arduino     ; path to this folder's arduino/ directory
```

**Arduino IDE**: copy `arduino/` into `~/Arduino/libraries/SensorFrame/`.

Then send a frame:

```cpp
#include <SensorFrame.h>

enum : uint8_t { TAG_UPTIME = 1, TAG_ANALOG = 2, TAG_BUTTON = 3 };

SensorFrameWriter<> frame;   // fixed 128-byte buffer, no heap
uint16_t seq = 0;

void setup() { Serial.begin(115200); pinMode(0, INPUT_PULLUP); }

void loop() {
  frame.begin(SF_MSG_TELEMETRY, seq++, /*deviceId*/ 1, millis() / 1000);
  frame.addU32(TAG_UPTIME, millis() / 1000);
  frame.addU16(TAG_ANALOG, analogRead(A0));
  frame.addBool(TAG_BUTTON, digitalRead(0) == LOW);
  frame.send(Serial);        // COBS-encoded, 0x00-terminated
  delay(1000);
}
```

This is [`arduino/examples/BasicSerial`](arduino/examples/BasicSerial/BasicSerial.ino).

### 2. Host (Node.js ≥ 18)

```bash
npm install ./sensorframe/js serialport
```

```js
const { SerialPort } = require('serialport');
const { FrameStream } = require('sensorframe');

const tags = {
  1: { name: 'uptime', fmt: 'u32', unit: 's' },
  2: { name: 'analog', fmt: 'u16' },
  3: { name: 'button', fmt: 'bool' },
};

new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 })
  .pipe(new FrameStream({ tags }))
  .on('data', (msg) => console.log(msg.msgTypeName, `#${msg.seq}`, msg.values))
  .on('frameError', (err) => console.warn('dropped frame:', err.code));
```

Expected output (your values will differ):

```
TELEMETRY #0 { uptime: 0, analog: 1843, button: false }
TELEMETRY #1 { uptime: 1, analog: 1840, button: false }
TELEMETRY #2 { uptime: 2, analog: 1851, button: true }
```

No hardware yet? `cd js && node examples/simulate.js` runs the whole pipeline with a simulated device.

ESM works too: `import { FrameStream, createCodec } from 'sensorframe'`. TypeScript types are included.

---

## Defining your tags

The tag table is the only thing the two sides must agree on. Give each sensor a number from 1 to 239 and a fmt, and keep both sides in sync:

<table>
<tr><th>Device: <code>tags.h</code></th><th>Host: <code>tags.js</code></th></tr>
<tr><td>

```cpp
enum Tag : uint8_t {
  TAG_RUN_SECONDS = 1,  // u32
  TAG_TOTAL_COUNT = 2,  // u32
  TAG_ALTERNATOR  = 3,  // bool
  TAG_TEMP_X10    = 4,  // i16, 0.1 °C
};
```

</td><td>

```js
module.exports = {
  1: { name: 'runSeconds',  fmt: 'u32', unit: 's' },
  2: { name: 'totalCount',  fmt: 'u32' },
  3: { name: 'alternator',  fmt: 'bool' },
  4: { name: 'temperature', fmt: 'i16', scale: 0.1, unit: '°C' },
};
```

</td></tr>
</table>

Rules of thumb:

- **Use the smallest fmt that fits the value**: `u8` for percentages, `u16` for ADC readings, `u32` for counters.
- **Send scaled integers rather than floats**: `addI16(TAG_TEMP_X10, 234)` on the device and `scale: 0.1` on the host gives `23.4`, using 2 bytes instead of 4.
- **Never reuse a tag number for a different meaning.** Retire it and pick a new number.
- **Unknown tags are not errors.** They arrive as `tag_<n>`, so you can update the device before the host.
- **Send only what changed** if bandwidth is tight. Every record is optional.

Available fmts: `u8 i8 u16 i16 u32 i32 f32 bool bytes u64 i64 f64`. See [SPEC §3.1](SPEC.md#31-fmt-codes).

---

## Transport recipes

Stream transports need COBS framing, so use `send()` on the device and `FrameStream` on the host. Packet transports delimit messages already, so send the raw packet (`finish()`/`size()` on the device, `decode()` on the host).

| Transport | Device | Host |
|---|---|---|
| USB Serial / UART | `frame.send(Serial)` | `port.pipe(new FrameStream({ tags }))` |
| RS485 | `digitalWrite(DE, HIGH); frame.send(Serial2); Serial2.flush(); digitalWrite(DE, LOW);` | same as UART |
| TCP | `frame.send(client)` (`WiFiClient`) | `socket.pipe(new FrameStream({ tags }))` |
| MQTT | `mqtt.publish(topic, frame.finish(), frame.size())` | `codec.decode(payload)` — [example](js/examples/mqtt-handler.js) |
| ESP-NOW | `esp_now_send(peer, frame.finish(), frame.size())` | gateway forwards over serial or MQTT |
| LoRa | `LoRa.beginPacket(); LoRa.write(frame.finish(), frame.size()); LoRa.endPacket();` | `codec.decode(packet)` |

For LoRa, use a small buffer such as `SensorFrameWriter<51>` so packets fit the lowest data rate. `add*()` returns `false` when the next record would not fit.

### Receiving on the device (commands from Node)

```cpp
SensorFrameReader<> reader;

void onFrame(SensorFrameView& f, void*) {
  SensorFrameRecord r;
  if (f.msgType() == SF_MSG_COMMAND && f.find(TAG_CMD_SET_COUNTER, r)) counter = r.asU32();
}

void setup() { Serial.begin(115200); reader.onFrame(onFrame); }
void loop()  { reader.poll(Serial); /* ... */ }
```

```js
port.write(codec.frame({ msgType: MSG_TYPE.COMMAND, seq: 42, values: { setCounter: 0 } }));
```

For the full round trip with an ACK, see [`Bidirectional.ino`](arduino/examples/Bidirectional/Bidirectional.ino) and [`send-command.js`](js/examples/send-command.js).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A few `frameError` with `COBS`/`CRC` right after connecting | ESP32 boot log or a partial frame was already in the buffer | Expected. The stream resyncs on the next `0x00` |
| Constant `CRC` errors | `Serial.print` debug text mixed into the binary stream | Move logs to another UART, or guard them with `#ifdef DEBUG_TEXT` |
| Constant `CRC` / `COBS` errors | Baud rate mismatch, or RS485 A/B swapped | Use the same baud on both sides and check the wiring |
| `add*()` returns `false`, `overflow()` is true | Writer buffer full | Use a larger `SensorFrameWriter<N>` (max 250) or fewer records |
| `OVERFLOW` on the host | Frame larger than `maxPacketSize` | Raise `maxPacketSize` in `createCodec` |
| Value shows as `tag_7` | Tag missing from the host's tag table | Add it to `tags.js` |
| Serial monitor shows garbage | Expected: the data is binary | Use `js/examples/serial-reader.js` |

---

## Project layout

```
sensorframe/
├── SPEC.md              wire format (normative)
├── docs/
│   ├── API-arduino.md   C++ API reference
│   ├── API-js.md        Node.js API reference
│   └── RATIONALE.md     why not JSON / MessagePack / CBOR / protobuf
├── arduino/             Arduino + PlatformIO library (header-only)
│   ├── src/  examples/  test/
├── js/                  npm package "sensorframe"
│   ├── src/  examples/  test/  index.d.ts
├── test-vectors.json    golden bytes shared by both test suites
└── tools/gen-vectors.js regenerates the vectors
```

## Running the tests

```bash
cd js && npm test                    # Node: codec, COBS/CRC, stream, golden vectors
make -C arduino/test                 # C++: same golden vectors, built with ASan/UBSan
pio ci --lib=arduino --board=esp32dev arduino/examples/HourMeter   # firmware build check
```

Both suites check the same `test-vectors.json`, so the C++ encoder and the JS decoder (and the reverse) are proven to agree byte for byte. If you change `tools/vectors.input.json`, run `node tools/gen-vectors.js`.

## Further reading

- [SPEC.md](SPEC.md): bytes, CRC parameters, COBS rules, error handling, versioning
- [docs/API-arduino.md](docs/API-arduino.md): `SensorFrameWriter`, `SensorFrameReader`, `SensorFrameView`
- [docs/API-js.md](docs/API-js.md): `createCodec`, `FrameStream`, errors
- [docs/RATIONALE.md](docs/RATIONALE.md): comparison with JSON, MessagePack, CBOR and protobuf
- [CHANGELOG.md](CHANGELOG.md)
