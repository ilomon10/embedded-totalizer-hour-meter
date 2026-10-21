#!/usr/bin/env -S deno run --allow-read --allow-net=jlcpcb.com
// jlc-stock.ts: check every LCSC part of a JLCPCB BOM against JLCPCB's live stock.
//
//   ./scripts/jlc-stock.ts schematic/hour-meter-board/production/BOM-hour-meter-board.csv --boards 10
//
// Prints one row per BOM line (verdict, LCSC, stock, basic/pref/ext, designators, comment)
// and exits 1 if any line is LOW, MISSING or has no LCSC number. Mounting holes, solder
// jumpers, test points and fiducials are BOARD-ONLY: nothing to buy, never a problem.
import { type JlcPart, parseBom, toPart, verdict } from './jlc-stock-lib.ts';

const API = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';

async function fetchPart(code: string): Promise<JlcPart | undefined> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ keyword: code, currentPage: 1, pageSize: 5, searchSource: 'search' }),
  });
  if (!res.ok) throw new Error(`JLCPCB API answered ${res.status} for ${code}`);
  const body = await res.json();
  const list: Record<string, unknown>[] = body?.data?.componentPageInfo?.list ?? [];
  const hit = list.find((item) => item.componentCode === code);
  return hit ? toPart(hit) : undefined;
}

const args = [...Deno.args];
const at = args.indexOf('--boards');
const boards = at >= 0 ? Number(args.splice(at, 2)[1]) : 5;
const [bomPath] = args;
if (!bomPath || !(boards > 0)) {
  console.error('usage: jlc-stock.ts <bom.csv> [--boards N]');
  Deno.exit(2);
}

let problems = 0;
for (const line of parseBom(await Deno.readTextFile(bomPath))) {
  const part = /^C\d+$/.test(line.lcsc) ? await fetchPart(line.lcsc) : undefined;
  const v = verdict(line, part, boards);
  if (v !== 'OK' && v !== 'BOARD-ONLY') problems++;
  const lib = part ? (part.basic ? 'basic' : part.preferred ? 'pref' : 'ext') : '-';
  console.log([v.padEnd(7), line.lcsc.padEnd(10), String(part?.stock ?? 0).padStart(9), lib.padEnd(5), line.designators.join(','), line.comment].join('  '));
  await new Promise((r) => setTimeout(r, 250)); // keep the request rate low
}
console.log(problems ? `${problems} line(s) need attention` : `all parts in stock for ${boards} boards`);
Deno.exit(problems ? 1 : 0);
