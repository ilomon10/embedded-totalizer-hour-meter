// jlc-stock-lib.ts: pure helpers for jlc-stock.ts (no network, no files), so they can be unit-tested.

export interface BomLine {
  designators: string[];
  comment: string;
  footprint: string;
  lcsc: string;
  qty: number;
}

export interface JlcPart {
  code: string;
  mpn: string;
  pkg: string;
  stock: number;
  basic: boolean;
  preferred: boolean;
  unitPrice: number | null;
}

export type Verdict = 'OK' | 'LOW' | 'MISSING' | 'NO-LCSC' | 'BOARD-ONLY';

/** Footprints that are only copper or holes on the board, so there is no part to buy. */
const BOARD_ONLY = /^(MountingHole|TestPoint|Fiducial):|^Jumper:SolderJumper/;

/** Splits CSV text: quoted fields, doubled quotes, LF or CRLF line ends. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  endRow();
  return rows;
}

/** Reads a JLCPCB-style BOM: Designator, Comment, Footprint, LCSC and Qty columns, in any order. */
export function parseBom(text: string): BomLine[] {
  const [header, ...rows] = parseCsv(text);
  const col = (name: string): number => {
    const i = header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
    if (i < 0) throw new Error(`BOM has no "${name}" column`);
    return i;
  };
  const [d, c, f, l, q] = ['Designator', 'Comment', 'Footprint', 'LCSC', 'Qty'].map(col);
  return rows.map((r) => ({
    designators: r[d].split(/[\s,]+/).filter(Boolean),
    comment: r[c],
    footprint: r[f],
    lcsc: (r[l] ?? '').trim(),
    qty: Number(r[q]),
  }));
}

/** Maps one item of JLCPCB's selectSmtComponentList response. */
export function toPart(item: Record<string, unknown>): JlcPart {
  const prices = item.componentPrices as { productPrice: number }[] | undefined;
  return {
    code: String(item.componentCode),
    mpn: String(item.componentModelEn),
    pkg: String(item.componentSpecificationEn),
    stock: Number(item.stockCount),
    basic: item.componentLibraryType === 'base',
    preferred: item.preferredComponentFlag === true,
    unitPrice: prices?.[0]?.productPrice ?? null,
  };
}

/** OK when JLCPCB holds enough for `boards` boards, LOW when it holds some but not enough. */
export function verdict(line: BomLine, part: JlcPart | undefined, boards: number): Verdict {
  if (!line.lcsc && BOARD_ONLY.test(line.footprint)) return 'BOARD-ONLY';
  if (!/^C\d+$/.test(line.lcsc)) return 'NO-LCSC';
  if (!part || part.stock === 0) return 'MISSING';
  return part.stock >= line.qty * boards ? 'OK' : 'LOW';
}
