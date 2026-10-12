// frames.ts: pure frame builders, a line-by-line port of the firmware's
// esp32/lib/App/src/Telemetry.cpp, buildAck() in CommandHandler.cpp and
// appendAll/appendCalibration in SettingsSchema.cpp.
//
// Records are emitted in the SAME ORDER and with the SAME scaling as the
// firmware, so the bytes are identical (test/frames.test.ts proves it against
// the firmware's golden frames). No I/O and no clock here.
import { FIRMWARE_VERSION, type Message, MSG, type Rec, rec, SETTINGS } from './protocol.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Firmware HourMeterSnapshot. */
export interface HourMeterSnapshot {
  runSeconds: number;
  totalCount: number;
  running: boolean;
  pulsesPerUnit: number;
  lastSavedEpoch: number;
  journalSeq: number;
}

/** Firmware DeviceStatus. */
export interface DeviceStatus {
  timeValid: boolean;
  epoch: number;
  uptimeS: number;
  devices: number;
  i2cErrors: number;
  overruns: number;
  resetReason: number;
  settingsSource: number;
  btState: number;
  rtcTempValid: boolean;
  rtcTempQuarterC: number;
  flags: number;
}

/** Firmware ImuOutput (units: g, deg/s, uT, deg). */
export interface ImuOutput {
  rawAccelG: Vec3;
  rawGyroDps: Vec3;
  rawMagUt: Vec3;
  accelG: Vec3;
  gyroDps: Vec3;
  magUt: Vec3;
  rollDeg: number;
  pitchDeg: number;
  headingDeg: number;
  headingValid: boolean;
  hasMag: boolean;
}

export interface VibrationLevel {
  rmsMg: number;
  peakMg: number;
}

/** Firmware Calibration. `flags`: bit 0 IMU calibrated, bit 1 magnetometer calibrated. */
export interface Calibration {
  accelBiasG: Vec3;
  gyroBiasDps: Vec3;
  accelNoiseVar: Vec3;
  gyroNoiseVar: Vec3;
  magOffsetUt: Vec3;
  magScale: Vec3;
  flags: number;
}

export type Settings = Record<string, number | boolean>;

export const StreamMode = Object.freeze({ off: 0, raw: 1, filtered: 2, both: 3 });
export const EventKind = Object.freeze({ boot: 1, calibrationDone: 2, devicesChanged: 3 });
export const GetWhat = Object.freeze({ hourMeter: 1, settings: 2, status: 3, calibration: 4 });

const EPOCH_2000 = 946684800;

export function headerTimestamp(st: DeviceStatus): number {
  return st.timeValid ? st.epoch : st.uptimeS;
}

// C roundf(): halves round away from zero (Math.round rounds them up).
function roundf(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v));
}

export function toI16(value: number, scale: number): number {
  const v = roundf(Math.fround(value * scale));
  if (Number.isNaN(v)) return 0;
  return Math.max(-32768, Math.min(32767, v));
}

export function toU16(value: number, scale: number): number {
  const v = roundf(Math.fround(value * scale));
  if (Number.isNaN(v) || v < 0) return 0;
  return Math.min(65535, v);
}

export function appendHourMeter(out: Rec[], hm: HourMeterSnapshot, withPersistInfo: boolean): void {
  const ppu = hm.pulsesPerUnit === 0 ? 1 : hm.pulsesPerUnit;
  out.push(
    rec('runSeconds', hm.runSeconds),
    rec('totalCount', hm.totalCount),
    rec('alternator', hm.running),
    rec('runHours', Math.floor(hm.runSeconds / 36)), // x0.01 h
    rec('totalUnits', Number((BigInt(hm.totalCount) * 100n) / BigInt(ppu))), // x0.01 unit
  );
  if (withPersistInfo) out.push(rec('lastSavedEpoch', hm.lastSavedEpoch), rec('journalSeq', hm.journalSeq));
}

export function appendStatus(out: Rec[], st: DeviceStatus, full: boolean): void {
  out.push(rec('timeValid', st.timeValid), rec('statusFlags', st.flags >>> 0));
  if (!full) return;
  out.push(
    rec('epoch', st.epoch),
    rec('uptime', st.uptimeS),
    rec('devices', st.devices),
    rec('i2cErrors', st.i2cErrors),
    rec('overruns', st.overruns),
    rec('resetReason', st.resetReason),
    rec('settingsSource', st.settingsSource),
    rec('btState', st.btState),
    rec('fwVersion', FIRMWARE_VERSION),
  );
  if (st.rtcTempValid) out.push(rec('rtcTemp', st.rtcTempQuarterC));
}

export function appendDerived(out: Rec[], imu: ImuOutput, vib: VibrationLevel | null): void {
  out.push(rec('roll', toI16(imu.rollDeg, 100)), rec('pitch', toI16(imu.pitchDeg, 100)));
  if (imu.headingValid) out.push(rec('heading', toU16(imu.headingDeg, 100)));
  if (vib) out.push(rec('vibRms', toU16(vib.rmsMg, 1)), rec('vibPeak', toU16(vib.peakMg, 1)));
}

/** TELEMETRY. `imu` null = no IMU fitted; `vib` null = first vibration window not finished yet. */
export function buildTelemetry(
  hm: HourMeterSnapshot,
  st: DeviceStatus,
  imu: ImuOutput | null,
  vib: VibrationLevel | null,
): Message {
  const records: Rec[] = [];
  appendHourMeter(records, hm, false);
  appendStatus(records, st, false);
  if (imu) appendDerived(records, imu, vib);
  return { msgType: MSG.TELEMETRY, timestamp: headerTimestamp(st), records };
}

