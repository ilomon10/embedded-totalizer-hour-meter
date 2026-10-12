// Live view of everything the device sends.
//   node reader.js [/dev/ttyUSB0 | /dev/rfcomm0] [--imu] [--no-time-sync] [--pin 1234]
//   --imu           also print the IMU stream
//   --no-time-sync  do not send the PC clock when the device reports an unknown time
//                   (by default it does: needed when the RTC has no backup battery)
const { DeviceClient } = require('./device');
const { MSG, EVENT_KIND, decodeStatusFlags } = require('./tags');

const args = process.argv.slice(2);
const path = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--pin') || process.env.HOUR_METER_PORT || '/dev/ttyUSB0';
const showImu = args.includes('--imu');
const timeSync = !args.includes('--no-time-sync');
const pinIdx = args.indexOf('--pin');
const pin = pinIdx >= 0 ? args[pinIdx + 1] : process.env.HOUR_METER_PIN;

function when(msg) {
  // Header timestamp is UTC epoch when timeValid, otherwise seconds since boot.
  return msg.values.timeValid === false ? `uptime ${msg.timestamp}s` : new Date(msg.timestamp * 1000).toISOString();
}

DeviceClient.open(path, { pin }).then((dev) => {
  if (timeSync) {
    dev.enableAutoTimeSync()
      .on('timeSynced', (e) => console.log(`time sync: device clock set to ${new Date(e * 1000).toISOString()} (UTC)`))
      .on('timeSyncError', (err) => console.warn('time sync failed:', err.message));
  }
  dev.on('frame', (msg) => {
    const v = msg.values;
    if (msg.msgType === MSG.TELEMETRY) {
      const imu = v.roll !== undefined ? ` roll ${v.roll}° pitch ${v.pitch}°${v.heading !== undefined ? ` heading ${v.heading}°` : ''}` : '';
      const vib = v.vibRms !== undefined ? ` vib ${v.vibRms}/${v.vibPeak} mg` : '';
      const flags = decodeStatusFlags(v.statusFlags ?? 0);
      console.log(`${when(msg)} #${msg.seq} engine ${v.alternator ? 'ON ' : 'OFF'} run ${v.runHours.toFixed(2)} h total ${v.totalCount}${imu}${vib}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    } else if (msg.msgType === MSG.EVENT) {
      console.log(`${when(msg)} EVENT ${EVENT_KIND[v.eventKind] ?? v.eventKind}`, v);
    } else if (msg.msgType === MSG.IMU && showImu) {
      console.log(`${when(msg)} IMU`, v);
    }
  });
  dev.on('frameError', (err) => console.warn('dropped frame:', err.code));
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
