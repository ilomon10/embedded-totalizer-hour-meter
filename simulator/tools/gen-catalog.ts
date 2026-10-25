// gen-catalog.ts: print the example frames of esp32/docs/FRAME-CATALOG.md as
// Markdown (records table + wire hex) so the doc can be refreshed after a
// protocol change:
//
//   bun run gen-catalog            # all frames
//   bun run gen-catalog telemetry  # one frame by id
//
// Paste the blocks into the doc; test/catalog.test.ts checks they match.
import { catalogFrames, recordRows, sizes, wireHex } from './catalog.ts';

const only = process.argv[2];
for (const f of catalogFrames()) {
  if (only && f.id !== only) continue;
  const { packet, wire } = sizes(f);
  console.log(`### ${f.title}\n`);
  console.log(
    `seq ${f.seq} · deviceId 0x${f.deviceId.toString(16)} · ${packet}-byte packet, ${wire} bytes on the wire\n`,
  );
  console.log('| Tag | Name | Type | Bytes | Raw value |\n|---:|---|---|---:|---|');
  console.log(recordRows(f).join('\n'));
  console.log(`\n<!-- frame:${f.id} -->\n\`\`\`text\n${wireHex(f)}\n\`\`\`\n`);
}
