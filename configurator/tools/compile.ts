// compile.ts: build the standalone release binaries (no Bun needed to run them).
//
//   bun run compile              # every target into dist/
//   bun run compile linux-x64    # one target
//
// The codec (../sensorframe/js) is a static import, so the bundle carries it.
// The binary must not pick up a .env or bunfig.toml from the folder it runs in,
// so both autoloads are off.
import type { BunPlugin } from 'bun';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { TOOL_VERSION } from '../src/version.ts';

const TARGETS: Record<string, Bun.Build.CompileTarget> = {
  'linux-x64': 'bun-linux-x64',
  'windows-x64': 'bun-windows-x64',
};
const OUT = 'dist';

// ink's dev mode (DEV=true: React DevTools) is not part of the binary. ink checks DEV at run time, and then reads
// its own package.json, which a binary does not have: isDev() is pinned to false. The bundler still resolves the
// import of react-devtools-core (an optional peer, not installed), so that gets a stub.
const noDevtools: BunPlugin = {
  name: 'no-react-devtools',
  setup(build) {
    build.onLoad({ filter: /[\\/]ink[\\/]build[\\/]utils\.js$/ }, () => ({
      contents: 'export const isDev = () => false;',
      loader: 'js',
    }));
    build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: [
        `throw Object.assign(new Error('react-devtools-core is not in this build'), { code: 'ERR_MODULE_NOT_FOUND' });`,
        'export default undefined;', // never reached; ink imports a default
      ].join('\n'),
      loader: 'js',
    }));
  },
};

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  const code = await Bun.spawn([cmd, ...args], { cwd, stdout: 'inherit', stderr: 'inherit' }).exited;
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${code})`);
}

async function build(name: string, target: Bun.Build.CompileTarget): Promise<string> {
  const exe = target.includes('windows') ? 'hour-meter.exe' : 'hour-meter';
  const dir = `${OUT}/hour-meter-${TOOL_VERSION}-${name}`;
  await mkdir(dir, { recursive: true });
  const result = await Bun.build({
    entrypoints: ['main.ts'],
    compile: { target, outfile: `${dir}/${exe}`, autoloadDotenv: false, autoloadBunfig: false },
    plugins: [noDevtools],
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
await rm(OUT, { recursive: true, force: true });
const archives: string[] = [];
for (const [name, target] of chosen) archives.push(await build(name, target));
const sums = await Promise.all(archives.map(async (a) => `${await sha256(`${OUT}/${a}`)}  ${a}`));
await writeFile(`${OUT}/SHA256SUMS`, sums.join('\n') + '\n');
console.log(`\n${archives.length} archive(s) in ${OUT}/:\n${sums.join('\n')}`);
