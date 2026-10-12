// tracks.ts: recorded tracks -> waypoints. Pure text parsing (no DOM), shared by
// the web UI (drop a file) and the CLI (--route file).
//
//   GPX: <trkpt|rtept|wpt lat=".." lon=".."> with optional <ele> and <time>
//   CSV: a header row naming lat, lon and optionally alt|ele|altitude and time|timestamp
//        (ISO 8601 or Unix seconds); without a header: lat,lon[,alt]
// With times, every waypoint gets the speed the recording had on that stretch.
import { distanceM } from './geo.ts';
import type { Waypoint } from './route.ts';

interface Fix {
  lat: number;
  lon: number;
  alt?: number;
  /** seconds */
  t?: number;
}

const MIN_SPACING_M = 4; // closer points add noise, not shape
const SPEED_RANGE: [number, number] = [0.5, 90];

function parseTime(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const n = Number(text);
  if (Number.isFinite(n)) return n > 1e11 ? n / 1000 : n; // ms or s
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

export function parseGpx(text: string): Fix[] {
  const fixes: Fix[] = [];
  const point = /<(trkpt|rtept|wpt)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of text.matchAll(point)) {
    const attrs = m[2];
    const body = m[4] ?? '';
    const lat = Number(/\blat\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    const lon = Number(/\blon\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = /<ele>\s*([^<]+)\s*<\/ele>/.exec(body)?.[1];
    fixes.push({
      lat,
      lon,
      alt: ele === undefined ? undefined : Number(ele),
      t: parseTime(/<time>\s*([^<]+)\s*<\/time>/.exec(body)?.[1]),
    });
  }
  if (fixes.length === 0) throw new Error('no <trkpt>, <rtept> or <wpt> points with lat/lon found');
  return fixes;
}

export function parseCsv(text: string): Fix[] {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (rows.length === 0) throw new Error('empty CSV');
  const split = (l: string) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
  const head = split(rows[0]).map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => /^(lat|latitude)$/.test(h));
  const col = (names: RegExp, fallback: number) => {
    const i = head.findIndex((h) => names.test(h));
    return hasHeader ? i : fallback;
  };
  const iLat = col(/^(lat|latitude)$/, 0);
  const iLon = col(/^(lon|lng|long|longitude)$/, 1);
  const iAlt = col(/^(alt|altitude|ele|elevation)$/, 2);
  const iTime = col(/^(time|timestamp|t)$/, -1);
  if (iLat < 0 || iLon < 0) throw new Error('CSV needs lat and lon columns');
  const fixes: Fix[] = [];
  for (const row of rows.slice(hasHeader ? 1 : 0)) {
    const c = split(row);
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const alt = iAlt >= 0 && c[iAlt] !== undefined && c[iAlt] !== '' ? Number(c[iAlt]) : undefined;
    fixes.push({
      lat,
      lon,
      alt: Number.isFinite(alt) ? alt : undefined,
      t: iTime >= 0 ? parseTime(c[iTime]) : undefined,
    });
  }
  if (fixes.length === 0) throw new Error('no rows with numeric lat and lon');
  return fixes;
}

/**
 * Thin the fixes and turn timestamps into per-stretch speeds. Altitudes become
 * heights above the first fix (the simulator's frame starts at the track's start).
 */
export function fixesToWaypoints(fixes: Fix[]): Waypoint[] {
  const base = fixes.find((f) => f.alt !== undefined)?.alt ?? 0;
  const out: Waypoint[] = [];
  let prev: Fix | undefined;
  for (const f of fixes) {
    if (prev && distanceM(prev, f) < MIN_SPACING_M) continue;
    let speed: number | undefined;
    if (prev?.t !== undefined && f.t !== undefined && f.t > prev.t) {
      speed = Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], distanceM(prev, f) / (f.t - prev.t)));
    }
    out.push({ lat: f.lat, lon: f.lon, alt: f.alt === undefined ? undefined : f.alt - base, speed });
    prev = f;
  }
  if (out.length < 2) throw new Error('the track needs at least two points more than 4 m apart');
  return out;
}

export function parseTrack(name: string, text: string): Waypoint[] {
  const gpx = /\.gpx$/i.test(name) || /<gpx[\s>]/i.test(text);
  return fixesToWaypoints(gpx ? parseGpx(text) : parseCsv(text));
}
