// catalog.ts: every example frame in esp32/docs/FRAME-CATALOG.md, built from
// fixed inputs with the same builders the simulator uses. test/catalog.test.ts
// fails if the doc's hex dumps differ from these bytes.
import {
  appendCalibration,
  appendHourMeter,
  appendSettings,
  appendStatus,
  buildAck,
  buildBootEvent,
  buildCalibrationEvent,
  buildDevicesChangedEvent,
  buildImuStream,
  buildTelemetry,
  type Calibration,
  type DeviceStatus,
  type HourMeterSnapshot,
  type ImuOutput,
  StreamMode,
} from '../src/frames.ts';
import { DEFAULT_SETTINGS } from '../src/device.ts';
import { Ack, codec, Device, Flag, frameBytes, type Message, MSG, rec, RESET_MAGIC, TAGS } from '../src/protocol.ts';

export const DEVICE_ID = 0x1a2b3c4d;
const EPOCH = 1791376496; // 2026-10-07T12:34:56Z

const hm: HourMeterSnapshot = {
  runSeconds: 4500000, // 1250.00 h
  totalCount: 15000,
  running: true,
  inputActive: true,
  pulsesPerUnit: 1,
  lastSavedEpoch: 1791376440,
  journalSeq: 812,
};

const st: DeviceStatus = {
  timeValid: true,
  epoch: EPOCH,
  uptimeS: 3600,
  devices: Device.eeprom | Device.rtc | Device.imu | Device.mag,
  i2cErrors: 0,
  overruns: 0,
  resetReason: 1,
  settingsSource: 1,
  btState: 0,
  lastCause: 0,
  lastStage: 0,
  rtcTempValid: true,
  rtcTempQuarterC: 117, // 29.25 C
  flags: 0,
};

const imu: ImuOutput = {
  rawAccelG: { x: 0.021, y: -0.012, z: 1.004 },
  rawGyroDps: { x: 0.6, y: -0.4, z: 0.1 },
  rawMagUt: { x: 30.4, y: -5.2, z: -40.1 },
  accelG: { x: 0.008, y: -0.004, z: 0.998 },
  gyroDps: { x: 0.1, y: -0.1, z: 0 },
  magUt: { x: 30.1, y: -5, z: -40 },
  rollDeg: 2.5,
  pitchDeg: -0.48,
  headingDeg: 33.5,
  headingValid: true,
  hasMag: true,
};

const cal: Calibration = {
  accelBiasG: { x: 0.012, y: -0.004, z: 0.021 },
  gyroBiasDps: { x: 0.41, y: -0.22, z: 0.09 },
  accelNoiseVar: { x: 0.00004, y: 0.00005, z: 0.00007 },
  gyroNoiseVar: { x: 0.0021, y: 0.0019, z: 0.0024 },
  magOffsetUt: { x: 12.5, y: -8.25, z: 31 },
  magScale: { x: 1.02, y: 0.97, z: 1.01 },
  flags: 3,
};

export interface CatalogFrame {
  id: string;
  title: string;
  seq: number;
  deviceId: number;
  msg: Message;
}

function ack(cmdSeq: number, status: number, rejectedTag = 0, extra?: (records: Message['records']) => void): Message {
  const msg = buildAck(st, cmdSeq, status, rejectedTag);
  extra?.(msg.records);
  return msg;
}

function cmd(...records: Message['records']): Message {
  return { msgType: MSG.COMMAND, timestamp: 0, records };
}

const device = (id: string, title: string, seq: number, msg: Message): CatalogFrame => ({
  id,
  title,
  seq,
  deviceId: DEVICE_ID,
  msg,
});
const host = (id: string, title: string, seq: number, msg: Message): CatalogFrame => ({
  id,
  title,
  seq,
  deviceId: 0,
  msg,
});

