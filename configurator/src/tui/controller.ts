// controller.ts: everything the TUI does with the device, without drawing anything. It follows the connection
// (whose client changes after an unplug and replug, and after a firmware update), folds every frame into the
// DeviceState (state.ts), runs the commands with a busy mark and a result, and keeps the jobs that outlive a key
// press: a calibration waiting for its EVENT, the 10 s vibration measurements, a firmware update. Screens read
// `snapshot` and call the methods; `subscribe` tells them when to draw again.
import { AckError } from '../device.ts';
import type { ConnState } from '../connection.ts';
import type { FirmwareImage, Note } from '../firmware.ts';
import type { FlashProgress } from '../flash.ts';
import type { FirmwareRelease } from '../releases.ts';
import { panicPayload } from '../reset.ts';
import { ACK_STATUS, EVENT_KIND, MSG } from '../tags.ts';
import { FLASH_STEPS, type FirmwareActions, type FlashStepId, type StepStatus } from './firmware-actions.ts';
import type { CounterPlan } from './model/counters.ts';
import { EPOCH_2000 } from './model/format.ts';
import { addSample, type LiveSample, type Measure, MEASURE_MS, measureResult } from './model/history.ts';
import { type Change, commandFor } from './model/settings.ts';
import {
  addLog,
  applyConnState,
  applyMessage,
  confirmSettings,
  type DecodedMessage,
  type DeviceState,
  type Level,
} from './state.ts';

// EventEmitter's listener type (DeviceClient extends node:events EventEmitter).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

export interface Client {
  request(values: Record<string, number | boolean>): Promise<DecodedMessage>;
  sendRaw?(bytes: Uint8Array): Promise<void>;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
}

/** The link to the device (connection.ts Connection): its client changes on a reconnect. */
export interface Link {
  client?: Client;
  state: ConnState;
  port: string;
  demo: boolean;
  on(event: 'client' | 'state', listener: Listener): unknown;
  off(event: 'client' | 'state', listener: Listener): unknown;
  rememberPin?(pin: string): void;
}

export interface Result {
  ok: boolean;
  text: string;
  atMs: number;
}

export interface FlashJob {
  /** "2.6.0 → 2.7.0 (v1.3.0)" */
  label: string;
  steps: Array<{ id: FlashStepId; label: string; status: StepStatus; detail?: string }>;
  progress?: FlashProgress;
  notes: Note[];
  done: boolean;
  ok?: boolean;
}

export interface Calibration {
  kind: 1 | 2;
  startedMs: number;
  result?: Result;
}

export interface Measurement {
  startedMs: number;
  /** The measured RMS (key on: highest; idle: lowest), once the 10 s are over. */
  value?: number;
}

export interface UiState {
  device: DeviceState;
  /** The command waiting for its ACK. */
  busy?: string;
  /** The last command's outcome (shown next to where it was started). */
  result?: Result;
  /** A command was answered Locked: a Bluetooth session that needs the PIN. */
  locked: boolean;
  /** Since when frames are expected (connect, end of a flash): the no-data warning counts from here. */
  sinceMs: number;
  history: LiveSample[];
  /** The device's clock from the last frame with a real date (UTC epoch at `atMs`). */
  clock?: { epoch: number; atMs: number };
  /** When the engine was last seen to start or stop in this session (unknown before the first change). */
  engine?: { running: boolean; sinceMs?: number };
  releases?: FirmwareRelease[];
  releasesNote?: string;
  flash?: FlashJob;
  calibration?: Calibration;
  measures: Partial<Record<Measure, Measurement>>;
  /** Settings edited on screen, not applied yet (sent together by applySettings). */
  draft: Record<string, number | boolean>;
}

export interface ControllerOptions {
  conn: Link;
  initial: DeviceState;
  firmware: FirmwareActions;
  /** Pulse EN through the USB adapter; only for a local serial port. */
  hardReset?: () => Promise<void>;
  now?: () => number;
  /** How long a calibration may take before it counts as lost (default 40 s). */
  calibrationTimeoutMs?: number;
  statusPollMs?: number;
  /** The release list of the last session (a port change): GitHub is not asked again. */
  releases?: FirmwareRelease[];
}

const CALIBRATION_TIMEOUT_MS = 40_000;
/** Why a device action is refused while the flasher has the port. */
export const FLASH_RUNNING = 'a firmware update is running: wait for it to finish';
const STATUS_POLL_MS = 10_000;

