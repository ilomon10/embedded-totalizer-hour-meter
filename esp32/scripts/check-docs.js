#!/usr/bin/env node
// check-docs.js: fails (exit 1) when firmware, Node tag table and docs disagree.
//
//   node scripts/check-docs.js
//
// Checks:
//  1. every tag in lib/App/src/Protocol.h exists in node/tags.js with the same number
//  2. every setting row in SettingsSchema.cpp matches node/tags.js (name, fmt) and
//     the INTEGRATION-GUIDE settings table (name, type, min, max)
//  3. every tag in node/tags.js is documented in the INTEGRATION-GUIDE tables
//  3b. status flag bits agree between Protocol.h, node/tags.js and the guide
//  4. golden frames in the guide equal the ones asserted by test/test_app
//  5. the JS and Python reference decoders in the guide decode those frames correctly
//  6. relative links in esp32/docs/*.md, esp32/README.md, the root and simulator READMEs resolve
//  7. the firmware version in Protocol.h matches the guide, the frame catalog and the simulator
//  8. every hex dump in FRAME-CATALOG.md is a valid frame (COBS + CRC) for the node codec
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const esp32 = path.join(__dirname, '..');
const root = path.join(esp32, '..');
const read = (p) => fs.readFileSync(path.join(esp32, p), 'utf8');
const guide = read('docs/INTEGRATION-GUIDE.md');
const { tags } = require(path.join(root, 'node', 'tags.js'));

const errors = [];
const fail = (msg) => errors.push(msg);

// ---- 1. Protocol.h tags vs node/tags.js ----
const protocol = read('lib/App/src/Protocol.h');
const tagNs = protocol.slice(protocol.indexOf('namespace tag {'), protocol.indexOf('}  // namespace tag'));
const SKIP = new Set(['kSettingFirst', 'kSettingLast', 'kSpeed', 'kFwVersion', 'kAckSeq', 'kAckStatus']);
for (const [, cname, num] of tagNs.matchAll(/constexpr uint8_t (k\w+) = (\d+);/g)) {
  if (SKIP.has(cname)) continue;
  const name = cname.replace(/^k(Cmd|Filt)?/, '').replace(/^./, (c) => c.toLowerCase());
  const def = tags[num];
  if (!def) fail(`Protocol.h ${cname}=${num} missing from node/tags.js`);
  else if (def.name !== name) fail(`tag ${num}: Protocol.h says ${name}, node/tags.js says ${def.name}`);
}

// ---- 2. Settings schema vs node/tags.js vs guide ----
const FMT = { SF_U8: 'u8', SF_U16: 'u16', SF_U32: 'u32', SF_BOOL: 'bool', SF_F32: 'f32' };
const schema = read('lib/App/src/SettingsSchema.cpp');
const rows = [...schema.matchAll(/\{(\d+), "(\w+)", (SF_\w+), ([\d.e+-]+), ([\d.e+-]+)\}/g)];
const nodeSettings = Object.keys(require(path.join(root, 'node', 'tags.js')).SETTINGS).length;
if (rows.length !== nodeSettings) fail(`SettingsSchema.cpp has ${rows.length} settings, node/tags.js SETTINGS has ${nodeSettings}`);
for (const [, num, name, fmt, min, max] of rows) {
  const def = tags[num];
  if (!def || def.name !== name || def.fmt !== FMT[fmt]) {
    fail(`setting ${num}: schema {${name}, ${FMT[fmt]}} vs node/tags.js ${JSON.stringify(def)}`);
  }
  const js = require(path.join(root, 'node', 'tags.js')).SETTINGS[name];
  if (!js || js.tag !== Number(num) || js.min !== Number(min) || js.max !== Number(max)) {
    fail(`setting ${num} ${name}: node/tags.js SETTINGS range differs from SettingsSchema.cpp (${min}..${max})`);
  }
  const line = guide.split('\n').find((l) => l.startsWith(`| ${num} | \`${name}\` |`));
  if (!line) { fail(`setting ${num} ${name} missing from INTEGRATION-GUIDE §7`); continue; }
  if (!line.includes(`| ${FMT[fmt]} |`)) fail(`setting ${num}: guide type differs (expected ${FMT[fmt]})`);
  if (FMT[fmt] !== 'bool' && num !== '118' && !(line.includes(min) && line.includes(max))) {
    fail(`setting ${num}: guide range must show ${min} and ${max}`);
  }
}

