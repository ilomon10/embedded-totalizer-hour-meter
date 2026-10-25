// overview.tsx: 1 Overview, the home screen. The counters and the engine at a glance, what needs attention (each
// with the screen that fixes it), and the device in one line per fact.
import { formatFirmware } from '../../releases.ts';
import { duration, num } from '../model/format.ts';
import { problems } from '../model/health.ts';
import { activeFlags, updateAvailable } from '../state.ts';
import { charOf, useNow, useRefState, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import { Blank, bold, dim, Heading, keyHint, Line, ok, type Seg, warn } from '../ui.tsx';
import { clockSegs, deviceEpochNow, issueSegs, moduleSegs, restartText, storageSegs } from './common.tsx';

export function OverviewScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const now = useNow(1000);
  const d = ui.device;
  const v = d.values;
  const flags = activeFlags(d);
  const list = problems(flags, { fwVersion: v.fwVersion as number | undefined, autoTimeSync: shell.autoTimeSync });
  const [sel, setSel, selRef] = useRefState(0);
  const index = Math.min(sel, Math.max(0, list.length - 1));

  useScreenKeys((k) => {
    const c = charOf(k);
    const n = list.length;
    const at = Math.min(selRef.current, Math.max(0, n - 1));
    if ((k.name === 'down' || c === 'j') && n) setSel((at + 1) % n);
    else if ((k.name === 'up' || c === 'k') && n) setSel((at + n - 1) % n);
    else if (k.name === 'return' && list[at]?.screen) shell.go(list[at].screen!);
    else if (c === 'h') {
      shell.intent.current = { screen: 'counters', action: 'hours' };
      shell.go('counters');
    } else if (c === 't') void ctrl.setTime();
    else if (c === 'w') shell.go('report');
    else return false;
    return true;
  });

  const ppu = Number(d.settings.pulsesPerUnit ?? 1);
  const epoch = deviceEpochNow(ui, now);
  const savedAgo =
    typeof v.lastSavedEpoch === 'number' && v.lastSavedEpoch > 0 && epoch !== undefined
      ? `saved ${duration(Math.max(0, epoch - v.lastSavedEpoch))} ago`
      : 'saved';
  const engine: Seg[] =
    v.alternator === undefined
      ? [dim('–')]
      : v.alternator
        ? [ok(`${MARK.live} RUNNING`), ui.engine?.sinceMs ? ` for ${duration((now - ui.engine.sinceMs) / 1000)}` : '']
        : [
            { t: `${MARK.off} stopped`, fg: C.fg },
            ui.engine?.sinceMs ? dim(` for ${duration((now - ui.engine.sinceMs) / 1000)}`) : '',
          ];
  const input: Seg[] =
    v.altInput === undefined
      ? []
      : [dim(`input ${v.altInput ? 'on' : 'off'}${typeof v.vibRms === 'number' ? ` · vib ${v.vibRms} mg` : ''}`)];
  const col = Math.max(22, Math.floor(shell.width / 3));
  const pad = (s: string) => `${s} `.padEnd(col);
  const update = updateAvailable(v.fwVersion, ui.releases);
  const telemetry = d.settings.telemetryIntervalMs;
  return (
    <box style={{ flexDirection: 'column' }}>
      <Line segs={[bold(pad('HOUR METER'), C.dim), bold(pad('TOTALIZER'), C.dim), bold('ENGINE', C.dim)]} />
      <Line
        segs={[bold(pad(`${num(v.runHours)} h`), C.green), bold(pad(`${num(v.totalUnits)} units`), C.green), ...engine]}
      />
      <Line
        segs={[
          dim(pad(`${String(v.runSeconds ?? '–')} s`)),
          dim(pad(`${String(v.totalCount ?? '–')} pulses · ${ppu} per unit`)),
          ...input,
        ]}
      />
      <Line segs={[dim(`${savedAgo}${v.journalSeq !== undefined ? ` (#${String(v.journalSeq)})` : ''}`)]} />
      <Blank />
      <Heading title="NEEDS ATTENTION" right={list.length ? [dim(`${list.length}`)] : []} />
      {v.statusFlags === undefined ? (
        <Line segs={[dim('reading the device status…')]} />
      ) : list.length === 0 ? (
        <Line segs={[ok(`${MARK.ok} nothing: the device reports no problems`)]} />
      ) : (
        list.slice(0, 5).map((issue, i) => <Line key={issue.flag} segs={issueSegs(issue, shell.width, i === index)} />)
      )}
      {list.length > 5 ? <Line segs={[dim(`  … ${list.length - 5} more in 8 Diagnostics`)]} /> : null}
      <Blank />
      <Heading title="DEVICE" />
      <Line segs={['Clock      ', ...clockSegs(ui, now, shell.autoTimeSync)]} />
      <Line segs={['Modules    ', ...moduleSegs(v)]} />
      <Line segs={['Storage    ', ...storageSegs(d)]} />
      <Line segs={['Restart    ', dim(restartText(v))]} />
      <Line
        segs={[
          'Link       ',
          dim(
            `${d.connection === 'demo' ? 'demo device' : d.port}${typeof telemetry === 'number' ? ` · telemetry every ${duration(telemetry / 1000)}` : ''} · ${d.frames} frames`,
          ),
        ]}
      />
      <Line
        segs={[
          'Firmware   ',
          formatFirmware(v.fwVersion),
          update ? warn(` · ${MARK.update} ${update} available`) : '',
          update ? dim('  → 9 Firmware') : '',
        ]}
      />
      <Blank />
      <Line
        segs={[
          ...keyHint('h', 'set hours…'),
          ...keyHint('t', 'set time'),
          ...keyHint('r', 'refresh'),
          ...keyHint('w', 'service report'),
        ]}
      />
    </box>
  );
}
