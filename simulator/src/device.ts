// device.ts: the simulated hour meter. It mirrors esp32/src/Application.cpp:
// the same scheduler (telemetry, IMU stream, presence check every 2 s), the same
// command pipeline (duplicate replay -> Bluetooth gate -> validate all -> apply
// settings -> run actions -> ACK) and the same status flags.
//
// No I/O: frames go out through the `send` callback, bytes come in through
// onCommand(), and time comes from the injected Clock. main.ts wires it to a
// transport; the tests drive it with a FakeClock.
import { AccessGate } from './access-gate.ts';
import type { Clock } from './clock.ts';
import { CMD, isSettingTag, readUint, validateCommand } from './commands.ts';
import {
  appendCalibration,
  appendFitting,
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
  GetWhat,
  type HourMeterSnapshot,
  type ImuOutput,
  type Settings,
  StreamMode,
  type Vec3,
  type VibrationLevel,
} from './frames.ts';
import { Ack, codec, type DecodedMessage, Device, Flag, frameBytes, type Message, MSG } from './protocol.ts';

/** Factory defaults, esp32/lib/Storage/src/Settings.cpp (tag order 110..128). */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  telemetryIntervalMs: 1000,
  imuSampleHz: 100,
  imuStreamHz: 10,
  streamMode: StreamMode.filtered,
  persistIntervalS: 60,
  vibrationWindowMs: 1000,
  rtcSyncIntervalS: 60,
  output: 1, // usb
  uartBaud: 115200,
  altActiveHigh: false,
  altDebounceMs: 200,
  pulseRisingEdge: false,
  pulseMinIntervalUs: 1000,
  pulsesPerUnit: 1,
  kalmanQAccel: Math.fround(0.0005),
  kalmanQGyro: Math.fround(0.01),
  kalmanQMag: Math.fround(0.05),
  bluetooth: false,
  btPin: 1234,
});

/** esp_reset_reason_t values the simulator uses (tag 58). */
export const ResetReason = Object.freeze({ powerOn: 1, software: 3, taskWatchdog: 6 });

const PRESENCE_PERIOD_MS = 2000;
const LOST_AFTER_MISSES = 3;
const DUPLICATE_WINDOW_MS = 10_000;
const REBOOT_DELAY_MS = 100;
const IMU_CALIB_SAMPLES = 512;
const MAG_CALIB_MS = 20_000;
const MODULES = [Device.eeprom, Device.rtc, Device.imu, Device.mag];

export interface DeviceOptions {
  deviceId: number;
  runSeconds: number;
  totalCount: number;
  /** Totalizer pulses per second while the engine runs. */
  pulsesPerSecond: number;
  /** Modules physically fitted at power-on (Device bits). */
  fitted: number;
  /** false: the RTC has no battery and loses the time at power-on. */
  rtcBattery: boolean;
  /** The link behaves like a Bluetooth SPP client: locked until unlock=<PIN>. */
  bluetoothSession: boolean;
  btPin: number;
  /** Random source for sensor noise (seeded by main.ts). */
  random: () => number;
}

/** Called for every frame the device sends. `periodic` frames obey `output` and the Bluetooth lock. */
export type SendFn = (frame: Uint8Array, msg: Message & { seq: number }, periodic: boolean) => void;

interface TimeState {
  valid: boolean;
  epochAtSync: number;
  syncMs: number;
  backedUp: boolean; // false = RAM only (timeNotBackedUp)
}

export class SimDevice {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private cal: Calibration = defaultCalibration();
  private readonly gate = new AccessGate();
  private seq = 0;
  private bootMs = 0;
  private resetReason: number = ResetReason.powerOn;
  private bootFlags = 0;
  private devices = 0;
  private fitted: number;
  private misses = new Map<number, number>();
  private eepromMerged = false;
  private stored: { runSeconds: number; totalCount: number; savedEpoch: number; journalSeq: number };
  private runSeconds = 0;
  private runMsRemainder = 0;
  private totalCount = 0;
  private pulseRemainder = 0;
  private lastSavedEpoch = 0;
  private journalSeq = 0;
  private dirty = false;
  private lastPersistMs = 0;
  private lastInputMs = 0;
  private engineOn = true;
  private rtcHasTime: boolean;
  private time: TimeState = { valid: false, epochAtSync: 0, syncMs: 0, backedUp: false };
  private settingsNotSaved = false;
  private imuSinceMs = 0;
  private calib: { kind: number; doneAtMs: number } | null = null;
  private due = { telemetry: 0, stream: 0, presence: 0 };
  private lastCmd: { seq: number; atMs: number; ack: Uint8Array; msg: Message & { seq: number } } | null = null;
  private rebootAtMs: number | null = null;

