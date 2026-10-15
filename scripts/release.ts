#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
// release.ts: publish one GitHub release (tag v<VERSION>) with the firmware, the
// configurator and the simulator, each built from the same commit and keeping its
// own version (kFirmwareVersion, TOOL_VERSION, SIM_VERSION).
//
//   ./scripts/release.ts --dry-run              # show everything it would do, change nothing
//   ./scripts/release.ts                        # test, build, ask, then tag, push and publish
//   ./scripts/release.ts --bump minor           # first raise VERSION (1.0.0 -> 1.1.0) in a commit
//   ./scripts/release.ts --help
//
// Steps:
//   1. checks: on main, nothing uncommitted in the released folders, logged in to gh,
//      origin/main is already in HEAD, the tag and release don't exist yet
//   2. reads VERSION and the three component versions at the commit (HEAD or --ref)
//   3. tests and builds all three in a temporary git worktree of exactly that commit
//   4. collects every file, one SHA256SUMS and NOTES.md in .release/v<VERSION>/
//   5. asks, then pushes main, tags, pushes the tag and creates the GitHub release
//   6. downloads the release again and checks it (sha256sum -c, --version, image header)
//
// With --dry-run, steps 1, 2 and the notes still run (they only read), and every
// command that would commit, build, write, tag, push or publish is printed instead.
import {
  assetNames,
  type Bump,
  bumpVersion,
  type Commit,
  type Component,
  type ComponentNotes,
  COMPONENTS,
  FLASH_LAYOUT,
  generateNotes,
  INFO,
  parseProjectVersion,
  parseVersion,
  releaseTitle,
  repoFromRemote,
  shellLine,
  splitNotes,
  tagOf,
  VERSION_FILE,
} from './release-lib.ts';

const HELP = `Usage: ./scripts/release.ts [options]

Publishes one release, tag v<VERSION>, with the firmware, configurator and simulator.

Options:
  --dry-run          show what would run; change nothing (no commit, build, tag, push or release)
  --bump <part>      raise VERSION first (major, minor or patch) and commit it
  --ref <commit>     release this commit instead of HEAD (it must be on main)
  --notes <file>     your own release notes (first line "# Title" sets the title). Without it they
                     are generated from the Conventional Commit messages since the previous release
  --draft            create the release as a draft (publish it on GitHub when ready)
  --skip-tests       don't run the tests before building
  --no-verify        don't download and check the release afterwards
  --yes              don't ask before pushing and publishing
  --out <dir>        where the files go (default .release/)
  -h, --help         this text
`;

// ------------------------------------------------------------------ arguments ----

interface Options {
  dryRun: boolean;
  bump: Bump | null;
  ref: string | null;
  notes: string | null;
  draft: boolean;
  skipTests: boolean;
  verify: boolean;
  yes: boolean;
  out: string;
}

function parseOptions(argv: string[]): Options {
  const o: Options = {
    dryRun: false,
    bump: null,
    ref: null,
    notes: null,
    draft: false,
    skipTests: false,
    verify: true,
    yes: false,
    out: '.release',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') {
      console.log(HELP);
      Deno.exit(0);
    } else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--draft') o.draft = true;
    else if (a === '--skip-tests') o.skipTests = true;
    else if (a === '--no-verify') o.verify = false;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--ref') o.ref = value();
    else if (a === '--notes') o.notes = value();
    else if (a === '--out') o.out = value();
    else if (a === '--bump') {
      const b = value();
      if (b !== 'major' && b !== 'minor' && b !== 'patch') fail('--bump takes major, minor or patch');
      o.bump = b;
    } else fail(`unknown argument '${a}' (see --help)`);
  }
  if (o.bump && o.ref) fail('--bump commits on top of HEAD, so it does not go with --ref');
  return o;
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  Deno.exit(2);
}

// -------------------------------------------------------------------- running ----

const opts = parseOptions(Deno.args);
const DRY = opts.dryRun;
const bold = (s: string) => Deno.stdout.isTerminal() ? `\x1b[1m${s}\x1b[0m` : s;
const dim = (s: string) => Deno.stdout.isTerminal() ? `\x1b[2m${s}\x1b[0m` : s;

