// Read SensorFrames from a serial port and print them.
//   npm i serialport
//   node examples/serial-reader.js /dev/ttyUSB0 [baud]
const { SerialPort } = require('serialport');
const { FrameStream } = require('sensorframe');
const tags = require('./tags');

const [path = '/dev/ttyUSB0', baud = '115200'] = process.argv.slice(2);
const port = new SerialPort({ path, baudRate: Number(baud) });

port
  .pipe(new FrameStream({ tags }))
  .on('data', (msg) => console.log(msg.msgTypeName, `#${msg.seq}`, msg.values))
  .on('frameError', (err) => console.warn('dropped frame:', err.code, err.message));
