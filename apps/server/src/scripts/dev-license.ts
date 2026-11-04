import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import {
  collectFingerprint,
  createActivationRequest,
  generateSigningKeyPair,
  issueLicense,
  publicKeyFromPrivate,
  computeKeyId,
  serializeLicenseFile,
  TrustedKey,
} from '@crescent/licensing';
import { CONFIG_DIR, loadConfig } from '../config/nxgen.config';
import { initPlatformForDev } from './dev-platform';

/**
 * DEVELOPMENT ONLY — plays the vendor License Authority locally:
 *  1. ensures this machine has a simulated, verified installation
 *  2. ensures a local dev signing key exists and is trusted (dev trust file only)
 *  3. generates this workstation's activation request
 *  4. issues a bound .nxlic into the provisioning inbox and prints the activation code
 */
async function main() {
  const config = loadConfig();
  if (config.production)
    throw new Error('dev:license is not available in production');
  const { identity } = initPlatformForDev(config);

  const repoRoot = resolve(__dirname, '..', '..', '..', '..');
  const keyDir = join(repoRoot, 'tools', 'license-authority', 'keys', 'dev');
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  let privateKeyPem: string;
  const existing = readdirSync(keyDir).find((f) => f.endsWith('.private.pem'));
  if (existing) privateKeyPem = readFileSync(join(keyDir, existing), 'utf8');
  else {
    const pair = generateSigningKeyPair();
    writeFileSync(
      join(keyDir, `${pair.keyId}.private.pem`),
      pair.privateKeyPem,
      { mode: 0o600 },
    );
    writeFileSync(join(keyDir, `${pair.keyId}.public.pem`), pair.publicKeyPem);
    privateKeyPem = pair.privateKeyPem;
  }
  const publicKeyPem = publicKeyFromPrivate(privateKeyPem);
  const keyId = computeKeyId(publicKeyPem);

  const trustPath = join(CONFIG_DIR, 'trusted-license-keys.dev.json');
  const trusted: TrustedKey[] = existsSync(trustPath)
    ? (JSON.parse(readFileSync(trustPath, 'utf8')) as TrustedKey[])
    : [];
  let trustChanged = false;
  if (!trusted.some((k) => k.keyId === keyId)) {
    trusted.push({
      keyId,
      publicKeyPem,
      label: 'Local development key (NOT FOR PRODUCTION)',
    });
    writeFileSync(trustPath, `${JSON.stringify(trusted, null, 2)}\n`);
    trustChanged = true;
  }

  const request = createActivationRequest({
    platform: identity,
    platformVersion: config.platformVersion,
    fingerprint: await collectFingerprint(),
  });
  const license = issueLicense({
    request,
    privateKeyPem,
    customer: {
      id: 'DEV-CUSTOMER',
      name: 'Development Laboratory',
      site: 'Local workstation',
    },
    licenseType: 'PERPETUAL',
    modules: [
      { id: 'ph', expiresAt: null },
      { id: 'tlc', expiresAt: null },
    ],
  });

  const inbox = join(config.dataDir, 'licensing', 'inbox');
  mkdirSync(inbox, { recursive: true });
  const file = join(inbox, `${license.payload.activationCode}.nxlic`);
  writeFileSync(file, serializeLicenseFile(license));

  console.log(`Platform Instance ID: ${identity.instanceId}`);
  console.log(`License package:      ${file}`);
  console.log(`Signing key:          ${keyId} (dev)`);
  console.log(`\n  Activation code:  ${license.payload.activationCode}\n`);
  if (trustChanged)
    console.log(
      'A new dev signing key was trusted — restart the server so it is loaded.',
    );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
