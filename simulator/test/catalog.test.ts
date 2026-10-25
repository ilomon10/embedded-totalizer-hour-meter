// catalog.test.ts: every hex dump in esp32/docs/FRAME-CATALOG.md equals the
// bytes the generator builds, and every generated frame is in the doc.
// After a protocol change: `bun run gen-catalog`, then paste the new blocks.
import { test } from 'bun:test';

import { assertEquals } from './assert.ts';
import { catalogFrames, wireHex } from '../tools/catalog.ts';

const DOC = new URL('../../esp32/docs/FRAME-CATALOG.md', import.meta.url);

async function docBlocks(): Promise<Map<string, string>> {
  const text = await Bun.file(DOC).text();
  const blocks = new Map<string, string>();
  for (const [, id, body] of text.matchAll(/<!-- frame:([\w-]+) -->\n```text\n([\s\S]*?)\n```/g)) {
    blocks.set(id, body.trim());
  }
  return blocks;
}

test('FRAME-CATALOG.md hex dumps match the generated frames', async () => {
  const blocks = await docBlocks();
  for (const frame of catalogFrames()) {
    assertEquals(blocks.get(frame.id), wireHex(frame), `frame:${frame.id} (run: bun run gen-catalog ${frame.id})`);
  }
  assertEquals([...blocks.keys()].sort(), catalogFrames().map((f) => f.id).sort());
});
