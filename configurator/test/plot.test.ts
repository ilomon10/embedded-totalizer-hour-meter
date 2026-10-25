// plot.test.ts: the braille pictures of 5 Live inputs: dots to characters, the vibration time series (scale,
// threshold, gaps), the time axis, and which way the attitude gauges lean.
import { test } from 'bun:test';

import { assert, assertEquals } from './assert.ts';
import {
  Canvas,
  type Cell,
  columnOf,
  compassPoint,
  gauge,
  type Ink,
  niceCeil,
  plotSeries,
  timeAxis,
} from '../src/tui/model/plot.ts';

const BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** The dots of braille cells back as [x, y], from cells with one of `inks` (any when not given). */
function dots(cells: Cell[][], inks?: Ink[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (inks && !(cell.ink && inks.includes(cell.ink))) return;
      const bits = (cell.ch.codePointAt(0) ?? 0) - 0x2800;
      if (bits <= 0 || bits > 0xff) return;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) if (bits & BITS[y][x]) out.push([c * 2 + x, r * 4 + y]);
    }),
  );
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('canvas: each dot sets its bit of a braille character; a letter takes a whole cell', () => {
  const c = new Canvas(2, 1);
  c.dot(0, 0, 'data');
  c.dot(1, 3, 'data');
  c.dot(9, 9, 'data'); // outside: dropped
  c.letter(2, 0, 'N', 'mark');
  assertEquals(c.cells(), [
    [
      { ch: '⢁', ink: 'data' },
      { ch: 'N', ink: 'mark' },
    ],
  ]);
  assertEquals(new Canvas(1, 1).cells(), [[{ ch: ' ', ink: undefined }]]);
});

test('time series: 0 at the bottom, max at the top, time to the right; the line above the threshold is "high"', () => {
  const flat = Array.from({ length: 11 }, (_, i) => ({ atMs: i * 1000, value: 50 }));
  const rows = plotSeries(flat, { cols: 10, rows: 2, fromMs: 0, toMs: 10_000, max: 100, gapMs: 3000 });
  const ys = dots(rows, ['data']).map(([, y]) => y);
  assert(ys.length > 15 && ys.every((y) => y === 4), `half way is dot row 4 of 0..7: ${ys}`);
  assertEquals(dots(rows, ['data']).at(-1)?.[0], 19); // the newest point at the right edge

  const withGuide = plotSeries(flat, { cols: 10, rows: 2, fromMs: 0, toMs: 10_000, max: 100, gapMs: 3000, guide: 75 });
  assert(
    withGuide[0].some((cell) => cell.ink === 'guide'),
    'a dotted line at 75',
  );
  assert(!withGuide.flat().some((cell) => cell.ink === 'high'), '50 stays under a threshold of 75');
  const above = plotSeries(flat, { cols: 10, rows: 2, fromMs: 0, toMs: 10_000, max: 100, gapMs: 3000, guide: 25 });
  assert(
    above.flat().some((cell) => cell.ink === 'high'),
    '50 is over a threshold of 25',
  );
});

test('time series: points further apart than gapMs are not joined; the point before the window leads in', () => {
  const apart = [
    { atMs: 0, value: 10 },
    { atMs: 10_000, value: 10 },
  ];
  assertEquals(dots(plotSeries(apart, { cols: 10, rows: 1, fromMs: 0, toMs: 10_000, max: 20, gapMs: 3000 })).length, 2);
  const joined = plotSeries(apart, { cols: 10, rows: 1, fromMs: 0, toMs: 10_000, max: 20, gapMs: 20_000 });
  assertEquals(dots(joined).length, 20);
  const leadIn = plotSeries(apart, { cols: 10, rows: 1, fromMs: 5000, toMs: 10_000, max: 20, gapMs: 20_000 });
  assertEquals(dots(leadIn)[0]?.[0], 0); // from the left edge, not from the first point inside
});

test('axis helpers: columns of a time, round tops, and the time labels', () => {
  assertEquals(columnOf(0, 0, 10_000, 10), 0);
  assertEquals(columnOf(10_000, 0, 10_000, 10), 9);
  assert(columnOf(-5000, 0, 10_000, 10) < 0, 'before the window');
  assertEquals(
    [5, 12, 43, 49.5, 114, 160, 999].map((v) => niceCeil(v)),
    [10, 15, 50, 50, 150, 200, 1000],
  );
  assertEquals(niceCeil(41, 50), 50);
  const axis = timeAxis(120_000, 40);
  assertEquals(axis.length, 40);
  assert(axis.startsWith('2 min ago') && axis.endsWith('now') && axis.includes('1 min ago'), axis);
});

test('gauges lean the way the machine does (x forward, z up)', () => {
  const centre = 10; // a 10 × 5 cell gauge is 20 × 20 dots
  const inner = (cells: Cell[][]) => dots(cells, ['data']).filter(([x, y]) => Math.hypot(x - centre, y - centre) < 7.5);
  const halves = (cells: Cell[][]) => {
    const line = inner(cells);
    return {
      left: mean(line.filter(([x]) => x < centre - 3).map(([, y]) => y)),
      right: mean(line.filter(([x]) => x > centre + 3).map(([, y]) => y)),
    };
  };
  const roll = halves(gauge('roll', 20, 10, 5));
  assert(roll.right > roll.left, `roll +20: the right side down (${roll.left} → ${roll.right})`);
  const pitch = halves(gauge('pitch', 20, 10, 5));
  assert(pitch.right < pitch.left, `pitch +20: the nose (right) up (${pitch.left} → ${pitch.right})`);
  const level = halves(gauge('roll', 0, 10, 5));
  assertEquals(level.left, level.right);

  const needle = (deg: number) => {
    const d = inner(gauge('heading', deg, 10, 5));
    return { x: mean(d.map(([x]) => x)) - centre, y: mean(d.map(([, y]) => y)) - centre };
  };
  assert(needle(0).y < -2, 'north: up');
  assert(needle(90).x > 2, 'east: right');
  assert(needle(180).y > 2, 'south: down');
  assert(needle(270).x < -2, 'west: left');
  assert(
    gauge('heading', 0, 10, 5)[0].some((cell) => cell.ch === 'N'),
    'N on the rim',
  );
  assertEquals(dots(gauge('roll', undefined, 10, 5), ['data']).length, 0); // no reading: the frame only
  assertEquals([0, 33, 90, 225, 359, -45].map(compassPoint), ['N', 'NE', 'E', 'SW', 'N', 'NW']);
});
