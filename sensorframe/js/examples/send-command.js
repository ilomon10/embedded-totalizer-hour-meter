// Send a COMMAND to the Bidirectional sketch and wait for its ACK.
//   node examples/send-command.js /dev/ttyUSB0 500
const { SerialPort } = require('serialport');
const { createCodec, FrameStream, MSG_TYPE } = require('sensorframe');
const tags = require('./tags');

const [path = '/dev/ttyUSB0', value = '0'] = process.argv.slice(2);
const codec = createCodec({ tags });
const port = new SerialPort({ path, baudRate: 115200 });
const seq = Math.floor(Math.random() * 0xffff);

port.pipe(new FrameStream({ codec })).on('data', (msg) => {
  if (msg.msgType === MSG_TYPE.ACK && msg.values.ackSeq === seq) {
    console.log(msg.values.ackStatus === 0 ? 'ACK ok' : `ACK error ${msg.values.ackStatus}`);
    port.close();
  } else {
    console.log(msg.msgTypeName, msg.values);
  }
});

port.on('open', () => {
  // ESP32 dev boards reset when the port opens; give the sketch time to boot.
  setTimeout(() => port.write(codec.frame({ msgType: MSG_TYPE.COMMAND, seq, values: { setCounter: Number(value) } })), 2000);
});