export function catalogFrames(): CatalogFrame[] {
  const noImu: DeviceStatus = {
    ...st,
    devices: Device.eeprom | Device.rtc,
    flags: Flag.imuMissing | Flag.magMissing,
  };
  return [
    device('telemetry', 'TELEMETRY, IMU fitted', 120, buildTelemetry(hm, st, imu, { rmsMg: 37, peakMg: 103 })),
    device('telemetry-no-imu', 'TELEMETRY, no IMU', 120, buildTelemetry(hm, noImu, null, null)),
    device('event-boot', 'EVENT boot', 0, buildBootEvent(hm, st)),
    device('event-calibration', 'EVENT calibration done (IMU, Ok)', 57, buildCalibrationEvent(st, 1, Ack.Ok, cal)),
    device('event-calibration-failed', 'EVENT calibration failed', 57, buildCalibrationEvent(st, 2, Ack.Failed, cal)),
    device('event-devices-changed', 'EVENT modules changed (IMU lost)', 300, buildDevicesChangedEvent(noImu)),
    device('imu-raw', 'IMU stream, streamMode=1 raw', 121, buildImuStream(st, imu, StreamMode.raw)),
    device('imu-filtered', 'IMU stream, streamMode=2 filtered', 121, buildImuStream(st, imu, StreamMode.filtered)),
    device('imu-both', 'IMU stream, streamMode=3 both', 121, buildImuStream(st, imu, StreamMode.both)),
    device('ack-ok', 'ACK Ok (to setTime)', 130, ack(42, Ack.Ok)),
    device('ack-error', 'ACK InvalidValue, rejectedTag 111', 131, ack(44, Ack.InvalidValue, 111)),
    device(
      'ack-get-hour',
      'ACK to get=1',
      132,
      ack(43, Ack.Ok, 0, (r) => appendHourMeter(r, hm, true)),
    ),
    device(
      'ack-get-settings',
      'ACK to get=2',
      133,
      ack(45, Ack.Ok, 0, (r) => appendSettings(r, { ...DEFAULT_SETTINGS })),
    ),
    device(
      'ack-get-status',
      'ACK to get=3',
      134,
      ack(46, Ack.Ok, 0, (r) => appendStatus(r, st, true)),
    ),
    device(
      'ack-get-calibration',
      'ACK to get=4',
      135,
      ack(47, Ack.Ok, 0, (r) => appendCalibration(r, cal)),
    ),
    device('ack-locked', 'ACK Locked (Bluetooth, before unlock)', 136, ack(48, Ack.Locked, 107)),
    host('cmd-set-time', 'COMMAND setTime', 42, cmd(rec('setTime', EPOCH))),
    host('cmd-get-hour', 'COMMAND get=1', 43, cmd(rec('get', 1))),
    host(
      'cmd-settings',
      'COMMAND write two settings',
      44,
      cmd(rec('telemetryIntervalMs', 500), rec('streamMode', StreamMode.off)),
    ),
    host(
      'cmd-preset',
      'COMMAND preset counters',
      49,
      cmd(rec('setRunSeconds', 4500000), rec('setTotalCount', 0), rec('get', 1)),
    ),
    host('cmd-reset', 'COMMAND resetCounters', 50, cmd(rec('resetCounters', RESET_MAGIC))),
    host('cmd-calibrate', 'COMMAND calibrate IMU', 51, cmd(rec('calibrate', 1))),
    host('cmd-unlock', 'COMMAND unlock (Bluetooth)', 52, cmd(rec('unlock', 1234))),
  ];
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function packetOf(f: CatalogFrame): Uint8Array {
  return codec.encode({ ...f.msg, seq: f.seq, deviceId: f.deviceId });
}

/** The bytes on the wire: COBS(packet) + 0x00, wrapped at 16 bytes per line. */
export function wireHex(f: CatalogFrame): string {
  const bytes = hexOf(frameBytes(packetOf(f))).split(' ');
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) lines.push(bytes.slice(i, i + 16).join(' '));
  return lines.join('\n');
}

const SIZE: Record<string, number> = { u8: 1, bool: 1, u16: 2, i16: 2, u32: 4, f32: 4 };

/** One table row per record, in wire order: tag, name, fmt, bytes, raw value. */
export function recordRows(f: CatalogFrame): string[] {
  return f.msg.records.map((r) => {
    const def = TAGS[r.tag];
    const raw =
      typeof r.value === 'number' && def.fmt === 'f32' ? Number(Math.fround(r.value).toPrecision(6)) : r.value;
    return `| ${r.tag} | \`${def.name}\` | ${def.fmt} | ${2 + SIZE[def.fmt]} | ${raw} |`;
  });
}

export function sizes(f: CatalogFrame): { packet: number; wire: number } {
  const packet = packetOf(f);
  return { packet: packet.length, wire: frameBytes(packet).length };
}
