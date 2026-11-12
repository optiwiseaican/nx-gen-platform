// Writes this Mac's settings for the packaged app from the repository .env.
// They live outside the app so the database password is never inside it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseEnv } from 'util';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envFile = join(repo, '.env');
if (!existsSync(envFile)) throw new Error(`Not found: ${envFile}`);
const env = parseEnv(readFileSync(envFile, 'utf8'));
if (!env.DATABASE_URL) throw new Error('.env has no DATABASE_URL');

const target = join(homedir(), 'Library', 'Application Support', 'NxGen');
mkdirSync(target, { recursive: true, mode: 0o700 });
const lines = [
  `DATABASE_URL=${JSON.stringify(env.DATABASE_URL)}`,
  `DEPLOYMENT_MODE=${env.DEPLOYMENT_MODE ?? 'STANDALONE'}`,
  // The same data folder as this checkout: it holds the licence binding and the installed modules.
  `NXGEN_DATA_DIR=${JSON.stringify(join(repo, 'apps', 'server', '.nxgen-data'))}`,
];
const ca = join(repo, 'apps', 'server', 'config', 'database-ca.pem');
if (existsSync(ca)) {
  const copy = join(target, 'database-ca.pem');
  copyFileSync(ca, copy);
  lines.push(`DATABASE_CA_CERT=${JSON.stringify(copy)}`);
}
const file = join(target, 'nxgen.env');
writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Settings written to ${file}`);
