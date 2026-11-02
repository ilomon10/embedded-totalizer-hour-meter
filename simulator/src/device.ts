// device.ts: the simulated hour meter. It mirrors esp32/src/Application.cpp:
// the same scheduler (telemetry, IMU stream, presence check every 2 s), the same
// command pipeline (duplicate replay -> Bluetooth gate -> validate all -> apply
// settings -> run actions -> ACK) and the same status flags. The I2C bus is
// supervised like the firmware does (bus-guard.ts): a bus that stays bad is parked,
// never a reason to restart.
//
// No I/O: frames go out through the `send` callback, bytes come in through
// onCommand(), and time comes from the injected Clock. main.ts wires it to a
// transport; the tests drive it with a FakeClock.
import { AccessGate } from './access-gate.ts';
import { BusGuard } from './bus-guard.ts';
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
  type VibrationLevel,
} from './frames.ts';
import {
  defaultInputs,
  effectiveInputs,
  type Group,
  type Inputs,
  type InputValues,
  setAuto,
  setManual,
  setVehicleModes,
} from './inputs.ts';
import { RunConfirm } from './run-confirm.ts';
import type { VehicleSim } from './vehicle/sim.ts';
import { Ack, codec, type DecodedMessage, Device, Flag, frameBytes, type Message, MSG } from './protocol.ts';

/** Factory defaults, esp32/lib/Storage/src/Settings.cpp (table order: tags 110..129, then 150 and 151). */
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
  runVibMinMg: 0,
  i2c: true,
  pulseInput: true,
});

/** esp_reset_reason_t values the simulator uses (tag 58). */
export const ResetReason = Object.freeze({ powerOn: 1, software: 3, taskWatchdog: 6 });

/** Protocol.h LastCause (tag 62) and Stage (tag 63) values the simulator uses. */
export const LastCause = Object.freeze({
  none: 0,
  watchdog: 1,
  i2cStuck: 2, // firmware <= 2.6.0 only: 2.7.0 parks a bad bus instead, so the simulator never sends it
  usbStalled: 3,
  panicSignal: 4,
  rebootCommand: 5,
  crash: 6,
});
export const Stage = Object.freeze({ unknown: 0, boot: 1, rtc: 6, imu: 7, serial: 8 });

/** Why and where the previous run ended, reported by the next boot EVENT. */
export interface RestartInfo {
  reason: number;
  cause: number;
  stage: number;
}

/** What can be wrong on the I2C bus, and what `i2cLines` (tag 64) reports while the firmware has parked it. */
export interface BusFault {
  /** A module or a short holds SDA low (i2cLines bit 0). */
  sdaLow: boolean;
  /** A module or a short holds SCL low (i2cLines bit 1). */
  sclLow: boolean;
  /** Both lines are free but every transfer times out (a module that hangs, noise): i2cLines 0. */
  timeouts: boolean;
}

const PRESENCE_PERIOD_MS = 2000;
const LOST_AFTER_MISSES = 3;
const DUPLICATE_WINDOW_MS = 10_000;
const REBOOT_DELAY_MS = 100;
const IMU_CALIB_SAMPLES = 512;
const MAG_CALIB_MS = 20_000;
const MODULES = [Device.eeprom, Device.rtc, Device.imu, Device.mag];

/** Firmware storage_mirror::combine: the other history added to the counters `own` counted from zero. */
function combine(own: Stored, other: Stored): Stored {
  return {
    ...own,
    runSeconds: own.runFromZero ? own.runSeconds + other.runSeconds : own.runSeconds,
    totalCount: own.countFromZero ? own.totalCount + other.totalCount : own.totalCount,
    runFromZero: false,
    countFromZero: false,
  };
}

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
  /** First boot after 3 unplanned restarts (watchdog, crash, USB stall): no I2C at all (safe-mode scenario). */
  safeMode?: boolean;
  /** What a module or a short does to the I2C bus from power-on (i2c-parked scenario); the web UI changes it live. */
  busFault?: Partial<BusFault>;
  /** false: no "hmdata" partition (an old partition table): flashStoreMissing, the EEPROM is the only store. */
  flashStore?: boolean;
  /** The flash copy is empty: the first boot after updating to 2.6.0 (the EEPROM's values move to the flash). */
  freshFlash?: boolean;
  /** What the first boot reports as the previous run's end (default: power-on, cause none). */
  firstBoot?: RestartInfo;
}