function addAxes(out: Rec[], firstName: string, axes: [string, string, string], v: Vec3, scale: number): void {
  const [x, y, z] = axes;
  out.push(
    rec(`${firstName}${x}`, toI16(v.x, scale)),
    rec(`${firstName}${y}`, toI16(v.y, scale)),
    rec(`${firstName}${z}`, toI16(v.z, scale)),
  );
}

/** IMU stream (msgType 128). Accel g -> mg (x1000), gyro deg/s -> 0.1 deg/s (x10), mag uT -> 0.1 uT (x10). */
export function buildImuStream(st: DeviceStatus, imu: ImuOutput, mode: number): Message {
  const records: Rec[] = [];
  const xyz: [string, string, string] = ['X', 'Y', 'Z'];
  if (mode === StreamMode.raw || mode === StreamMode.both) {
    addAxes(records, 'rawAccel', xyz, imu.rawAccelG, 1000);
    addAxes(records, 'rawGyro', xyz, imu.rawGyroDps, 10);
    if (imu.hasMag) addAxes(records, 'rawMag', xyz, imu.rawMagUt, 10);
  }
  if (mode === StreamMode.filtered || mode === StreamMode.both) {
    addAxes(records, 'accel', xyz, imu.accelG, 1000);
    addAxes(records, 'gyro', xyz, imu.gyroDps, 10);
    if (imu.hasMag) addAxes(records, 'mag', xyz, imu.magUt, 10);
    appendDerived(records, imu, null);
  }
  return { msgType: MSG.IMU, timestamp: headerTimestamp(st), records };
}

export function buildBootEvent(hm: HourMeterSnapshot, st: DeviceStatus): Message {
  const records: Rec[] = [rec('eventKind', EventKind.boot)];
  appendHourMeter(records, hm, true);
  appendStatus(records, st, true);
  return { msgType: MSG.EVENT, timestamp: headerTimestamp(st), records };
}

export function buildCalibrationEvent(st: DeviceStatus, kind: number, result: number, cal: Calibration): Message {
  const records: Rec[] = [
    rec('eventKind', EventKind.calibrationDone),
    rec('calibrate', kind),
    rec('calibResult', result),
  ];
  if (result === 0) appendCalibration(records, cal);
  return { msgType: MSG.EVENT, timestamp: headerTimestamp(st), records };
}

export function buildDevicesChangedEvent(st: DeviceStatus): Message {
  const records: Rec[] = [rec('eventKind', EventKind.devicesChanged)];
  appendStatus(records, st, true);
  return { msgType: MSG.EVENT, timestamp: headerTimestamp(st), records };
}

/** ACK header records. Requested data (get=...) is appended by the caller. */
export function buildAck(st: DeviceStatus, cmdSeq: number, status: number, rejectedTag: number): Message {
  const records: Rec[] = [rec('ackSeq', cmdSeq), rec('ackStatus', status)];
  if (rejectedTag !== 0) records.push(rec('rejectedTag', rejectedTag));
  return { msgType: MSG.ACK, timestamp: headerTimestamp(st), records };
}

/** All settings in tag order (110..128) with the firmware's wire types. */
export function appendSettings(out: Rec[], s: Settings): void {
  for (const name of Object.keys(SETTINGS)) {
    const value = s[name];
    out.push(rec(name, typeof value === 'boolean' ? value : Number(value)));
  }
}

function addVec(out: Rec[], prefix: string, v: Vec3): void {
  out.push(rec(`${prefix}X`, v.x), rec(`${prefix}Y`, v.y), rec(`${prefix}Z`, v.z));
}

export function appendCalibration(out: Rec[], c: Calibration): void {
  addVec(out, 'calAccelBias', c.accelBiasG);
  addVec(out, 'calGyroBias', c.gyroBiasDps);
  addVec(out, 'calAccelNoise', c.accelNoiseVar);
  addVec(out, 'calGyroNoise', c.gyroNoiseVar);
  addVec(out, 'calMagOffset', c.magOffsetUt);
  addVec(out, 'calMagScale', c.magScale);
  out.push(rec('calFlags', c.flags));
}

const RECORD_BYTES: Record<string, number> = { u8: 3, bool: 3, u16: 4, i16: 4, u32: 6, f32: 6 };
const HEADER_AND_CRC_BYTES = 14;
const MAX_PACKET_BYTES = 250;

export function packetSize(records: Rec[]): number {
  return records.reduce((n, r) => n + RECORD_BYTES[r.fmt], HEADER_AND_CRC_BYTES);
}

/**
 * Append a group of records the way FrameWriter does when the packet is full:
 * each add that does not fit fails, and `ok && add(...)` skips the rest of the group.
 */
export function appendFitting(out: Rec[], group: Rec[]): void {
  let size = packetSize(out);
  for (const r of group) {
    size += RECORD_BYTES[r.fmt];
    if (size > MAX_PACKET_BYTES) return;
    out.push(r);
  }
}

/** Time range the firmware accepts for setTime (DS3231 range). */
export const EPOCH_MIN = EPOCH_2000;
export const EPOCH_MAX = 4102444799; // 2099-12-31T23:59:59Z
