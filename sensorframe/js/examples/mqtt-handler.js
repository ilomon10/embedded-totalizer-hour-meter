// Packet transports (MQTT, WebSocket, ESP-NOW gateway, LoRa): the transport
// already delimits messages, so the device sends the raw packet (no COBS) and
// you call codec.decode() directly.
//   npm i mqtt
//   node examples/mqtt-handler.js mqtt://localhost devices/+/telemetry
const mqtt = require('mqtt');
const { createCodec } = require('sensorframe');
const tags = require('./tags');

const [url = 'mqtt://localhost', topic = 'devices/+/telemetry'] = process.argv.slice(2);
const codec = createCodec({ tags });
const client = mqtt.connect(url);

client.on('connect', () => client.subscribe(topic));
client.on('message', (t, payload) => {
  try {
    const msg = codec.decode(payload);
    console.log(t, msg.deviceId.toString(16), msg.values);
  } catch (err) {
    console.warn(t, 'bad packet:', err.code);
  }
});