  constructor(private readonly opts: DeviceOptions, private readonly clock: Clock, private readonly send: SendFn) {
    this.fitted = opts.fitted;
    this.rtcHasTime = (opts.fitted & Device.rtc) !== 0 && opts.rtcBattery;
    this.stored = {
      runSeconds: opts.runSeconds,
      totalCount: opts.totalCount,
      savedEpoch: clock.hostEpochS() - 60, // last EEPROM save a minute before power-on
      journalSeq: 812,
    };
    if (opts.bluetoothSession) this.settings.bluetooth = true;
    this.settings.btPin = opts.btPin;
  }

  // ------------------------------------------------------------ lifecycle ----

  /** Power applied: an RTC without battery has lost its time. */
  powerOn(): void {
    this.boot(ResetReason.powerOn, true);
  }

  /** Reset without a power cut (reboot command, watchdog, DTR on port open): the RTC keeps its time. */
  reset(reason: number): void {
    this.boot(reason, false);
  }

  private boot(reason: number, powerCut: boolean): void {
    const nowMs = this.clock.nowMs();
    this.bootMs = nowMs;
    this.resetReason = reason;
    this.seq = 0;
    this.bootFlags = 0;
    this.devices = this.fitted;
    this.misses.clear();
    this.calib = null;
    this.rebootAtMs = null;
    this.lastCmd = null;
    this.gate.lock();
    this.bootTime(nowMs, powerCut);
    this.bootCounters(nowMs);
    this.imuSinceMs = nowMs;
    this.lastInputMs = nowMs;
    this.due = { telemetry: nowMs + this.telemetryPeriodMs(), stream: nowMs + this.streamPeriodMs(), presence: nowMs };
    this.emit(buildBootEvent(this.hourMeter(), this.status()), true);
  }

  private bootTime(nowMs: number, powerCut: boolean): void {
    const hasRtc = (this.fitted & Device.rtc) !== 0;
    if (hasRtc && powerCut && !this.opts.rtcBattery) {
      // The journal says the last save had a valid time (a used machine), so the loss is reported.
      this.bootFlags |= Flag.rtcBatteryLost;
      this.rtcHasTime = false;
    }
    if (hasRtc && this.rtcHasTime) {
      const epoch = this.time.valid ? this.epochNow(nowMs) : this.clock.hostEpochS();
      this.time = { valid: true, epochAtSync: epoch, syncMs: nowMs, backedUp: true };
    } else {
      this.time = { valid: false, epochAtSync: 0, syncMs: nowMs, backedUp: false }; // RAM time is lost on reset
    }
  }

  private bootCounters(nowMs: number): void {
    this.runSeconds = 0;
    this.totalCount = 0;
    this.runMsRemainder = 0;
    this.lastSavedEpoch = 0;
    this.journalSeq = 0;
    this.eepromMerged = false;
    this.dirty = false;
    this.lastPersistMs = nowMs;
    if ((this.devices & Device.eeprom) !== 0) this.mergeStored();
  }

  private mergeStored(): void {
    const counted = this.runSeconds !== 0 || this.totalCount !== 0;
    this.runSeconds += this.stored.runSeconds;
    this.totalCount += this.stored.totalCount;
    this.lastSavedEpoch = this.stored.savedEpoch;
    this.journalSeq = this.stored.journalSeq;
    this.eepromMerged = true;
    this.dirty = this.dirty || counted;
  }

  // -------------------------------------------------------- scenario hooks ----

  setEngine(on: boolean): void {
    this.engineOn = on;
  }

  engineRunning(): boolean {
    return this.engineOn;
  }

  /** Physically plug or unplug a module. The device notices at its next presence checks. */
  setFitted(bit: number, present: boolean): void {
    // The magnetometer is inside the MPU9250: it leaves and comes back with the IMU.
    const bits = bit === Device.imu ? Device.imu | (this.opts.fitted & Device.mag) : bit;
    this.fitted = present ? this.fitted | bits : this.fitted & ~bits;
  }

