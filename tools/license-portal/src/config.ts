import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { PortalStore } from './store';

/**
 * Portal settings (environment):
 *   PORTAL_DATABASE_URL       PostgreSQL for keys and issued licences (falls back to DATABASE_URL)
 *   PORTAL_DATABASE_CA_CERT   CA certificate when the URL asks for TLS (sslmode=require / verify-*)
 *   PORTAL_DB_SCHEMA          default license_portal
 *   PORTAL_SIGNING_KEY_FILE   Ed25519 private key (PEM) that NxGen installations trust
 *   PORT                      default 4100
 */
export function portalStore(): PortalStore {
  const raw = process.env.PORTAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error('Set PORTAL_DATABASE_URL (or DATABASE_URL) to the portal database.');
  const url = new URL(raw);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  let ssl: false | { ca: string; rejectUnauthorized: true } = false;
  if (sslmode && sslmode !== 'disable') {
    const caFile = process.env.PORTAL_DATABASE_CA_CERT ?? process.env.DATABASE_CA_CERT;
    if (!caFile) throw new Error('The database URL asks for TLS: set PORTAL_DATABASE_CA_CERT to its CA certificate.');
    ssl = { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
  }
  return new PortalStore(new Pool({ connectionString: url.toString(), ssl, max: 5 }), process.env.PORTAL_DB_SCHEMA ?? 'license_portal');
}

export function signingKey(): string {
  const file = process.env.PORTAL_SIGNING_KEY_FILE;
  if (!file) throw new Error('Set PORTAL_SIGNING_KEY_FILE to the private signing key (PEM).');
  return readFileSync(file, 'utf8');
}
