// demo-device.ts: a simulated hour meter that speaks the real protocol.
// Lets you try the TUI (and app code) without hardware:  npm run tui -- --demo
//
// It is a stream pair like a serial port: the client writes COMMAND frames,
// the "device" answers ACKs and pushes TELEMETRY / IMU / EVENT frames.
import { PassThrough } from 'node:stream';

import deviceCjs from '../device.js';
import tagsCjs from '../tags.js';

const { codec } = deviceCjs;
const { MSG, SETTINGS, RESET_MAGIC } = tagsCjs;

type Values = Record<string, number | boolean>;

const DEFAULTS: Values = {
  telemetryIntervalMs: 1000, imuSampleHz: 100, imuStreamHz: 10, streamMode: 2, persistIntervalS: 60,
  vibrationWindowMs: 1000, rtcSyncIntervalS: 60, output: 1, uartBaud: 115200, altActiveHigh: false,
  altDebounceMs: 200, pulseRisingEdge: false, pulseMinIntervalUs: 1000, pulsesPerUnit: 1,
  kalmanQAccel: 0.0005, kalmanQGyro: 0.01, kalmanQMag: 0.05, bluetooth: false, btPin: 1234,
};
const ACK = { Ok: 0, UnknownTag: 1, InvalidValue: 2, BadMagic: 6 } as const;
const DEVICE_ID = 0x1a2b3c4d;
const FW = 0x00020300;

export interface DemoPort extends PassThrough {
  close(): void;
}

export function createDemoDevice(): DemoPort {
  const toDevice = new PassThrough();
  const port = new PassThrough() as DemoPort;
  const sim = new DemoHourMeter((bytes) => port.push(bytes));
  port.write = ((chunk: Buffer) => toDevice.write(chunk)) as DemoPort['write'];
  port.close = () => sim.stop();
  let pending = Buffer.alloc(0);
  toDevice.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let zero: number;
    while ((zero = pending.indexOf(0)) !== -1) {
      const frame = pending.subarray(0, zero + 1);
      pending = pending.subarray(zero + 1);
      try {
        sim.onCommand(codec.decodeFrame(frame));
      } catch {
        /* corrupt frame: a real device drops it too */
      }
    }
  });
  sim.start();
  return port;
}