  isFitted(bit: number): boolean {
    return (this.fitted & bit) !== 0;
  }

  /** A new client opened the port (TCP connect, tty open). Bluetooth sessions start locked. */
  clientConnected(): void {
    this.gate.lock();
    this.lastCmd = null;
  }

  // ------------------------------------------------------------- the loop ----

  /** Run everything that is due. Call often (main.ts: every 10 ms). */
  poll(): void {
    const nowMs = this.clock.nowMs();
    if (this.rebootAtMs !== null && nowMs >= this.rebootAtMs) return this.reset(ResetReason.software);
    this.runInputs(nowMs);
    this.runCalibration(nowMs);
    if (nowMs >= this.due.presence) this.runPresence(nowMs);
    if (nowMs >= this.due.stream) this.runStream(nowMs);
    if (nowMs >= this.due.telemetry) this.runTelemetry(nowMs);
  }

  private runInputs(nowMs: number): void {
    const elapsedMs = nowMs - this.lastInputMs;
    this.lastInputMs = nowMs;
    if (this.engineOn && elapsedMs > 0) {
      this.runMsRemainder += elapsedMs;
      const whole = Math.floor(this.runMsRemainder / 1000);
      this.runSeconds = (this.runSeconds + whole) >>> 0;
      this.runMsRemainder -= whole * 1000;
      this.pulseRemainder += (elapsedMs / 1000) * this.opts.pulsesPerSecond;
      const pulses = Math.floor(this.pulseRemainder);
      this.totalCount = (this.totalCount + pulses) >>> 0;
      this.pulseRemainder -= pulses;
      this.dirty = this.dirty || whole > 0 || pulses > 0;
    }
    if (this.dirty && nowMs - this.lastPersistMs >= Number(this.settings.persistIntervalS) * 1000) {
      this.persist(nowMs);
    }
  }

  private persist(nowMs: number): void {
    if ((this.devices & Device.eeprom) === 0) return;
    this.journalSeq = (this.journalSeq + 1) >>> 0;
    this.lastSavedEpoch = this.epochNow(nowMs);
    this.stored = {
      runSeconds: this.runSeconds,
      totalCount: this.totalCount,
      savedEpoch: this.lastSavedEpoch,
      journalSeq: this.journalSeq,
    };
    this.dirty = false;
    this.lastPersistMs = nowMs;
  }

  private runPresence(nowMs: number): void {
    this.due.presence = nowMs + PRESENCE_PERIOD_MS;
    const before = this.devices;
    for (const bit of MODULES) this.checkModule(bit);
    if (this.devices === before) return;
    if ((this.devices & Device.imu) !== 0 && (before & Device.imu) === 0) this.imuSinceMs = nowMs;
    if ((this.devices & Device.eeprom) !== 0 && !this.eepromMerged) this.mergeStored();
    if ((this.devices & Device.imu) === 0) this.calib = null;
    this.emit(buildDevicesChangedEvent(this.status()), true);
  }

  // A present module is LOST after 3 failed checks; a missing one is attached at the first answer.
  private checkModule(bit: number): void {
    const answers = (this.fitted & bit) !== 0;
    if ((this.devices & bit) === 0) {
      if (answers) this.devices |= bit;
      return;
    }
    const misses = answers ? 0 : (this.misses.get(bit) ?? 0) + 1;
    this.misses.set(bit, misses);
    if (misses >= LOST_AFTER_MISSES) {
      this.devices &= ~bit;
      this.misses.set(bit, 0);
    }
  }

  private runStream(nowMs: number): void {
    this.due.stream = nowMs + this.streamPeriodMs();
    const mode = Number(this.settings.streamMode);
    if (Number(this.settings.imuStreamHz) === 0 || mode === StreamMode.off) return;
    if ((this.devices & Device.imu) === 0) return;
    this.emit(buildImuStream(this.status(), this.imuOutput(nowMs), mode), true);
  }

  private runTelemetry(nowMs: number): void {
    this.due.telemetry = nowMs + this.telemetryPeriodMs();
    const imu = (this.devices & Device.imu) !== 0 ? this.imuOutput(nowMs) : null;
    const vib = imu && nowMs - this.imuSinceMs >= Number(this.settings.vibrationWindowMs) ? this.vibration() : null;
    this.emit(buildTelemetry(this.hourMeter(), this.status(), imu, vib), true);
  }

