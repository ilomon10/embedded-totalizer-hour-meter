// firmware.ts: `hour-meter firmware ...`: the device's firmware version, the firmware on the GitHub releases,
// downloading it, and flashing it over the board's USB port.
//
//   hour-meter firmware [version]        the device's firmware and the newest release
//   hour-meter firmware list             every firmware release
//   hour-meter firmware download [latest|2.5.0|v1.0.0] [-o dir]
//   hour-meter firmware flash [latest|2.5.0|v1.0.0|file.bin] [--baud N] [--no-reset] [--yes]
//
// A flash first backs up the counters and settings. They live in the EEPROM, which flashing does not touch, but a
// firmware with another EEPROM layout reformats it at boot. After the flash the version is checked and what the
// update lost is put back (updateDevice, shared with the TUI). parseFirmwareArgs() and planRestore() are pure
// (test/firmware.test.ts).
import { join } from 'node:path';

import { connect, connectHelp, DEFAULT_PORT, env, takeFlag, takeOption, type Target } from './cli.ts';
import type { CommandValues, DeviceClient } from './device.ts';
import { BAUDS, DEFAULT_BAUD, flashDevice, type FlashIo, type FlashProgress, inspectImage, systemIo } from './flash.ts';
import {
  cacheDir,
  compareVersions,
  downloadFirmware,
  findRelease,
  type FirmwareRelease,
  formatFirmware,
  type GitHubOptions,
  listFirmware,
  REPO,
} from './releases.ts';
import type { DecodedMessage } from './sensorframe.ts';
import { decodeStatusFlags, GET, SETTINGS } from './tags.ts';

export const FIRMWARE_USAGE = `Firmware (GitHub releases of ${REPO}):
  hour-meter firmware [version]        the device's firmware and the newest release
  hour-meter firmware list             every firmware release
  hour-meter firmware download [latest|2.5.0|v1.0.0] [-o dir]    download, checked against SHA256SUMS
  hour-meter firmware flash [latest|2.5.0|v1.0.0|file.bin] [--baud 460800] [--no-reset] [--yes]
                                       over the board's USB port: backs up the counters and settings, writes,
                                       checks the version, restores what the new firmware lost
                                       (--no-reset: you hold BOOT and tap EN; Linux and macOS only)`;

export type FirmwareArgs =
  | { sub: 'version' | 'list' }
  | { sub: 'download'; spec: string; dir: string }
  | { sub: 'flash'; spec: string; baud: number; noReset: boolean; yes: boolean };

/** The words after `firmware` (--port, --pin and --demo already taken) -> what to do. */
export function parseFirmwareArgs(args: string[]): FirmwareArgs {
  const [sub = 'version', ...rest] = args;
  const one = (words: string[]): string => {
    const option = words.find((w) => w.startsWith('-'));
    if (option) throw new Error(`firmware ${sub}: unknown option '${option}'`);
    if (words.length > 1) throw new Error(`firmware ${sub}: one release or file, not '${words.join(' ')}'`);
    return words[0] ?? 'latest';
  };
  switch (sub) {
    case 'version':
    case 'list':
      if (rest.length) throw new Error(`firmware ${sub}: unexpected '${rest[0]}'`);
      return { sub };
    case 'download': {
      const out = takeOption(rest, '-o');
      const spec = one(out.rest);
      if (!isReleaseWord(spec)) throw new Error(`firmware download: latest, a version (2.5.0) or a tag (v1.0.0)`);
      return { sub, spec, dir: out.value ?? '.' };
    }
    case 'flash': {
      const baud = takeOption(rest, '--baud');
      const noReset = takeFlag(baud.rest, '--no-reset');
      const yes = takeFlag(noReset.rest, '--yes');
      const speed = Number(baud.value ?? DEFAULT_BAUD);
      if (!BAUDS.includes(speed)) throw new Error(`--baud: one of ${BAUDS.join(', ')}`);
      return { sub, spec: one(yes.rest), baud: speed, noReset: noReset.value, yes: yes.value };
    }
    default:
      throw new Error(`firmware what? version, list, download or flash\n${FIRMWARE_USAGE}`);
  }
}

