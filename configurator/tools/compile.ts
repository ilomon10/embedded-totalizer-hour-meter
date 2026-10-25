// compile.ts: build the standalone release binaries (no Bun needed to run them).
//
//   bun run compile              # every target into dist/
//   bun run compile linux-x64    # one target
//
// The codec (../sensorframe/js) is a static import, so the bundle carries it.
// The binary must not pick up a .env or bunfig.toml from the folder it runs in,
// so both autoloads are off.
import type { BunPlugin } from 'bun';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { TOOL_VERSION } from '../src/version.ts';

const TARGETS: Record<string, Bun.Build.CompileTarget> = {
  'linux-x64': 'bun-linux-x64',
  'windows-x64': 'bun-windows-x64',
};
const OUT = 'dist';

// OpenTUI loads its native renderer (Zig) from a package per platform. `bun install --os=* --cpu=*` puts all of them
// in node_modules (a cross-compile needs the target's); each binary embeds only its own, the others are stubs.
const NATIVE: Record<string, string> = {
  'bun-linux-x64': '@opentui/core-linux-x64',
  'bun-windows-x64': '@opentui/core-win32-x64',
};

function onlyTargetNative(target: Bun.Build.CompileTarget): BunPlugin {
  return {
    name: 'opentui-target-native',
    setup(build) {
      build.onResolve({ filter: /^@opentui\/core-[a-z0-9-]+$/ }, (args) =>
        args.path === NATIVE[target] ? undefined : { path: args.path, namespace: 'other-platform' },
      );
      build.onLoad({ filter: /.*/, namespace: 'other-platform' }, (args) => ({
        contents: `throw new Error('${args.path} is not in this build');\nexport default undefined;`,
        loader: 'js',
      }));
    },
  };
}

// React DevTools (DEV=true) are not part of the binary: the optional peer react-devtools-core is not installed,
// but the bundler still resolves its import, so it gets a stub that fails like a missing package.
const noDevtools: BunPlugin = {
  name: 'no-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: [
        `throw Object.assign(new Error('react-devtools-core is not in this build'), { code: 'ERR_MODULE_NOT_FOUND' });`,
        'export default undefined;', // never reached; the importer takes a default
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
  if (!existsSync(`node_modules/${NATIVE[target]}`)) {
    throw new Error(
      `${NATIVE[target]} is not installed: run bun install --os='*' --cpu='*' first (the TUI's native part)`,
    );
  }
  const exe = target.includes('windows') ? 'hour-meter.exe' : 'hour-meter';
  const dir = `${OUT}/hour-meter-${TOOL_VERSION}-${name}`;
  await mkdir(dir, { recursive: true });
  const result = await Bun.build({
    entrypoints: ['main.ts'],
    compile: { target, outfile: `${dir}/${exe}`, autoloadDotenv: false, autoloadBunfig: false },
    define: { 'process.env.DEV': '"false"' }, // DEV=true in the user's shell must not reach for React DevTools
    plugins: [onlyTargetNative(target), noDevtools],
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