  private runCalibration(nowMs: number): void {
    if (!this.calib || nowMs < this.calib.doneAtMs) return;
    const kind = this.calib.kind;
    this.calib = null;
    this.cal = kind === 1 ? { ...this.cal, ...measuredImuCalibration(), flags: this.cal.flags | 1 } : {
      ...this.cal,
      magOffsetUt: { x: 12.5, y: -8.25, z: 31 },
      magScale: { x: 1.02, y: 0.97, z: 1.01 },
      flags: this.cal.flags | 2,
    };
    this.emit(buildCalibrationEvent(this.status(), kind, Ack.Ok, this.cal), true);
  }

  private telemetryPeriodMs(): number {
    return Number(this.settings.telemetryIntervalMs);
  }

  private streamPeriodMs(): number {
    const hz = Number(this.settings.imuStreamHz);
    return hz > 0 ? 1000 / hz : 1000;
  }

  // -------------------------------------------------------------- commands ----

  /** Handle one decoded frame from the host (main.ts splits the byte stream with FrameSplitter). */
  onCommand(cmd: DecodedMessage): void {
    if (cmd.msgType !== MSG.COMMAND) return;
    const nowMs = this.clock.nowMs();
    if (this.lastCmd && this.lastCmd.seq === cmd.seq && nowMs - this.lastCmd.atMs < DUPLICATE_WINDOW_MS) {
      return this.send(this.lastCmd.ack, this.lastCmd.msg, false); // a retry: replay the ACK, run nothing again
    }
    const ack = this.opts.bluetoothSession && !this.gate.unlocked() ? this.bluetoothGate(cmd, nowMs) : null;
    const msg = ack ?? this.handle(cmd, nowMs);
    const sent = this.emit(msg, false);
    this.lastCmd = { seq: cmd.seq, atMs: nowMs, ...sent };
  }

  // Locked Bluetooth session: only a correct unlock gets through. Returns the refusal, or null to proceed.
  private bluetoothGate(cmd: DecodedMessage, nowMs: number): Message | null {
    const unlock = cmd.records.find((r) => r.tag === CMD.unlock);
    const status = unlock ? this.gate.tryUnlock(Number(unlock.raw), Number(this.settings.btPin), nowMs) : Ack.Locked;
    return status === Ack.Ok ? null : buildAck(this.status(), cmd.seq, status, CMD.unlock);
  }

  private handle(cmd: DecodedMessage, nowMs: number): Message {
    const checked = validateCommand(cmd.records, this.settings);
    if ('status' in checked) return buildAck(this.status(), cmd.seq, checked.status, checked.rejectedTag);
    const changedSettings = cmd.records.some((r) => isSettingTag(r.tag));
    if (changedSettings) this.applySettings(checked.next, nowMs);
    const failed = this.runActions(cmd, nowMs);
    if (failed) return buildAck(this.status(), cmd.seq, failed.status, failed.rejectedTag);
    const ack = buildAck(this.status(), cmd.seq, Ack.Ok, 0);
    this.appendRequested(cmd, ack);
    return ack;
  }

  private applySettings(next: Settings, nowMs: number): void {
    this.settingsNotSaved = (this.devices & Device.eeprom) === 0;
    const streamChanged = next.imuStreamHz !== this.settings.imuStreamHz;
    const telemetryChanged = next.telemetryIntervalMs !== this.settings.telemetryIntervalMs;
    this.settings = next;
    if (this.opts.bluetoothSession) this.settings.bluetooth = true; // the simulated client is on Bluetooth
    if (telemetryChanged) this.due.telemetry = nowMs + this.telemetryPeriodMs();
    if (streamChanged) this.due.stream = nowMs + this.streamPeriodMs();
  }