/** Called for every frame the device sends. `periodic` frames obey `output` and the Bluetooth lock. */
export type SendFn = (frame: Uint8Array, msg: Message & { seq: number }, periodic: boolean) => void;

interface TimeState {
  valid: boolean;
  epochAtSync: number;
  syncMs: number;
  backedUp: boolean; // false = RAM only (timeNotBackedUp)
}

/** A saved counter record (firmware JournalRecord), in the flash or in the EEPROM. */
interface Stored {
  runSeconds: number;
  totalCount: number;
  savedEpoch: number;
  journalSeq: number;
  lineage: number; // which history (firmware StorageMirror.h); 0 = written by firmware 2.5.0 or older
  runFromZero: boolean; // the hour meter started at 0, its real value unknown
  countFromZero: boolean;
}

export class SimDevice {
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private cal: Calibration = defaultCalibration();
  private readonly gate = new AccessGate();
  private seq = 0;
  private bootMs = 0;
  private resetReason: number = ResetReason.powerOn;
  private lastCause: number = LastCause.none;
  private lastStage: number = Stage.unknown;
  private safeMode = false;
  private hung = false;
  private booted = false;
  private bootFlags = 0;
  private devices = 0;
  private fitted: number;
  private misses = new Map<number, number>();
  private busFault: BusFault;
  private guard = new BusGuard(); // firmware busGuard_: parks the bus when it stays bad, retries it later
  private linesLow = 0; // firmware bus_.linesLow(): the lines the last bus recovery found held low
  private devicesChanged = false; // the modules changed: reported by an EVENT at the next poll
  // Firmware 2.6.0 keeps the counters twice (StorageMirror.h): the ESP32's flash is the main store, the EEPROM a copy.
  private stored: Stored; // the EEPROM's copy
  private readonly flashAvailable: boolean; // false without the "hmdata" partition
  private flashStored: Stored | null; // the flash copy; null while empty
  private lineage = 0; // this device's history
  private runFromZero = false;
  private countFromZero = false;
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
  private vibrationMg: readonly [number, number] | null = null;
  private runConfirm = new RunConfirm();
  private rtcHasTime: boolean;
  private time: TimeState = { valid: false, epochAtSync: 0, syncMs: 0, backedUp: false };
  private settingsNotSaved = false;
  private imuSinceMs = 0;
  private calib: { kind: number; doneAtMs: number } | null = null;
  private due = { telemetry: 0, stream: 0, presence: 0 };
  private lastCmd: { seq: number; atMs: number; ack: Uint8Array; msg: Message & { seq: number } } | null = null;
  private rebootAtMs: number | null = null;
  private inputState: Inputs = defaultInputs();
  private vehicleSim: VehicleSim | null = null;
  /** This moment's sensor values (auto or manual per group), refreshed on every poll. */
  private current: InputValues;

  constructor(
    private readonly opts: DeviceOptions,
    private readonly clock: Clock,
    private readonly send: SendFn,
  ) {
    this.fitted = opts.fitted;
    this.busFault = { sdaLow: false, sclLow: false, timeouts: false, ...opts.busFault };
    this.rtcHasTime = (opts.fitted & Device.rtc) !== 0 && opts.rtcBattery;
    this.stored = {
      runSeconds: opts.runSeconds,
      totalCount: opts.totalCount,
      savedEpoch: clock.hostEpochS() - 60, // last save a minute before power-on
      journalSeq: 812,
      lineage: 0x2a2a2a2a,
      runFromZero: false,
      countFromZero: false,
    };
    this.flashAvailable = opts.flashStore !== false;
    this.flashStored = this.flashAvailable && !opts.freshFlash ? { ...this.stored } : null; // both stores in step
    if (opts.freshFlash) this.stored.lineage = 0; // the EEPROM was last written by firmware 2.5.0
    if (opts.bluetoothSession) this.settings.bluetooth = true;
    this.settings.btPin = opts.btPin;
    this.inputState.manual.pulses.perSecond = opts.pulsesPerSecond;
    this.inputState.manual.rtc.battery = opts.rtcBattery;
    this.current = this.computeInputs(clock.nowMs());
  }

  // ------------------------------------------------------------ lifecycle ----

