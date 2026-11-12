// Builds NxGen.app and a .dmg for this Mac (Apple Silicon). Usage: npm run package:mac
// Everything is assembled in a temporary folder, so running dev servers are not disturbed.
import { execFileSync } from 'child_process';
import { build as esbuild } from 'esbuild';
import { build as electronBuilder } from 'electron-builder';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..', '..');
// The real path: on macOS the temp folder sits behind a symlink, which packaging refuses.
const stage = mkdtempSync(join(realpathSync(tmpdir()), 'nxgen-mac-'));
const run = (cmd, args, cwd = repo, env = process.env) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
const step = (s) => console.log(`\n== ${s}`);

step('Shared packages');
run('npm', ['run', 'build', '-w', '@crescent/licensing', '-w', '@crescent/module-sdk']);

step('Service');
const server = join(stage, 'server');
const serverSrc = join(repo, 'apps', 'server');
run('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', join(server, 'dist'), '--incremental', 'false', '--noEmit', 'false'], serverSrc);
if (!existsSync(join(server, 'dist', 'main.js'))) throw new Error('The service did not build to dist/main.js');
cpSync(join(serverSrc, 'src', 'database', 'migrations'), join(server, 'dist', 'database', 'migrations'), { recursive: true });
mkdirSync(join(server, 'config'));
for (const f of ['trusted-license-keys.json', 'trusted-license-keys.dev.json']) {
  if (existsSync(join(serverSrc, 'config', f))) cpSync(join(serverSrc, 'config', f), join(server, 'config', f));
}

step('Service dependencies');
const packs = join(stage, 'packs');
mkdirSync(packs);
const packed = {};
for (const [name, dir] of [['@crescent/licensing', 'packages/licensing'], ['@crescent/module-sdk', 'packages/module-sdk']]) {
  const out = execFileSync('npm', ['pack', '--pack-destination', packs, '--silent'], { cwd: join(repo, dir), encoding: 'utf8' }).trim().split('\n').pop();
  packed[name] = `file:${join(packs, out)}`;
}
const serverPkg = JSON.parse(readFileSync(join(serverSrc, 'package.json'), 'utf8'));
writeFileSync(join(server, 'package.json'), JSON.stringify({ name: 'nxgen-service', version: '2.0.0', private: true, main: 'dist/main.js', dependencies: { ...serverPkg.dependencies, ...packed } }, null, 2));
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], server);

step('Screens');
const webCopy = join(stage, 'web-build');
run('rsync', ['-a', '--exclude', '.next', '--exclude', 'out', '--exclude', 'node_modules', '--exclude', 'tsconfig.tsbuildinfo', `${join(repo, 'apps', 'web')}/`, `${webCopy}/`]);
symlinkSync(join(repo, 'node_modules'), join(stage, 'node_modules'));
if (existsSync(join(repo, 'apps', 'web', 'node_modules'))) symlinkSync(join(repo, 'apps', 'web', 'node_modules'), join(webCopy, 'node_modules'));
const webEnv = { ...process.env };
delete webEnv.NEXT_PUBLIC_API_URL; // the screens and API share one address in the app
run('node', [join(repo, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], webCopy, webEnv);
cpSync(join(webCopy, 'out'), join(stage, 'web'), { recursive: true });
rmSync(webCopy, { recursive: true, force: true });

step('App window');
const appDir = join(stage, 'app');
await esbuild({
  entryPoints: [join(desktop, 'src', 'main.ts'), join(desktop, 'src', 'preload.ts')],
  outdir: appDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  define: { 'process.env.NXGEN_LOCAL_BUILD': '"1"' },
  logLevel: 'warning',
});
const electronVersion = JSON.parse(readFileSync(join(repo, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'nxgen', productName: 'NxGen', version: '2.0.0', description: 'NxGen Compliance Platform', author: 'AICAN', main: 'main.js' }, null, 2));

step('Mac app');
const output = join(desktop, 'release');
rmSync(output, { recursive: true, force: true });
await electronBuilder({
  projectDir: appDir,
  publish: 'never',
  config: {
    appId: 'com.aican.nxgen',
    productName: 'NxGen',
    electronVersion,
    electronDist: join(repo, 'node_modules', 'electron', 'dist'),
    npmRebuild: false,
    directories: { output, buildResources: join(desktop, 'build') },
    files: ['**/*'],
    mac: { target: [{ target: 'dmg', arch: ['arm64'] }], icon: join(desktop, 'build', 'icon.png'), category: 'public.app-category.productivity', identity: null },
    dmg: { title: 'NxGen' },
    // Plain copies: packaging tools skip nested node_modules when given as resources.
    afterPack: async ({ appOutDir }) => {
      const resources = join(appOutDir, 'NxGen.app', 'Contents', 'Resources');
      cpSync(server, join(resources, 'server'), { recursive: true, verbatimSymlinks: true });
      cpSync(join(stage, 'web'), join(resources, 'web'), { recursive: true });
      cpSync(join(server, 'config'), join(resources, 'config'), { recursive: true });
      // Apple Silicon needs every app to carry a signature; this one is local to this Mac.
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(appOutDir, 'NxGen.app')], { stdio: 'inherit' });
    },
  },
});
rmSync(stage, { recursive: true, force: true });
console.log(`\nBuilt: ${readdirSync(output).filter((f) => f.endsWith('.dmg')).map((f) => join(output, f)).join(', ')}`);
