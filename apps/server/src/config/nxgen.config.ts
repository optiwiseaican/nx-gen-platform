import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parseEnv } from 'util';
import {
  computeKeyId,
  DEFAULT_CLOCK_ROLLBACK_TOLERANCE_MS,
  TrustedKey,
} from '@crescent/licensing';

export const NXGEN_CONFIG = Symbol('NXGEN_CONFIG');

export const PLATFORM_NAME = 'NxGen Compliance Platform';
/** Installed platform version. Licenses are scoped to the major version. */
export const PLATFORM_VERSION = '2.0.0';

export interface DatabaseConfig {
  /** Connection string without TLS parameters (those are carried in `ssl`). */
  connectionString: string;
  ssl: { ca: string; rejectUnauthorized: true } | false;
  /** PostgreSQL schema holding all NxGen objects. */
  schema: string;
}

/** Part 11 account & session controls (configurable per site SOP). */
export interface SecurityPolicy {
  passwordMinLength: number;
  passwordHistory: number;
  passwordMaxAgeDays: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
}

/** Values in force before an administrator changes them (also seeded by migration 005). */
export const DEFAULT_SECURITY_POLICY: Readonly<SecurityPolicy> = Object.freeze({
  passwordMinLength: 12,
  passwordHistory: 5,
  passwordMaxAgeDays: 90,
  maxFailedLogins: 5,
  lockoutMinutes: 30,
  sessionIdleMinutes: 15,
  sessionMaxHours: 12,
});

/**
 * Validated limits. The database enforces the same ranges with CHECK
 * constraints (migration 005), so no change can weaken the rules below them.
 */
export const SECURITY_POLICY_LIMITS: Readonly<
  Record<keyof SecurityPolicy, { min: number; max: number }>
> = Object.freeze({
  passwordMinLength: { min: 8, max: 64 },
  passwordHistory: { min: 1, max: 24 },
  passwordMaxAgeDays: { min: 30, max: 365 },
  maxFailedLogins: { min: 3, max: 10 },
  lockoutMinutes: { min: 5, max: 1440 },
  sessionIdleMinutes: { min: 5, max: 60 },
  sessionMaxHours: { min: 1, max: 24 },
});

export interface NxGenConfig {
  production: boolean;
  /** null → no database configured: audit goes to the bootstrap journal file only. */
  database: DatabaseConfig | null;
  /**
   * The policy in force. One mutable object per process: loaded from
   * security_settings at startup and updated in place when an administrator
   * changes it, so every service reads the current rules.
   */
  security: SecurityPolicy;
  dataDir: string;
  platformVersion: string;
  trustedKeys: TrustedKey[];
  clockRollbackToleranceMs: number;
}

/** apps/server/config — same relative depth from src/config and dist/config. */
export const CONFIG_DIR = resolve(__dirname, '..', '..', 'config');

/**
 * Trusted license-signing PUBLIC keys.
 *  - trusted-license-keys.json      committed; production vendor keys (covered by the release integrity manifest)
 *  - trusted-license-keys.dev.json  git-ignored; per-developer key from `npm run dev:license`, never loaded in production
 * Entries whose keyId does not match their public key are rejected.
 */
export function loadTrustedKeys(
  production: boolean,
  configDir = CONFIG_DIR,
): TrustedKey[] {
  const files = [
    'trusted-license-keys.json',
    ...(production ? [] : ['trusted-license-keys.dev.json']),
  ];
  const keys: TrustedKey[] = [];
  for (const file of files) {
    const path = resolve(configDir, file);
    if (!existsSync(path)) continue;
    const entries = JSON.parse(readFileSync(path, 'utf8')) as TrustedKey[];
    for (const entry of entries) {
      if (computeKeyId(entry.publicKeyPem) !== entry.keyId) {
        throw new Error(
          `Trusted key ${entry.keyId} in ${file} does not match its public key`,
        );
      }
      keys.push(entry);
    }
  }
  return keys;
}

const REPO_ENV_FILE = resolve(__dirname, '..', '..', '..', '..', '.env');

/** Loads the repository .env in development (never overrides real environment variables). */
export function loadEnvFile(): void {
  if (process.env.NODE_ENV === 'production' || !existsSync(REPO_ENV_FILE))
    return;
  const parsed = parseEnv(readFileSync(REPO_ENV_FILE, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && value !== undefined)
      process.env[key] = value;
  }
}

/**
 * TLS is all-or-nothing: if the URL asks for TLS (sslmode=require/verify-*),
 * the server certificate is ALWAYS verified against a configured CA. There is
 * deliberately no "accept any certificate" mode — audit data and credentials
 * travel over this connection.
 */
export function loadDatabaseConfig(
  configDir = CONFIG_DIR,
): DatabaseConfig | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  const url = new URL(raw);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');

  const schema = process.env.NXGEN_DB_SCHEMA ?? 'nxgen';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
    throw new Error(`Invalid NXGEN_DB_SCHEMA "${schema}"`);

  if (!sslmode || sslmode === 'disable') {
    return { connectionString: url.toString(), ssl: false, schema };
  }
  const caPath = [
    process.env.DATABASE_CA_CERT,
    resolve(configDir, 'database-ca.pem'),
    resolve(configDir, 'aiven-ca.pem'),
  ]
    .filter((p): p is string => !!p)
    .find((p) => existsSync(p));
  if (!caPath) {
    throw new Error(
      'DATABASE_URL requires TLS but no CA certificate is configured. Download the CA certificate from your ' +
        'PostgreSQL provider and save it as apps/server/config/database-ca.pem (or set DATABASE_CA_CERT).',
    );
  }
  return {
    connectionString: url.toString(),
    ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true },
    schema,
  };
}

export function loadConfig(): NxGenConfig {
  loadEnvFile();
  const production = process.env.NODE_ENV === 'production';
  return {
    production,
    database: loadDatabaseConfig(),
    security: { ...DEFAULT_SECURITY_POLICY },
    dataDir: resolve(
      process.env.NXGEN_DATA_DIR ??
        resolve(__dirname, '..', '..', '.nxgen-data'),
    ),
    platformVersion: PLATFORM_VERSION,
    trustedKeys: loadTrustedKeys(production),
    clockRollbackToleranceMs: Number(
      process.env.NXGEN_CLOCK_ROLLBACK_TOLERANCE_MS ??
        DEFAULT_CLOCK_ROLLBACK_TOLERANCE_MS,
    ),
  };
}