  /** Power applied: an RTC without battery has lost its time. */
  powerOn(): void {
    // The first boot may be a scenario's (safe mode, a watchdog restart); a later power cycle is a clean start.
    const first = this.booted ? undefined : this.opts.firstBoot;
    this.safeMode = !this.booted && this.opts.safeMode === true;
    this.booted = true;
    this.boot(first ?? { reason: ResetReason.powerOn, cause: LastCause.none, stage: Stage.unknown }, true);
  }

  /** Reset without a power cut (reboot command, watchdog, DTR on port open): the RTC keeps its time. */
  reset(reason: number, cause: number = LastCause.none, stage: number = Stage.unknown): void {
    this.boot({ reason, cause, stage }, false);
  }

  /**
   * Restart the firmware does on purpose (Application::restart): counters are saved first, so none are lost.
   * A restart someone asked for (reboot command, panic signal) clears the unplanned-restart count, so it also
   * leaves safe mode (reset_history::nextConsecutive in Supervisor.h).
   */
  private restart(cause: number): void {
    if (this.dirty) this.persist(this.clock.nowMs());
    this.safeMode = false;
    this.reset(ResetReason.software, cause, Stage.serial);
  }

  /**
   * The panic signal (SerialLink: 64 zero bytes in a row on a wired port): restart now, no ACK.
   * A Bluetooth session cannot send it. A frozen device honours it too (a real watchdog would reboot it anyway).
   */
  panicSignal(): void {
    if (this.opts.bluetoothSession) return;
    this.restart(LastCause.panicSignal);
  }

  /** Freeze the MCU: it sends nothing and ignores commands until a restart. */
  hang(): void {
    this.hung = true;
  }

  isHung(): boolean {
    return this.hung;
  }

  private boot(info: RestartInfo, powerCut: boolean): void {
    const nowMs = this.clock.nowMs();
    this.bootMs = nowMs;
    this.resetReason = info.reason;
    this.lastCause = info.cause;
    this.lastStage = info.stage;
    this.hung = false;
    this.seq = 0;
    this.bootFlags = this.safeMode ? Flag.safeMode : 0;
    this.bootBus(nowMs);
    this.misses.clear();
    this.calib = null;
    this.rebootAtMs = null;
    this.lastCmd = null;
    this.gate.lock();
    this.current = this.computeInputs(nowMs);
    this.bootTime(nowMs, powerCut);
    this.bootCounters(nowMs);
    this.imuSinceMs = nowMs;
    this.runConfirm = new RunConfirm();
    this.runConfirm.update((this.devices & Device.imu) !== 0, false, 0, Number(this.settings.runVibMinMg));
    this.lastInputMs = nowMs;
    this.due = { telemetry: nowMs + this.telemetryPeriodMs(), stream: nowMs + this.streamPeriodMs(), presence: nowMs };
    this.emit(buildBootEvent(this.hourMeter(), this.status()), true);
  }

  // Firmware setup(): the bus starts unless safe mode or the `i2c` setting say no. A line held low parks it (retried
  // after BusGuard's pause); the modules that answer are attached at boot, none while the transfers time out.
  private bootBus(nowMs: number): void {
    this.guard = new BusGuard();
    this.linesLow = 0;
    this.devicesChanged = false;
    this.devices = 0;
    if (!this.i2cWanted()) return;
    if (!this.startBus()) this.guard.parked(nowMs);
    else if (!this.busFault.timeouts) this.devices = this.fitted;
  }

  private bootTime(nowMs: number, powerCut: boolean): void {
    const rtcRead = (this.devices & Device.rtc) !== 0; // the RTC is read at boot only while the bus is in use
    if ((this.fitted & Device.rtc) !== 0 && powerCut && !this.current.rtc.battery) {
      this.rtcHasTime = false;
      // The journal says the last save had a valid time (a used machine), so the loss is reported.
      if (rtcRead) this.bootFlags |= Flag.rtcBatteryLost;
    }
    if (rtcRead && this.rtcHasTime) {
      const epoch = this.time.valid ? this.epochNow(nowMs) : this.clock.hostEpochS();
      this.time = { valid: true, epochAtSync: epoch, syncMs: nowMs, backedUp: true };
    } else {
      this.time = { valid: false, epochAtSync: 0, syncMs: nowMs, backedUp: false }; // RAM time is lost on reset
    }
  }

