// report.ts: the service report of the Report screen: a Markdown file for maintenance records, with the raw
// values at the end as JSON (for a script or a later comparison). Pure; tui/store.ts writes the file.
import { formatFirmware } from '../../releases.ts';
import { causeText } from '../../restart.ts';
import { SETTINGS } from '../../tags.ts';
import { activeFlags, type DeviceState } from '../state.ts';
import { deviceIdText, num, utcText } from './format.ts';
import { problems } from './health.ts';
import { changedFromFactory, SETTING_UI, valueText } from './settings.ts';

export interface ReportFields {
  technician: string;
  unit: string;
  note: string;
}

export interface ReportInput {
  state: DeviceState;
  fields: ReportFields;
  toolVersion: string;
  nowMs: number;
  /** Commission steps done, of all. */
  commission?: { done: number; total: number };
  autoTimeSync?: boolean;
}

/** "1A2B3C4D-2026-10-25-1432.md" (UTC). */
export function reportFileName(deviceId: number | undefined, nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  return `${deviceIdText(deviceId)}-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}.md`;
}

const calibrated = (flags: string[], missing: string, notCal: string) =>
  flags.includes(missing) ? 'not fitted' : flags.includes(notCal) ? '✖ not calibrated' : '✔ calibrated';

/** The lines the Report screen shows before saving: [label, value]. */
export function reportSummary(input: ReportInput): Array<[string, string]> {
  const { state } = input;
  const v = state.values;
  const flags = activeFlags(state);
  const list = problems(flags, { fwVersion: v.fwVersion as number | undefined, autoTimeSync: input.autoTimeSync });
  const changed = SETTING_UI.filter((s) => changedFromFactory(s.name, state.settings[s.name])).length;
  const read = SETTING_UI.filter((s) => state.settings[s.name] !== undefined).length;
  const ppu = Number(state.settings.pulsesPerUnit ?? 1);
  const rows: Array<[string, string]> = [
    [
      'Device',
      `${deviceIdText(state.deviceId)} · firmware ${formatFirmware(v.fwVersion)} · read ${utcText(input.nowMs / 1000)}`,
    ],
    ['Hour meter', `${num(v.runHours)} h (${String(v.runSeconds ?? '–')} s)`],
    ['Totalizer', `${num(v.totalUnits)} units (${String(v.totalCount ?? '–')} pulses, ${ppu} per unit)`],
    [
      'Health',
      v.statusFlags === undefined
        ? 'not read yet'
        : list.length === 0
          ? '✔ no problems'
          : `${list.some((i) => i.severity === 'error') ? '✖' : '▲'} ${list.map((i) => i.title).join(', ')}`,
    ],
    ['Settings', `${read} read · ${changed} differ from factory defaults`],
    [
      'Calibration',
      `IMU ${calibrated(flags, 'imuMissing', 'imuNotCalibrated')} · compass ${calibrated(flags, 'magMissing', 'magNotCalibrated')}`,
    ],
    ['Restarts', `previous run: ${causeText(v) ?? 'ended normally'}`],
  ];
  if (input.commission)
    rows.push(['Commissioning', `${input.commission.done} of ${input.commission.total} steps done`]);
  return rows;
}

/** The whole report as Markdown. */
export function buildReport(input: ReportInput): string {
  const { state, fields } = input;
  const lines = [
    `# Hour meter service report: ${deviceIdText(state.deviceId)}`,
    '',
    `Written ${utcText(input.nowMs / 1000)} by hour-meter ${input.toolVersion}.`,
    '',
    '| | |',
    '|---|---|',
    `| Technician | ${fields.technician || '–'} |`,
    `| Unit / vehicle | ${fields.unit || '–'} |`,
    ...reportSummary(input).map(([k, val]) => `| ${k} | ${val} |`),
    '',
  ];
  if (fields.note.trim()) lines.push('## Note', '', fields.note.trim(), '');
  const flags = activeFlags(state);
  const list = problems(flags, {
    fwVersion: state.values.fwVersion as number | undefined,
    autoTimeSync: input.autoTimeSync,
  });
  if (list.length) {
    lines.push('## Needs attention', '');
    for (const i of list) lines.push(`- **${i.title}** (\`${i.flag}\`): ${i.why}${i.fix ? ` ${i.fix}` : ''}`);
    lines.push('');
  }
  lines.push('## Settings', '', '| Setting | Value | Factory |', '|---|---|---|');
  for (const s of SETTING_UI) {
    const v = state.settings[s.name];
    const mark = changedFromFactory(s.name, v) ? ' •' : '';
    lines.push(
      `| ${s.label} (\`${s.name}\`) | ${valueText(s.name, v, true)}${mark} | ${valueText(s.name, s.factory, true)} |`,
    );
  }
  const raw: Record<string, unknown> = {
    deviceId: state.deviceId,
    writtenAt: new Date(input.nowMs).toISOString(),
    technician: fields.technician,
    unit: fields.unit,
    values: Object.fromEntries(
      Object.entries(state.values).filter(([, x]) => typeof x === 'number' || typeof x === 'boolean'),
    ),
    settings: Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, state.settings[k]])),
    flags,
  };
  lines.push('', '## Raw values', '', '```json', JSON.stringify(raw, null, 2), '```', '');
  return lines.join('\n');
}