/** A read-only command: runs in the dry run too. Returns trimmed stdout, or null on a non-zero exit. */
async function query(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  try {
    const r = await new Deno.Command(cmd, { args, cwd, stdout: 'piped', stderr: 'piped' }).output();
    return r.success ? new TextDecoder().decode(r.stdout).trim() : null;
  } catch {
    return null; // not installed
  }
}

/** A command that commits, builds, writes or publishes: printed in the dry run, run (and must succeed) otherwise. */
async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  const line = shellLine(cmd, args, cwd);
  if (DRY) {
    console.log(`  ${dim('would run')} $ ${line}`);
    return;
  }
  console.log(`  $ ${line}`);
  const { code } = await new Deno.Command(cmd, { args, cwd, stdout: 'inherit', stderr: 'inherit' }).output();
  if (code !== 0) throw new Error(`failed (exit ${code}): ${line}`);
}

/** A file written by the script itself: shown in the dry run. */
async function writeFile(path: string, text: string): Promise<void> {
  if (DRY) {
    console.log(`  ${dim('would write')} ${path}`);
    return;
  }
  await Deno.writeTextFile(path, text);
}

const exists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ preflight ----

const root = await query('git', ['rev-parse', '--show-toplevel']);
if (!root) fail('run it inside the repository');
Deno.chdir(root);
const HOME = Deno.env.get('HOME') ?? '';
const PIO = `${HOME}/.platformio`;
const PIO_PYTHON = `${PIO}/penv/bin/python`;
const ESPTOOL = `${PIO}/packages/tool-esptoolpy/esptool.py`;
const BOOT_APP0 = `${PIO}/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin`;

const problems: string[] = [];
const warnings: string[] = [];

const remoteUrl = await query('git', ['remote', 'get-url', 'origin']);
if (!remoteUrl) fail('no git remote named origin');
const repo = repoFromRemote(remoteUrl);

console.log(bold(`Release to github.com/${repo}${DRY ? ' (dry run)' : ''}\n`));
console.log(bold('Checks'));

for (const tool of ['git', 'gh', 'deno', 'pio', 'tar', 'zip', 'sha256sum']) {
  if ((await query('sh', ['-c', `command -v ${tool}`])) === null) problems.push(`${tool} is not installed`);
}
for (const path of [PIO_PYTHON, ESPTOOL, BOOT_APP0]) {
  if (!(await exists(path))) problems.push(`missing ${path} (build the firmware once with pio)`);
}

const branch = await query('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') problems.push(`on branch '${branch}', not main`);
const head = (await query('git', ['rev-parse', 'HEAD']))!;

const watched = [...COMPONENTS.map((c) => INFO[c].dir), 'sensorframe', 'scripts', VERSION_FILE];
const dirty = await query('git', ['status', '--porcelain', '--', ...watched]);
if (dirty) problems.push(`uncommitted changes (commit or stash them first):\n${dirty.replace(/^/gm, '      ')}`);
const otherDirty = await query('git', ['status', '--porcelain', '--', '.', ...watched.map((d) => `:!${d}`)]);
if (otherDirty) {
  warnings.push(`uncommitted changes elsewhere (not released, left alone):\n${otherDirty.replace(/^/gm, '      ')}`);
}

if ((await query('gh', ['auth', 'status'])) === null) problems.push('gh is not logged in: run `gh auth login`');

const remoteMain = (await query('git', ['ls-remote', 'origin', 'refs/heads/main']))?.split(/\s+/)[0] ?? null;
if (remoteMain === null) problems.push('cannot reach origin (git ls-remote failed)');
else if ((await query('git', ['merge-base', '--is-ancestor', remoteMain, 'HEAD'])) === null) {
  problems.push('origin/main has commits this checkout lacks: git pull first');
}
const pushMain = opts.bump !== null || (remoteMain !== null && remoteMain !== head);

// The commit and the project version.
const baseSha = await query('git', ['rev-parse', '--verify', `${opts.ref ?? 'HEAD'}^{commit}`]);
if (!baseSha) fail(`commit ${opts.ref} not found`);
if ((await query('git', ['merge-base', '--is-ancestor', baseSha, 'HEAD'])) === null) {
  problems.push(`${baseSha.slice(0, 7)} is not on main`);
}
const versionText = await query('git', ['show', `${baseSha}:${VERSION_FILE}`]);
let version = '0.0.0';
if (versionText === null) {
  problems.push(`no committed ${VERSION_FILE} file at ${baseSha.slice(0, 7)}: create one (echo 1.0.0 > VERSION)`);
} else {
  try {
    version = parseProjectVersion(versionText);
  } catch (e) {
    problems.push((e as Error).message);
  }
}
if (opts.bump) version = bumpVersion(version, opts.bump);
const tag = tagOf(version);
const outDir = `${opts.out}/${tag}`;