// ---- 3. every node tag documented in the guide ----
const documented = new Set();
for (const line of guide.split('\n')) {
  const m = line.match(/^\| ([\d /–]+) \|/);
  if (!m) continue;
  for (const part of m[1].split('/')) {
    const range = part.trim().match(/^(\d+)(?:–(\d+))?$/);
    if (!range) continue;
    const a = Number(range[1]);
    const b = range[2] ? Number(range[2]) : a;
    for (let n = a; n <= b; n++) documented.add(n);
  }
}
for (const num of Object.keys(tags)) {
  if (!documented.has(Number(num))) fail(`tag ${num} (${tags[num].name}) is not in an INTEGRATION-GUIDE table`);
}

// ---- 3b. status flag bits: Protocol.h vs node/tags.js STATUS_FLAGS vs guide §5.5 ----
const { STATUS_FLAGS } = require(path.join(root, 'node', 'tags.js'));
const flagNs = protocol.slice(protocol.indexOf('namespace status_flag {'), protocol.indexOf('}  // namespace status_flag'));
const flags = [...flagNs.matchAll(/constexpr uint32_t k(\w+) = 1u << (\d+);/g)];
for (const [, cname, bit] of flags) {
  const name = cname.replace(/^./, (c) => c.toLowerCase());
  if (STATUS_FLAGS[Number(bit)] !== name) fail(`status flag bit ${bit}: Protocol.h ${name}, node/tags.js ${STATUS_FLAGS[Number(bit)]}`);
  if (!guide.includes(`| ${bit} | \`${name}\` |`)) fail(`status flag bit ${bit} (${name}) missing from INTEGRATION-GUIDE §5.5`);
}
if (STATUS_FLAGS.length !== flags.length) fail(`node/tags.js has ${STATUS_FLAGS.length} status flags, Protocol.h ${flags.length}`);

