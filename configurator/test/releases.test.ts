// releases.test.ts: the GitHub release list, picking a release, checked downloads, the cache folder.
// No network: fetch is a fake answering from a table.
import { test } from 'bun:test';

import { assertEquals, assertRejects } from './assert.ts';
import {
  cacheDir,
  compareVersions,
  expectedSha256,
  type Fetch,
  fetchVerified,
  findRelease,
  FIRMWARE_ASSET,
  formatFirmware,
  listFirmware,
  parseReleases,
  parseSums,
  sha256Hex,
} from '../src/releases.ts';
import { assetNames } from '../../scripts/release-lib.ts';

const asset = (name: string) => ({ name, browser_download_url: `https://dl.example/${name}` });

const RELEASES = [
  {
    tag_name: 'firmware-v2.4.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-12T05:23:09Z',
    assets: [asset('hour-meter-2.4.0-esp32dev-merged.bin'), asset('SHA256SUMS')],
  },
  {
    tag_name: 'v1.1.0',
    draft: false,
    prerelease: true,
    published_at: '2026-11-01T00:00:00Z',
    assets: [
      asset('hour-meter-1.3.0-linux-x64.tar.gz'),
      asset('hour-meter-2.6.0-esp32dev-merged.bin'),
      asset('SHA256SUMS'),
    ],
  },
  {
    tag_name: 'v1.0.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-15T02:24:11Z',
    assets: [
      asset('hour-meter-2.5.0-esp32dev-merged.bin'),
      asset('hour-meter-firmware-2.5.0-esp32dev.tar.gz'),
      asset('SHA256SUMS'),
    ],
  },
  {
    tag_name: 'firmware-v2.5.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-13T00:00:00Z',
    assets: [asset('hour-meter-2.5.0-esp32dev-merged.bin'), asset('SHA256SUMS')],
  },
  {
    tag_name: 'simulator-v1.3.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-12T05:24:00Z',
    assets: [asset('hour-meter-sim-1.3.0-linux-x64.tar.gz'), asset('SHA256SUMS')],
  },
  {
    tag_name: 'v1.2.0',
    draft: true,
    prerelease: false,
    published_at: null,
    assets: [asset('hour-meter-2.7.0-esp32dev-merged.bin'), asset('SHA256SUMS')],
  },
];

/** A fetch that answers from a table: a body, an HTTP status, or a whole Response. Records the requests. */
function fakeFetch(
  table: Record<string, string | Uint8Array | number | (() => Response)>,
  seen: Request[] = [],
): Fetch {
  return (url, init) => {
    seen.push(new Request(url, init));
    const body = table[url];
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    if (typeof body === 'function') return Promise.resolve(body());
    if (typeof body === 'number') return Promise.resolve(new Response('', { status: body }));
    return Promise.resolve(new Response(typeof body === 'string' ? body : new Uint8Array(body)));
  };
}

const API = 'https://api.github.com/repos/ilomon10/embedded-totalizer-hour-meter/releases?per_page=100';

test('releases: one entry per firmware, newest first; drafts and releases without firmware are skipped', () => {
  const list = parseReleases(RELEASES);
  assertEquals(
    list.map((r) => `${r.version} ${r.tag}${r.prerelease ? ' pre' : ''}`),
    [
      '2.6.0 v1.1.0 pre',
      '2.5.0 v1.0.0', // also in firmware-v2.5.0: the newer release wins
      '2.4.0 firmware-v2.4.0',
    ],
  );
  assertEquals(findRelease(list, 'latest')?.version, '2.5.0'); // not the prerelease
  assertEquals(findRelease(list, 'v1.0.0')?.version, '2.5.0');
  assertEquals(findRelease(list, '2.4.0')?.tag, 'firmware-v2.4.0');
  assertEquals(findRelease(list, '9.9.9'), undefined);
  assertEquals(list[1].url, 'https://dl.example/hour-meter-2.5.0-esp32dev-merged.bin');
});

test('the release script names its firmware asset the way the downloader looks for it', () => {
  const name = assetNames('firmware', '2.5.0')[0];
  assertEquals(name.match(FIRMWARE_ASSET)?.[1], '2.5.0');
});

test('versions compare numerically; fwVersion formats', () => {
  assertEquals(compareVersions('2.10.0', '2.9.1') > 0, true);
  assertEquals(compareVersions('2.5.0', '2.5.0'), 0);
  assertEquals(compareVersions('2.4.9', '2.5.0') < 0, true);
  assertEquals(formatFirmware(0x00020500), '2.5.0');
  assertEquals(formatFirmware(undefined), '?');
});

