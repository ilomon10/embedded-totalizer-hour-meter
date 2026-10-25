// releases.ts: the firmware on the project's GitHub releases. List it, download an image checked against the
// release's SHA256SUMS, and keep downloads in a cache folder.
//
// Every release since firmware 2.4.0 (tags firmware-v*, then v* from 1.0.0) carries
// hour-meter-<firmware version>-esp32dev-merged.bin and SHA256SUMS. The names come from scripts/release-lib.ts
// (assetNames); test/releases.test.ts keeps the two in step. `fetch` is a parameter, so the tests need no network.
//
// The list comes from the GitHub API. Without a token the API allows 60 requests an hour per IP address, which a
// shared address (office, mobile carrier NAT) uses up quickly; then the list is built from the web pages instead,
// which have no such limit: the release feed, each release's SHA256SUMS, and where releases/latest points.
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OS } from './platform.ts';
import { TOOL_VERSION } from './version.ts';

export const REPO = 'ilomon10/embedded-totalizer-hour-meter';
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const WEB_URL = `https://github.com/${REPO}/releases`;
export const FIRMWARE_ASSET = /^hour-meter-(\d+\.\d+\.\d+)-esp32dev-merged\.bin$/;
const SUMS_ASSET = 'SHA256SUMS';
const TIMEOUT_MS = 30000;

