// Builds the NxGen desktop app for the computer it runs on:
//   macOS (Apple Silicon): NxGen.app and a .dmg        npm run package:mac
//   Windows (x64):         NxGen-Setup-<v>.exe (NSIS)  npm run package:win
// Everything is assembled in a temporary folder, so running dev servers are not disturbed.
// Windows builds must be made on Windows: the camera helper (nxgen-camera.exe, IDS peak) and the
// service's native modules are built for the machine they are packaged on.
import { execFileSync } from 'child_process';
import { build as esbuild } from 'esbuild';
import { build as electronBuilder } from 'electron-builder';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const target = process.argv[2];
if (target !== 'mac' && target !== 'win') throw new Error('Usage: node scripts/package.mjs mac|win');
if (target === 'mac' && process.platform !== 'darwin') throw new Error('The Mac app is built on a Mac.');
if (target === 'win' && process.platform !== 'win32') throw new Error('The Windows installer is built on the Windows PC (it bundles the IDS camera helper built there).');

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..', '..');
// The real path: on macOS the temp folder sits behind a symlink, which packaging refuses.
const stage = mkdtempSync(join(realpathSync(tmpdir()), `nxgen-${target}-`));
const run = (cmd, args, cwd = repo, env = process.env) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit' });
// npm and tsc through Node itself: on Windows they are .cmd files, which cannot be started without a shell.
const npmCli = process.env.npm_execpath && basename(process.env.npm_execpath).startsWith('npm-cli')
  ? process.env.npm_execpath
  : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npm = (args, cwd = repo, opts = {}) => execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit', ...opts });
// Directory links: junctions on Windows need no administrator rights.
const linkDir = (to, at) => symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');
const step = (s) => console.log(`\n== ${s}`);

step('Shared packages');
npm(['run', 'build', '-w', '@crescent/licensing', '-w', '@crescent/module-sdk']);

step('Service');
const server = join(stage, 'server');
const serverSrc = join(repo, 'apps', 'server');
run(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json', '--outDir', join(server, 'dist'), '--incremental', 'false', '--noEmit', 'false'], serverSrc);
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
  const out = npm(['pack', '--pack-destination', packs, '--silent'], join(repo, dir), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split(/\r?\n/).pop();
  packed[name] = `file:${join(packs, out)}`;
}
const serverPkg = JSON.parse(readFileSync(join(serverSrc, 'package.json'), 'utf8'));
writeFileSync(join(server, 'package.json'), JSON.stringify({ name: 'nxgen-service', version: '2.0.0', private: true, main: 'dist/main.js', dependencies: { ...serverPkg.dependencies, ...packed } }, null, 2));
npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], server);

step('Screens');
const webSrc = join(repo, 'apps', 'web');
const webCopy = join(stage, 'web-build');
const skip = new Set(['.next', 'out', 'node_modules', 'tsconfig.tsbuildinfo']);
cpSync(webSrc, webCopy, { recursive: true, filter: (src) => src === webSrc || !skip.has(basename(src)) || dirname(src) !== webSrc });
linkDir(join(repo, 'node_modules'), join(stage, 'node_modules'));
if (existsSync(join(webSrc, 'node_modules'))) linkDir(join(webSrc, 'node_modules'), join(webCopy, 'node_modules'));
const webEnv = { ...process.env };
delete webEnv.NEXT_PUBLIC_API_URL; // the screens and API share one address in the app
run(process.execPath, [join(repo, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], webCopy, webEnv);
cpSync(join(webCopy, 'out'), join(stage, 'web'), { recursive: true });
rmSync(webCopy, { recursive: true, force: true });

// The lamp box camera helper. IDS peak has no macOS build, so only the Windows app carries it.
let cameraHelper = null;
if (target === 'win') {
  step('Camera helper');
  const helperSrc = join(repo, 'tools', 'camera-helper');
  const exe = join(helperSrc, 'dist', 'nxgen-camera.exe');
  if (!existsSync(exe)) {
    try {
      run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(helperSrc, 'build.ps1')], helperSrc);
    } catch {
      throw new Error('Building nxgen-camera.exe failed. It needs Python 3.10+ on PATH and IDS peak installed; see tools/camera-helper/README.md.');
    }
  }
  if (!existsSync(exe)) throw new Error(`Not found after the build: ${exe}`);
  cameraHelper = join(stage, 'camera-helper');
  mkdirSync(cameraHelper);
  cpSync(exe, join(cameraHelper, 'nxgen-camera.exe'));
  cpSync(join(helperSrc, 'sim'), join(cameraHelper, 'sim'), { recursive: true });
}

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

step(target === 'mac' ? 'Mac app' : 'Windows installer');
const output = join(desktop, 'release');
rmSync(output, { recursive: true, force: true });
// Plain copies: packaging tools skip nested node_modules when given as resources.
const copyResources = (resources) => {
  cpSync(server, join(resources, 'server'), { recursive: true, verbatimSymlinks: true });
  cpSync(join(stage, 'web'), join(resources, 'web'), { recursive: true });
  cpSync(join(server, 'config'), join(resources, 'config'), { recursive: true });
  if (cameraHelper) cpSync(cameraHelper, join(resources, 'camera-helper'), { recursive: true });
};
const platformConfig =
  target === 'mac'
    ? {
        mac: { target: [{ target: 'dmg', arch: ['arm64'] }], icon: join(desktop, 'build', 'icon.png'), category: 'public.app-category.productivity', identity: null },
        dmg: { title: 'NxGen' },
        afterPack: async ({ appOutDir }) => {
          copyResources(join(appOutDir, 'NxGen.app', 'Contents', 'Resources'));
          // Apple Silicon needs every app to carry a signature; this one is local to this Mac.
          execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(appOutDir, 'NxGen.app')], { stdio: 'inherit' });
        },
      }
    : {
        win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: join(desktop, 'build', 'icon.png') },
        nsis: {
          artifactName: 'NxGen-Setup-${version}.${ext}',
          oneClick: false,
          perMachine: false, // installs for this user: no administrator rights needed
          allowToChangeInstallationDirectory: true,
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: 'NxGen',
        },
        afterPack: async ({ appOutDir }) => copyResources(join(appOutDir, 'resources')),
      };
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
    ...platformConfig,
  },
});
rmSync(stage, { recursive: true, force: true });
const ext = target === 'mac' ? '.dmg' : '.exe';
console.log(`\nBuilt: ${readdirSync(output).filter((f) => f.endsWith(ext)).map((f) => join(output, f)).join(', ')}`);
