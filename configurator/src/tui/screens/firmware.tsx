// firmware.tsx: 9 Firmware. The device's version against the releases (prereleases marked, never preselected),
// an update behind a dialog that needs FLASH typed (and warns about a downgrade), and the update itself as a
// checklist: download, backup, bootloader, write, verify, restart, check and restore.
import type { FirmwareImage } from '../../firmware.ts';
import { compareVersions, findRelease, type FirmwareRelease, formatFirmware } from '../../releases.ts';
import { progressBar } from '../model/format.ts';
import { charOf, useDialogKeys, useRefState, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import {
  Blank,
  bold,
  checkMark,
  CheckRow,
  dim,
  Dialog,
  DialogButtons,
  editLine,
  FieldLine,
  keyHint,
  Line,
  Spread,
  warn,
} from '../ui.tsx';

/** The steps that show the flasher's progress bar while they run. */
const PROGRESS_STEPS: readonly string[] = ['bootloader', 'write', 'verify', 'restart'];

function FlashDialog({
  label,
  from,
  release,
  image,
  onClose,
}: {
  label: string;
  from: string;
  release?: FirmwareRelease;
  image?: FirmwareImage;
  onClose(): void;
}) {
  const shell = useShell();
  const { ctrl } = shell;
  const [word, setWord, wordRef] = useRefState('');
  const to = release?.version ?? image?.version;
  const downgrade = to && from !== '?' && compareVersions(to, from) < 0;
  useDialogKeys((k) => {
    if (k.name === 'escape') onClose();
    else if (k.name === 'return') {
      if (wordRef.current !== 'FLASH') return true;
      onClose();
      void ctrl.flash({ release, image }, label);
    } else {
      const next = editLine(wordRef.current, k, (c) => /[A-Za-z]/.test(c));
      if (next !== undefined) setWord(next);
    }
    return true;
  });
  return (
    <Dialog title="Update firmware" width={64}>
      <Line segs={[bold(`${from} → ${label}`)]} />
      <Line segs={[dim(`Over ${ctrl.port} · about 40 s · the board restarts`)]} />
      <Line segs={[dim('Backup first: counters and settings (put back if the update loses them)')]} />
      {downgrade ? (
        <Line segs={[warn(`${MARK.warn} This is OLDER than the device's ${from}: settings may be reset.`)]} />
      ) : null}
      <Blank />
      <FieldLine label="Type FLASH to start:  " text={word} />
      <Blank />
      <DialogButtons ok="Start" disabled={word !== 'FLASH'} />
    </Dialog>
  );
}

function PathDialog({ onImage, onClose }: { onImage(image: FirmwareImage): void; onClose(): void }) {
  const { ctrl } = useShell();
  const [path, setPath, pathRef] = useRefState('');
  const [, setOpening, openingRef] = useRefState(false);
  useDialogKeys((k) => {
    if (openingRef.current) return true; // reading the file: one Enter is enough
    if (k.name === 'escape') onClose();
    else if (k.name === 'return' && pathRef.current.trim()) {
      setOpening(true);
      void ctrl.openFile(pathRef.current.trim()).then((image) => {
        setOpening(false);
        if (image) onImage(image);
      });
    } else {
      const next = editLine(pathRef.current, k);
      if (next !== undefined) setPath(next);
    }
    return true;
  });
  return (
    <Dialog title="Flash a file" width={72}>
      <FieldLine label="Image  " text={path} placeholder="merged .bin or firmware.bin (~ works)" />
      <Blank />
      <DialogButtons ok="Next" />
    </Dialog>
  );
}

export function FirmwareScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const releases = ui.releases ?? [];
  const device = formatFirmware(ui.device.values.fwVersion);
  const latest = ui.releases ? findRelease(ui.releases, 'latest') : undefined;
  const [sel, setSel, selRef] = useRefState<number | undefined>(undefined);
  const start = Math.max(
    0,
    releases.findIndex((r) => r === latest),
  );
  const index = sel ?? start;
  const job = ui.flash;

  const ask = (release: FirmwareRelease) =>
    shell.openDialog(
      <FlashDialog
        label={`${release.version} (${release.tag})`}
        from={device}
        release={release}
        onClose={() => shell.openDialog(undefined)}
      />,
    );
  useScreenKeys((k) => {
    const c = charOf(k);
    if (job) {
      // The other keys stay with the shell: the screens, help, and q/p (refused while flashing).
      if (!job.done || (k.name !== 'return' && k.name !== 'escape')) return false;
      ctrl.closeFlash();
      return true;
    }
    const n = releases.length;
    const at = selRef.current ?? start;
    if ((k.name === 'down' || c === 'j') && n) setSel((at + 1) % n);
    else if ((k.name === 'up' || c === 'k') && n) setSel((at + n - 1) % n);
    else if (k.name === 'return' && releases[at]) {
      if (!ctrl.canFlash) ctrl.log('warn', `flash: ${ctrl.flashNote ?? 'not available'}`);
      else ask(releases[at]);
    } else if (c === 'd' && releases[at]) void ctrl.download(releases[at]);
    else if (c === 'c') void ctrl.checkReleases();
    else if (c === 'f') {
      if (!ctrl.canFlash) ctrl.log('warn', `flash: ${ctrl.flashNote ?? 'not available'}`);
      else {
        shell.openDialog(
          <PathDialog
            onClose={() => shell.openDialog(undefined)}
            onImage={(image) =>
              shell.openDialog(
                <FlashDialog
                  label={image.label}
                  from={device}
                  image={image}
                  onClose={() => shell.openDialog(undefined)}
                />,
              )
            }
          />,
        );
      }
    } else return false;
    return true;
  });

  if (job) {
    const progress = job.progress;
    // A note already shown as a step's detail (the chip, the reason a step failed) is not repeated below.
    const notes = job.notes.filter((n) => !job.steps.some((s) => s.detail === n.text)).slice(-4);
    return (
      <box style={{ flexDirection: 'column' }}>
        <Line segs={[bold(`UPDATING  ${device} → ${job.label}`)]} />
        {job.steps.map((s) =>
          s.status === 'run' && progress && PROGRESS_STEPS.includes(s.id) ? (
            <Line
              key={s.id}
              segs={[
                checkMark('run'),
                ' ',
                s.label.padEnd(22),
                {
                  t: `${progressBar(progress.done / (progress.total || 1), 20)}  ${Math.floor((100 * progress.done) / (progress.total || 1))}%  ${Math.round(progress.done / 1024)}/${Math.round(progress.total / 1024)} KB`,
                  fg: C.cyan,
                },
              ]}
            />
          ) : (
            <CheckRow key={s.id} status={s.status} label={s.label} detail={s.detail} />
          ),
        )}
        <Blank />
        {notes.map((n, i) => (
          <Line
            key={i}
            wrap
            segs={[
              {
                t: `${n.level === 'error' ? MARK.error : n.level === 'warn' ? MARK.warn : n.level === 'ok' ? MARK.ok : ' '} ${n.text}`,
                fg: n.level === 'error' ? C.red : n.level === 'warn' ? C.yellow : C.dim,
              },
            ]}
          />
        ))}
        {notes.length ? <Blank /> : null}
        {job.done ? (
          <>
            <Line
              segs={[
                job.ok
                  ? { t: `${MARK.ok} Done.`, fg: C.green }
                  : { t: `${MARK.error} The update did not finish. A cut write is safe to repeat.`, fg: C.red },
              ]}
            />
            <Line segs={keyHint('Enter', 'back to the list')} />
          </>
        ) : (
          <Line segs={[dim('Keep the board plugged in. A cut write is safe to repeat.')]} />
        )}
      </box>
    );
  }

  const c = latest && device !== '?' ? compareVersions(latest.version, device) : undefined;
  return (
    <box style={{ flexDirection: 'column' }}>
      <Line segs={['ON THE DEVICE   ', bold(device)]} />
      <Spread
        left={[
          'LATEST          ',
          latest
            ? `${latest.version} · release ${latest.tag} · ${latest.date.slice(0, 10)}`
            : dim(ui.releasesNote ?? '–'),
        ]}
        right={
          c === undefined
            ? []
            : c > 0
              ? [warn(`${MARK.update} update available`)]
              : [{ t: c === 0 ? `${MARK.ok} up to date` : 'the device is newer', fg: C.green }]
        }
      />
      <Blank />
      <Line segs={[dim('  VERSION    RELEASE          DATE')]} />
      {releases.slice(0, Math.max(3, shell.height - 12)).map((r, i) => {
        const marks = [
          r === latest ? 'latest' : '',
          r.prerelease ? 'prerelease (never "latest")' : '',
          r.version === device ? 'on the device' : '',
          device !== '?' && compareVersions(r.version, device) < 0 && r.version !== device
            ? 'older: asks before a downgrade'
            : '',
        ]
          .filter(Boolean)
          .join(', ');
        const on = i === index;
        return (
          <Line
            key={`${r.tag}-${r.version}`}
            segs={[
              { t: on ? `${MARK.select} ` : '  ', fg: C.cyan },
              { t: r.version.padEnd(11), fg: r.prerelease ? C.dim : on ? C.cyan : C.fg, bold: on },
              { t: `${r.tag} `.padEnd(17), fg: r.prerelease ? C.dim : C.fg },
              dim(`${r.date.slice(0, 10)}   `),
              { t: marks, fg: r === latest ? C.green : C.dim },
            ]}
          />
        );
      })}
      {releases.length === 0 ? <Line segs={[dim(`  ${ui.releasesNote ?? 'no releases'}`)]} /> : null}
      <Blank />
      <Line
        segs={[
          ...keyHint('Enter', `update to ${releases[index]?.version ?? '…'}…`),
          ...keyHint('f', 'file…'),
          ...keyHint('d', 'download'),
          ...keyHint('c', 'check'),
        ]}
      />
      <Blank />
      {ctrl.canFlash ? (
        <>
          <Line segs={[dim("Uses the board's own USB port. Counters and settings are backed up first")]} />
          <Line segs={[dim('and put back if the new firmware loses them. Bluetooth pairing is kept.')]} />
        </>
      ) : (
        <Line segs={[warn(`${MARK.warn} ${ctrl.flashNote ?? 'Flashing is not available here.'}`)]} />
      )}
    </box>
  );
}
