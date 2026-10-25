// plot.ts: pictures in braille characters for 5 Live inputs: a time series (the vibration RMS of the last
// minutes) and gauges for the attitude (roll and pitch as the machine seen from behind and from the side, heading
// as a compass). A braille character holds 2 × 4 dots, which are about square on a terminal. Pure: cells come
// out with an ink, and the screen gives each ink its colour.
import { duration } from './format.ts';

/** What a cell shows. A cell takes the strongest ink drawn into it (in this order, weakest first). */
export type Ink = 'axis' | 'guide' | 'mark' | 'data' | 'high';
const STRENGTH: Record<Ink, number> = { axis: 1, guide: 2, mark: 3, data: 4, high: 5 };

export interface Cell {
  ch: string;
  ink?: Ink;
}

// The bit of each dot in a braille character (U+2800 + bits), by [row][column] within the cell.
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** `cols` × `rows` cells, so `cols * 2` × `rows * 4` dots; (0, 0) is the top left dot. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly bits: Uint8Array;
  private readonly inks: Array<Ink | undefined>;
  private readonly letters = new Map<number, string>();

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.width = cols * 2;
    this.height = rows * 4;
    this.bits = new Uint8Array(cols * rows);
    this.inks = Array.from<Ink | undefined>({ length: cols * rows });
  }

  /** One dot (rounded to the nearest); outside the canvas it is dropped. */
  dot(x: number, y: number, ink: Ink): void {
    const dx = Math.round(x);
    const dy = Math.round(y);
    if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) return;
    const i = (dy >> 2) * this.cols + (dx >> 1);
    this.bits[i] |= DOT_BITS[dy & 3][dx & 1];
    const was = this.inks[i];
    if (!was || STRENGTH[ink] > STRENGTH[was]) this.inks[i] = ink;
  }

  /** A straight line; `ink` may depend on the height of each dot (above a threshold, say). */
  line(x0: number, y0: number, x1: number, y1: number, ink: Ink | ((y: number) => Ink)): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let s = 0; s <= steps; s++) {
      const y = y0 + ((y1 - y0) * s) / steps;
      this.dot(x0 + ((x1 - x0) * s) / steps, y, typeof ink === 'function' ? ink(y) : ink);
    }
  }

  circle(cx: number, cy: number, r: number, ink: Ink): void {
    const steps = Math.max(8, Math.ceil(4 * Math.PI * r));
    for (let s = 0; s < steps; s++) {
      const a = (2 * Math.PI * s) / steps;
      this.dot(cx + r * Math.cos(a), cy + r * Math.sin(a), ink);
    }
  }

  /** A character in place of the cell that holds dot (x, y): a compass letter. */
  letter(x: number, y: number, ch: string, ink: Ink): void {
    const cx = Math.floor(Math.round(x) / 2);
    const cy = Math.floor(Math.round(y) / 4);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return;
    const i = cy * this.cols + cx;
    this.letters.set(i, ch);
    this.inks[i] = ink;
  }

  /** The cells, row by row; an empty cell is a space. */
  cells(): Cell[][] {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.cols }, (_, c) => {
        const i = r * this.cols + c;
        const ch = this.letters.get(i) ?? (this.bits[i] ? String.fromCharCode(0x2800 + this.bits[i]) : ' ');
        return { ch, ink: this.inks[i] };
      }),
    );
  }
}

// ------------------------------------------------------------------ time series --

export interface Point {
  atMs: number;
  value: number;
}

export interface SeriesOptions {
  cols: number;
  rows: number;
  fromMs: number;
  toMs: number;
  /** The value of the top dot row; 0 is the bottom one. */
  max: number;
  /** Samples further apart than this are not joined: the link was down. */
  gapMs: number;
  /** A dotted line across at this value (the threshold); the line above it is drawn in the ink `high`. */
  guide?: number;
}

/**
 * The points of [fromMs, toMs] (in time order) joined by lines, time to the right. The point just before fromMs
 * is joined too, so the line runs in from the left edge.
 */
export function plotSeries(points: readonly Point[], o: SeriesOptions): Cell[][] {
  const c = new Canvas(o.cols, o.rows);
  const span = Math.max(1, o.toMs - o.fromMs);
  const x = (t: number) => ((t - o.fromMs) / span) * (c.width - 1);
  const y = (v: number) => (c.height - 1) * (1 - Math.max(0, Math.min(1, v / (o.max || 1))));
  const guide = o.guide !== undefined && o.guide > 0 && o.guide <= o.max ? y(o.guide) : undefined;
  if (guide !== undefined) for (let i = 0; i < c.width; i += 3) c.dot(i, guide, 'guide');
  const ink = (dotY: number): Ink => (guide !== undefined && Math.round(dotY) <= Math.round(guide) ? 'high' : 'data');
  let last: { x: number; y: number; atMs: number } | undefined;
  for (const p of points) {
    if (p.atMs > o.toMs) break;
    const here = { x: x(p.atMs), y: y(p.value), atMs: p.atMs };
    if (p.atMs >= o.fromMs) {
      if (last && p.atMs - last.atMs <= o.gapMs) c.line(last.x, last.y, here.x, here.y, ink);
      else c.dot(here.x, here.y, ink(here.y));
    }
    last = here;
  }
  return c.cells();
}