const tagSha = await query('git', ['rev-list', '-n', '1', `refs/tags/${tag}`]);
const remoteTagLine = (await query('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`])) ?? '';
const remoteTagSha = remoteTagLine.split(/\s+/)[0] || null;
const localTag = !opts.bump && tagSha === baseSha; // an earlier run stopped half way: reuse the tag
const remoteTag = !opts.bump && remoteTagSha === baseSha;
if (tagSha && !localTag) {
  problems.push(`tag ${tag} already exists on ${tagSha.slice(0, 7)}: use --bump patch|minor|major`);
}
if (remoteTagSha && !remoteTag) problems.push(`tag ${tag} already exists on origin: use --bump patch|minor|major`);
if ((await query('gh', ['release', 'view', tag, '--repo', repo])) !== null) {
  problems.push(`release ${tag} already exists: use --bump patch|minor|major`);
}

// The component versions, and what changed since the previous release.
const previousTag = await previousRelease(baseSha);
const versions = {} as Record<Component, string>;
const parts: ComponentNotes[] = [];
for (const c of COMPONENTS) {
  const v = parseVersion(c, (await query('git', ['show', `${baseSha}:${INFO[c].versionFile}`])) ?? '');
  versions[c] = v;
  const since = previousTag ?? (await previousComponentTag(c, baseSha)); // before the first v… release
  const previousVersion = since
    ? since.startsWith('v')
      ? parseVersion(c, (await query('git', ['show', `${since}:${INFO[c].versionFile}`])) ?? '')
      : since.replace(`${c}-v`, '')
    : null;
  const commits = await commitsSince(since, baseSha, INFO[c].dir);
  if (commits.length && previousVersion === v) {
    warnings.push(`${c}: changed since ${since} but still ${v} (bump it in ${INFO[c].versionFile})`);
  }
  parts.push({ component: c, version: v, previousVersion, commits });
}

let notes = generateNotes({ version, repo, previousTag, components: parts });
let notesFrom = `generated from the commits since ${previousTag ?? "each part's last release"}`;
if (opts.notes) {
  if (!(await exists(opts.notes))) problems.push(`notes file ${opts.notes} not found`);
  notes = splitNotes(await Deno.readTextFile(opts.notes).catch(() => ''), releaseTitle(version, versions));
  notesFrom = opts.notes;
}
const assets = COMPONENTS.flatMap((c) => assetNames(c, versions[c]));

/** The newest v… release tag that is an ancestor of `sha`. */
async function previousRelease(sha: string): Promise<string | null> {
  const tags = (await query('git', ['tag', '-l', 'v*', '--sort=-v:refname']))?.split('\n').filter(Boolean) ?? [];
  for (const t of tags) {
    if (t === tag || !/^v\d+\.\d+\.\d+$/.test(t)) continue;
    if ((await query('git', ['merge-base', '--is-ancestor', t, sha])) !== null) return t;
  }
  return null;
}

/** The newest old-style <component>-v… tag that is an ancestor of `sha`. */
async function previousComponentTag(c: Component, sha: string): Promise<string | null> {
  const tags = (await query('git', ['tag', '-l', `${c}-v*`, '--sort=-v:refname']))?.split('\n').filter(Boolean) ?? [];
  for (const t of tags) {
    if ((await query('git', ['merge-base', '--is-ancestor', t, sha])) !== null) return t;
  }
  return null;
}

async function commitsSince(previous: string | null, sha: string, dir: string): Promise<Commit[]> {
  const range = previous ? `${previous}..${sha}` : sha;
  const raw = await query('git', ['log', '--reverse', '--format=%s%x1f%b%x1e', range, '--', `${dir}/`]) ?? '';
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [subject, body = ''] = r.split('\x1f');
    return { subject: subject.trim(), body };
  });
}

for (const w of warnings) console.log(`  ! ${w}`);
for (const p of problems) console.log(`  ✘ ${p}`);
if (problems.length === 0) console.log('  ✔ ready');

