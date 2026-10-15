// release-lib.ts: the pure part of scripts/release.ts. What each component is,
// where its version lives, which files a release carries and the generated
// release notes. No I/O here, so it is tested on its own (release-lib.test.ts).

export type Component = 'firmware' | 'configurator' | 'simulator';

export const COMPONENTS: readonly Component[] = ['firmware', 'configurator', 'simulator'];

export interface ComponentInfo {
  /** source folder (commits touching it belong to this component) */
  dir: string;
  /** file that holds the version, relative to the repo root */
  versionFile: string;
  /** what the release is called on GitHub, before the version */
  title: string;
}

export const INFO: Record<Component, ComponentInfo> = {
  firmware: { dir: 'esp32', versionFile: 'esp32/lib/App/src/Protocol.h', title: 'Hour meter firmware' },
  configurator: {
    dir: 'configurator',
    versionFile: 'configurator/src/version.ts',
    title: 'hour-meter configurator',
  },
  simulator: { dir: 'simulator', versionFile: 'simulator/main.ts', title: 'hour-meter-sim simulator' },
};

/** Platforms `deno task compile` builds, as they appear in archive names. */
export const TOOL_PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64'] as const;

const PLATFORM_LABEL: Record<(typeof TOOL_PLATFORMS)[number], string> = {
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux arm64 (Raspberry Pi 4/5 64-bit)',
  'macos-x64': 'macOS Intel',
  'macos-arm64': 'macOS Apple Silicon',
  'windows-x64': 'Windows x64',
};