  // Firmware StorageMirror::adopt: the flash is the main store; an EEPROM from another history is added to the
  // counters the device counted from zero; a store that does not hold the values in use is brought up to date.
  // Not simulated: an EEPROM ahead of the flash in the same history (it ran in another ESP32, or flash writes
  // failed), where the firmware takes the newer save. One simulated board with a working flash never gets one.
  private bootCounters(nowMs: number): void {
    this.runSeconds = 0;
    this.totalCount = 0;
    this.runMsRemainder = 0;
    this.lastSavedEpoch = 0;
    this.journalSeq = 0;
    this.dirty = false;
    this.lastPersistMs = nowMs;
    const eeprom = (this.devices & Device.eeprom) !== 0 ? this.stored : null;
    if (!this.flashAvailable && !eeprom) this.bootFlags |= Flag.settingsDefaults; // no store held the settings
    let r = this.flashStored ?? eeprom;
    if (r && this.flashStored && eeprom && eeprom.lineage !== r.lineage) r = combine(r, eeprom);
    if (!r) {
      this.lineage = this.newLineage(); // nothing stored anywhere: a new history, counted from zero
      this.runFromZero = true;
      this.countFromZero = true;
      this.bootFlags |= Flag.journalEmpty;
      return;
    }
    this.lineage = r.lineage !== 0 ? r.lineage : this.newLineage();
    this.runFromZero = r.runFromZero;
    this.countFromZero = r.countFromZero;
    this.runSeconds = r.runSeconds;
    this.totalCount = r.totalCount;
    this.lastSavedEpoch = r.savedEpoch;
    this.journalSeq = r.journalSeq;
    const same = (s: Stored | null) =>
      s !== null &&
      s.lineage === this.lineage &&
      s.journalSeq === r.journalSeq &&
      s.runSeconds === r.runSeconds &&
      s.totalCount === r.totalCount;
    if ((this.flashAvailable && !same(this.flashStored)) || (eeprom && !same(eeprom))) this.persist(nowMs);
  }

  /** Firmware onEepromArrived: told the device's values; from another history, added where it counted from zero. */
  private onEepromArrived(nowMs: number): void {
    const other = this.stored.lineage !== this.lineage;
    let added = false;
    if (other && this.runFromZero) {
      this.runSeconds += this.stored.runSeconds; // engine time without storage is still engine time
      this.runFromZero = false;
      added = true;
    }
    if (other && this.countFromZero) {
      this.totalCount += this.stored.totalCount;
      this.countFromZero = false;
      added = true;
    }
    if (added) this.bootFlags &= ~Flag.journalEmpty;
    if (added || other || this.stored.journalSeq !== this.journalSeq) this.persist(nowMs);
    this.settingsNotSaved = false; // the settings in use are saved to it now
  }

  private newLineage(): number {
    return Math.floor(this.opts.random() * 0xfffffffe) + 1; // non-zero
  }

  private anyStore(): boolean {
    return this.flashAvailable || (this.devices & Device.eeprom) !== 0;
  }

  // -------------------------------------------------------- scenario hooks ----

  /** Engine state for auto mode (--engine, engine-cycle scenario). A manual engine ignores it. */
  setEngine(on: boolean): void {
    this.engineOn = on;
  }

  /** Auto vibration RMS range in mg, independent of the engine input (acc-wire scenario); null: follows it. */
  setVibrationRange(range: readonly [number, number] | null): void {
    this.vibrationMg = range;
  }

  engineRunning(): boolean {
    return this.current.engine.running;
  }

  // -------------------------------------------------------- web UI hooks ----

  inputs(): Inputs {
    return this.inputState;
  }

  /** Hold a group at manual values (the rest of the group keeps its current value). */
  setInput<G extends Group>(group: G, patch: Partial<InputValues[G]>): void {
    this.inputState = setManual(this.inputState, group, this.current[group], patch);
    this.current = this.computeInputs(this.clock.nowMs());
  }

  /** Give a group back to the built-in animation. */
  setAutoInput(group: Group): void {
    this.inputState = setAuto(this.inputState, group);
    this.current = this.computeInputs(this.clock.nowMs());
  }

  /** Set the counters like a preset command would (saved to EEPROM if fitted), without a COMMAND. */
  presetCounters(runSeconds: number | null, totalCount: number | null): void {
    this.preset(runSeconds, totalCount, this.clock.nowMs());
  }