console.log(bold('\nPlan'));
console.log(`  ${tag}${opts.draft ? ' (draft)' : ''}  "${notes.title}"`);
console.log(
  `  commit        ${
    opts.bump ? `a new commit on ${head.slice(0, 7)} setting ${VERSION_FILE} to ${version}` : baseSha.slice(0, 7)
  }`,
);
for (const p of parts) {
  const changed = p.previousVersion === null
    ? 'first release'
    : p.commits.length
    ? `was ${p.previousVersion}`
    : 'unchanged';
  console.log(`  ${p.component.padEnd(13)} ${p.version.padEnd(7)} ${dim(changed)}`);
}
console.log(`  notes         ${dim(notesFrom)}`);
console.log(`  files         ${dim(`${assets.length} + SHA256SUMS in ${outDir}/`)}`);
if (pushMain) console.log('  push main to origin');

if (problems.length && !DRY) {
  console.error(`\nrelease: stopped, ${problems.length} problem(s) above. Nothing was changed.`);
  Deno.exit(1);
}

// ------------------------------------------------------------------ bump + build ----

let sha = baseSha;
const wt = `${opts.out}/worktree`;
let worktree = false;
let declined = false;
try {
  if (opts.bump) {
    console.log(bold(`\nBump ${VERSION_FILE} to ${version}`));
    await writeFile(VERSION_FILE, `${version}\n`);
    await run('git', ['commit', '-m', `chore(release): ${tag}`, '--', VERSION_FILE]);
    if (!DRY) sha = (await query('git', ['rev-parse', 'HEAD']))!;
  }
  await build();

  // ------------------------------------------------------------------- publish ----
  console.log(bold('\nPublish'));
  if (!DRY && !opts.yes) {
    const answer = prompt(`Push and publish ${tag} to github.com/${repo}? [y/N]`);
    declined = !/^y(es)?$/i.test(answer ?? '');
  }
  if (!declined) {
    if (pushMain) await run('git', ['push', 'origin', 'main']);
    if (!localTag) await run('git', ['tag', '-a', tag, commitArg(), '-m', notes.title]);
    if (!remoteTag) await run('git', ['push', 'origin', `refs/tags/${tag}`]);
    await run('gh', [
      'release',
      'create',
      tag,
      '--repo',
      repo,
      '--verify-tag',
      '--title',
      notes.title,
      '--notes-file',
      `${outDir}/NOTES.md`,
      ...(opts.draft ? ['--draft'] : []),
      ...[...assets, 'SHA256SUMS'].map((name) => `${outDir}/${name}`),
    ]);
    if (opts.verify) await verify();
  }
} finally {
  // (also after a failure: the files stay in .release/<tag>/, the worktree does not)
  if (worktree) await run('git', ['worktree', 'remove', '--force', wt]).catch(() => {});
}

if (declined) {
  console.log(`\nNot published. The files are in ${outDir}/; nothing was tagged or pushed.`);
  if (opts.bump) console.log(`The ${VERSION_FILE} bump is committed locally: drop it with git reset --hard HEAD~1.`);
} else {
  console.log(bold(`\n${DRY ? 'Dry run finished: nothing was changed.' : 'Done.'}`));
  console.log(`  https://github.com/${repo}/releases/tag/${tag}`);
}
if (DRY && problems.length) {
  console.log(`\n${problems.length} problem(s) above would stop a real run.`);
  Deno.exit(1);
}

// ------------------------------------------------------------------- steps ----

/** The commit to build and tag, as shown in the dry run before the bump commit exists. */
function commitArg(): string {
  return DRY && opts.bump ? '<bump-commit>' : sha;
}