/** The cell column of time `t` in a plot of `cols` cells over [fromMs, toMs] (may be outside 0..cols-1). */
export function columnOf(t: number, fromMs: number, toMs: number, cols: number): number {
  return Math.floor((((t - fromMs) / Math.max(1, toMs - fromMs)) * (cols * 2 - 1)) / 2);
}

/** A round top for an axis, at least `value` and `least`: 10, 15, 20, 30, 50, 75, 100, 150… */
export function niceCeil(value: number, least = 10): number {
  const v = Math.max(value, least);
  const decade = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 3, 5, 7.5]) if (m * decade >= v) return m * decade;
  return 10 * decade;
}

/** The time axis under a plot of `cols` cells: "2 min ago" at the left, the half-way time, "now" at the right. */
export function timeAxis(windowMs: number, cols: number): string {
  const row = Array<string>(cols).fill(' ');
  const put = (text: string, at: number) => [...text].forEach((ch, i) => at + i < cols && (row[at + i] = ch));
  const left = `${duration(windowMs / 1000)} ago`;
  const middle = `${duration(windowMs / 2000)} ago`;
  put(left, 0);
  const mid = Math.round(cols / 2 - middle.length / 2);
  if (mid > left.length + 1 && mid + middle.length < cols - 4) put(middle, mid);
  put('now', cols - 3);
  return row.join('');
}

// ----------------------------------------------------------------------- gauges --

export type GaugeKind = 'roll' | 'pitch' | 'heading';

/**
 * A round gauge of `cols` × `rows` cells for an angle in degrees, in the firmware's sense (x forward, z up):
 * - roll: the machine seen from behind, a line across it that tilts with it (right side down when positive), and a
 *   mast for its up direction;
 * - pitch: the machine seen from its right side, nose to the right (up when positive), an arrow at the nose;
 * - heading: a compass, north up, the needle clockwise from north.
 * Roll and pitch have the level as a dotted line. Without an angle only the frame is drawn.
 */
export function gauge(kind: GaugeKind, deg: number | undefined, cols = 8, rows = 4): Cell[][] {
  const c = new Canvas(cols, rows);
  // The centre on a whole dot, so a level line is one straight row of dots.
  const cx = Math.floor(c.width / 2);
  const cy = Math.floor(c.height / 2);
  const r = Math.min(cx, cy) - 1;
  c.circle(cx, cy, r, 'axis');
  if (kind === 'heading') c.letter(cx, cy - r, 'N', 'mark');
  else {
    // The level: a tick inside the rim on either side.
    c.line(cx - r + 1, cy, cx - r + 2, cy, 'guide');
    c.line(cx + r - 2, cy, cx + r - 1, cy, 'guide');
  }
  if (deg === undefined || !Number.isFinite(deg)) return c.cells();
  const a = (deg * Math.PI) / 180;
  const arm = r - 1;
  if (kind === 'roll') {
    const [dx, dy] = [Math.cos(a), Math.sin(a)];
    c.line(cx - arm * dx, cy - arm * dy, cx + arm * dx, cy + arm * dy, 'data');
    c.line(cx, cy, cx + arm * 0.6 * dy, cy - arm * 0.6 * dx, 'data'); // up: square to the line
  } else if (kind === 'pitch') {
    const [dx, dy] = [Math.cos(a), -Math.sin(a)];
    c.line(cx - arm * dx, cy - arm * dy, cx + arm * dx, cy + arm * dy, 'data');
    arrowHead(c, cx + arm * dx, cy + arm * dy, dx, dy);
  } else {
    const [dx, dy] = [Math.sin(a), -Math.cos(a)];
    c.line(cx - arm * 0.4 * dx, cy - arm * 0.4 * dy, cx, cy, 'axis'); // the tail
    c.line(cx, cy, cx + arm * dx, cy + arm * dy, 'data');
    arrowHead(c, cx + arm * dx, cy + arm * dy, dx, dy);
  }
  return c.cells();
}

/** Two short strokes back from the tip (x, y) of a line pointing along (dx, dy). */
function arrowHead(c: Canvas, x: number, y: number, dx: number, dy: number): void {
  const size = 2.5;
  for (const turn of [0.5, -0.5]) {
    const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
    c.line(x, y, x - size * (dx * cos - dy * sin), y - size * (dx * sin + dy * cos), 'data');
  }
}

/** "NE": the compass point (of 8) nearest to a heading. */
export function compassPoint(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
