# sensorframe (Node.js)

Decode and encode SensorFrame packets: compact binary sensor frames from ESP32/Arduino, with CRC16 and COBS framing. Zero dependencies, no schema compile step.

```js
const { FrameStream } = require('sensorframe');

port.pipe(new FrameStream({ tags: { 1: { name: 'runSeconds', fmt: 'u32' } } }))
  .on('data', (msg) => console.log(msg.values));
```

- Quick start, tag tables and transport recipes: [../README.md](../README.md)
- API reference: [../docs/API-js.md](../docs/API-js.md)
- Wire format: [../SPEC.md](../SPEC.md)
- Try it without hardware: `node examples/simulate.js`
