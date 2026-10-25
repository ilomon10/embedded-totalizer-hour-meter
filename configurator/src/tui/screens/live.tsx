// live.tsx: 5 Live inputs, the wiring check. The engine input raw and counted; the vibration RMS now (with the
// peak) and as a time series of the last minutes against the threshold, with the WIRING.md procedure (measure key
// on and idling, get a suggested threshold, set it); the pulse input's rate; and the attitude as gauges: roll and
// pitch as the machine seen from behind and from the side, heading as a compass. "Since" counts from when the
// screen opened (z: from now). On a small terminal the gauges give way to one line, so the chart keeps its rows.
import { useState } from 'react';

import { bar, duration, num } from '../model/format.ts';
import { grownSince, MEASURE_MS, pulseRate, suggestThreshold } from '../model/history.ts';
import {
  type Cell,
  columnOf,
  compassPoint,
  gauge,
  type GaugeKind,
  type Ink,
  niceCeil,
  plotSeries,
  timeAxis,
} from '../model/plot.ts';
import { activeFlags } from '../state.ts';
import { charOf, useNow, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import { Blank, bold, dim, Heading, keyHint, Line, ok, type Seg, Spread } from '../ui.tsx';
import { ApplyDialog } from './settings.tsx';

/** The time series' spans: − shows more, + less. */
const WINDOWS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/** The y axis left of the chart: "150 ┤". */
const AXIS = 5;
/** A gauge: 10 × 5 cells (20 × 20 dots), in a slot of 12 columns with its value under it. */
const GAUGE = { cols: 10, rows: 5, slot: 12 };
/** Rows of the screen besides the chart, with the gauges (19) and without (14). */
const ROWS_FULL = 19;
const ROWS_COMPACT = 14;

const CHART_INK: Record<Ink, string> = { axis: C.border, guide: C.yellow, mark: C.fg, data: C.cyan, high: C.green };
const GAUGE_INK: Record<Ink, string> = { axis: C.border, guide: C.dim, mark: C.fg, data: C.cyan, high: C.cyan };

/** Cells as pieces of a line: one piece for each run of the same colours. */
function cellSegs(cells: readonly Cell[], ink: Record<Ink, string>, bgOf?: (col: number) => string | undefined): Seg[] {
  const out: Seg[] = [];
  let run = '';
  let fg: string | undefined;
  let bg: string | undefined;
  cells.forEach((cell, col) => {
    const f = cell.ink ? ink[cell.ink] : undefined;
    const b = bgOf?.(col);
    if (run && (f !== fg || b !== bg)) {
      out.push({ t: run, fg, bg });
      run = '';
    }
    fg = f;
    bg = b;
    run += cell.ch;
  });
  if (run) out.push({ t: run, fg, bg });
  return out;
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

export function LiveScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const now = useNow(500);
  const [since, setSince] = useState(Date.now());
  const [zoom, setZoom] = useState(WINDOWS_MS.indexOf(120_000));
  const v = ui.device.values;
  const s = ui.device.settings;
  const flags = activeFlags(ui.device);
  const threshold = Number(s.runVibMinMg ?? 0);
  const keyOn = ui.measures.keyOn;
  const idle = ui.measures.idle;
  const suggestion = suggestThreshold(keyOn?.value, idle?.value);

  useScreenKeys((k) => {
    const c = charOf(k);
    if (c === 'o')
      ctrl.measure('keyOn'); // o: key on, engine off (j and k move, as everywhere)
    else if (c === 'i') ctrl.measure('idle');
    else if (c === 'z') setSince(Date.now());
    else if (c === '-') setZoom((z) => Math.min(WINDOWS_MS.length - 1, z + 1));
    else if (c === '+' || c === '=') setZoom((z) => Math.max(0, z - 1));
    else if (c === 't') {
      const to = suggestion.value;
      if (to === undefined) ctrl.log('info', `no suggested threshold yet: ${suggestion.why}`);
      else {
        shell.openDialog(
          <ApplyDialog
            changes={[{ name: 'runVibMinMg', from: s.runVibMinMg, to }]}
            onClose={() => shell.openDialog(undefined)}
          />,
        );
      }
    } else return false;
    return true;
  });

  // ------------------------------------------------------------------ layout --
  const width = shell.width;
  const compact = shell.height - ROWS_FULL < 5;
  const chartRows = compact ? Math.max(3, shell.height - ROWS_COMPACT) : Math.min(20, shell.height - ROWS_FULL);
  const plotCols = Math.max(10, width - AXIS);

  // ------------------------------------------------------------- time series --
  const windowMs = WINDOWS_MS[zoom];
  const points = ui.history.flatMap((x) => (x.vibRms === undefined ? [] : [{ atMs: x.atMs, value: x.vibRms }]));
  const toMs = Math.max(now, points.at(-1)?.atMs ?? 0);
  const fromMs = toMs - windowMs;
  const shown = points.filter((p) => p.atMs >= fromMs).map((p) => p.value);
  const top = niceCeil(Math.max(...shown, threshold, keyOn?.value ?? 0, idle?.value ?? 0) * 1.15);
  const telemetryMs = Number(s.telemetryIntervalMs ?? 1000);
  const cells = plotSeries(points, {
    cols: plotCols,
    rows: chartRows,
    fromMs,
    toMs,
    max: top,
    gapMs: Math.max(3000, 3 * telemetryMs),
    guide: threshold > 0 ? threshold : undefined,
  });
  // The 10 s measurements as bands behind the chart, marked o and i under it.
  const bands = (
    [
      [keyOn, C.bandKeyOn, 'o', C.yellow],
      [idle, C.bandIdle, 'i', C.green],
    ] as const
  ).flatMap(([m, bg, mark, fg]) => {
    if (!m) return [];
    const first = columnOf(m.startedMs, fromMs, toMs, plotCols);
    const last = columnOf(m.startedMs + MEASURE_MS, fromMs, toMs, plotCols);
    return last < 0 || first >= plotCols ? [] : [{ first, last, bg, mark, fg }];
  });
  const bgOf = (col: number) => bands.find((b) => col >= b.first && col <= b.last)?.bg;
  const rowOf = (value: number) => Math.floor(Math.round((chartRows * 4 - 1) * (1 - value / top)) / 4);
  const thresholdRow = threshold > 0 && threshold <= top ? rowOf(threshold) : undefined;
  const axisLabel = (row: number): Seg[] => {
    const value =
      row === 0
        ? top
        : row === chartRows - 1
          ? 0
          : row === thresholdRow
            ? threshold
            : chartRows >= 5 &&
                row === Math.round((chartRows - 1) / 2) &&
                (thresholdRow === undefined || Math.abs(row - thresholdRow) > 1)
              ? top / 2
              : undefined;
    if (value === undefined) return [{ t: '    │', fg: C.border }];
    return [
      { t: String(Math.round(value)).padStart(4), fg: row === thresholdRow ? C.yellow : C.dim },
      { t: '┤', fg: C.border },
    ];
  };
  const axisRow: Seg[] = (() => {
    const row = [...timeAxis(windowMs, plotCols)].map((ch) => ({ ch, fg: C.dim as string }));
    for (const b of bands) {
      // Under the middle of its band, but never over "now".
      const at = Math.max(0, Math.min(plotCols - 5, Math.round((b.first + b.last) / 2)));
      row[at] = { ch: b.mark, fg: b.fg };
    }
    return [' '.repeat(AXIS), ...row.map((x) => ({ t: x.ch, fg: x.fg }))];
  })();
  const stats = shown.length
    ? `${duration(windowMs / 1000)}: min ${Math.min(...shown)} · avg ${Math.round(shown.reduce((a, b) => a + b, 0) / shown.length)} · max ${Math.max(...shown)} mg`
    : `${duration(windowMs / 1000)}: no readings yet`;

  // ---------------------------------------------------------------- now, peak --
  const rmsNow = typeof v.vibRms === 'number' ? v.vibRms : undefined;
  const peak = typeof v.vibPeak === 'number' ? v.vibPeak : undefined;
  const barTop = niceCeil(Math.max(rmsNow ?? 0, peak ?? 0, threshold), 50);
  const barCols = Math.max(10, width - 24 - 10);
  const solid = bar(rmsNow ?? 0, barTop, barCols);
  const shade = '░'.repeat(Math.max(0, Math.round(((peak ?? 0) / barTop) * barCols) - [...solid].length));

  // ------------------------------------------------------------ engine, pulses --
  const hoursSince = grownSince(ui.history, 'runSeconds', since);
  const pulsesSince = grownSince(ui.history, 'totalCount', since);
  const rate = pulseRate(ui.history, now);
  // A fixed width ("◌ measuring 10 s" and a space), so the key hints after it stay put.
  const measuring = (m?: { startedMs: number; value?: number }): Seg => {
    const width = 17;
    if (!m) return dim('–'.padEnd(width));
    if (m.value !== undefined) return bold(`${m.value} mg`.padEnd(width));
    const left = Math.max(0, Math.ceil((MEASURE_MS - (now - m.startedMs)) / 1000));
    return { t: `${MARK.busy} measuring ${left} s`.padEnd(width), fg: C.yellow };
  };
  const onOff = (x: unknown, onText = 'ON', offText = 'OFF'): Seg =>
    x === undefined
      ? dim('–')
      : x
        ? ok(`${MARK.live} ${onText}`.padEnd(12))
        : { t: `${MARK.off} ${offText}`.padEnd(12), fg: C.fg };

  // ----------------------------------------------------------------- attitude --
  const imu = !flags.includes('imuMissing');
  const mag = imu && !flags.includes('magMissing');
  const magCal = !flags.includes('magNotCalibrated');
  const angle = (x: unknown) => (typeof x === 'number' ? x : undefined);
  const heading = mag ? angle(v.heading) : undefined;
  const attitudeText: Seg[] = !imu
    ? [dim('no IMU')]
    : [
        `roll ${num(v.roll)}°   pitch ${num(v.pitch)}°   `,
        heading === undefined
          ? dim(mag ? 'heading –' : 'no compass')
          : `heading ${num(heading, 1)}° ${compassPoint(heading)}`,
        heading !== undefined && !magCal ? { t: `  ${MARK.warn} not calibrated`, fg: C.yellow } : '',
      ];
  const gauges: Array<{ kind: GaugeKind; deg: number | undefined; label: string; ink: Record<Ink, string> }> = [
    {
      kind: 'roll',
      deg: imu ? angle(v.roll) : undefined,
      label: imu ? `roll ${num(v.roll, 1)}°` : 'no IMU',
      ink: GAUGE_INK,
    },
    {
      kind: 'pitch',
      deg: imu ? angle(v.pitch) : undefined,
      label: imu ? `pitch ${num(v.pitch, 1)}°` : '',
      ink: GAUGE_INK,
    },
    {
      kind: 'heading',
      deg: heading,
      label:
        heading === undefined ? (mag ? 'heading –' : 'no compass') : `${num(heading, 1)}° ${compassPoint(heading)}`,
      ink: magCal ? GAUGE_INK : { ...GAUGE_INK, data: C.yellow },
    },
  ];
  const drawn = gauges.map((g) => gauge(g.kind, g.deg, GAUGE.cols, GAUGE.rows));
  const pad = ' '.repeat((GAUGE.slot - GAUGE.cols) / 2);
  const centre = (text: string) => {
    const n = [...text].length;
    const left = Math.max(0, Math.floor((GAUGE.slot - n) / 2));
    return ' '.repeat(left) + text + ' '.repeat(Math.max(0, GAUGE.slot - n - left));
  };

  const pulseLines: Seg[][] = [
    [`Total   ${String(v.totalCount ?? '–')} pulses`],
    [`        = ${num(v.totalUnits)} units`],
    ['Rate    ', rate === undefined ? dim('–') : `${rate.toFixed(1)} pulses/s`],
    [dim(pulsesSince === undefined ? '' : `+${pulsesSince} pulses since ${clock(since)}`)],
  ];

  return (
    <box style={{ flexDirection: 'column' }}>
      <Heading title="ENGINE INPUT" />
      <Line
        segs={[
          'Input (raw)      ',
          onOff(v.altInput),
          dim(`active ${s.altActiveHigh ? 'HIGH' : 'LOW'} · debounce ${String(s.altDebounceMs ?? '?')} ms`),
        ]}
      />
      <Line
        segs={[
          'Counted          ',
          onOff(v.alternator, 'RUNNING', 'stopped'),
          dim(hoursSince === undefined ? '' : `+${(hoursSince / 3600).toFixed(2)} h since ${clock(since)}`),
        ]}
      />
      <Line
        segs={[
          'Vibration check  ',
          threshold > 0 ? `on: counts above ${threshold} mg` : dim('off (threshold 0)'),
          flags.includes('imuMissing') ? { t: '  no IMU: ignored', fg: C.yellow } : '',
        ]}
      />
      {compact ? null : <Blank />}
      <Heading title="VIBRATION RMS" right={[dim(stats)]} />
      <Spread
        left={[
          `now ${String(rmsNow ?? '–').padStart(4)} · peak ${String(peak ?? '–').padStart(4)} mg  `,
          { t: solid, fg: threshold > 0 && (rmsNow ?? 0) >= threshold ? C.green : C.cyan },
          { t: shade, fg: C.dim },
        ]}
        right={[dim(`0–${barTop} mg`)]}
      />
      {cells.map((row, i) => (
        <Line key={i} segs={[...axisLabel(i), ...cellSegs(row, CHART_INK, bgOf)]} />
      ))}
      <Line segs={axisRow} />
      <Line segs={[dim('key on, engine off   max '), measuring(keyOn), ...keyHint('o', 'measure 10 s')]} />
      <Line segs={[dim('engine idling        min '), measuring(idle), ...keyHint('i', 'measure 10 s')]} />
      <Line
        segs={[
          dim('suggested threshold  '),
          suggestion.value === undefined ? dim(suggestion.why) : bold(`${suggestion.value} mg`, C.green),
          suggestion.value === undefined ? '' : dim(` (${suggestion.why})   `),
          suggestion.value === undefined ? '' : { t: '[t]', fg: C.cyan },
          suggestion.value === undefined ? '' : ' set…',
        ]}
      />
      {compact ? (
        <>
          <Heading title="PULSE INPUT" />
          <Line
            segs={[
              `${String(v.totalCount ?? '–')} pulses = ${num(v.totalUnits)} units · `,
              rate === undefined ? dim('–') : `${rate.toFixed(1)} pulses/s`,
            ]}
          />
          <Line segs={pulseLines[3]} />
          <Line segs={[bold('ATTITUDE  ', C.dim), ...attitudeText]} />
        </>
      ) : (
        <>
          <Blank />
          <box style={{ flexDirection: 'row' }}>
            <box style={{ flexDirection: 'column', width: width - GAUGE.slot * 3, flexShrink: 0 }}>
              <Heading title="PULSE INPUT" />
              {pulseLines.map((segs, i) => (
                <Line key={i} segs={segs} max={width - GAUGE.slot * 3 - 1} />
              ))}
            </box>
            <box style={{ flexDirection: 'column', width: GAUGE.slot * 3, flexShrink: 0 }}>
              <Line
                max={GAUGE.slot * 3}
                segs={[
                  bold('ATTITUDE', C.dim),
                  heading !== undefined && !magCal ? { t: `  ${MARK.warn} compass not calibrated`, fg: C.yellow } : '',
                ]}
              />
              {Array.from({ length: GAUGE.rows }, (_, r) => (
                <Line
                  key={r}
                  max={GAUGE.slot * 3}
                  segs={gauges.flatMap((g, i) => [pad, ...cellSegs(drawn[i][r], g.ink), pad])}
                />
              ))}
              <Line max={GAUGE.slot * 3} segs={[dim(gauges.map((g) => centre(g.label)).join(''))]} />
            </box>
          </box>
        </>
      )}
    </box>
  );
}