  /** Mark the IMU (bit 0) and magnetometer (bit 1) as calibrated or not. */
  setCalibrationFlags(flags: number): void {
    this.cal = flags & 1 ? { ...this.cal, ...measuredImuCalibration(), flags } : { ...this.cal, flags };
  }

  /** Everything the web UI shows. */
  snapshot(): SimSnapshot {
    return {
      hourMeter: this.hourMeter(),
      status: this.status(),
      settings: { ...this.settings },
      calibrationFlags: this.cal.flags,
      calibrating: this.calib !== null,
      fitted: this.fitted,
      busFault: { ...this.busFault },
      inputs: this.inputState,
      values: this.current,
      liveData: this.liveDataAllowed(),
      bluetoothSession: this.opts.bluetoothSession,
      nextSeq: this.seq,
    };
  }

  private computeInputs(nowMs: number): InputValues {
    return effectiveInputs(
      this.inputState,
      {
        t: (nowMs - this.bootMs) / 1000,
        engineOn: this.engineOn,
        vibrationMg: this.vibrationMg,
        pulsesPerSecond: this.opts.pulsesPerSecond,
        rtcBattery: this.opts.rtcBattery,
        random: this.opts.random,
      },
      this.vehicleSim?.inputValues() ?? {},
    );
  }

  // ------------------------------------------------------------- vehicle ----

  /** Let a simulated vehicle drive the motion, vibration, IMU, engine and fuel groups (null = detach). */
  attachVehicle(sim: VehicleSim | null): void {
    this.vehicleSim = sim;
    this.inputState = setVehicleModes(this.inputState, sim !== null);
    this.current = this.computeInputs(this.clock.nowMs());
  }