class DemoHourMeter {
  private settings: Values = { ...DEFAULTS };
  private runSeconds = 4_500_000;   // 1250 h, as if installed on a used machine
  private totalCount = 15_000;
  private journalSeq = 812;
  private epochAtMs: { epoch: number; atMs: number } | null = null;  // starts unknown (no RTC battery)
  private bootMs = Date.now();
  private seq = 0;
  private calibrating = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly send: (bytes: Buffer) => void) {}

  start(): void {
    this.stop();  // also used for a simulated reboot
    this.bootMs = Date.now();
    this.emit(MSG.EVENT, { eventKind: 1, ...this.hourValues(true), ...this.statusValues(true) });
    this.timers.push(setInterval(() => this.tickSecond(), 1000));  // timers[0] = counters
    this.schedule();
  }

  stop(): void {
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }

  private schedule(): void {
    this.timers.slice(1).forEach((t) => clearInterval(t));
    this.timers = this.timers.slice(0, 1);
    this.timers.push(setInterval(() => this.telemetry(), Number(this.settings.telemetryIntervalMs)));
    const streamHz = Number(this.settings.imuStreamHz);
    if (streamHz > 0 && Number(this.settings.streamMode) !== 0) {
      this.timers.push(setInterval(() => this.imuStream(), 1000 / streamHz));
    }
  }

  private engineRunning(): boolean {
    return Math.floor((Date.now() - this.bootMs) / 40000) % 2 === 0;  // 40 s on, 40 s off
  }

  private tickSecond(): void {
    if (this.engineRunning()) {
      this.runSeconds += 1;
      this.totalCount += 3 + Math.floor(Math.random() * 2);
    }
  }

  private epoch(): number {
    if (!this.epochAtMs) return 0;
    return this.epochAtMs.epoch + Math.floor((Date.now() - this.epochAtMs.atMs) / 1000);
  }

  private hourValues(full: boolean): Values {
    const v: Values = {
      runSeconds: this.runSeconds, totalCount: this.totalCount, alternator: this.engineRunning(),
      runHours: Math.floor(this.runSeconds / 36) / 100,
      totalUnits: Math.floor((this.totalCount * 100) / Number(this.settings.pulsesPerUnit)) / 100,
    };
    if (full) Object.assign(v, { lastSavedEpoch: this.epoch(), journalSeq: this.journalSeq });
    return v;
  }

  private statusValues(full: boolean): Values {
    const flags = (this.epochAtMs ? 0 : 1 << 2) | (this.calibrating ? 1 << 14 : 0) | (1 << 5) | (1 << 6);
    const v: Values = { timeValid: this.epochAtMs !== null, statusFlags: flags };
    if (full) {
      Object.assign(v, {
        epoch: this.epoch(), uptime: Math.floor((Date.now() - this.bootMs) / 1000), devices: 0x0f, i2cErrors: 0,
        overruns: 0, resetReason: 1, settingsSource: 1, fwVersion: FW, rtcTemp: 29.25,
        btState: this.settings.bluetooth ? 1 : 0,
      });
    }
    return v;
  }

  private motionValues(): Values {
    const t = (Date.now() - this.bootMs) / 1000;
    const vib = this.engineRunning() ? 35 + Math.random() * 8 : 2 + Math.random();
    return {
      roll: Math.round((1.5 + Math.sin(t / 7)) * 100) / 100, pitch: Math.round((-0.8 + Math.cos(t / 9)) * 100) / 100,
      heading: Math.round(((t * 3) % 360) * 100) / 100, vibRms: Math.round(vib), vibPeak: Math.round(vib * 2.8),
    };
  }

  private telemetry(): void {
    this.emit(MSG.TELEMETRY, { ...this.hourValues(false), ...this.statusValues(false), ...this.motionValues() });
  }

  private imuStream(): void {
    const n = (s: number) => (Math.random() - 0.5) * s;
    const raw = { rawAccelX: n(0.06), rawAccelY: n(0.06), rawAccelZ: 1 + n(0.06), rawGyroX: n(2), rawGyroY: n(2), rawGyroZ: n(2), rawMagX: 30 + n(3), rawMagY: -5 + n(3), rawMagZ: -40 + n(3) };
    const filt = { accelX: n(0.01), accelY: n(0.01), accelZ: 1 + n(0.01), gyroX: n(0.3), gyroY: n(0.3), gyroZ: n(0.3), magX: 30 + n(0.5), magY: -5 + n(0.5), magZ: -40 + n(0.5) };
    const mode = Number(this.settings.streamMode);
    const r = (o: Record<string, number>, d: number) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * d) / d]));
    this.emit(MSG.IMU, {
      ...(mode === 1 || mode === 3 ? { ...r(raw, 1000) } : {}),
      ...(mode === 2 || mode === 3 ? { ...r(filt, 1000), ...this.motionValues() } : {}),
    });
  }

  private emit(msgType: number, values: Values, seqOverride?: number): void {
    const seq = seqOverride ?? (this.seq = (this.seq + 1) & 0xffff);
    const timestamp = this.epochAtMs ? this.epoch() : Math.floor((Date.now() - this.bootMs) / 1000);
    this.send(codec.frame({ msgType, seq, deviceId: DEVICE_ID, timestamp, values }));
  }

  onCommand(cmd: { msgType: number; seq: number; values: Record<string, number | boolean | bigint | Buffer> }): void {
    if (cmd.msgType !== MSG.COMMAND) return;
    const reply = (ackStatus: number, extra: Values = {}) => this.emit(MSG.ACK, { ackSeq: cmd.seq, ackStatus, ...extra });
    const next = { ...this.settings };
    for (const [name, raw] of Object.entries(cmd.values)) {
      const spec = SETTINGS[name as keyof typeof SETTINGS];
      if (!spec) continue;
      const value = Number(raw);
      const okRange = value >= spec.min && value <= spec.max && (!spec.values || spec.values.includes(value));
      if (!okRange) return reply(ACK.InvalidValue, { rejectedTag: spec.tag });
      next[name] = typeof DEFAULTS[name] === 'boolean' ? Boolean(raw) : value;
    }
    if (Number(next.imuStreamHz) > Number(next.imuSampleHz)) return reply(ACK.InvalidValue, { rejectedTag: 112 });
    if (cmd.values.resetCounters !== undefined && Number(cmd.values.resetCounters) !== RESET_MAGIC) return reply(ACK.BadMagic, { rejectedTag: 104 });
    this.settings = next;
    this.schedule();
    this.runActions(cmd.values);
    reply(ACK.Ok, this.getValues(cmd.values.get as number | undefined));
  }

  private runActions(v: Record<string, unknown>): void {
    if (typeof v.setTime === 'number') this.epochAtMs = { epoch: v.setTime, atMs: Date.now() };
    if (typeof v.setRunSeconds === 'number') this.runSeconds = v.setRunSeconds;
    if (typeof v.setTotalCount === 'number') this.totalCount = v.setTotalCount;
    if (v.resetCounters !== undefined) this.runSeconds = this.totalCount = 0;
    if (typeof v.calibrate === 'number') {
      this.calibrating = v.calibrate;
      setTimeout(() => {
        this.calibrating = 0;
        this.emit(MSG.EVENT, { eventKind: 2, calibrate: v.calibrate as number, calibResult: 0, calFlags: 3 });
      }, v.calibrate === 2 ? 8000 : 4000);
    }
    if (v.reboot !== undefined) setTimeout(() => this.start(), 500);
  }

  private getValues(what: number | undefined): Values {
    switch (what) {
      case 1: return this.hourValues(true);
      case 2: return { ...this.settings };
      case 3: return this.statusValues(true);
      case 4: return { calAccelBiasX: 0.012, calAccelBiasY: -0.004, calAccelBiasZ: 0.021, calGyroBiasX: 0.41, calGyroBiasY: -0.22, calGyroBiasZ: 0.09, calFlags: 3 };
      default: return {};
    }
  }
}
