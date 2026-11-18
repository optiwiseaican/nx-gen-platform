// Mac test builds only: writes this Mac's settings for the packaged app from the repository .env, so it
// uses the database server named there (e.g. the Aiven test database). The password never goes inside the app.
// Windows installations always use their built-in database and need no settings.
// Usage: npm run configure:mac
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

if (process.platform !== 'darwin') {
  throw new Error('Not needed here: NxGen installations use their built-in database. configure:mac is for Mac test builds.');
}
// Electron's userData folder for the product "NxGen".
const target = join(homedir(), 'Library', 'Application Support', 'NxGen');
mkdirSync(target, { recursive: true, mode: 0o700 });
// Values in single quotes: the service reads this file with util.parseEnv, which turns "\n" inside
// double quotes into a line break (C:\nxgen\... would break) but takes single-quoted text literally.
const quote = (value) => {
  if (/[\r\n]/.test(value)) throw new Error('A setting cannot contain a line break');
  if (!value.includes("'")) return `'${value}'`;
  if (/\\/.test(value)) throw new Error(`Cannot write a value with both ' and \\: ${value}`);
  return JSON.stringify(value);
};
const lines = [
  `DATABASE_URL=${quote(env.DATABASE_URL)}`,
  `DEPLOYMENT_MODE=${env.DEPLOYMENT_MODE ?? 'STANDALONE'}`,
  // The same data folder as this checkout: it holds the licence binding and the installed modules.
  `NXGEN_DATA_DIR=${quote(join(repo, 'apps', 'server', '.nxgen-data'))}`,
];
if (env.NXGEN_CAMERA) lines.push(`NXGEN_CAMERA=${env.NXGEN_CAMERA}`);
const ca = join(repo, 'apps', 'server', 'config', 'database-ca.pem');
if (existsSync(ca)) {
  const copy = join(target, 'database-ca.pem');
  copyFileSync(ca, copy);
  lines.push(`DATABASE_CA_CERT=${quote(copy)}`);
}
const file = join(target, 'nxgen.env');
writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Settings written to ${file}`);