  vehicle(): VehicleSim | null {
    return this.vehicleSim;
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

  /** A module or a short pulls a bus line low, or the transfers time out. The device notices at its next bus check. */
  setBusFault(patch: Partial<BusFault>): void {
    const next = { ...this.busFault, ...patch };
    this.busFault = { sdaLow: Boolean(next.sdaLow), sclLow: Boolean(next.sclLow), timeouts: Boolean(next.timeouts) };
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
    if (this.hung) return;
    if (this.rebootAtMs !== null && nowMs >= this.rebootAtMs) return this.restart(LastCause.rebootCommand);
    this.vehicleSim?.advance(nowMs, this.settings, this.cal);
    this.current = this.computeInputs(nowMs);
    this.runInputs(nowMs);
    this.runCalibration(nowMs);
    this.superviseBus(nowMs);
    if (this.devicesChanged) {
      this.devicesChanged = false; // after the ACK of the command that caused it, like the firmware's devicesChanged_
      this.emit(buildDevicesChangedEvent(this.status()), true);
    }
    if (nowMs >= this.due.stream) this.runStream(nowMs);
    if (nowMs >= this.due.telemetry) this.runTelemetry(nowMs);
  }

  private runInputs(nowMs: number): void {
    const elapsedMs = nowMs - this.lastInputMs;
    this.lastInputMs = nowMs;
    const confirmed = this.runConfirm.update(
      (this.devices & Device.imu) !== 0,
      this.hasVibration(nowMs),
      this.current.vibration.rmsMg,
      Number(this.settings.runVibMinMg),
    );
    const countPulses = Boolean(this.settings.pulseInput);
    if (!countPulses) this.pulseRemainder = 0; // GPIO26 is ignored: pulses not collected yet are dropped
    if (this.current.engine.running && confirmed && elapsedMs > 0) {
      this.runMsRemainder += elapsedMs;
      const whole = Math.floor(this.runMsRemainder / 1000);
      this.runSeconds = (this.runSeconds + whole) >>> 0;
      this.runMsRemainder -= whole * 1000;
      let pulses = 0;
      if (countPulses) {
        // Counted in pulse-milliseconds so 0.1-pulse steps cannot drift (exact for whole and half rates).
        this.pulseRemainder += elapsedMs * Math.max(0, this.current.pulses.perSecond);
        pulses = Math.floor(this.pulseRemainder / 1000);
        this.totalCount = (this.totalCount + pulses) >>> 0;
        this.pulseRemainder -= pulses * 1000;
      }
      this.dirty = this.dirty || whole > 0 || pulses > 0;
    }
    if (this.dirty && nowMs - this.lastPersistMs >= Number(this.settings.persistIntervalS) * 1000) {
      this.persist(nowMs);
    }
  }

  // Firmware persistCounters: every store there is, one new seq above anything either holds.
  private persist(nowMs: number): void {
    const eeprom = (this.devices & Device.eeprom) !== 0;
    if (!this.anyStore()) return;
    const highest = Math.max(this.journalSeq, this.flashStored?.journalSeq ?? 0, eeprom ? this.stored.journalSeq : 0);
    this.journalSeq = (highest + 1) >>> 0;
    this.lastSavedEpoch = this.epochNow(nowMs);
    const saved: Stored = {
      runSeconds: this.runSeconds,
      totalCount: this.totalCount,
      savedEpoch: this.lastSavedEpoch,
      journalSeq: this.journalSeq,
      lineage: this.lineage,
      runFromZero: this.runFromZero,
      countFromZero: this.countFromZero,
    };
    if (this.flashAvailable) this.flashStored = saved;
    if (eeprom) this.stored = { ...saved };
    this.dirty = false;
    this.lastPersistMs = nowMs;
  }

  // ---------------------------------------------------------------- I2C bus ----
  // In use (presence check every 2 s), parked after trouble (BusGuard: tried again after a growing pause), or off
  // (safe mode, `i2c` setting). Parked or off, every module counts as missing and the hour meter runs on the flash.

  /** The bus may be used: not in safe mode, and the `i2c` setting is on (firmware i2cWanted). */
  private i2cWanted(): boolean {
    return !this.safeMode && Boolean(this.settings.i2c);
  }

  private heldLines(): number {
    return (this.busFault.sdaLow ? 1 : 0) | (this.busFault.sclLow ? 2 : 0);
  }

  /** No line held and no timeouts: a module that is fitted answers its address. */
  private busWorks(): boolean {
    return this.heldLines() === 0 && !this.busFault.timeouts;
  }

  // Firmware bus_.begin(): a bus recovery reads the lines; one held low keeps the bus parked.
  private startBus(): boolean {
    this.linesLow = this.heldLines();
    return this.linesLow === 0;
  }

  // Firmware superviseBus. A line held low is found by a bus recovery, which the IMU's reads and an EEPROM save run
  // when they fail; the firmware has neither without an IMU and parks after 5 s of failures, the simulator at once.
  private superviseBus(nowMs: number): void {
    if (!this.i2cWanted()) return;
    if (this.guard.isParked()) return this.retryBus(nowMs);
    if (nowMs >= this.due.presence) this.runPresence(nowMs);
    const held = this.heldLines();
    if (held !== 0) this.linesLow = held;
    if (this.guard.shouldPark(nowMs, !this.busWorks(), held !== 0)) this.parkBus(nowMs);
  }

  // After BusGuard's pause: free lines put the bus back in use (the next presence check re-attaches the modules),
  // a line still held low keeps it parked for twice as long.
  private retryBus(nowMs: number): void {
    if (!this.guard.retryDue(nowMs)) return;
    if (this.startBus()) this.guard.resumed(nowMs);
    else this.guard.retryFailed(nowMs);
  }

  // The bus kept failing (or a line is held low): stop using it instead of restarting, which could not fix a module
  // or a short anyway.
  private parkBus(nowMs: number): void {
    this.guard.parked(nowMs);
    this.dropModules();
  }

  // Firmware applyI2cMode: the `i2c` setting (or safe mode) applied to the bus. Off drops every module and forgets the
  // pause history; on starts the bus as at boot, and the modules attach at the next presence check.
  private applyI2cMode(nowMs: number): void {
    if (!this.i2cWanted()) {
      this.guard.reset();
      this.dropModules();
    } else if (!this.startBus()) {
      this.guard.parked(nowMs);
    }
  }

  // Every module counts as missing: the counters and settings go on in the flash, the time in RAM.
  private dropModules(): void {
    const before = this.devices;
    this.misses.clear();
    if ((this.devices & Device.rtc) !== 0) this.loseRtc();
    this.devices &= ~(Device.eeprom | Device.imu | Device.mag);
    this.calib = null;
    if (this.devices !== before) this.devicesChanged = true;
  }

  // Firmware loseRtc: the time stays, but in RAM only (timeNotBackedUp).
  private loseRtc(): void {
    this.devices &= ~Device.rtc;
    if (this.time.valid) this.time = { ...this.time, backedUp: false };
  }

  // Firmware attachRtc + syncRtc: the RTC's time is the device's time again; an RTC without one gets the RAM time.
  private attachRtc(nowMs: number): void {
    this.devices |= Device.rtc;
    if (this.time.valid) {
      this.time = { ...this.time, backedUp: true };
      this.rtcHasTime = true;
    } else if (this.rtcHasTime) {
      this.time = { valid: true, epochAtSync: this.clock.hostEpochS(), syncMs: nowMs, backedUp: true };
    }
  }

  private runPresence(nowMs: number): void {
    this.due.presence = nowMs + PRESENCE_PERIOD_MS;
    const before = this.devices;
    for (const bit of MODULES) this.checkModule(bit, nowMs);
    if (this.devices === before) return;
    if ((this.devices & Device.imu) !== 0 && (before & Device.imu) === 0) this.imuSinceMs = nowMs;
    if ((this.devices & Device.eeprom) !== 0 && (before & Device.eeprom) === 0) this.onEepromArrived(nowMs);
    if ((this.devices & Device.imu) === 0) this.calib = null;
    this.devicesChanged = true;
  }

  // A present module is LOST after 3 failed checks; a missing one is attached at the first answer.
  private checkModule(bit: number, nowMs: number): void {
    const answers = (this.fitted & bit) !== 0 && this.busWorks();
    if ((this.devices & bit) === 0) {
      if (!answers) return;
      if (bit === Device.rtc) this.attachRtc(nowMs);
      else this.devices |= bit;
      return;
    }
    const misses = answers ? 0 : (this.misses.get(bit) ?? 0) + 1;
    this.misses.set(bit, misses);
    if (misses >= LOST_AFTER_MISSES) {
      this.misses.set(bit, 0);
      if (bit === Device.rtc) this.loseRtc();
      else this.devices &= ~bit;
    }
  }

  private runStream(nowMs: number): void {
    this.due.stream = nowMs + this.streamPeriodMs();
    const mode = Number(this.settings.streamMode);
    if (Number(this.settings.imuStreamHz) === 0 || mode === StreamMode.off) return;
    if ((this.devices & Device.imu) === 0) return;
    this.emit(buildImuStream(this.status(), this.imuOutput(), mode), true);
  }

  private runTelemetry(nowMs: number): void {
    this.due.telemetry = nowMs + this.telemetryPeriodMs();
    const imu = (this.devices & Device.imu) !== 0 ? this.imuOutput() : null;
    const vib = imu && this.hasVibration(nowMs) ? this.vibration() : null;
    this.emit(buildTelemetry(this.hourMeter(), this.status(), imu, vib), true);
  }

  private runCalibration(nowMs: number): void {
    if (!this.calib || nowMs < this.calib.doneAtMs) return;
    const kind = this.calib.kind;
    this.calib = null;
    this.cal =
      kind === 1
        ? { ...this.cal, ...measuredImuCalibration(), flags: this.cal.flags | 1 }
        : {
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
    if (cmd.msgType !== MSG.COMMAND || this.hung) return;
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
    this.settingsNotSaved = !this.anyStore(); // firmware 2.6.0: saved in flash even without an EEPROM
    const streamChanged = next.imuStreamHz !== this.settings.imuStreamHz;
    const telemetryChanged = next.telemetryIntervalMs !== this.settings.telemetryIntervalMs;
    const i2cChanged = next.i2c !== this.settings.i2c;
    this.settings = next;
    if (this.opts.bluetoothSession) this.settings.bluetooth = true; // the simulated client is on Bluetooth
    if (telemetryChanged) this.due.telemetry = nowMs + this.telemetryPeriodMs();
    if (streamChanged) this.due.stream = nowMs + this.streamPeriodMs();
    if (i2cChanged) this.applyI2cMode(nowMs); // after the save: it went to the EEPROM too, if one was there
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
        if (!this.anyStore()) return { status: Ack.DeviceMissing, rejectedTag: r.tag };
        this.preset(0, 0, nowMs);
      } else if (r.tag === CMD.calibrate) {
        const status = this.startCalibration(Number(r.raw), nowMs);
        if (status !== Ack.Ok) return { status, rejectedTag: r.tag };
      } else if (r.tag === CMD.reboot) this.rebootAtMs = nowMs + REBOOT_DELAY_MS;
    }
    if (run === null && count === null) return null;
    if (!this.anyStore()) {
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
    this.runFromZero = this.runFromZero && run === null; // known now: a later EEPROM is not added to these
    this.countFromZero = this.countFromZero && count === null;
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
      running: this.current.engine.running && this.runConfirm.confirmed(),
      inputActive: this.current.engine.running,
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
    if (!this.flashAvailable) f |= Flag.flashStoreMissing;
    if (!this.time.valid) f |= Flag.timeInvalid;
    if (this.time.valid && !this.time.backedUp) f |= Flag.timeNotBackedUp;
    if ((this.cal.flags & 1) === 0) f |= Flag.imuNotCalibrated;
    if (has(Device.mag) && (this.cal.flags & 2) === 0) f |= Flag.magNotCalibrated;
    if (this.calib) f |= Flag.calibrating;
    const parked = this.guard.isParked();
    if (parked) f |= Flag.i2cParked;
    if (!this.settings.i2c) f |= Flag.i2cOff;
    const { errors, flags, rtc } = this.current;
    if (errors.i2cErrors > 0) f |= Flag.i2cErrors;
    if (flags.storageError) f |= Flag.storageError;
    if (flags.eepromFormatted) f |= Flag.eepromFormatted;
    if (has(Device.imu) && flags.imuStuck) f |= Flag.imuStuck;
    if (has(Device.imu) && flags.imuSaturated) f |= Flag.imuSaturated;
    return {
      timeValid: this.time.valid,
      epoch: this.epochNow(nowMs),
      uptimeS: Math.floor((nowMs - this.bootMs) / 1000),
      devices: d,
      i2cErrors: errors.i2cErrors >>> 0,
      overruns: errors.overruns >>> 0,
      resetReason: this.resetReason,
      settingsSource: this.flashAvailable ? 3 : has(Device.eeprom) ? 1 : 0, // flash copy A, else EEPROM copy A
      btState: this.btState(),
      lastCause: this.lastCause,
      lastStage: this.lastStage,
      i2cParked: parked,
      i2cLines: parked ? this.linesLow : 0,
      rtcTempValid: has(Device.rtc),
      rtcTempQuarterC: Math.max(-32768, Math.min(32767, Math.round(rtc.tempC * 4))), // x0.25 C
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

  private imuOutput(): ImuOutput {
    const { imu, motion } = this.current;
    const hasMag = (this.devices & Device.mag) !== 0;
    return {
      rawAccelG: imu.rawAccelG,
      rawGyroDps: imu.rawGyroDps,
      rawMagUt: imu.rawMagUt,
      accelG: imu.accelG,
      gyroDps: imu.gyroDps,
      magUt: imu.magUt,
      rollDeg: motion.rollDeg,
      pitchDeg: motion.pitchDeg,
      headingDeg: ((motion.headingDeg % 360) + 360) % 360,
      headingValid: hasMag,
      hasMag,
    };
  }

  /** A vibration window has completed since the IMU appeared (firmware pipeline.hasVibration()). */
  private hasVibration(nowMs: number): boolean {
    return (this.devices & Device.imu) !== 0 && nowMs - this.imuSinceMs >= Number(this.settings.vibrationWindowMs);
  }

  private vibration(): VibrationLevel {
    return this.current.vibration;
  }

  // ------------------------------------------------------------------ send ----

  // Every frame takes the next seq (wraps 65535 -> 0), like the firmware's txSeq_.
  private emit(msg: Message, periodic: boolean): { ack: Uint8Array; msg: Message & { seq: number } } {
    const full = { ...msg, seq: this.seq };
    this.seq = (this.seq + 1) & 0xffff;
    const bytes = frameBytes(codec.encode({ ...full, deviceId: this.opts.deviceId >>> 0 }));
    this.vehicleSim?.onFrame(full, this.clock.nowMs());
    this.send(bytes, full, periodic);
    return { ack: bytes, msg: full };
  }
}

/** Everything the web UI shows (see src/web/messages.ts). */
export interface SimSnapshot {
  hourMeter: HourMeterSnapshot;
  status: DeviceStatus;
  settings: Settings;
  calibrationFlags: number;
  calibrating: boolean;
  /** Modules physically plugged in (Device bits); status.devices is what the firmware has detected. */
  fitted: number;
  /** What is wrong on the I2C bus right now. */
  busFault: BusFault;
  inputs: Inputs;
  /** This moment's values, auto or manual. */
  values: InputValues;
  liveData: boolean;
  bluetoothSession: boolean;
  nextSeq: number;
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