/** The version in a component's version file, e.g. "2.5.0". Throws if it is not found. */
export function parseVersion(c: Component, source: string): string {
  if (c === 'firmware') {
    const m = source.match(/kFirmwareVersion\s*=\s*0x([0-9a-fA-F]{8})/);
    if (!m) throw new Error('kFirmwareVersion not found in Protocol.h');
    const n = parseInt(m[1], 16); // 0x00MMmmpp
    return `${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
  }
  const name = c === 'configurator' ? 'TOOL_VERSION' : 'SIM_VERSION';
  const m = source.match(new RegExp(`${name}\\s*=\\s*'(\\d+\\.\\d+\\.\\d+)'`));
  if (!m) throw new Error(`${name} not found in ${INFO[c].versionFile}`);
  return m[1];
}

export const tagOf = (c: Component, version: string) => `${c}-v${version}`;

/** Names of the files attached to the release (SHA256SUMS last). */
export function assetNames(c: Component, version: string): string[] {
  if (c === 'firmware') {
    return [
      `hour-meter-${version}-esp32dev-merged.bin`,
      `hour-meter-firmware-${version}-esp32dev.tar.gz`,
      'SHA256SUMS',
    ];
  }
  const base = c === 'configurator' ? 'hour-meter' : 'hour-meter-sim';
  return [
    ...TOOL_PLATFORMS.map((p) => `${base}-${version}-${p}.${p.startsWith('windows') ? 'zip' : 'tar.gz'}`),
    'SHA256SUMS',
  ];
}

/** Flash offsets of the ESP32 images (Arduino core, 4 MB, default partition table). */
export const FLASH_LAYOUT = [
  { offset: '0x1000', file: 'bootloader.bin' },
  { offset: '0x8000', file: 'partitions.bin' },
  { offset: '0xe000', file: 'boot_app0.bin' },
  { offset: '0x10000', file: 'firmware.bin' },
] as const;

export interface Commit {
  subject: string;
  body: string;
}

/**
 * The change list from Conventional Commits: each subject without its type(scope)
 * prefix, then the body's "- " bullets indented under it. Commits of other scopes
 * (a docs change that touched the folder) are kept, with their scope in brackets.
 */
export function changeList(c: Component, commits: Commit[]): string[] {
  const lines: string[] = [];
  for (const commit of commits) {
    const m = commit.subject.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/);
    const scope = m?.[2];
    const text = m ? m[3] : commit.subject;
    if (m && ['chore', 'ci', 'style', 'test'].includes(m[1])) continue;
    lines.push(`- ${scope && scope !== c ? `[${scope}] ` : ''}${text.charAt(0).toUpperCase()}${text.slice(1)}`);
    let inBullet = false;
    for (const b of commit.body.split('\n')) {
      const bullet = b.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) lines.push(`  - ${bullet[1].trim()}`);
      else if (inBullet && /^\s+\S/.test(b)) lines[lines.length - 1] += ` ${b.trim()}`; // a wrapped bullet
      inBullet = bullet !== null || (inBullet && /^\s+\S/.test(b));
    }
  }
  return lines;
}

export interface NotesInput {
  component: Component;
  version: string;
  repo: string;
  /** the tag of the previous release of this component, if any */
  previousTag: string | null;
  commits: Commit[];
}

/** Release notes generated from the commits, in the style of the earlier releases. */
export function generateNotes(n: NotesInput): { title: string; body: string } {
  const { component: c, version: v, repo } = n;
  const assets = assetNames(c, v);
  const out: string[] = [];
  if (c === 'firmware') {
    out.push(
      `Firmware **${v}** for the ESP32 DevKit hour meter.`,
      '',
      '| File | What |',
      '|---|---|',
      `| \`${assets[0]}\` | One image, flash at \`0x0\` |`,
      `| \`${assets[1]}\` | The separate images (${FLASH_LAYOUT.map((l) => `${l.file} \`${l.offset}\``).join(', ')}) |`,
      '',
      '```bash',
      `esptool.py --chip esp32 --port /dev/ttyUSB0 --baud 921600 write_flash 0x0 ${assets[0]}`,
      '# or from the source tree:  cd esp32 && pio run -e esp32dev -t upload',
      '```',
    );
  } else {
    const exe = c === 'configurator' ? 'hour-meter' : 'hour-meter-sim';
    out.push(
      `\`${exe}\` **${v}**. One standalone binary, no Deno needed.`,
      '',
      '| Platform | File |',
      '|---|---|',
      ...TOOL_PLATFORMS.map((p, i) => `| ${PLATFORM_LABEL[p]} | \`${assets[i]}\` |`),
      '',
      '```bash',
      `tar xzf ${assets[0]} && cd ${assets[0].replace(/\.tar\.gz$/, '')}`,
      c === 'configurator'
        ? './hour-meter --demo            # or: ./hour-meter /dev/ttyUSB0'
        : './hour-meter-sim --web',
      '```',
    );
  }
  const changes = changeList(c, n.commits);
  out.push('', '### Changes', ...(changes.length ? changes : ['- (no commits found)']));
  out.push('', '### Notes');
  if (n.previousTag) {
    out.push(`- Full list: https://github.com/${repo}/compare/${n.previousTag}...${tagOf(c, v)}`);
  }
  out.push('- Verify a download with `sha256sum -c SHA256SUMS`.');
  return { title: `${INFO[c].title} ${v}`, body: out.join('\n') + '\n' };
}

/** A notes file: an optional first line "# Title", then the body. */
export function splitNotes(text: string, fallbackTitle: string): { title: string; body: string } {
  const m = text.match(/^#\s+(.+)\n+/);
  return m ? { title: m[1].trim(), body: text.slice(m[0].length) } : { title: fallbackTitle, body: text };
}

/** "owner/name" from a GitHub remote URL (https or ssh). */
export function repoFromRemote(url: string): string {
  const m = url.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`origin is not a GitHub remote: ${url}`);
  return m[1];
}

/** A command line as it would be typed (for the dry run and the log). */
export function shellLine(cmd: string, args: string[], cwd?: string): string {
  const quote = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
  const line = [cmd, ...args].map(quote).join(' ');
  return cwd ? `(cd ${quote(cwd)} && ${line})` : line;
}
