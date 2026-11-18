import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { Pool } from 'pg';
import { bundledBinariesDir, LocalDatabase } from '@crescent/local-postgres';
import { PortalStore } from './store';

/** Port of the portal's own built-in database (NxGen's is 47811). */
const PORTAL_DATABASE_PORT = 47812;

/**
 * Portal settings (environment). By default everything is local and offline: keys and issued licences live in
 * a built-in PostgreSQL in the portal's data folder, started and stopped by the portal itself.
 *   PORTAL_DATA_DIR           default: ~/Library/Application Support/AICAN License Portal (macOS),
 *                             %ProgramData%\AICAN License Portal (Windows), ~/.local/share/aican-license-portal
 *   PORTAL_DATABASE_URL       use this PostgreSQL server instead (e.g. when the portal is hosted)
 *   PORTAL_DATABASE_CA_CERT   CA certificate when that URL asks for TLS (sslmode=require / verify-*)
 *   PORTAL_DB_SCHEMA          default license_portal
 *   PORTAL_SIGNING_KEY_FILE   Ed25519 private key (PEM) NxGen installations trust; default in a checkout:
 *                             the demo key in tools/license-authority/keys/vendor-demo (testing only)
 *   PORT, HOST                default 4100, 127.0.0.1
 */
export function portalDataDir(): string {
  if (process.env.PORTAL_DATA_DIR) return resolve(process.env.PORTAL_DATA_DIR);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'AICAN License Portal');
  if (process.platform === 'win32') return join(process.env.ProgramData || 'C:\\ProgramData', 'AICAN License Portal');
  return join(homedir(), '.local', 'share', 'aican-license-portal');
}

export interface OpenStore {
  store: PortalStore;
  /** Where the data is, for messages. */
  location: string;
  close(): Promise<void>;
}

export async function openPortalStore(): Promise<OpenStore> {
  const schema = process.env.PORTAL_DB_SCHEMA ?? 'license_portal';
  const raw = process.env.PORTAL_DATABASE_URL;
  if (raw) {
    const url = new URL(raw);
    const sslmode = url.searchParams.get('sslmode');
    url.searchParams.delete('sslmode');
    let ssl: false | { ca: string; rejectUnauthorized: true } = false;
    if (sslmode && sslmode !== 'disable') {
      const caFile = process.env.PORTAL_DATABASE_CA_CERT;
      if (!caFile) throw new Error('The database URL asks for TLS: set PORTAL_DATABASE_CA_CERT to its CA certificate.');
      ssl = { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
    }
    const store = new PortalStore(new Pool({ connectionString: url.toString(), ssl, max: 5 }), schema);
    return { store, location: `${url.hostname} (${schema})`, close: () => store.pool.end() };
  }

  const binaries = bundledBinariesDir();
  if (!binaries || !LocalDatabase.available(binaries))
    throw new Error('The built-in PostgreSQL is not installed here (run npm install), or set PORTAL_DATABASE_URL.');
  const dir = join(portalDataDir(), 'database');
  const db = new LocalDatabase({ binariesDir: binaries, dir, port: PORTAL_DATABASE_PORT });
  const url = await db.start();
  const store = new PortalStore(new Pool({ connectionString: url, max: 5 }), schema);
  return {
    store,
    location: dir,
    close: async () => {
      await store.pool.end();
      await db.stop();
    },
  };
}

export function signingKey(): { pem: string; demo: boolean } {
  let file = process.env.PORTAL_SIGNING_KEY_FILE;
  let demo = false;
  if (!file) {
    const demoDir = resolve(__dirname, '..', '..', 'license-authority', 'keys', 'vendor-demo');
    const pem = existsSync(demoDir) ? readdirSync(demoDir).find((f) => f.endsWith('.private.pem')) : undefined;
    if (!pem) throw new Error('Set PORTAL_SIGNING_KEY_FILE to the private signing key (PEM).');
    file = join(demoDir, pem);
    demo = true;
  }
  return { pem: readFileSync(file, 'utf8'), demo };
}