// ---- 4. golden frames ----
const testSrc = read('test/test_app/test_main.cpp');
const golden = {};
for (const [, key, body] of testSrc.matchAll(/kGolden(\w+) =\s*((?:"[^"]*"\s*)+);/g)) {
  golden[key] = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
}
const guideGolden = (marker) => {
  const i = guide.indexOf(`<!-- golden:${marker} -->`);
  return i < 0 ? null : guide.slice(i).split('```')[1].trim();
};
const goldenPairs = { Telemetry: 'telemetry', SetTime: 'set-time', AckGetHour: 'ack-get-hour' };
for (const [key, marker] of Object.entries(goldenPairs)) {
  if (!golden[key]) fail(`kGolden${key} not found in test/test_app`);
  else if (guideGolden(marker) !== golden[key]) fail(`guide golden:${marker} differs from test kGolden${key}`);
}

// ---- 5. run the reference decoders from the guide ----
const codeAfter = (marker, lang) => {
  const i = guide.indexOf(`<!-- reference-decoder:${lang} -->`);
  if (i < 0) return null;
  const rest = guide.slice(i);
  const start = rest.indexOf('```' + marker) + marker.length + 3;
  return rest.slice(start, rest.indexOf('```', start));
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-docs-'));
const frames = Object.fromEntries(Object.entries(golden).map(([k, v]) => [k, v.replace(/ /g, '')]));
const expectations = (d) => [
  [d.Telemetry.msgType, 1], [d.Telemetry.records[1], 4500000], [d.Telemetry.records[4], 125000],
  [d.SetTime.seq, 42], [d.SetTime.records[100], 1791376496],
  [d.AckGetHour.records[242], 43], [d.AckGetHour.records[243], 0], [d.AckGetHour.records[7], 812],
];
try {
  const jsCode = codeAfter('js', 'js');
  if (!jsCode) throw new Error('JS reference decoder block not found');
  fs.writeFileSync(path.join(tmp, 'decoder.js'), jsCode);
  const { decodeFrame } = require(path.join(tmp, 'decoder.js'));
  const decoded = {};
  for (const [k, hex] of Object.entries(frames)) {
    const bytes = Buffer.from(hex, 'hex');
    decoded[k] = decodeFrame(bytes.subarray(0, bytes.length - 1));
  }
  expectations(decoded).forEach(([got, want], i) => { if (got !== want) fail(`JS decoder check ${i}: got ${got}, want ${want}`); });

  const pyCode = codeAfter('python', 'python');
  if (!pyCode) throw new Error('Python reference decoder block not found');
  fs.writeFileSync(path.join(tmp, 'sensorframe_decoder.py'), pyCode);
  const harness = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("dec", sys.argv[1]); dec = importlib.util.module_from_spec(spec); spec.loader.exec_module(dec)
frames = json.loads(sys.argv[2]); out = {}
for k, h in frames.items():
    d = dec.decode_frame(bytes.fromhex(h)[:-1]); d["records"] = {str(t): v for t, v in d["records"].items()}; out[k] = d
print(json.dumps(out))`;
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', harness, path.join(tmp, 'sensorframe_decoder.py'), JSON.stringify(frames)]));
  expectations(out).forEach(([got, want], i) => { if (got !== want) fail(`Python decoder check ${i}: got ${got}, want ${want}`); });
} catch (err) {
  fail(`reference decoder: ${err.message}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 6. relative links ----
const mdFiles = [
  ...fs.readdirSync(path.join(esp32, 'docs')).map((f) => path.join(esp32, 'docs', f)),
  path.join(esp32, 'README.md'),
  path.join(root, 'README.md'),
  path.join(root, 'simulator', 'README.md'),
].filter((f) => f.endsWith('.md'));
for (const file of mdFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^https?:/.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) fail(`${path.relative(root, file)}: broken link ${target}`);
  }
}

// ---- 7. firmware version everywhere ----
const fwHex = protocol.match(/kFirmwareVersion = (0x[0-9A-Fa-f]+)/)?.[1];
const fw = fwHex ? [16, 8, 0].map((shift) => (Number(fwHex) >> shift) & 0xff).join('.') : null;
if (!fw) fail('kFirmwareVersion not found in Protocol.h');
const catalog = read('docs/FRAME-CATALOG.md');
const simProtocol = fs.readFileSync(path.join(root, 'simulator', 'src', 'protocol.ts'), 'utf8');
const versionChecks = [
  ['INTEGRATION-GUIDE.md header', guide.match(/firmware (\d+\.\d+\.\d+)\./)?.[1]],
  ['FRAME-CATALOG.md header', catalog.match(/firmware \*\*(\d+\.\d+\.\d+)\*\*/)?.[1]],
  ['simulator FIRMWARE_VERSION', simProtocol.match(/FIRMWARE_VERSION = (0x[0-9a-fA-F]+)/)?.[1] === fwHex ? fw : 'other'],
];
for (const [where, found] of versionChecks) {
  if (found !== fw) fail(`${where} says firmware ${found}, Protocol.h says ${fw}`);
}

// ---- 8. frame catalog dumps decode ----
const { createCodec } = require(path.join(root, 'sensorframe', 'js'));
const nodeCodec = createCodec({ tags });
const dumps = [...catalog.matchAll(/<!-- frame:([\w-]+) -->\n```text\n([\s\S]*?)\n```/g)];
if (dumps.length === 0) fail('FRAME-CATALOG.md: no <!-- frame:... --> dumps found');
for (const [, id, body] of dumps) {
  try {
    nodeCodec.decodeFrame(Buffer.from(body.replace(/\s+/g, ''), 'hex'));
  } catch (err) {
    fail(`FRAME-CATALOG.md frame:${id}: ${err.message}`);
  }
}

if (errors.length) {
  console.error(`check-docs: ${errors.length} problem(s)\n - ${errors.join('\n - ')}`);
  process.exit(1);
}
console.log(`check-docs: OK (${Object.keys(tags).length} tags, ${flags.length} status flags, ${rows.length} settings, ${Object.keys(golden).length} golden frames, JS + Python decoders, ${mdFiles.length} docs, firmware ${fw}, ${dumps.length} catalog frames)`);
