// compile.ts: build the standalone release binaries (no Bun needed to run them).
//
//   bun run compile              # every target into dist/
//   bun run compile linux-x64    # one target
//
// The codec (../sensorframe/js) is a static import, so the bundle carries it.
// The web UI is built first (bun run web:build) and web/dist is embedded as an
// asset: it lands as dist/ under import.meta.dir, where src/web/server.ts looks.
// The binary must not pick up a .env or bunfig.toml from the folder it runs in,
// so both autoloads are off.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { SIM_VERSION } from '../main.ts';

const TARGETS: Record<string, Bun.Build.CompileTarget> = {
  'linux-x64': 'bun-linux-x64',
  'windows-x64': 'bun-windows-x64',
};
const OUT = 'dist';

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  const code = await Bun.spawn([cmd, ...args], { cwd, stdout: 'inherit', stderr: 'inherit' }).exited;
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${code})`);
}

async function build(name: string, target: Bun.Build.CompileTarget): Promise<string> {
  const exe = target.includes('windows') ? 'hour-meter-sim.exe' : 'hour-meter-sim';
  const dir = `${OUT}/hour-meter-sim-${SIM_VERSION}-${name}`;
  await mkdir(dir, { recursive: true });
  const result = await Bun.build({
    entrypoints: ['main.ts'],
    compile: { target, outfile: `${dir}/${exe}`, assets: ['web/dist'], autoloadDotenv: false, autoloadBunfig: false },
  });
  if (!result.success) throw new AggregateError(result.logs, `bun build for ${name} failed`);
  await copyFile('README.md', `${dir}/README.md`);
  const base = dir.slice(OUT.length + 1);
  if (target.includes('windows')) {
    await run('zip', ['-qr', `${base}.zip`, base], OUT);
    return `${base}.zip`;
  }
  await run('tar', ['-czf', `${base}.tar.gz`, base], OUT);
  return `${base}.tar.gz`;
}

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await readFile(path)).digest('hex');
}

const only = process.argv[2];
const chosen = Object.entries(TARGETS).filter(([name]) => !only || name === only);
if (chosen.length === 0) throw new Error(`unknown target '${only}' (use: ${Object.keys(TARGETS).join(', ')})`);
await run('bun', ['run', 'web:build']);
await rm(OUT, { recursive: true, force: true });
const archives: string[] = [];
for (const [name, target] of chosen) archives.push(await build(name, target));
const sums = await Promise.all(archives.map(async (a) => `${await sha256(`${OUT}/${a}`)}  ${a}`));
await writeFile(`${OUT}/SHA256SUMS`, sums.join('\n') + '\n');
console.log(`\n${archives.length} archive(s) in ${OUT}/:\n${sums.join('\n')}`);