export class TuiController {
  private ui: UiState;
  private readonly listeners = new Set<() => void>();
  private client?: Client;
  private readonly now: () => number;
  private poll?: ReturnType<typeof setInterval>;
  private calibrationTimer?: ReturnType<typeof setTimeout>;
  private readonly measureTimers = new Map<Measure, ReturnType<typeof setTimeout>>();
  private refreshing?: Promise<void>;
  private started = false;

  constructor(private readonly options: ControllerOptions) {
    this.now = options.now ?? Date.now;
    const { conn } = options;
    this.ui = {
      device: applyConnState(options.initial, conn.state, conn.port, this.now()),
      locked: false,
      sinceMs: this.now(),
      history: [],
      measures: {},
      draft: {},
    };
  }

  get snapshot(): UiState {
    return this.ui;
  }

  get flashing(): boolean {
    return this.ui.flash !== undefined && !this.ui.flash.done;
  }

  get canHardReset(): boolean {
    return this.options.hardReset !== undefined;
  }

  get canFlash(): boolean {
    return this.options.firmware.flash !== undefined;
  }

  get flashNote(): string | undefined {
    return this.options.firmware.flashNote;
  }

  get port(): string {
    return this.options.conn.port;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(change: (ui: UiState) => UiState): void {
    this.ui = change(this.ui);
    for (const l of this.listeners) l();
  }

  log(level: Level, text: string): void {
    this.update((ui) => ({ ...ui, device: addLog(ui.device, level, text, this.now()) }));
  }

  // ------------------------------------------------------------- lifecycle --

  start(): void {
    if (this.started) return;
    this.started = true;
    const { conn } = this.options;
    conn.on('client', this.onClient);
    conn.on('state', this.onState);
    this.onState(conn.state);
    if (conn.client) this.onClient(conn.client);
    this.poll = setInterval(() => {
      if (!this.flashing) void this.send('get status', { get: 3 }, { quiet: true });
    }, this.options.statusPollMs ?? STATUS_POLL_MS);
    const known = this.options.releases;
    if (known) this.update((ui) => ({ ...ui, releases: known }));
    else void this.checkReleases();
  }

  stop(): void {
    const { conn } = this.options;
    conn.off('client', this.onClient);
    conn.off('state', this.onState);
    this.detach();
    clearInterval(this.poll);
    clearTimeout(this.calibrationTimer);
    for (const t of this.measureTimers.values()) clearTimeout(t);
    this.started = false;
  }

  private onState = (state: ConnState) => {
    this.update((ui) => ({ ...ui, device: applyConnState(ui.device, state, this.options.conn.port, this.now()) }));
    if (state.kind === 'connected') this.update((ui) => ({ ...ui, sinceMs: this.now() }));
    else this.detach();
  };

  private onClient = (client: Client) => {
    this.detach();
    this.client = client;
    client.on('frame', this.onFrame);
    client.on('timeSynced', this.onSynced);
    client.on('timeSyncError', this.onSyncError);
    this.update((ui) => ({ ...ui, sinceMs: this.now() }));
    if (!this.flashing) void this.refresh(); // after an update, flash() reads the device once it is done
  };

  private detach(): void {
    const c = this.client;
    if (!c) return;
    c.off('frame', this.onFrame);
    c.off('timeSynced', this.onSynced);
    c.off('timeSyncError', this.onSyncError);
    this.client = undefined;
  }

  private onSynced = (epoch: number) =>
    this.log('ok', `time set from this PC: ${new Date(epoch * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`);

  private onSyncError = (err: Error) => this.log('error', `setting the time failed: ${err.message}`);

  private onFrame = (msg: DecodedMessage) => {
    const at = this.now();
    this.update((ui) => {
      const next: UiState = { ...ui, device: applyMessage(ui.device, msg, at), locked: false };
      if (msg.msgType === MSG.TELEMETRY) next.history = addSample(ui.history, msg.values, at);
      if (msg.timestamp >= EPOCH_2000) next.clock = { epoch: msg.timestamp, atMs: at };
      const running = msg.values.alternator;
      if (typeof running === 'boolean' && running !== ui.engine?.running) {
        next.engine = { running, sinceMs: ui.engine === undefined ? undefined : at };
      }
      if (
        msg.msgType === MSG.EVENT &&
        EVENT_KIND[Number(msg.values.eventKind)] === 'calibrationDone' &&
        ui.calibration
      ) {
        const status = ACK_STATUS[Number(msg.values.calibResult)] ?? String(msg.values.calibResult);
        next.calibration = { ...ui.calibration, result: { ok: status === 'Ok', text: status, atMs: at } };
      }
      return next;
    });
    if (msg.msgType === MSG.EVENT && EVENT_KIND[Number(msg.values.eventKind)] === 'calibrationDone') {
      clearTimeout(this.calibrationTimer);
      void this.send('get calibration', { get: 4 }, { quiet: true }); // the new biases for the result line
    }
  };

  // -------------------------------------------------------------- commands --

  /**
   * One COMMAND and its ACK. The label shows as busy while it waits; the outcome goes to `result` and the log
   * (quiet: nothing is logged, for reads the user did not ask for).
   */
  async send(label: string, values: Record<string, number | boolean>, { quiet = false } = {}): Promise<Result> {
    const client = this.flashing ? undefined : this.client;
    if (!client) {
      const r = { ok: false, text: `${label}: ${this.flashing ? FLASH_RUNNING : 'not connected'}`, atMs: this.now() };
      if (!quiet) this.update((ui) => ({ ...ui, result: r, device: addLog(ui.device, 'warn', r.text, r.atMs) }));
      return r;
    }
    if (!quiet) this.update((ui) => ({ ...ui, busy: label }));
    try {
      const ack = await client.request(values);
      const r = { ok: true, text: `${label}: ${ACK_STATUS[Number(ack.values.ackStatus)] ?? 'Ok'}`, atMs: this.now() };
      this.update((ui) => {
        let device = confirmSettings(applyMessage(ui.device, ack, r.atMs), values);
        if (!quiet) device = addLog(device, 'ok', r.text, r.atMs);
        return { ...ui, device, locked: false, ...(quiet ? {} : { busy: undefined, result: r }) };
      });
      return r;
    } catch (err) {
      const status = err instanceof AckError ? ACK_STATUS[Number(err.ack.values.ackStatus)] : undefined;
      const locked = status === 'Locked' || status === 'BadPin';
      const r = { ok: false, text: `${label}: ${(err as Error).message}`, atMs: this.now() };
      this.update((ui) => ({
        ...ui,
        locked: ui.locked || locked,
        ...(quiet ? {} : { busy: undefined, result: r, device: addLog(ui.device, 'error', r.text, r.atMs) }),
      }));
      return r;
    }
  }

  /** Read settings, status, counters and calibration; one log line, an error only if a read failed. A refresh
   * asked for while one runs joins it. */
  refresh(): Promise<void> {
    if (this.flashing) {
      this.log('warn', FLASH_RUNNING);
      return Promise.resolve();
    }
    this.refreshing ??= this.readAll().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async readAll(): Promise<void> {
    const failed: string[] = [];
    for (const [what, name] of [
      [2, 'settings'],
      [3, 'status'],
      [1, 'counters'],
      [4, 'calibration'],
    ] as const) {
      if (!(await this.send(`get ${name}`, { get: what }, { quiet: true })).ok) failed.push(name);
    }
    if (failed.length === 4) this.log('error', 'the device does not answer (reading it failed)');
    else if (failed.length) this.log('warn', `could not read ${failed.join(', ')}`);
    else this.log('ok', 'read settings, status, counters, calibration');
  }

  setTime(): Promise<Result> {
    return this.send('set time from this PC', { setTime: Math.floor(this.now() / 1000) });
  }

  /** A counter change from the Counters dialog, then the counters read again (new save number). */
  async applyCounter(plan: CounterPlan): Promise<Result> {
    const r = await this.send(plan.logText, plan.command);
    if (!r.ok) return r;
    await this.send('get counters', { get: 1 }, { quiet: true });
    const seq = this.ui.device.values.journalSeq;
    const done = { ...r, text: `${plan.logText}${seq !== undefined ? ` (save #${String(seq)})` : ''}` };
    this.update((ui) => ({ ...ui, result: done }));
    return done;
  }

  /** The staged settings, in one command: the device applies all of them or none. Applied ones leave the draft. */
  async applySettings(changes: readonly Change[]): Promise<Result> {
    const label = `settings: ${changes.map((c) => `${c.name} ${String(c.from ?? '?')} → ${String(c.to)}`).join(', ')}`;
    const r = await this.send(label, commandFor(changes));
    if (r.ok) {
      this.update((ui) => {
        const draft = { ...ui.draft };
        for (const c of changes) delete draft[c.name];
        return { ...ui, draft };
      });
    }
    return r;
  }

  /** Stage a setting (not sent yet); a value equal to the device's drops the staged one. */
  stage(name: string, value: number | boolean): void {
    this.update((ui) => {
      const draft = { ...ui.draft };
      const device = ui.device.settings[name];
      if (device !== undefined && Number(device) === Number(value)) delete draft[name];
      else draft[name] = value;
      return { ...ui, draft };
    });
  }

  unstage(name?: string): void {
    this.update((ui) => {
      if (name === undefined) return { ...ui, draft: {} };
      const draft = { ...ui.draft };
      delete draft[name];
      return { ...ui, draft };
    });
  }

  /** Start a calibration; its result comes with the calibration EVENT (or not within the timeout). */
  async calibrate(kind: 1 | 2): Promise<Result> {
    const running = this.ui.calibration;
    if (running && !running.result) {
      return { ok: false, text: 'a calibration is running: wait for its result', atMs: this.now() };
    }
    clearTimeout(this.calibrationTimer);
    this.update((ui) => ({ ...ui, calibration: { kind, startedMs: this.now() } }));
    const r = await this.send(kind === 1 ? 'calibrate accel + gyro' : 'calibrate compass', { calibrate: kind });
    if (!r.ok) {
      this.update((ui) => ({ ...ui, calibration: ui.calibration && { ...ui.calibration, result: r } }));
      return r;
    }
    this.calibrationTimer = setTimeout(() => {
      this.update((ui) =>
        ui.calibration && !ui.calibration.result
          ? {
              ...ui,
              calibration: {
                ...ui.calibration,
                result: { ok: false, text: 'no result from the device', atMs: this.now() },
              },
            }
          : ui,
      );
    }, this.options.calibrationTimeoutMs ?? CALIBRATION_TIMEOUT_MS);
    return r;
  }

  reboot(): Promise<Result> {
    return this.send('reboot', { reboot: 1 });
  }

  /** 64 zero bytes: a frozen device restarts (wired links only; never over Bluetooth). */
  async panic(): Promise<Result> {
    const client = this.client;
    const at = this.now();
    if (this.flashing) return this.finish({ ok: false, text: `panic signal: ${FLASH_RUNNING}`, atMs: at }, 'warn');
    if (!client?.sendRaw) return this.finish({ ok: false, text: 'panic signal: not connected', atMs: at }, 'warn');
    try {
      await client.sendRaw(panicPayload());
      return this.finish({ ok: true, text: 'panic signal sent: the device restarts', atMs: at }, 'ok');
    } catch (err) {
      return this.finish({ ok: false, text: `panic signal: ${(err as Error).message}`, atMs: at }, 'error');
    }
  }

  async hardReset(): Promise<Result> {
    const at = this.now();
    if (this.flashing) return this.finish({ ok: false, text: `hard reset: ${FLASH_RUNNING}`, atMs: at }, 'warn');
    if (!this.options.hardReset) {
      return this.finish({ ok: false, text: 'hard reset needs a local USB serial port', atMs: at }, 'warn');
    }
    try {
      await this.options.hardReset();
      return this.finish({ ok: true, text: 'hard reset: EN pulsed through the USB adapter', atMs: at }, 'ok');
    } catch (err) {
      return this.finish({ ok: false, text: (err as Error).message, atMs: at }, 'error');
    }
  }

  /** Unlock a Bluetooth session; the PIN is kept for reconnects. */
  async unlock(pin: string): Promise<Result> {
    const r = await this.send('unlock', { unlock: Number(pin) });
    if (r.ok) {
      this.options.conn.rememberPin?.(pin);
      this.update((ui) => ({ ...ui, locked: false }));
      void this.refresh();
    }
    return r;
  }

  private finish(r: Result, level: Level): Result {
    this.update((ui) => ({ ...ui, result: r, device: addLog(ui.device, level, r.text, r.atMs) }));
    return r;
  }

  // -------------------------------------------------- vibration measurement --

  /** Measure 10 s of vibration (key on: highest RMS; idle: lowest) for the threshold suggestion. */
  measure(kind: Measure): void {
    clearTimeout(this.measureTimers.get(kind));
    const startedMs = this.now();
    this.update((ui) => ({ ...ui, measures: { ...ui.measures, [kind]: { startedMs } } }));
    this.measureTimers.set(
      kind,
      setTimeout(() => {
        this.update((ui) => ({
          ...ui,
          measures: { ...ui.measures, [kind]: { startedMs, value: measureResult(ui.history, kind, startedMs) } },
        }));
      }, MEASURE_MS),
    );
  }

  // --------------------------------------------------------------- firmware --

  async checkReleases(): Promise<void> {
    this.update((ui) => ({ ...ui, releasesNote: 'checking the GitHub releases…' }));
    try {
      const list = await this.options.firmware.list();
      this.update((ui) => ({
        ...ui,
        releases: list,
        releasesNote: list.length ? undefined : 'no firmware releases found',
      }));
    } catch (err) {
      this.update((ui) => ({ ...ui, releasesNote: `no release list: ${(err as Error).message}` }));
    }
  }

  /** A release's image: from the cache folder, else downloaded; checked against SHA256SUMS either way. */
  async download(release: FirmwareRelease): Promise<FirmwareImage | undefined> {
    this.update((ui) => ({ ...ui, busy: `getting firmware ${release.version}` }));
    try {
      const image = await this.options.firmware.image(release);
      const how = image.cached ? 'was in the cache' : 'downloaded';
      this.finish(
        { ok: true, text: `firmware ${image.label} ${how}, SHA256 ok: ${image.path ?? ''}`, atMs: this.now() },
        'ok',
      );
      return image;
    } catch (err) {
      this.finish({ ok: false, text: `download: ${(err as Error).message}`, atMs: this.now() }, 'error');
      return undefined;
    } finally {
      this.update((ui) => ({ ...ui, busy: undefined }));
    }
  }

  /** A local image file, checked to be an ESP32 image. */
  async openFile(path: string): Promise<FirmwareImage | undefined> {
    try {
      return await this.options.firmware.file(path);
    } catch (err) {
      this.finish({ ok: false, text: (err as Error).message, atMs: this.now() }, 'error');
      return undefined;
    }
  }

  /** Update the board: a checklist of steps with the progress of the current one. */
  async flash(target: { release?: FirmwareRelease; image?: FirmwareImage }, label: string): Promise<boolean> {
    const flash = this.options.firmware.flash;
    if (!flash) {
      this.finish({ ok: false, text: `flash: ${this.flashNote ?? 'not available'}`, atMs: this.now() }, 'warn');
      return false;
    }
    if (this.flashing) return false;
    const job: FlashJob = {
      label,
      steps: FLASH_STEPS.map((s) => ({ ...s, status: 'todo' as StepStatus })),
      notes: [],
      done: false,
    };
    this.update((ui) => ({ ...ui, flash: job, result: undefined }));
    const step = (id: FlashStepId, status: StepStatus, detail?: string) =>
      this.update((ui) =>
        ui.flash
          ? {
              ...ui,
              flash: {
                ...ui.flash,
                steps: ui.flash.steps.map((s) => (s.id === id ? { ...s, status, detail: detail ?? s.detail } : s)),
              },
            }
          : ui,
      );
    let ok = false;
    try {
      step('download', 'run');
      let image = target.image;
      if (image) step('download', 'ok', `${image.label}, ${Math.round(image.bytes.length / 1024)} KB`);
      else {
        image = await this.options.firmware.image(target.release!);
        step(
          'download',
          'ok',
          `${Math.round(image.bytes.length / 1024)} KB, SHA256 ok${image.cached ? ' (cached)' : ''}`,
        );
      }
      this.log('info', `updating firmware: ${label}; keep the board plugged in`);
      const result = await flash(image, {
        step,
        progress: (p) => this.update((ui) => (ui.flash ? { ...ui, flash: { ...ui.flash, progress: p } } : ui)),
        note: (n) => {
          this.log(n.level, n.text);
          this.update((ui) => (ui.flash ? { ...ui, flash: { ...ui.flash, notes: [...ui.flash.notes, n] } } : ui));
        },
      });
      ok = result.ok;
    } catch (err) {
      step('download', 'fail', (err as Error).message);
      this.log('error', `firmware update: ${(err as Error).message}`);
    }
    this.update((ui) => ({
      ...ui,
      sinceMs: this.now(),
      device: { ...ui.device, lastFrameMs: undefined },
      flash: ui.flash && { ...ui.flash, done: true, ok, progress: undefined },
    }));
    this.finish(
      { ok, text: ok ? `firmware update done: ${label}` : 'firmware update failed', atMs: this.now() },
      ok ? 'ok' : 'error',
    );
    if (this.client) void this.refresh();
    return ok;
  }

  /** Leave the finished update's checklist. */
  closeFlash(): void {
    if (!this.flashing) this.update((ui) => ({ ...ui, flash: undefined }));
  }
}
