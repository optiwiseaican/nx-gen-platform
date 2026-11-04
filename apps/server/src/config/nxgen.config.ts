import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  computeKeyId,
  DEFAULT_CLOCK_ROLLBACK_TOLERANCE_MS,
  TrustedKey,
} from '@crescent/licensing';

export const NXGEN_CONFIG = Symbol('NXGEN_CONFIG');

export const PLATFORM_NAME = 'NxGen Compliance Platform';
/** Installed platform version. Licenses are scoped to the major version. */
export const PLATFORM_VERSION = '2.0.0';

export interface NxGenConfig {
  production: boolean;
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

export function loadConfig(): NxGenConfig {
  const production = process.env.NODE_ENV === 'production';
  return {
    production,
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
