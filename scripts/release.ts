#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env
// release.ts: publish firmware, configurator and simulator releases to GitHub.
//
//   ./scripts/release.ts all --dry-run          # show everything it would do, change nothing
//   ./scripts/release.ts firmware simulator     # test, build, ask, then tag, push and publish
//   ./scripts/release.ts --help
//
// For each component it:
//   1. checks: on main, nothing uncommitted in the component, logged in to gh, origin/main
//      is already in HEAD, the tag and release don't exist yet
//   2. picks the commit (the newest one touching the component's folder, or --ref) and
//      reads the version there: tag = <component>-v<version>
//   3. tests and builds in a temporary git worktree of exactly that commit
//   4. collects the files and SHA256SUMS in .release/<tag>/, writes NOTES.md
//   5. asks, then pushes main, tags, pushes the tag and creates the GitHub release
//   6. downloads the release again and checks it (sha256sum -c, --version, image header)
//
// With --dry-run, steps 1, 2 and the notes still run (they only read), and every
// command that would build, write, tag, push or publish is printed instead.
import {
  assetNames,
  type Commit,
  type Component,
  COMPONENTS,
  FLASH_LAYOUT,
  generateNotes,
  INFO,
  parseVersion,
  repoFromRemote,
  shellLine,
  splitNotes,
  tagOf,
} from './release-lib.ts';

const HELP = `Usage: ./scripts/release.ts <component>... [options]

Components: firmware, configurator, simulator, or all.

Options:
  --dry-run                 show what would run; change nothing (no build, tag, push or release)
  --ref <commit>            release this commit (one component only; default: the newest commit
                            that touches the component's folder)
  --notes <file>            release notes for one component (first line "# Title" sets the title)
  --notes <component>=<file>  notes per component (repeatable). Without notes they are generated
                            from the Conventional Commit messages since the previous release
  --draft                   create the releases as drafts (publish them on GitHub when ready)
  --skip-tests              don't run the tests before building
  --no-verify               don't download and check the release afterwards
  --yes                     don't ask before pushing and publishing
  --out <dir>               where the files go (default .release/)
  -h, --help                this text
`;

// ------------------------------------------------------------------ arguments ----

interface Options {
  components: Component[];
  dryRun: boolean;
  ref: string | null;
  notes: Partial<Record<Component, string>>;
  draft: boolean;
  skipTests: boolean;
  verify: boolean;
  yes: boolean;
  out: string;
}

function parseOptions(argv: string[]): Options {
  const o: Options = {
    components: [],
    dryRun: false,
    ref: null,
    notes: {},
    draft: false,
    skipTests: false,
    verify: true,
    yes: false,
    out: '.release',
  };
  const notes: string[] = [];
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
    else if (a === '--out') o.out = value();
    else if (a === '--notes') notes.push(value());
    else if (a === 'all') o.components.push(...COMPONENTS);
    else if ((COMPONENTS as readonly string[]).includes(a)) o.components.push(a as Component);
    else fail(`unknown argument '${a}' (see --help)`);
  }
  o.components = COMPONENTS.filter((c) => o.components.includes(c));
  if (o.components.length === 0) fail('name what to release: firmware, configurator, simulator or all (see --help)');
  if (o.ref && o.components.length > 1) fail('--ref works with one component only');
  for (const n of notes) {
    const m = n.match(/^(firmware|configurator|simulator)=(.+)$/);
    if (m) o.notes[m[1] as Component] = m[2];
    else if (o.components.length === 1) o.notes[o.components[0]] = n;
    else fail('with several components, give notes as --notes <component>=<file>');
  }
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

/** A command that builds, writes or publishes: printed in the dry run, run (and must succeed) otherwise. */
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

interface Plan {
  component: Component;
  sha: string;
  short: string;
  version: string;
  tag: string;
  /** the tag already exists on this commit (an earlier run stopped half way) */
  localTag: boolean;
  remoteTag: boolean;
  title: string;
  notes: string;
  notesFrom: string;
  dir: string;
}

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

console.log(bold(`Release ${opts.components.join(', ')} to github.com/${repo}${DRY ? ' (dry run)' : ''}\n`));
console.log(bold('Checks'));

const needTools = ['git', 'gh', 'deno', 'tar', 'zip', 'sha256sum'];
if (opts.components.includes('firmware')) needTools.push('pio');
for (const tool of needTools) {
  if ((await query('sh', ['-c', `command -v ${tool}`])) === null) problems.push(`${tool} is not installed`);
}
if (opts.components.includes('firmware')) {
  for (const path of [PIO_PYTHON, ESPTOOL, BOOT_APP0]) {
    if (!(await exists(path))) problems.push(`missing ${path} (build the firmware once with pio)`);
  }
}

const branch = await query('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') problems.push(`on branch '${branch}', not main`);
const head = (await query('git', ['rev-parse', 'HEAD']))!;

const watched = [...new Set([...opts.components.map((c) => INFO[c].dir), 'sensorframe', 'scripts'])];
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
const pushMain = remoteMain !== null && remoteMain !== head;
const remoteTags = await query('git', ['ls-remote', '--tags', 'origin']) ?? '';

