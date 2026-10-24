// release-lib.ts: the pure part of scripts/release.ts. One release (tag v<VERSION>)
// carries all three components, each with its own version: where those versions
// live, which files the release carries, and the generated release notes.
// No I/O here, so it is tested on its own (release-lib.test.ts).

export type Component = 'firmware' | 'configurator' | 'simulator';

export const COMPONENTS: readonly Component[] = ['firmware', 'configurator', 'simulator'];

export interface ComponentInfo {
  /** source folder (commits touching it belong to this component) */
  dir: string;
  /** file that holds the version, relative to the repo root */
  versionFile: string;
  /** how the notes name it */
  label: string;
}

export const INFO: Record<Component, ComponentInfo> = {
  firmware: { dir: 'esp32', versionFile: 'esp32/lib/App/src/Protocol.h', label: 'Firmware' },
  configurator: {
    dir: 'configurator',
    versionFile: 'configurator/src/version.ts',
    label: 'Configurator (`hour-meter`)',
  },
  simulator: { dir: 'simulator', versionFile: 'simulator/main.ts', label: 'Simulator (`hour-meter-sim`)' },
};

/** The project version file (the release tag is v<its content>). */
export const VERSION_FILE = 'VERSION';

/** Platforms `deno task compile` builds, as they appear in archive names. */
export const TOOL_PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64'] as const;

const PLATFORM_LABEL: Record<(typeof TOOL_PLATFORMS)[number], string> = {
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux arm64 (Raspberry Pi 4/5 64-bit)',
  'macos-x64': 'macOS Intel',
  'macos-arm64': 'macOS Apple Silicon',
  'windows-x64': 'Windows x64',
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

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

/** The project version from the VERSION file ("1.0.0", whitespace ignored). */
export function parseProjectVersion(text: string): string {
  const v = text.trim();
  if (!SEMVER.test(v)) throw new Error(`${VERSION_FILE} must hold a version like 1.0.0, not '${v}'`);
  return v;
}

export type Bump = 'major' | 'minor' | 'patch';

export function bumpVersion(v: string, bump: Bump): string {
  const [, a, b, c] = v.match(SEMVER)!.map(Number);
  return bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
}

export const tagOf = (version: string) => `v${version}`;

/** Files one component adds to the release (without SHA256SUMS: there is one for the whole release). */
export function assetNames(c: Component, version: string): string[] {
  if (c === 'firmware') {
    return [`hour-meter-${version}-esp32dev-merged.bin`, `hour-meter-firmware-${version}-esp32dev.tar.gz`];
  }
  const base = c === 'configurator' ? 'hour-meter' : 'hour-meter-sim';
  return TOOL_PLATFORMS.map((p) => `${base}-${version}-${p}.${p.startsWith('windows') ? 'zip' : 'tar.gz'}`);
}

/** Flash offsets of the ESP32 images (Arduino core, 4 MB, esp32/partitions.csv). */
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
    if (m && ['build', 'chore', 'ci', 'style', 'test'].includes(m[1])) continue; // not what users run
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

/** Commits that change what users run (not docs, build scripts, tests or chores): they need a new version. */
export function needsBump(commits: Commit[]): boolean {
  return commits.some((c) => {
    const type = c.subject.match(/^(\w+)(?:\([^)]*\))?!?:/)?.[1];
    return type === undefined || !['docs', 'build', 'chore', 'ci', 'style', 'test'].includes(type);
  });
}

export interface ComponentNotes {
  component: Component;
  version: string;
  /** the version in the previous release, null if this is its first */
  previousVersion: string | null;
  commits: Commit[];
}

export interface NotesInput {
  version: string;
  repo: string;
  /** the previous release's tag (v… or an old per-component tag), for the compare link */
  previousTag: string | null;
  components: ComponentNotes[];
}

export function releaseTitle(version: string, versions: Record<Component, string>): string {
  return `Hour meter ${version}: firmware ${versions.firmware}, configurator ${versions.configurator}, simulator ${versions.simulator}`;
}

/** Release notes generated from the commits, in the style of the earlier releases. */
export function generateNotes(n: NotesInput): { title: string; body: string } {
  const versions = Object.fromEntries(n.components.map((c) => [c.component, c.version])) as Record<Component, string>;
  const out: string[] = [
    `One release with everything for the ESP32 hour meter. Each part keeps its own version.`,
    '',
    '| Part | Version | Changed |',
    '|---|---|---|',
    ...n.components.map((c) =>
      `| ${INFO[c.component].label} | ${c.version} | ${
        c.previousVersion === null ? 'new' : c.commits.length ? `yes (was ${c.previousVersion})` : 'no'
      } |`
    ),
  ];
  for (const c of n.components) {
    const assets = assetNames(c.component, c.version);
    out.push('', `## ${INFO[c.component].label} ${c.version}`, '');
    if (c.component === 'firmware') {
      out.push(
        '| File | What |',
        '|---|---|',
        `| \`${assets[0]}\` | One image, flash at \`0x0\` |`,
        `| \`${assets[1]}\` | The separate images (${
          FLASH_LAYOUT.map((l) => `${l.file} \`${l.offset}\``).join(', ')
        }) |`,
        '',
        '```bash',
        `esptool.py --chip esp32 --port /dev/ttyUSB0 --baud 921600 write_flash 0x0 ${assets[0]}`,
        '```',
      );
    } else {
      const exe = c.component === 'configurator' ? './hour-meter --demo' : './hour-meter-sim --web';
      out.push(
        '| Platform | File |',
        '|---|---|',
        ...TOOL_PLATFORMS.map((p, i) => `| ${PLATFORM_LABEL[p]} | \`${assets[i]}\` |`),
        '',
        '```bash',
        `tar xzf ${assets[0]} && cd ${assets[0].replace(/\.tar\.gz$/, '')} && ${exe}`,
        '```',
      );
    }
    const changes = changeList(c.component, c.commits);
    if (changes.length) out.push('', '### Changes', ...changes);
    else out.push('', `No changes since the previous release.`);
  }
  out.push('', '## Notes');
  if (n.previousTag) {
    out.push(`- Full list: https://github.com/${n.repo}/compare/${n.previousTag}...${tagOf(n.version)}`);
  }
  out.push('- Verify a download with `sha256sum -c SHA256SUMS` (it lists every file in this release).');
  return { title: releaseTitle(n.version, versions), body: out.join('\n') + '\n' };
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