/** 'latest', a firmware version (2.5.0) or a release tag (v1.0.0, firmware-v2.4.0). Anything else is a file. */
export function isReleaseWord(spec: string): boolean {
  return spec === 'latest' || /^\d+\.\d+\.\d+$/.test(spec) || /^(firmware-)?v\d+\.\d+\.\d+$/.test(spec);
}

/** Why `target` cannot be flashed, or undefined. Only the board's own USB port reaches the ROM bootloader. */
export function flashPortProblem(target: Pick<Target, 'demo' | 'port'>, os: string = Deno.build.os) {
  if (target.demo) return 'flashing needs the real board on its USB port, not --demo';
  if (target.port.startsWith('tcp://')) return `flashing needs the board's USB port, not ${target.port}`;
  if (/rfcomm/i.test(target.port)) return "flashing needs the board's USB port: Bluetooth cannot reach the bootloader";
  if (os === 'windows') return 'flashing needs Linux or macOS: serial ports are not supported on Windows yet';
  return undefined;
}

// ------------------------------------------------------------------ images --

export interface FirmwareImage {
  bytes: Uint8Array;
  /** "2.6.0 (v1.1.0)" or the file's path. */
  label: string;
  /** The firmware version of a release (unknown for a file). */
  version?: string;
  /** Where the file is (a release: in the cache folder). */
  path?: string;
  /** A release image that was already in the cache folder (not downloaded again). */
  cached?: boolean;
  /** Why a downloaded release image could not be kept in the cache folder (it is still checked and usable). */
  notSaved?: string;
}

export const firmwareDir = () => join(cacheDir(env), 'firmware');
export const backupDir = () => join(cacheDir(env), 'backups');

/** A release's image, downloaded into the cache folder (checked against SHA256SUMS). */
export async function releaseImage(release: FirmwareRelease, github: GitHubOptions = {}): Promise<FirmwareImage> {
  const file = await downloadFirmware(release, firmwareDir(), github);
  const label = `${release.version} (${release.tag})`;
  const path = file.notSaved ? undefined : file.path;
  return { bytes: file.bytes, label, version: release.version, path, cached: file.cached, notSaved: file.notSaved };
}

/** A local image file, refused unless it is an ESP32 image (inspectImage). */
export async function fileImage(path: string): Promise<FirmwareImage> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch {
    throw new Error(`no such file or release: '${path}' (hour-meter firmware list shows the releases)`);
  }
  inspectImage(bytes);
  return { bytes, label: path, path };
}

async function pickRelease(spec: string, github: GitHubOptions): Promise<FirmwareRelease> {
  const release = findRelease(await listFirmware(github), spec);
  if (!release) throw new Error(`no firmware release '${spec}' (hour-meter firmware list shows them)`);
  return release;
}

// -------------------------------------------------------- backup + restore --

/** Anything that sends a COMMAND and resolves with its ACK: DeviceClient, the TUI's client. */
export interface Requester {
  request(values: CommandValues): Promise<DecodedMessage>;
}

/** What an update must keep, read from the device before it and compared after it. */
export interface Snapshot {
  deviceId: number;
  fwVersion?: number;
  statusFlags: number;
  runSeconds?: number;
  totalCount?: number;
  settings: Record<string, number | boolean>;
  /** When it was read (ISO 8601). */
  at: string;
}

export interface Note {
  level: 'info' | 'ok' | 'warn' | 'error';
  text: string;
}

const optionalNumber = (v: unknown) => (typeof v === 'number' ? v : undefined);
const hours = (seconds: number | undefined) => (seconds === undefined ? '?' : `${(seconds / 3600).toFixed(2)} h`);
const hex = (id: number) => (id >>> 0).toString(16).padStart(8, '0');
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function snapshot(dev: Requester): Promise<Snapshot> {
  const status = await dev.request({ get: GET.status });
  const hour = (await dev.request({ get: GET.hour })).values;
  const stored = (await dev.request({ get: GET.settings })).values;
  const settings: Record<string, number | boolean> = {};
  for (const name of Object.keys(SETTINGS)) {
    const v = stored[name];
    if (typeof v === 'number' || typeof v === 'boolean') settings[name] = v;
  }
  return {
    deviceId: status.deviceId,
    fwVersion: optionalNumber(status.values.fwVersion),
    statusFlags: Number(status.values.statusFlags ?? 0),
    runSeconds: optionalNumber(hour.runSeconds),
    totalCount: optionalNumber(hour.totalCount),
    settings,
    at: new Date().toISOString(),
  };
}

