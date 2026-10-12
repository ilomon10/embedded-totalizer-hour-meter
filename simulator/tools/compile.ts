// compile.ts: build the standalone release binaries (no Deno needed to run them).
//
//   deno task compile              # every target into dist/
//   deno task compile linux-x64    # one target
//
// The codec is loaded at runtime through createRequire, so it must be listed
// with --include or the binary cannot find it.
import { SIM_VERSION } from '../main.ts';

const TARGETS: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'macos-x64': 'x86_64-apple-darwin',
  'macos-arm64': 'aarch64-apple-darwin',
  'windows-x64': 'x86_64-pc-windows-msvc',
};
const INCLUDES = ['../sensorframe/js/index.js', '../sensorframe/js/src'];
const PERMISSIONS = ['--allow-read', '--allow-run=socat', '--allow-net'];
const OUT = 'dist';

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  const { code } = await new Deno.Command(cmd, { args, cwd, stdout: 'inherit', stderr: 'inherit' }).output();
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${code})`);
}

async function build(name: string, target: string): Promise<string> {
  const exe = target.includes('windows') ? 'hour-meter-sim.exe' : 'hour-meter-sim';
  const dir = `${OUT}/hour-meter-sim-${SIM_VERSION}-${name}`;
  await Deno.mkdir(dir, { recursive: true });
  const includes = INCLUDES.flatMap((path) => ['--include', path]);
  await run('deno', ['compile', ...PERMISSIONS, ...includes, '--target', target, '-o', `${dir}/${exe}`, 'main.ts']);
  await Deno.copyFile('README.md', `${dir}/README.md`);
  const base = dir.slice(OUT.length + 1);
  if (target.includes('windows')) {
    await run('zip', ['-qr', `${base}.zip`, base], OUT);
    return `${base}.zip`;
  }
  await run('tar', ['-czf', `${base}.tar.gz`, base], OUT);
  return `${base}.tar.gz`;
}

async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await Deno.readFile(path));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const only = Deno.args[0];
const chosen = Object.entries(TARGETS).filter(([name]) => !only || name === only);
if (chosen.length === 0) throw new Error(`unknown target '${only}' (use: ${Object.keys(TARGETS).join(', ')})`);
await Deno.remove(OUT, { recursive: true }).catch(() => {});
const archives: string[] = [];
for (const [name, target] of chosen) archives.push(await build(name, target));
const sums = await Promise.all(archives.map(async (a) => `${await sha256(`${OUT}/${a}`)}  ${a}`));
await Deno.writeTextFile(`${OUT}/SHA256SUMS`, sums.join('\n') + '\n');
console.log(`\n${archives.length} archive(s) in ${OUT}/:\n${sums.join('\n')}`);