const plans: Plan[] = [];
for (const c of opts.components) {
  const info = INFO[c];
  const sha = await query('git', ['rev-parse', '--verify', `${opts.ref ?? (await newestCommit(info.dir))}^{commit}`]);
  if (!sha) {
    problems.push(`${c}: commit ${opts.ref} not found`);
    continue;
  }
  if ((await query('git', ['merge-base', '--is-ancestor', sha, 'HEAD'])) === null) {
    problems.push(`${c}: ${sha.slice(0, 7)} is not on main`);
  }
  const version = parseVersion(c, (await query('git', ['show', `${sha}:${info.versionFile}`])) ?? '');
  const headVersion = parseVersion(c, await Deno.readTextFile(info.versionFile));
  if (headVersion !== version) warnings.push(`${c}: HEAD says ${headVersion}, the released commit says ${version}`);
  const tag = tagOf(c, version);
  const localSha = await query('git', ['rev-list', '-n', '1', `refs/tags/${tag}`]);
  const remoteLine = remoteTags.split('\n').find((l) => l.endsWith(`refs/tags/${tag}^{}`));
  const remoteSha = remoteLine?.split(/\s+/)[0] ?? null;
  if (localSha && localSha !== sha) problems.push(`${c}: tag ${tag} already exists on ${localSha.slice(0, 7)}`);
  if (remoteSha && remoteSha !== sha) {
    problems.push(`${c}: tag ${tag} already exists on origin at ${remoteSha.slice(0, 7)}`);
  }
  if ((await query('gh', ['release', 'view', tag, '--repo', repo])) !== null) {
    problems.push(`${c}: release ${tag} already exists (bump the version in ${info.versionFile})`);
  }
  const previousTag = await previousRelease(c, tag, sha);
  let notes: { title: string; body: string };
  let notesFrom: string;
  const notesFile = opts.notes[c];
  if (notesFile) {
    if (!(await exists(notesFile))) problems.push(`${c}: notes file ${notesFile} not found`);
    notes = splitNotes(await Deno.readTextFile(notesFile).catch(() => ''), `${info.title} ${version}`);
    notesFrom = notesFile;
  } else {
    notes = generateNotes({
      component: c,
      version,
      repo,
      previousTag,
      commits: await commitsSince(previousTag, sha, info.dir),
    });
    notesFrom = `generated from the commits since ${previousTag ?? 'the start'}`;
  }
  plans.push({
    component: c,
    sha,
    short: sha.slice(0, 7),
    version,
    tag,
    localTag: localSha === sha,
    remoteTag: remoteSha === sha,
    title: notes.title,
    notes: notes.body,
    notesFrom,
    dir: `${opts.out}/${tag}`,
  });
}

async function newestCommit(dir: string): Promise<string> {
  return (await query('git', ['log', '-1', '--format=%H', 'HEAD', '--', `${dir}/`])) ?? 'HEAD';
}