/** Keep a snapshot as JSON in `dir`; returns the file. */
export async function saveBackup(snap: Snapshot, dir: string = backupDir()): Promise<string> {
  // Only the user may read it: the settings include the Bluetooth PIN.
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${hex(snap.deviceId)}-${snap.at.replace(/[:.]/g, '-')}.json`);
  await Deno.writeTextFile(path, `${JSON.stringify(snap, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export interface RestorePlan {
  /** Counters that went back during the update, as the command values that put them back. */
  counters: CommandValues;
  /** Settings that differ from the backup, with the backed-up values. */
  settings: CommandValues;
  /** The new firmware lost the stored settings (it runs on defaults now): `settings` are put back. */
  settingsLost: boolean;
  /** The new firmware reformatted the EEPROM (another layout). */
  formatted: boolean;
}

export function planRestore(before: Snapshot, after: Snapshot): RestorePlan {
  const counters: CommandValues = {};
  // Lower after the flash: reformatted, or counted but not yet saved when the chip was reset.
  if (before.runSeconds !== undefined && (after.runSeconds ?? 0) < before.runSeconds) {
    counters.setRunSeconds = before.runSeconds;
  }
  if (before.totalCount !== undefined && (after.totalCount ?? 0) < before.totalCount) {
    counters.setTotalCount = before.totalCount;
  }
  const settings: CommandValues = {};
  for (const [name, value] of Object.entries(before.settings)) {
    if (after.settings[name] !== undefined && after.settings[name] !== value) settings[name] = value;
  }
  const flagsBefore = decodeStatusFlags(before.statusFlags);
  const flagsAfter = decodeStatusFlags(after.statusFlags);
  return {
    counters,
    settings,
    settingsLost: flagsAfter.includes('settingsDefaults') && !flagsBefore.includes('settingsDefaults'),
    formatted: flagsAfter.includes('eepromFormatted'),
  };
}

/**
 * After the update: check the version against `expected` (a release; undefined for a file), then put back what the
 * new firmware lost. Counters that went back are restored. Settings are restored when the firmware lost them all
 * (defaults); otherwise the differences are listed with a ready `hour-meter set` line.
 */
export async function restoreAfterUpdate(
  dev: Requester,
  before: Snapshot | undefined,
  after: Snapshot,
  expected?: string,
): Promise<Note[]> {
  const notes: Note[] = [];
  const now = formatFirmware(after.fwVersion);
  notes.push(
    expected && now !== expected
      ? { level: 'error', text: `the device reports firmware ${now}, not ${expected}` }
      : { level: 'ok', text: `the device runs firmware ${now}` },
  );
  if (decodeStatusFlags(after.statusFlags).includes('flashStoreMissing')) {
    notes.push({
      level: 'error',
      text: 'no flash store (flashStoreMissing): the partition table on the board has no hmdata partition, ' +
        'so the counters can only be kept in an EEPROM. Flash the full merged image again',
    });
  }
  if (!before) return notes;
  if (before.deviceId !== after.deviceId) {
    const text = `another device answered (${hex(after.deviceId)}; the backup is of ${hex(before.deviceId)})`;
    notes.push({ level: 'warn', text: `${text}: nothing restored` });
    return notes;
  }
  const plan = planRestore(before, after);
  if (plan.formatted) notes.push({ level: 'warn', text: 'the new firmware reformatted the EEPROM (another layout)' });

  if (Object.keys(plan.counters).length) {
    const text = [
      plan.counters.setRunSeconds === undefined
        ? ''
        : `hour meter ${hours(after.runSeconds)} -> ${hours(before.runSeconds)}`,
      plan.counters.setTotalCount === undefined
        ? ''
        : `totalizer ${after.totalCount ?? '?'} -> ${before.totalCount} pulses`,
    ].filter(Boolean).join(', ');
    try {
      await dev.request(plan.counters);
      notes.push({ level: 'ok', text: `counters restored from the backup: ${text}` });
    } catch (err) {
      notes.push({ level: 'error', text: `could not restore the counters (${(err as Error).message}): ${text}` });
    }
  }

  const names = Object.keys(plan.settings);
  if (names.length === 0) return notes;
  const line = names.map((name) => `${name}=${plan.settings[name]}`).join(' ');
  if (!plan.settingsLost) {
    const diff = names.map((name) => `${name} ${after.settings[name]} (was ${plan.settings[name]})`).join(', ');
    notes.push({ level: 'warn', text: `settings changed by the update: ${diff}. To restore: hour-meter set ${line}` });
    return notes;
  }
  // One COMMAND first: the firmware checks rules between settings (imuStreamHz <= imuSampleHz) on the state after
  // the whole COMMAND. If the new firmware refuses one setting, put back the others one by one.
  const failed: string[] = [];
  await dev.request(plan.settings).catch(async () => {
    for (const name of names) await dev.request({ [name]: plan.settings[name] }).catch(() => failed.push(name));
  });
  const restored = names.length - failed.length;
  notes.push(
    failed.length
      ? { level: 'warn', text: `${restored} settings restored; the new firmware refused ${failed.join(', ')}` }
      : { level: 'ok', text: `the new firmware lost the settings: ${restored} restored from the backup` },
  );
  return notes;
}

/** How long `reopen` waits for a first frame: settle() retries while the new firmware boots anyway. */
export const REOPEN_READY_MS = 500;
const REOPEN_TRIES = 10; // a second apart: the port can be gone for a moment (USB hub, brown-out)

/** Read the device again until it answers (the new firmware needs a moment to boot). */
async function settle(dev: Requester, retryMs: number, tries = 3): Promise<Snapshot | undefined> {
  for (let i = 0; i < tries; i++) {
    try {
      return await snapshot(dev);
    } catch {
      await sleep(retryMs);
    }
  }
  return undefined;
}

export interface UpdateOptions {
  port: string;
  image: FirmwareImage;
  baud?: number;
  noReset?: boolean;
  onProgress?: (progress: FlashProgress) => void;
  note: (note: Note) => void;
  /** Open the port again after the flash (also after a failed one). */
  reopen: () => Promise<DeviceClient>;
  io?: FlashIo;
  /** Pause between tries to reopen the port or read the device (default 1 s). */
  retryMs?: number;
}

/** Open the port again. It can be gone for a moment after the restart; undefined (said) if it does not come back. */
async function reopenPort(reopen: () => Promise<DeviceClient>, note: (note: Note) => void, retryMs: number) {
  let last: unknown;
  for (let i = 0; i < REOPEN_TRIES; i++) {
    try {
      return await reopen();
    } catch (err) {
      last = err;
      await sleep(retryMs);
    }
  }
  note({ level: 'error', text: `the port did not come back (${(last as Error).message})` });
  return undefined;
}

/**
 * Flash, reopen the port, check the version and restore what the update lost. `before` is the backup taken first
 * (undefined if the device did not answer). The port must be free: close the client first. Never throws: returns
 * the reopened client (undefined if the port did not come back), and `ok` is false if anything failed (the reason
 * went to `note`).
 */
export async function updateDevice(
  options: UpdateOptions,
  before: Snapshot | undefined,
): Promise<{ dev?: DeviceClient; ok: boolean }> {
  const { note } = options;
  let restarted: boolean | undefined; // undefined: the flash failed
  try {
    const result = await flashDevice(options.port, options.image.bytes, {
      baud: options.baud,
      noReset: options.noReset,
      onProgress: options.onProgress,
      note: (text) => note({ level: 'info', text }),
    }, options.io ?? systemIo);
    restarted = result.restarted;
    note({
      level: 'ok',
      text: `${options.image.label} written and verified (${kb(result.bytes)}, ${result.baud} baud)`,
    });
    if (!result.restarted) note({ level: 'warn', text: 'press EN (reset) on the board to start the new firmware' });
  } catch (err) {
    note({ level: 'error', text: `flash failed: ${(err as Error).message}` });
  }
  const retryMs = options.retryMs ?? 1000;
  const dev = await reopenPort(options.reopen, note, retryMs);
  if (!dev) return { ok: false };
  if (restarted === undefined) return { dev, ok: false };
  if (!restarted) return { dev, ok: true }; // the board waits for EN: nothing to check yet
  const after = await settle(dev, retryMs);
  if (!after) {
    note({ level: 'error', text: 'the device does not answer after the update (check: hour-meter firmware version)' });
    return { dev, ok: false };
  }
  const notes = await restoreAfterUpdate(dev, before, after, options.image.version);
  notes.forEach(note);
  return { dev, ok: !notes.some((n) => n.level === 'error') };
}

// --------------------------------------------------------------------- CLI --

const STAGE: Record<FlashProgress['stage'], string> = {
  reset: 'resetting into the bootloader',
  sync: 'connecting to the bootloader',
  write: 'writing',
  verify: 'verifying',
  restart: 'restarting',
};

/** "writing   ██████░░░░░░░░░░░░░░  30%  352 KB / 1170 KB" (the TUI shows it too). */
export function progressLine(p: FlashProgress, width = 20): string {
  const pct = p.total ? Math.min(100, Math.floor((100 * p.done) / p.total)) : 0;
  const filled = Math.round((width * pct) / 100);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${STAGE[p.stage].padEnd(29)} ${bar} ${String(pct).padStart(3)}%  ${kb(p.done)} / ${kb(p.total)}`;
}

/** Progress on one rewritten line on a terminal, one line per stage otherwise. */
function progressPrinter() {
  const tty = Deno.stdout.isTerminal();
  const encoder = new TextEncoder();
  let open = false;
  let stage = '';
  return {
    progress(p: FlashProgress) {
      if (tty) {
        Deno.stdout.writeSync(encoder.encode(`\r${progressLine(p)}\x1b[K`));
        open = true;
      } else if (p.stage !== stage) {
        console.log(`${STAGE[p.stage]}...`);
      }
      stage = p.stage;
    },
    end() {
      if (open) console.log();
      open = false;
    },
  };
}

function printNote(n: Note): void {
  const mark = { info: ' ', ok: '✔', warn: '▲', error: '✘' }[n.level];
  (n.level === 'error' ? console.error : console.log)(`${mark} ${n.text}`);
}

const day = (iso: string) => iso.slice(0, 10) || '?';

async function runVersion(target: Target, github: GitHubOptions): Promise<number> {
  const dev = await connect(target).catch((err) => {
    throw new Error(`${(err as Error).message}\n${connectHelp()}`);
  });
  let fw: unknown;
  try {
    fw = (await dev.request({ get: GET.status })).values.fwVersion;
  } finally {
    dev.close();
  }
  const device = formatFirmware(fw);
  console.log(`device firmware: ${device}`);
  const latest = await listFirmware(github).then((list) => findRelease(list, 'latest')).catch((err: Error) => err);
  if (latest instanceof Error) console.log(`latest release:  unknown (${latest.message})`);
  else if (!latest) console.log('latest release:  none found');
  else {
    const c = device === '?' ? undefined : compareVersions(latest.version, device);
    const verdict = c === undefined
      ? ''
      : c > 0
      ? ': update available (hour-meter firmware flash)'
      : c === 0
      ? ': up to date'
      : ': the device runs a newer firmware';
    console.log(`latest release:  ${latest.version} (${latest.tag}, ${day(latest.date)})${verdict}`);
  }
  return 0;
}

async function runList(github: GitHubOptions): Promise<number> {
  const list = await listFirmware(github);
  if (list.length === 0) console.log('no firmware releases found');
  const latest = findRelease(list, 'latest');
  for (const r of list) {
    const marks = [r === latest ? 'latest' : '', r.prerelease ? 'prerelease' : ''].filter(Boolean).join(', ');
    console.log(`${r.version.padEnd(8)} ${r.tag.padEnd(18)} ${day(r.date)}${marks ? `  ${marks}` : ''}`);
  }
  return 0;
}

async function runDownload(spec: string, dir: string, github: GitHubOptions): Promise<number> {
  const release = await pickRelease(spec, github);
  const file = await downloadFirmware(release, dir, github);
  if (file.notSaved) throw new Error(`checked against SHA256SUMS, but not saved as ${file.path}: ${file.notSaved}`);
  console.log(`${file.cached ? 'already downloaded' : 'downloaded'}: ${file.path}`);
  console.log(
    `firmware ${release.version} (${release.tag}), ${kb(file.bytes.length)}, SHA-256 ${file.sha256}: matches`,
  );
  return 0;
}

/** Read the device and save a backup. Undefined (said) if the device does not answer: flashing still works. */
async function backupBeforeFlash(target: Target): Promise<Snapshot | undefined> {
  const dev = await connect({ ...target, pin: undefined }, 1500).catch((err) => {
    throw new Error(`${(err as Error).message}\n${connectHelp()}`); // no port, nothing to flash
  });
  let snap: Snapshot;
  try {
    snap = await snapshot(dev);
  } catch (err) {
    console.log(`device: does not answer (${(err as Error).message})`);
    console.log('        no backup; flashing still works, the bootloader is in ROM');
    return undefined;
  } finally {
    dev.close();
  }
  console.log(
    `device: firmware ${formatFirmware(snap.fwVersion)}, hour meter ${hours(snap.runSeconds)}, ` +
      `totalizer ${snap.totalCount ?? '?'} pulses`,
  );
  await saveBackup(snap).then(
    (file) => console.log(`backup: ${file}`),
    (err) => console.log(`backup: not saved (${(err as Error).message}); kept in memory for the restore`),
  );
  return snap;
}

async function runFlash(args: Extract<FirmwareArgs, { sub: 'flash' }>, target: Target, github: GitHubOptions) {
  const problem = flashPortProblem(target);
  if (problem) throw new Error(problem);
  const image = isReleaseWord(args.spec)
    ? await releaseImage(await pickRelease(args.spec, github), github)
    : await fileImage(args.spec);
  console.log(`image:  ${image.label}, ${inspectImage(image.bytes)} image, ${kb(image.bytes.length)}`);
  if (image.notSaved) console.log(`        checked, but not kept in the cache folder (${image.notSaved})`);
  const before = await backupBeforeFlash(target);
  const now = before?.fwVersion === undefined ? undefined : formatFirmware(before.fwVersion);
  if (now && image.version && compareVersions(image.version, now) < 0) {
    console.log(`note:   ${image.version} is older than the device's ${now} (a downgrade)`);
  }
  if (!args.yes && !confirm(`Write ${image.label} to the board on ${target.port}?`)) {
    console.log('cancelled (--yes skips this question)');
    return 1;
  }
  const printer = progressPrinter();
  const { dev, ok } = await updateDevice({
    port: target.port,
    image,
    baud: args.baud,
    noReset: args.noReset,
    onProgress: printer.progress,
    note: (n) => {
      printer.end();
      printNote(n);
    },
    reopen: () => connect({ ...target, pin: undefined }, REOPEN_READY_MS),
  }, before);
  dev?.close();
  return ok ? 0 : 1;
}

/** `hour-meter firmware ...` (argv without the word `firmware`): returns the exit code. */
export async function run(argv: string[]): Promise<number> {
  const port = takeOption(argv, '--port');
  const pin = takeOption(port.rest, '--pin');
  const demo = takeFlag(pin.rest, '--demo');
  const args = parseFirmwareArgs(demo.rest);
  const target: Target = {
    demo: demo.value,
    port: port.value ?? env('HOUR_METER_PORT') ?? DEFAULT_PORT,
    pin: pin.value ?? env('HOUR_METER_PIN'),
  };
  const github: GitHubOptions = { token: env('GITHUB_TOKEN') };
  switch (args.sub) {
    case 'version':
      return await runVersion(target, github);
    case 'list':
      return await runList(github);
    case 'download':
      return await runDownload(args.spec, args.dir, github);
    case 'flash':
      return await runFlash(args, target, github);
  }
}