  // Firmware runActions: presets in one frame are one EEPROM write; other actions run in order.
  private runActions(cmd: DecodedMessage, nowMs: number): { status: number; rejectedTag: number } | null {
    let run: number | null = null;
    let count: number | null = null;
    for (const r of cmd.records) {
      if (r.tag === CMD.setRunSeconds) run = readUint(r, 0xffffffff);
      else if (r.tag === CMD.setTotalCount) count = readUint(r, 0xffffffff);
      else if (r.tag === CMD.setTime) this.setTime(Number(r.raw), nowMs);
      else if (r.tag === CMD.resetCounters) {
        if ((this.devices & Device.eeprom) === 0) return { status: Ack.DeviceMissing, rejectedTag: r.tag };
        this.preset(0, 0, nowMs);
      } else if (r.tag === CMD.calibrate) {
        const status = this.startCalibration(Number(r.raw), nowMs);
        if (status !== Ack.Ok) return { status, rejectedTag: r.tag };
      } else if (r.tag === CMD.reboot) this.rebootAtMs = nowMs + REBOOT_DELAY_MS;
    }
    if (run === null && count === null) return null;
    if ((this.devices & Device.eeprom) === 0) {
      return { status: Ack.DeviceMissing, rejectedTag: run !== null ? CMD.setRunSeconds : CMD.setTotalCount };
    }
    this.preset(run, count, nowMs);
    return null;
  }

  private setTime(epoch: number, nowMs: number): void {
    const stored = (this.devices & Device.rtc) !== 0;
    if (stored) this.rtcHasTime = true;
    this.time = { valid: true, epochAtSync: epoch, syncMs: nowMs, backedUp: stored };
  }

  private preset(run: number | null, count: number | null, nowMs: number): void {
    if (run !== null) {
      this.runSeconds = run;
      this.runMsRemainder = 0;
    }
    if (count !== null) this.totalCount = count;
    this.dirty = true;
    this.persist(nowMs);
  }

  private startCalibration(kind: number, nowMs: number): number {
    if ((this.devices & Device.imu) === 0) return Ack.DeviceMissing;
    if (this.calib) return Ack.Busy;
    if (kind === 2 && (this.devices & Device.mag) === 0) return Ack.Unsupported;
    const durationMs = kind === 1 ? (IMU_CALIB_SAMPLES / Number(this.settings.imuSampleHz)) * 1000 : MAG_CALIB_MS;
    this.calib = { kind, doneAtMs: nowMs + durationMs };
    return Ack.Ok;
  }

  // Every get=N appends its group; a group that does not fit in 250 bytes is cut short (firmware appendRequested).
  private appendRequested(cmd: DecodedMessage, ack: Message): void {
    for (const r of cmd.records) {
      if (r.tag !== CMD.get) continue;
      const group: Message['records'] = [];
      const what = Number(r.raw);
      if (what === GetWhat.hourMeter) appendHourMeter(group, this.hourMeter(), true);
      if (what === GetWhat.settings) appendSettings(group, this.settings);
      if (what === GetWhat.status) appendStatus(group, this.status(), true);
      if (what === GetWhat.calibration) appendCalibration(group, this.cal);
      appendFitting(ack.records, group);
    }
  }

  // ------------------------------------------------------------ snapshots ----

  private epochNow(nowMs: number): number {
    if (!this.time.valid) return 0;
    return (this.time.epochAtSync + Math.floor((nowMs - this.time.syncMs) / 1000)) >>> 0;
  }

  hourMeter(): HourMeterSnapshot {
    return {
      runSeconds: this.runSeconds,
      totalCount: this.totalCount,
      running: this.engineOn,
      pulsesPerUnit: Number(this.settings.pulsesPerUnit),
      lastSavedEpoch: this.lastSavedEpoch,
      journalSeq: this.journalSeq,
    };
  }

  status(): DeviceStatus {
    const nowMs = this.clock.nowMs();
    const d = this.devices;
    const has = (bit: number) => (d & bit) !== 0;
    let f = this.bootFlags;
    if (!has(Device.eeprom)) f |= Flag.eepromMissing;
    if (!has(Device.rtc)) f |= Flag.rtcMissing;
    if (!has(Device.imu)) f |= Flag.imuMissing;
    if (!has(Device.mag)) f |= Flag.magMissing;
    if (this.settingsNotSaved) f |= Flag.settingsNotSaved;
    if (!this.time.valid) f |= Flag.timeInvalid;
    if (this.time.valid && !this.time.backedUp) f |= Flag.timeNotBackedUp;
    if ((this.cal.flags & 1) === 0) f |= Flag.imuNotCalibrated;
    if (has(Device.mag) && (this.cal.flags & 2) === 0) f |= Flag.magNotCalibrated;
    if (this.calib) f |= Flag.calibrating;
    return {
      timeValid: this.time.valid,
      epoch: this.epochNow(nowMs),
      uptimeS: Math.floor((nowMs - this.bootMs) / 1000),
      devices: d,
      i2cErrors: 0,
      overruns: 0,
      resetReason: this.resetReason,
      settingsSource: 1,
      btState: this.btState(),
      rtcTempValid: has(Device.rtc),
      rtcTempQuarterC: 117, // 29.25 C
      flags: f >>> 0,
    };
  }

