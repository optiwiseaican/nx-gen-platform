// Builds the pH module into dist/ (module.json, api/, ui/, migrations/),
// ready for: nxgen-license module-pack --dir modules/ph/dist
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await esbuild({
  entryPoints: [join(here, 'src/api/index.ts')],
  outfile: join(dist, 'api/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
});

await vite({
  configFile: false,
  root: join(here, 'src/ui'),
  base: '/modules/ph/',
  logLevel: 'warn',
  plugins: [react(), tailwind()],
  build: { outDir: join(dist, 'ui'), emptyOutDir: true, assetsDir: 'assets' },
});

cpSync(join(here, 'migrations'), join(dist, 'migrations'), { recursive: true });
const manifest = JSON.parse(readFileSync(join(here, 'module.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`module.json ${manifest.version} ≠ package.json ${pkg.version}`);
writeFileSync(join(dist, 'module.json'), JSON.stringify(manifest, null, 2));
console.log(`Built pH module ${manifest.version} → ${dist}`);
