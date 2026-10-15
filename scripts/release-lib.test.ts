// release-lib.test.ts: versions, tags, release files and generated notes.
//   deno test scripts/
import { deepStrictEqual as assertEquals, throws as assertThrows } from 'node:assert/strict';
import {
  assetNames,
  changeList,
  generateNotes,
  parseVersion,
  repoFromRemote,
  shellLine,
  splitNotes,
  tagOf,
} from './release-lib.ts';

Deno.test('versions come from Protocol.h, version.ts and main.ts', () => {
  assertEquals(parseVersion('firmware', 'constexpr uint32_t kFirmwareVersion = 0x00020500;'), '2.5.0');
  assertEquals(parseVersion('firmware', 'kFirmwareVersion = 0x000A0C0F;'), '10.12.15');
  assertEquals(parseVersion('configurator', "export const TOOL_VERSION = '1.2.0';"), '1.2.0');
  assertEquals(parseVersion('simulator', "export const SIM_VERSION = '1.5.0';"), '1.5.0');
  assertThrows(() => parseVersion('simulator', "TOOL_VERSION = '1.0.0'"), /SIM_VERSION not found/);
  assertEquals(tagOf('firmware', '2.5.0'), 'firmware-v2.5.0');
});

Deno.test('release files match the names the builds produce', () => {
  assertEquals(assetNames('firmware', '2.5.0'), [
    'hour-meter-2.5.0-esp32dev-merged.bin',
    'hour-meter-firmware-2.5.0-esp32dev.tar.gz',
    'SHA256SUMS',
  ]);
  const sim = assetNames('simulator', '1.5.0');
  assertEquals(sim[0], 'hour-meter-sim-1.5.0-linux-x64.tar.gz');
  assertEquals(sim[4], 'hour-meter-sim-1.5.0-windows-x64.zip');
  assertEquals(assetNames('configurator', '1.2.0').length, 6);
});

Deno.test('change list: subjects without type(scope), body bullets joined across wrapped lines', () => {
  const lines = changeList('firmware', [
    {
      subject: 'feat(firmware): confirm engine running by vibration (2.5.0)',
      body:
        'Intro text is skipped.\n\n- New setting runVibMinMg: run time counts only\n  while the engine vibrates\n- New tag 10\n',
    },
    { subject: 'docs(wiring): explain the L terminal', body: '' },
    { subject: 'chore: bump deps', body: '' },
    { subject: 'Plain message', body: '' },
  ]);
  assertEquals(lines, [
    '- Confirm engine running by vibration (2.5.0)',
    '  - New setting runVibMinMg: run time counts only while the engine vibrates',
    '  - New tag 10',
    '- [wiring] Explain the L terminal',
    '- Plain message',
  ]);
});

Deno.test('generated notes: title, files table, changes and the compare link', () => {
  const n = generateNotes({
    component: 'configurator',
    version: '1.2.0',
    repo: 'me/repo',
    previousTag: 'configurator-v1.1.0',
    commits: [{ subject: 'feat(configurator): something new', body: '' }],
  });
  assertEquals(n.title, 'hour-meter configurator 1.2.0');
  for (
    const part of [
      '`hour-meter-1.2.0-macos-arm64.tar.gz`',
      '- Something new',
      'compare/configurator-v1.1.0...configurator-v1.2.0',
    ]
  ) {
    assertEquals(n.body.includes(part), true, part);
  }
  const first = generateNotes({
    component: 'firmware',
    version: '1.0.0',
    repo: 'me/repo',
    previousTag: null,
    commits: [],
  });
  assertEquals(first.body.includes('compare/'), false);
  assertEquals(first.body.includes('(no commits found)'), true);
});

Deno.test('notes files, remotes and shell lines', () => {
  assertEquals(splitNotes('# Firmware 2.5.0: the ACC fix\n\nBody\n', 'x'), {
    title: 'Firmware 2.5.0: the ACC fix',
    body: 'Body\n',
  });
  assertEquals(splitNotes('Body only\n', 'Fallback'), { title: 'Fallback', body: 'Body only\n' });
  assertEquals(
    repoFromRemote('https://github.com/ilomon10/embedded-totalizer-hour-meter.git'),
    'ilomon10/embedded-totalizer-hour-meter',
  );
  assertEquals(repoFromRemote('git@github.com:me/repo.git'), 'me/repo');
  assertThrows(() => repoFromRemote('https://gitlab.com/me/repo.git'), /not a GitHub remote/);
  assertEquals(shellLine('git', ['tag', '-a', 'v1', '-m', "it's done"]), "git tag -a v1 -m 'it'\\''s done'");
  assertEquals(shellLine('deno', ['task', 'test'], 'simulator'), '(cd simulator && deno task test)');
});