test('listFirmware asks the GitHub API; the token goes only there; errors say why', async () => {
  const seen: Request[] = [];
  const list = await listFirmware({ fetch: fakeFetch({ [API]: JSON.stringify(RELEASES) }, seen), token: 'abc' });
  assertEquals(list.length, 3);
  assertEquals(seen[0].headers.get('authorization'), 'Bearer abc');
  assertEquals(seen[0].headers.get('user-agent')?.startsWith('hour-meter/'), true);
  await assertRejects(
    () => listFirmware({ fetch: fakeFetch({ [API]: 403 }) }),
    /GitHub API: HTTP 403, the hourly limit/,
  );
  await assertRejects(
    () => listFirmware({ fetch: () => Promise.reject(new TypeError('dns error')) }),
    /cannot reach GitHub \(dns error\)/,
  );
});

test('over the API limit the list comes from the web: feed, SHA256SUMS, releases/latest', async () => {
  const web = 'https://github.com/ilomon10/embedded-totalizer-hour-meter/releases';
  const entry = (tag: string, date: string) =>
    `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><updated>${date}</updated>` +
    `<link rel="alternate" type="text/html" href="${web}/tag/${tag}"/><title>${tag}</title></entry>`;
  const feed =
    `<?xml version="1.0"?><feed>${entry('v1.1.0', '2026-11-01T00:00:00Z')}` +
    `${entry('simulator-v1.3.0', '2026-10-20T00:00:00Z')}${entry('v1.0.0', '2026-10-15T02:24:11Z')}</feed>`;
  const sums = (...names: string[]) => names.map((n) => `${'a'.repeat(64)}  ${n}`).join('\n');
  const list = await listFirmware({
    fetch: fakeFetch({
      [API]: 403,
      [`${web}.atom`]: feed,
      [`${web}/latest`]: () => new Response(null, { status: 302, headers: { location: `${web}/tag/v1.0.0` } }),
      [`${web}/download/v1.1.0/SHA256SUMS`]: sums(
        'hour-meter-2.6.0-esp32dev-merged.bin',
        'hour-meter-1.3.0-linux-x64.tar.gz',
      ),
      [`${web}/download/v1.0.0/SHA256SUMS`]: sums('hour-meter-2.5.0-esp32dev-merged.bin'),
      [`${web}/download/simulator-v1.3.0/SHA256SUMS`]: sums('hour-meter-sim-1.3.0-linux-x64.tar.gz'),
    }),
  });
  // v1.1.0 is newer than what releases/latest points at, so it is a prerelease.
  assertEquals(
    list.map((r) => `${r.version} ${r.tag}${r.prerelease ? ' pre' : ''}`),
    ['2.6.0 v1.1.0 pre', '2.5.0 v1.0.0'],
  );
  assertEquals(findRelease(list, 'latest')?.version, '2.5.0');
  assertEquals(list[1].url, `${web}/download/v1.0.0/hour-meter-2.5.0-esp32dev-merged.bin`);
  assertEquals(list[1].sumsUrl, `${web}/download/v1.0.0/SHA256SUMS`);
});

test('downloads are checked against SHA256SUMS; a tampered image is refused', async () => {
  const release = parseReleases(RELEASES)[1];
  const image = new TextEncoder().encode('firmware bytes');
  const sum = sha256Hex(image);
  const sums = `${'0'.repeat(64)}  hour-meter-1.2.0-linux-x64.tar.gz\n${sum} *${release.asset}\n\n`;
  assertEquals(parseSums(sums).get(release.asset), sum);

  const seen: Request[] = [];
  const good = { fetch: fakeFetch({ [release.sumsUrl]: sums, [release.url]: image }, seen), token: 'abc' };
  const expected = await expectedSha256(release, good);
  assertEquals(await fetchVerified(release, expected, good), image);
  assertEquals(
    seen.map((r) => r.headers.get('authorization')),
    [null, null],
  ); // not sent to the downloads

  const bad = { fetch: fakeFetch({ [release.url]: new TextEncoder().encode('evil bytes') }) };
  await assertRejects(() => fetchVerified(release, expected, bad), /does not match SHA256SUMS/);
  await assertRejects(
    () => expectedSha256(release, { fetch: fakeFetch({ [release.sumsUrl]: 'nothing' }) }),
    /SHA256SUMS has no line/,
  );
});

test('the cache folder follows each OS', () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(cacheDir(env({ HOME: '/home/a' }), 'linux'), '/home/a/.cache/hour-meter');
  assertEquals(cacheDir(env({ HOME: '/home/a', XDG_CACHE_HOME: '/c' }), 'linux'), '/c/hour-meter');
  assertEquals(cacheDir(env({ HOME: '/Users/a' }), 'darwin'), '/Users/a/Library/Caches/hour-meter');
});