/** The newest earlier release tag of this component that is an ancestor of `sha`. */
async function previousRelease(c: Component, tag: string, sha: string): Promise<string | null> {
  const tags = (await query('git', ['tag', '-l', `${c}-v*`, '--sort=-v:refname']))?.split('\n').filter(Boolean) ?? [];
  for (const t of tags) {
    if (t === tag) continue;
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
for (const p of plans) {
  console.log(`  ${p.tag.padEnd(22)} commit ${p.short}  "${p.title}"${opts.draft ? ' (draft)' : ''}`);
  console.log(`  ${' '.repeat(22)} ${dim(`notes ${p.notesFrom}`)}`);
  console.log(`  ${' '.repeat(22)} ${dim(`files ${assetNames(p.component, p.version).join(', ')}`)}`);
}
if (pushMain) console.log(`  push main ${remoteMain?.slice(0, 7)}..${head.slice(0, 7)} to origin`);

if (problems.length && !DRY) {
  console.error(`\nrelease: stopped, ${problems.length} problem(s) above. Nothing was changed.`);
  Deno.exit(1);
}

// ---------------------------------------------------------------------- build ----

const worktrees: string[] = [];
try {
  for (const p of plans) await build(p);

  // ------------------------------------------------------------------- publish ----
  console.log(bold('\nPublish'));
  if (!DRY && !opts.yes) {
    const answer = prompt(`Push and publish ${plans.map((p) => p.tag).join(', ')} to github.com/${repo}? [y/N]`);
    if (!/^y(es)?$/i.test(answer ?? '')) {
      console.log(`Not published. The files are in ${opts.out}/; nothing was tagged or pushed.`);
      Deno.exit(0);
    }
  }
  if (pushMain) await run('git', ['push', 'origin', 'main']);
  for (const p of plans) await publish(p);

  if (opts.verify) {
    console.log(bold('\nVerify'));
    for (const p of plans) await verify(p);
  }
} finally {
  for (const wt of worktrees) await run('git', ['worktree', 'remove', '--force', wt]).catch(() => {});
}

console.log(bold(`\n${DRY ? 'Dry run finished: nothing was changed.' : 'Done.'}`));
for (const p of plans) console.log(`  https://github.com/${repo}/releases/tag/${p.tag}`);
if (DRY && problems.length) {
  console.log(`\n${problems.length} problem(s) above would stop a real run.`);
  Deno.exit(1);
}

// ------------------------------------------------------------------- steps ----

async function build(p: Plan): Promise<void> {
  const c = p.component;
  const wt = `${opts.out}/worktrees/${c}`;
  const src = `${wt}/${INFO[c].dir}`;
  console.log(bold(`\nBuild ${p.tag} from ${p.short}`));
  if (!DRY) {
    await Deno.remove(p.dir, { recursive: true }).catch(() => {});
    await Deno.remove(wt, { recursive: true }).catch(() => {});
    await Deno.mkdir(p.dir, { recursive: true });
    await query('git', ['worktree', 'prune']);
  }
  await run('git', ['worktree', 'add', '--detach', wt, p.sha]);
  worktrees.push(wt);

  if (c === 'firmware') {
    if (!opts.skipTests) await run('pio', ['test', '-e', 'native', '-d', src]);
    await run('pio', ['run', '-e', 'esp32dev', '-d', src]);
    await packageFirmware(p, `${src}/.pio/build/esp32dev`);
  } else {
    if (!opts.skipTests) await run('deno', ['task', 'test'], src);
    if (c === 'simulator') await run('deno', ['task', 'web:build'], src); // the binary embeds the web UI
    await run('deno', ['task', 'compile'], src);
    for (const name of assetNames(c, p.version)) await run('cp', [`${src}/dist/${name}`, `${p.dir}/${name}`]);
  }
  await writeFile(`${p.dir}/NOTES.md`, p.notes);
  if (DRY) {
    console.log(dim(`  ---- ${p.dir}/NOTES.md (title: ${p.title}) ----`));
    console.log(p.notes.replace(/^/gm, '  | '));
  } else {
    for (const name of assetNames(c, p.version)) {
      if (!(await exists(`${p.dir}/${name}`))) throw new Error(`the build did not produce ${name}`);
    }
  }
}

/** bootloader, partitions, boot_app0, app + one merged image, a tarball of all, SHA256SUMS. */
async function packageFirmware(p: Plan, build: string): Promise<void> {
  const [merged, tarball] = assetNames('firmware', p.version);
  const folder = tarball.replace(/\.tar\.gz$/, '');
  const stage = `${p.dir}/${folder}`;
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
  await run('cp', [`${stage}/${merged}`, `${p.dir}/${merged}`]);
  await run('tar', ['-czf', tarball, folder], p.dir);
  await run('rm', ['-r', stage]);
  await run('sh', ['-c', `sha256sum ${merged} ${tarball} > SHA256SUMS`], p.dir);
}

async function publish(p: Plan): Promise<void> {
  if (!p.localTag) await run('git', ['tag', '-a', p.tag, p.sha, '-m', p.title]);
  if (!p.remoteTag) await run('git', ['push', 'origin', `refs/tags/${p.tag}`]);
  const assets = assetNames(p.component, p.version).map((name) => `${p.dir}/${name}`);
  await run('gh', [
    'release',
    'create',
    p.tag,
    '--repo',
    repo,
    '--verify-tag',
    '--title',
    p.title,
    '--notes-file',
    `${p.dir}/NOTES.md`,
    ...(opts.draft ? ['--draft'] : []),
    ...assets,
  ]);
}

/** Download what GitHub now serves and check it like a user would. */
async function verify(p: Plan): Promise<void> {
  const dir = `${opts.out}/verify/${p.tag}`;
  if (!DRY) await Deno.remove(dir, { recursive: true }).catch(() => {});
  await run('gh', ['release', 'download', p.tag, '--repo', repo, '--dir', dir]);
  await run('sha256sum', ['-c', 'SHA256SUMS'], dir);
  if (p.component === 'firmware') {
    const merged = assetNames('firmware', p.version)[0];
    if (DRY) console.log(`  ${dim('would check')} ${merged} has an ESP32 image header (0xE9) at 0x1000`);
    else {
      const image = await Deno.readFile(`${dir}/${merged}`);
      if (image[0x1000] !== 0xe9) throw new Error(`${merged}: no ESP32 image at 0x1000`);
      console.log(`  ✔ ${merged}: bootloader image at 0x1000, ${image.length} bytes`);
    }
    return;
  }
  if (Deno.build.os !== 'linux' || Deno.build.arch !== 'x86_64') return; // only the host's own binary runs here
  const archive = assetNames(p.component, p.version)[0]; // linux-x64
  const exe = p.component === 'configurator' ? 'hour-meter' : 'hour-meter-sim';
  await run('tar', ['-xzf', archive], dir);
  const bin = `${dir}/${archive.replace(/\.tar\.gz$/, '')}/${exe}`;
  if (DRY) console.log(`  ${dim('would check')} ${exe} --version prints ${p.version}`);
  else {
    const out = await query(bin, ['--version']);
    if (!out?.includes(p.version)) throw new Error(`${exe} --version printed '${out}', expected ${p.version}`);
    console.log(`  ✔ ${exe} --version: ${out}`);
  }
}