export interface FirmwareRelease {
  /** Firmware version, e.g. 2.5.0. */
  version: string;
  /** The release that carries it, e.g. v1.0.0. */
  tag: string;
  /** Publication time, ISO 8601. */
  date: string;
  prerelease: boolean;
  /** File name of the merged image. */
  asset: string;
  url: string;
  sumsUrl: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubOptions {
  fetch?: Fetch;
  /** $GITHUB_TOKEN: only raises the API rate limit (60 requests an hour without it). */
  token?: string;
}

/** 0x00MMmmpp (the fwVersion tag) -> "M.m.p"; '?' when unknown. */
export function formatFirmware(v: unknown): string {
  if (typeof v !== 'number') return '?';
  return `${(v >> 16) & 0xff}.${(v >> 8) & 0xff}.${v & 0xff}`;
}

/** Order two versions like 2.5.0: negative if a is older, 0 if equal, positive if a is newer. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets?: { name: string; browser_download_url: string }[];
}

/** GitHub's release list -> one entry per firmware version, newest version first. */
export function parseReleases(json: unknown): FirmwareRelease[] {
  if (!Array.isArray(json)) throw new Error('GitHub did not answer with a release list');
  const newestFirst = (json as GitHubRelease[])
    .filter((r) => !r.draft)
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  const byVersion = new Map<string, FirmwareRelease>();
  for (const r of newestFirst) {
    const image = r.assets?.find((a) => FIRMWARE_ASSET.test(a.name));
    const sums = r.assets?.find((a) => a.name === SUMS_ASSET);
    if (!image || !sums) continue; // a release without firmware (or without checksums)
    const version = image.name.match(FIRMWARE_ASSET)![1];
    if (byVersion.has(version)) continue; // the same firmware again in an older release: keep the newest
    byVersion.set(version, {
      version,
      tag: r.tag_name,
      date: r.published_at ?? '',
      prerelease: r.prerelease,
      asset: image.name,
      url: image.browser_download_url,
      sumsUrl: sums.browser_download_url,
    });
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** The release a word names: 'latest' (newest that is not a prerelease), a firmware version, or a tag. */
export function findRelease(list: FirmwareRelease[], spec: string): FirmwareRelease | undefined {
  if (spec === 'latest') return list.find((r) => !r.prerelease);
  return list.find((r) => r.version === spec || r.tag === spec);
}

/** GET `url`; `what` names it in errors. The token only ever goes to the API, never to the downloads. */
async function get(url: string, what: string, { fetch: fetchFn = fetch, token }: GitHubOptions): Promise<Response> {
  const api = url === API_URL;
  const headers: Record<string, string> = { 'User-Agent': `hour-meter/${TOOL_VERSION}` };
  if (api) headers.Accept = 'application/vnd.github+json';
  if (api && token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`cannot reach GitHub (${(err as Error).message})`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    const limit = api && (res.status === 403 || res.status === 429) ? ', the hourly limit (set GITHUB_TOKEN)' : '';
    throw new Error(`${what}: HTTP ${res.status}${limit}`);
  }
  return res;
}

/** Every firmware on the GitHub releases, newest version first. */
export async function listFirmware(options: GitHubOptions = {}): Promise<FirmwareRelease[]> {
  try {
    return parseReleases(await (await get(API_URL, 'GitHub API', options)).json());
  } catch (apiError) {
    return await listFromWeb(options).catch(() => {
      throw apiError;
    });
  }
}

/** The release feed (Atom) -> tag and date of each release in it (the newest 10). */
export function parseFeed(xml: string): { tag: string; date: string }[] {
  const out: { tag: string; date: string }[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const tag = entry.match(/\/releases\/tag\/([^"]+)"/)?.[1];
    const date = entry.match(/<updated>([^<]+)<\/updated>/)?.[1];
    if (tag && date) out.push({ tag: decodeURIComponent(tag), date });
  }
  return out;
}

/**
 * The same list without the API. The feed has no prerelease mark, but releases/latest never points at a
 * prerelease, so a release newer than that one is a prerelease.
 */
export async function listFromWeb(options: GitHubOptions = {}): Promise<FirmwareRelease[]> {
  const feed = parseFeed(await (await get(`${WEB_URL}.atom`, 'GitHub release feed', options)).text());
  const latest = await latestTag(options).catch(() => undefined);
  const latestDate = feed.find((r) => r.tag === latest)?.date;
  const releases = await Promise.all(
    feed.map(async ({ tag, date }) => {
      const base = `${WEB_URL}/download/${encodeURIComponent(tag)}`;
      const sums = await get(`${base}/${SUMS_ASSET}`, `${tag} ${SUMS_ASSET}`, options).then(
        (r) => r.text(),
        () => '',
      );
      const image = [...parseSums(sums).keys()].find((name) => FIRMWARE_ASSET.test(name));
      if (!image) return undefined; // no firmware in this release
      const assets = [image, SUMS_ASSET].map((name) => ({ name, browser_download_url: `${base}/${name}` }));
      return { tag_name: tag, draft: false, prerelease: !!latestDate && date > latestDate, published_at: date, assets };
    }),
  );
  return parseReleases(releases.filter((r) => r !== undefined));
}

/** The tag releases/latest redirects to. */
async function latestTag({ fetch: fetchFn = fetch }: GitHubOptions): Promise<string | undefined> {
  const res = await fetchFn(`${WEB_URL}/latest`, {
    redirect: 'manual',
    headers: { 'User-Agent': `hour-meter/${TOOL_VERSION}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  const tag = res.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
  return tag && decodeURIComponent(tag);
}

/** SHA256SUMS text -> file name -> lowercase hex digest. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The image's SHA-256 as the release's SHA256SUMS lists it. */
export async function expectedSha256(release: FirmwareRelease, options: GitHubOptions = {}): Promise<string> {
  const sums = parseSums(await (await get(release.sumsUrl, `${release.tag} ${SUMS_ASSET}`, options)).text());
  const sum = sums.get(release.asset);
  if (!sum) throw new Error(`${release.tag}: SHA256SUMS has no line for ${release.asset}`);
  return sum;
}

/** Download the image and check it against `sha256`. Throws on a mismatch (a broken or tampered download). */
export async function fetchVerified(
  release: FirmwareRelease,
  sha256: string,
  options: GitHubOptions = {},
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await (await get(release.url, release.asset, options)).arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== sha256) {
    throw new Error(`${release.asset}: SHA-256 ${actual} does not match SHA256SUMS (${sha256}); nothing was saved`);
  }
  return bytes;
}

export interface Download {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  /** The file was already in `dir` with the right checksum. */
  cached: boolean;
  /** Why the checked image could not be saved at `path` (the bytes are still good to use). */
  notSaved?: string;
}

/** Download a release's image into `dir` (checked). A file already there with the right checksum is reused. */
export async function downloadFirmware(
  release: FirmwareRelease,
  dir: string,
  options: GitHubOptions = {},
): Promise<Download> {
  const sha256 = await expectedSha256(release, options);
  const path = join(dir, release.asset);
  const existing = await Bun.file(path)
    .bytes()
    .catch(() => undefined);
  if (existing && sha256Hex(existing) === sha256) return { path, bytes: existing, sha256, cached: true };
  const bytes = await fetchVerified(release, sha256, options);
  // Written under a temporary name, then renamed: a cut download never looks finished, and two downloads of the
  // same image (TUI and CLI at once) do not trip over each other's file.
  const part = `${path}.${crypto.randomUUID().slice(0, 8)}.part`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(part, bytes);
    await rename(part, path);
  } catch (err) {
    await rm(part).catch(() => {});
    return { path, bytes, sha256, cached: false, notSaved: (err as Error).message };
  }
  return { path, bytes, sha256, cached: false };
}

/** The tool's own folder for downloads and backups: ~/.cache/hour-meter, ~/Library/Caches/hour-meter on macOS. */
export function cacheDir(env: (name: string) => string | undefined, os: string = OS): string {
  const home = env('HOME') ?? env('USERPROFILE') ?? '.';
  if (os === 'darwin') return join(home, 'Library', 'Caches', 'hour-meter');
  if (os === 'windows') return join(env('LOCALAPPDATA') ?? home, 'hour-meter');
  return join(env('XDG_CACHE_HOME') ?? join(home, '.cache'), 'hour-meter');
}
