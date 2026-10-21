// jlc-stock-lib.test.ts: BOM parsing, API mapping and stock verdicts.
//   deno test scripts/
import { deepStrictEqual as assertEquals, throws as assertThrows } from 'node:assert/strict';
import { parseBom, parseCsv, toPart, verdict } from './jlc-stock-lib.ts';

const bom = [
  'Designator,Comment,Footprint,LCSC,Qty',
  '"R1,R2,R3",10k,R_0603_1608Metric,C25804,3',
  'U1,"ESP32-WROOM-32E-N4","RF_Module:ESP32-WROOM-32E",C701341,1',
  'TP1,TestPoint,TestPoint_Pad_D1.0mm,,1',
].join('\r\n');

Deno.test('parseCsv keeps quoted commas and doubled quotes', () => {
  assertEquals(parseCsv('a,"b,c","d ""e"""\n1,2,3\n'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
});

Deno.test('parseBom reads the JLCPCB columns and splits designators', () => {
  const lines = parseBom(bom);
  assertEquals(lines.length, 3);
  assertEquals(lines[0], { designators: ['R1', 'R2', 'R3'], comment: '10k', footprint: 'R_0603_1608Metric', lcsc: 'C25804', qty: 3 });
  assertEquals(lines[2].lcsc, '');
});

Deno.test('parseBom names a missing column', () => {
  assertThrows(() => parseBom('Designator,Comment\nR1,10k'), /no "Footprint" column/);
});

Deno.test('toPart maps a selectSmtComponentList item', () => {
  const part = toPart({
    componentCode: 'C8963',
    componentModelEn: 'SP3485EN-L/TR',
    componentSpecificationEn: 'SOIC-8',
    stockCount: 383253,
    componentLibraryType: 'base',
    preferredComponentFlag: false,
    componentPrices: [{ startNumber: 1, endNumber: 9, productPrice: 0.2677 }],
  });
  assertEquals(part, { code: 'C8963', mpn: 'SP3485EN-L/TR', pkg: 'SOIC-8', stock: 383253, basic: true, preferred: false, unitPrice: 0.2677 });
});

Deno.test('verdict: OK, LOW, MISSING and NO-LCSC', () => {
  const [r, , tp] = parseBom(bom);
  const part = (stock: number) => ({ code: 'C25804', mpn: '', pkg: '', stock, basic: true, preferred: false, unitPrice: null });
  assertEquals(verdict(r, part(30), 10), 'OK'); // 3 per board × 10 boards = 30
  assertEquals(verdict(r, part(29), 10), 'LOW');
  assertEquals(verdict(r, part(0), 10), 'MISSING');
  assertEquals(verdict(r, undefined, 10), 'MISSING');
  assertEquals(verdict(tp, undefined, 10), 'NO-LCSC');
});

Deno.test('verdict: holes, solder jumpers, test points and fiducials need no part', () => {
  const line = (footprint: string) => ({ designators: ['X1'], comment: '', footprint, lcsc: '', qty: 1 });
  for (const fp of ['MountingHole:MountingHole_3.2mm_M3', 'Jumper:SolderJumper-2_P1.3mm_Open_RoundedPad1.0x1.5mm', 'TestPoint:TestPoint_Pad_D1.0mm', 'Fiducial:Fiducial_1mm_Mask2mm']) {
    assertEquals(verdict(line(fp), undefined, 10), 'BOARD-ONLY');
  }
  assertEquals(verdict(line('Jumper:Jumper_2_Bridged'), undefined, 10), 'NO-LCSC'); // a real jumper part still needs one
});
