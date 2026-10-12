# SensorFrame (Arduino / PlatformIO)

Header-only, zero-heap library for compact binary sensor frames with CRC16 and COBS framing. Decode them in Node.js with the `sensorframe` npm package.

```cpp
#include <SensorFrame.h>
SensorFrameWriter<> frame;
frame.begin(SF_MSG_TELEMETRY, seq++, 1, millis() / 1000);
frame.addU32(1, runSeconds);
frame.send(Serial);
```

- Quick start, tag tables and transport recipes: [../README.md](../README.md)
- API reference: [../docs/API-arduino.md](../docs/API-arduino.md)
- Wire format: [../SPEC.md](../SPEC.md)
- Examples: `examples/BasicSerial`, `examples/HourMeter`, `examples/Bidirectional`
- Desktop tests: `make -C test`
