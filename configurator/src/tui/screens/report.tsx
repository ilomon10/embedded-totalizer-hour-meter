// report.tsx: 3 Report. What the service report will say, three fields to fill in (the technician and unit are
// remembered per device), and `s` writes it as Markdown to ~/hour-meter-reports.
import { useEffect, useState } from 'react';

import { deviceIdText } from '../model/format.ts';
import { STEPS } from '../model/commission.ts';
import { buildReport, type ReportFields, reportFileName, reportSummary } from '../model/report.ts';
import { charOf, useRefState, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { loadDeviceJson, reportDir, saveDeviceJson, saveReportFile } from '../store.ts';
import { C, MARK } from '../theme.ts';
import { Blank, dim, editLine, FieldLine, keyHint, Line } from '../ui.tsx';

const FIELDS: Array<{ key: keyof ReportFields; label: string; placeholder: string }> = [
  { key: 'technician', label: 'Technician     ', placeholder: 'name' },
  { key: 'unit', label: 'Unit / vehicle ', placeholder: 'e.g. DT-07' },
  { key: 'note', label: 'Note           ', placeholder: 'what you did and why' },
];

export function ReportScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const id = ui.device.deviceId;
  const [fields, setFields, fieldsRef] = useRefState<ReportFields>({ technician: '', unit: '', note: '' });
  const [focus, setFocus, focusRef] = useRefState<number | undefined>(undefined); // the field being typed in
  const [commission, setCommission] = useState<{ done: number; total: number } | undefined>();
  const [saved, setSaved] = useState<string>();

  useEffect(() => {
    if (id === undefined) return;
    void loadDeviceJson('report-fields', id, { technician: '', unit: '' }).then((f) =>
      setFields((x) => ({ ...x, ...f })),
    );
    void loadDeviceJson('commission', id, { marks: {} as Record<string, string> }).then((p) => {
      const done = Object.keys(p.marks ?? {}).length;
      setCommission(done ? { done, total: STEPS.length } : undefined);
    });
  }, [id]);

  const save = async () => {
    if (id === undefined) return ctrl.log('warn', 'report: no device yet');
    const nowMs = Date.now();
    const text = buildReport({
      state: ui.device,
      fields: fieldsRef.current,
      toolVersion: shell.toolVersion,
      nowMs,
      commission,
      autoTimeSync: shell.autoTimeSync,
    });
    try {
      const path = await saveReportFile(reportFileName(id, nowMs), text);
      await saveDeviceJson('report-fields', id, {
        technician: fieldsRef.current.technician,
        unit: fieldsRef.current.unit,
      });
      const progress = await loadDeviceJson('commission', id, {
        marks: {} as Record<string, string>,
        reportSaved: false,
      });
      await saveDeviceJson('commission', id, { ...progress, reportSaved: true });
      setSaved(path);
      ctrl.log('ok', `service report saved: ${path}`);
    } catch (err) {
      ctrl.log('error', `report not saved: ${(err as Error).message}`);
    }
  };

  useScreenKeys((k) => {
    const focused = focusRef.current;
    if (focused !== undefined) {
      if (k.name === 'escape' || k.name === 'return') setFocus(undefined);
      else if (k.name === 'tab') setFocus((focused + 1) % FIELDS.length);
      else {
        const key = FIELDS[focused].key;
        const next = editLine(fieldsRef.current[key], k);
        if (next !== undefined) setFields((f) => ({ ...f, [key]: next }));
      }
      return true; // typing: no shortcuts
    }
    const c = charOf(k);
    if (k.name === 'return')
      setFocus(0); // Tab stays the menu key until a field is open
    else if (c === 's') void save();
    else return false;
    return true;
  });

  const rows = reportSummary({
    state: ui.device,
    fields,
    toolVersion: shell.toolVersion,
    nowMs: Date.now(),
    commission,
    autoTimeSync: shell.autoTimeSync,
  });
  return (
    <box style={{ flexDirection: 'column' }}>
      <Line segs={[dim('A Markdown file for maintenance records, with the raw values as JSON.')]} />
      <Blank />
      {rows.map(([label, value]) => (
        <Line key={label} segs={[label.padEnd(15), value]} />
      ))}
      <Blank />
      {FIELDS.map((f, i) => (
        <FieldLine
          key={f.key}
          label={f.label}
          text={fields[f.key]}
          placeholder={f.placeholder}
          focused={focus === i}
          after={focus === i ? [] : []}
        />
      ))}
      <Blank />
      <Line
        segs={[
          'Save to        ',
          dim(`${reportDir()}/${reportFileName(id, Date.now())}`.replace(process.env.HOME ?? '\0', '~')),
        ]}
      />
      {saved ? (
        <Line segs={[{ t: `${MARK.ok} saved: ${saved.replace(process.env.HOME ?? '\0', '~')}`, fg: C.green }]} />
      ) : (
        <Blank />
      )}
      <Blank />
      <Line
        segs={
          focus === undefined
            ? [
                ...keyHint('s', 'save report'),
                ...keyHint('Enter', 'fill in the fields'),
                dim(id === undefined ? '' : `remembered for ${deviceIdText(id)}`),
              ]
            : [...keyHint('Tab', 'next field'), ...keyHint('Enter', 'done')]
        }
      />
    </box>
  );
}
