// firmware-actions.ts: the work behind 9 Firmware: list the releases, get an image (cache or download, checked
// against SHA256SUMS), and update the board: back up, pause the connection (the flasher needs the port), flash,
// reopen, check and restore. Each step is reported, so the screen shows a checklist instead of one line.
import { connect, env } from '../cli.ts';
import type { Connection } from '../connection.ts';
import {
  fileImage,
  type FirmwareImage,
  flashPortProblem,
  type Note,
  releaseImage,
  REOPEN_READY_MS,
  saveBackup,
  snapshot,
  updateDevice,
  type UpdateOptions,
} from '../firmware.ts';
import type { FlashProgress } from '../flash.ts';
import { type FirmwareRelease, listFirmware } from '../releases.ts';
import { SETTINGS } from '../tags.ts';

export type FlashStepId = 'download' | 'backup' | 'bootloader' | 'write' | 'verify' | 'restart' | 'restore';
export type StepStatus = 'todo' | 'run' | 'ok' | 'warn' | 'fail';

export const FLASH_STEPS: ReadonlyArray<{ id: FlashStepId; label: string }> = [
  { id: 'download', label: 'Download & check' },
  { id: 'backup', label: 'Back up' },
  { id: 'bootloader', label: 'Enter bootloader' },
  { id: 'write', label: 'Write' },
  { id: 'verify', label: 'Verify' },
  { id: 'restart', label: 'Restart & reconnect' },
  { id: 'restore', label: 'Check & restore' },
];

/** The flash stages (flash.ts) and the checklist step each belongs to. */
export const STAGE_STEP: Record<FlashProgress['stage'], FlashStepId> = {
  reset: 'bootloader',
  sync: 'bootloader',
  write: 'write',
  verify: 'verify',
  restart: 'restart',
};

export interface FlashHooks {
  progress(p: FlashProgress): void;
  note(n: Note): void;
  step(id: FlashStepId, status: StepStatus, detail?: string): void;
}

export interface FirmwareActions {
  /** The firmware on the GitHub releases, newest first. */
  list(): Promise<FirmwareRelease[]>;
  /** A release's image, from the cache folder or downloaded, checked against SHA256SUMS. */
  image(release: FirmwareRelease): Promise<FirmwareImage>;
  /** A local image file (refused unless it is an ESP32 image). */
  file(path: string): Promise<FirmwareImage>;
  /** Back up, flash, reconnect, restore. Only for the board's own USB port: `flashNote` says why it is missing. */
  flash?(image: FirmwareImage, hooks: FlashHooks): Promise<{ ok: boolean }>;
  flashNote?: string;
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** `port` stands in for the serial port in tests, as in updateDevice. */
export function firmwareActions(
  conn: Connection,
  port: Partial<Pick<UpdateOptions, 'io' | 'reopen'>> = {},
): FirmwareActions {
  const github = { token: env('GITHUB_TOKEN') };
  const problem = flashPortProblem({ demo: conn.demo, port: conn.port });
  // No time sync on this client: the connection turns it on when it takes the client back.
  const reopen = port.reopen ?? (() => connect({ demo: false, port: conn.port }, REOPEN_READY_MS));
  return {
    list: () => listFirmware(github),
    image: (release) => releaseImage(release, github),
    file: (path) => fileImage(path.replace(/^~(?=\/)/, env('HOME') ?? '~')),
    flashNote: problem && `${problem[0].toUpperCase()}${problem.slice(1)}.`,
    flash: problem
      ? undefined
      : async (image, hooks) => {
          hooks.step('backup', 'run');
          const before = conn.client && (await snapshot(conn.client).catch(() => undefined));
          if (!before) hooks.step('backup', 'warn', 'the device does not answer: no backup (flashing still works)');
          else {
            const settings = Object.keys(before.settings).filter((n) => n in SETTINGS).length;
            await saveBackup(before).then(
              (file) => hooks.step('backup', 'ok', `counters + ${settings} settings → ${file}`),
              (err) => hooks.step('backup', 'warn', `kept in memory, not saved (${(err as Error).message})`),
            );
          }
          await conn.pause(); // also waits for a reconnect that is opening the port right now
          let current: FlashStepId | undefined;
          let failed = false; // the flash did not finish: nothing is checked or restored
          let waiting = false; // written, but the board was not restarted: it waits for EN
          let runs: string | undefined; // the version the device reports after the update
          let warned = false; // a warning from the check and restore
          const { dev, ok } = await updateDevice(
            {
              port: conn.port,
              image,
              io: port.io,
              onProgress: (p) => {
                const step = STAGE_STEP[p.stage];
                if (step !== current) {
                  if (current) hooks.step(current, 'ok');
                  current = step;
                  hooks.step(step, 'run');
                }
                hooks.progress(p);
              },
              note: (n) => {
                if (n.text.startsWith('ESP32 ')) {
                  hooks.step('bootloader', 'ok', n.text);
                  current = 'write'; // the chip answered: a failure from here on (attach, baud, erase) fails the write
                  hooks.step('write', 'run');
                }
                if (/written and verified/.test(n.text))
                  hooks.step('verify', 'ok', `${kb(image.bytes.length)} verified`);
                if (/flash failed/.test(n.text)) {
                  failed = true;
                  if (current) hooks.step(current, 'fail', n.text);
                }
                if (/press EN/.test(n.text)) waiting = true;
                runs = /^the device runs firmware (.+)$/.exec(n.text)?.[1] ?? runs;
                if (runs && n.level === 'warn') warned = true;
                hooks.note(n);
              },
              reopen,
            },
            before,
          );
          if (!dev) hooks.step('restart', 'fail', 'the port did not come back');
          else if (waiting) hooks.step('restart', 'warn', 'press EN (reset) on the board to start the new firmware');
          else hooks.step('restart', 'ok', 'reconnected');
          if (failed) hooks.step('restore', 'todo', 'skipped: the flash did not finish');
          else if (!dev) hooks.step('restore', 'todo', 'skipped: the board is not connected');
          else if (waiting) hooks.step('restore', 'todo', 'after the restart: r reads the device again');
          else if (!ok || !runs) hooks.step('restore', 'fail', 'see the notes below');
          else
            hooks.step(
              'restore',
              warned ? 'warn' : 'ok',
              `runs ${runs}${warned ? ': see the notes below' : ', nothing lost'}`,
            );
          conn.resume(dev);
          return { ok };
        },
  };
}
