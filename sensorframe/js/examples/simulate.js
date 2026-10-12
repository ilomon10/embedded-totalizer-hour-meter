// No hardware? Simulate a device: encode frames, split them into random
// chunks like a serial port would, and decode them with FrameStream.
//   node examples/simulate.js
const { PassThrough } = require('stream');
const { createCodec, FrameStream } = require('sensorframe');
const tags = require('./tags');

const codec = createCodec({ tags });
const wire = new PassThrough();

wire
  .pipe(new FrameStream({ codec }))
  .on('data', (msg) => console.log(msg.msgTypeName, `#${msg.seq}`, msg.values))
  .on('frameError', (err) => console.warn('dropped frame:', err.code));

let seq = 0;
const timer = setInterval(() => {
  const n = seq++;
  const bytes = codec.frame({
    seq: n,
    deviceId: 0x12345678,
    timestamp: n,
    values: { runSeconds: 3600 + n, totalCount: 1234 + n * 3, alternator: n % 2 === 0, temperature: 23.4 },
  });
  const cut = 1 + Math.floor(Math.random() * (bytes.length - 1));
  wire.write(bytes.subarray(0, cut));
  wire.write(bytes.subarray(cut));
  if (seq === 3) {
    clearInterval(timer);
    wire.end();
  }
}, 200);