async function build(): Promise<void> {
  console.log(bold(`\nBuild ${tag} from ${DRY && opts.bump ? 'the bump commit' : sha.slice(0, 7)}`));
  if (!DRY) {
    await Deno.remove(outDir, { recursive: true }).catch(() => {});
    await Deno.remove(wt, { recursive: true }).catch(() => {});
    await Deno.mkdir(outDir, { recursive: true });
    await query('git', ['worktree', 'prune']);
  }
  await run('git', ['worktree', 'add', '--detach', wt, commitArg()]);
  worktree = true;

  console.log(bold(`\n  firmware ${versions.firmware}`));
  const fw = `${wt}/${INFO.firmware.dir}`;
  if (!opts.skipTests) await run('pio', ['test', '-e', 'native', '-d', fw]);
  await run('pio', ['run', '-e', 'esp32dev', '-d', fw]);
  await packageFirmware(`${fw}/.pio/build/esp32dev`);

  for (const c of ['configurator', 'simulator'] as const) {
    console.log(bold(`\n  ${c} ${versions[c]}`));
    const src = `${wt}/${INFO[c].dir}`;
    if (!opts.skipTests) await run('deno', ['task', 'test'], src);
    if (c === 'simulator') await run('deno', ['task', 'web:build'], src); // the binary embeds the web UI
    await run('deno', ['task', 'compile'], src);
    for (const name of assetNames(c, versions[c])) await run('cp', [`${src}/dist/${name}`, `${outDir}/${name}`]);
  }

  console.log(bold('\n  checksums and notes'));
  await run('sh', ['-c', `sha256sum ${assets.join(' ')} > SHA256SUMS`], outDir);
  await writeFile(`${outDir}/NOTES.md`, notes.body);
  if (DRY) {
    console.log(dim(`  ---- ${outDir}/NOTES.md (title: ${notes.title}) ----`));
    console.log(notes.body.replace(/^/gm, '  | '));
  } else {
    for (const name of [...assets, 'SHA256SUMS']) {
      if (!(await exists(`${outDir}/${name}`))) throw new Error(`the build did not produce ${name}`);
    }
  }
}

/** bootloader, partitions, boot_app0, app + one merged image, and a tarball of all of them. */
async function packageFirmware(build: string): Promise<void> {
  const [merged, tarball] = assetNames('firmware', versions.firmware);
  const folder = tarball.replace(/\.tar\.gz$/, '');
  const stage = `${outDir}/${folder}`;
  await run('mkdir', ['-p', stage]);
  for (const { file } of FLASH_LAYOUT) {
    await run('cp', [file === 'boot_app0.bin' ? BOOT_APP0 : `${build}/${file}`, stage]);
  }
  await run(PIO_PYTHON, [
    ESPTOOL,
    '--chip',
    'esp32',
    'merge_bin',
    '-o',
    `${stage}/${merged}`,
    '--flash_mode',
    'dio',
    '--flash_freq',
    '40m',
    '--flash_size',
    '4MB',
    ...FLASH_LAYOUT.flatMap(({ offset, file }) => [offset, `${stage}/${file}`]),
  ]);
  await run('cp', [`${stage}/${merged}`, `${outDir}/${merged}`]);
  await run('tar', ['-czf', tarball, folder], outDir);
  await run('rm', ['-r', stage]);
}

/** Download what GitHub now serves and check it like a user would. */
async function verify(): Promise<void> {
  console.log(bold('\nVerify'));
  const dir = `${opts.out}/verify/${tag}`;
  if (!DRY) await Deno.remove(dir, { recursive: true }).catch(() => {});
  await run('gh', ['release', 'download', tag, '--repo', repo, '--dir', dir]);
  await run('sha256sum', ['-c', 'SHA256SUMS'], dir);
  const merged = assetNames('firmware', versions.firmware)[0];
  if (DRY) console.log(`  ${dim('would check')} ${merged} has an ESP32 image header (0xE9) at 0x1000`);
  else {
    const image = await Deno.readFile(`${dir}/${merged}`);
    if (image[0x1000] !== 0xe9) throw new Error(`${merged}: no ESP32 image at 0x1000`);
    console.log(`  ✔ ${merged}: bootloader image at 0x1000, ${image.length} bytes`);
  }
  if (Deno.build.os !== 'linux' || Deno.build.arch !== 'x86_64') return; // only the host's own binaries run here
  for (const c of ['configurator', 'simulator'] as const) {
    const archive = assetNames(c, versions[c])[0]; // linux-x64
    const exe = c === 'configurator' ? 'hour-meter' : 'hour-meter-sim';
    await run('tar', ['-xzf', archive], dir);
    if (DRY) console.log(`  ${dim('would check')} ${exe} --version prints ${versions[c]}`);
    else {
      const out = await query(`${dir}/${archive.replace(/\.tar\.gz$/, '')}/${exe}`, ['--version']);
      if (!out?.includes(versions[c])) throw new Error(`${exe} --version printed '${out}', expected ${versions[c]}`);
      console.log(`  ✔ ${exe} --version: ${out}`);
    }
  }
}