  private btState(): number {
    if (!this.settings.bluetooth) return 0;
    if (!this.opts.bluetoothSession) return 1;
    return this.gate.unlocked() ? 3 : 2;
  }

  /** Bluetooth sessions get live data only after unlock (firmware setBluetoothTelemetry). */
  liveDataAllowed(): boolean {
    if (this.opts.bluetoothSession) return this.gate.unlocked();
    const output = Number(this.settings.output);
    return output === 1 || output === 3; // the simulated port is the USB port
  }

  private imuOutput(nowMs: number): ImuOutput {
    const t = (nowMs - this.bootMs) / 1000;
    const shake = this.engineOn ? 0.04 : 0.003;
    const n = (scale: number) => (this.opts.random() - 0.5) * scale;
    const hasMag = (this.devices & Device.mag) !== 0;
    const rollDeg = 1.5 + Math.sin(t / 7);
    const pitchDeg = -0.8 + Math.cos(t / 9);
    const accel: Vec3 = { x: n(shake), y: n(shake), z: 1 + n(shake) };
    const gyro: Vec3 = { x: n(0.3), y: n(0.3), z: n(0.3) };
    const mag: Vec3 = { x: 30 + n(0.5), y: -5 + n(0.5), z: -40 + n(0.5) };
    return {
      rawAccelG: jitter(accel, n, 0.05),
      rawGyroDps: jitter(gyro, n, 2),
      rawMagUt: jitter(mag, n, 3),
      accelG: accel,
      gyroDps: gyro,
      magUt: mag,
      rollDeg,
      pitchDeg,
      headingDeg: (t * 3) % 360,
      headingValid: hasMag,
      hasMag,
    };
  }

  private vibration(): VibrationLevel {
    const rmsMg = this.engineOn ? 35 + this.opts.random() * 8 : 2 + this.opts.random();
    return { rmsMg, peakMg: rmsMg * 2.8 };
  }

  // ------------------------------------------------------------------ send ----

  // Every frame takes the next seq (wraps 65535 -> 0), like the firmware's txSeq_.
  private emit(msg: Message, periodic: boolean): { ack: Uint8Array; msg: Message & { seq: number } } {
    const full = { ...msg, seq: this.seq };
    this.seq = (this.seq + 1) & 0xffff;
    const bytes = frameBytes(codec.encode({ ...full, deviceId: this.opts.deviceId >>> 0 }));
    this.send(bytes, full, periodic);
    return { ack: bytes, msg: full };
  }
}

function jitter(v: Vec3, n: (s: number) => number, scale: number): Vec3 {
  return { x: v.x + n(scale), y: v.y + n(scale), z: v.z + n(scale) };
}

/** Uncalibrated device: no bias, typical MPU9250 noise, mag offset 0 / scale 1. */
export function defaultCalibration(): Calibration {
  return {
    accelBiasG: { x: 0, y: 0, z: 0 },
    gyroBiasDps: { x: 0, y: 0, z: 0 },
    accelNoiseVar: { x: 0.0004, y: 0.0004, z: 0.0004 },
    gyroNoiseVar: { x: 0.01, y: 0.01, z: 0.01 },
    magOffsetUt: { x: 0, y: 0, z: 0 },
    magScale: { x: 1, y: 1, z: 1 },
    flags: 0, // Settings.cpp defaults
  };
}

function measuredImuCalibration(): Omit<Calibration, 'magOffsetUt' | 'magScale' | 'flags'> {
  return {
    accelBiasG: { x: 0.012, y: -0.004, z: 0.021 },
    gyroBiasDps: { x: 0.41, y: -0.22, z: 0.09 },
    accelNoiseVar: { x: 0.00004, y: 0.00005, z: 0.00007 },
    gyroNoiseVar: { x: 0.0021, y: 0.0019, z: 0.0024 },
  };
}
