// store.ts: what the TUI keeps on disk. Per device, in the cache folder: the commission progress and the report
// fields (technician, unit). Service reports and saved logs go to ~/hour-meter-reports ($HOUR_METER_REPORTS).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { env } from '../cli.ts';
import { cacheDir } from '../releases.ts';
import { deviceIdText } from './model/format.ts';

const deviceFile = (kind: string, deviceId: number) => join(cacheDir(env), kind, `${deviceIdText(deviceId)}.json`);

export async function loadDeviceJson<T>(
  kind: 'commission' | 'report-fields',
  deviceId: number,
  fallback: T,
): Promise<T> {
  try {
    return { ...fallback, ...JSON.parse(await readFile(deviceFile(kind, deviceId), 'utf8')) };
  } catch {
    return fallback;
  }
}

export async function saveDeviceJson(kind: 'commission' | 'report-fields', deviceId: number, data: unknown) {
  const path = deviceFile(kind, deviceId);
  try {
    await mkdir(join(cacheDir(env), kind), { recursive: true });
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  } catch {
    // only a convenience: the next session starts over
  }
}

export function reportDir(): string {
  return env('HOUR_METER_REPORTS') ?? join(env('HOME') ?? env('USERPROFILE') ?? '.', 'hour-meter-reports');
}

/** Write a report or a log into reportDir(); returns the path. */
export async function saveReportFile(fileName: string, text: string): Promise<string> {
  const dir = reportDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, text);
  return path;
}
