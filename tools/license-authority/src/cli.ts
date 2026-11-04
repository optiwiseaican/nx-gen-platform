#!/usr/bin/env node
/**
 * NxGen License Authority — VENDOR-ONLY tool.
 *
 * Holds the Ed25519 private signing key and turns activation requests (.nxreq
 * or NXR1 codes) into signed, platform-bound .nxlic files. This must run on a
 * controlled vendor workstation and must never be shipped to customers.
 *
 *   nxgen-license keygen  --out <dir> [--label <text>]
 *   nxgen-license issue   --key <private.pem> --request <file|NXR1-code>
 *                         --customer-id <id> --customer-name <name> [--site <site>]
 *                         [--type PERPETUAL|SUBSCRIPTION] [--expires YYYY-MM-DD]
 *                         [--modules ph,tlc] [--users N] [--devices N]
 *                         --out <file.nxlic> [--ledger <file.jsonl>]
 *   nxgen-license inspect <file.nxlic> [--trusted <trusted-keys.json>]
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { parseArgs } from 'util';
import {
  canonicalize,
  computeKeyId,
  generateSigningKeyPair,
  issueLicense,
  LICENSE_ERRORS,
  LICENSE_SIGNATURE_DOMAIN,
  licenseEnvelopeSchema,
  parseActivationRequest,
  serializeLicenseFile,
  signingMessage,
  TrustedKey,
  verifyMessage,
} from '@crescent/licensing';

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function keygen(args: string[]) {
  const { values } = parseArgs({ args, options: { out: { type: 'string' }, label: { type: 'string' } } });
  if (!values.out) fail('--out <dir> is required');
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const pair = generateSigningKeyPair();
  const privatePath = join(dir, `${pair.keyId}.private.pem`);
  const publicPath = join(dir, `${pair.keyId}.public.pem`);
  writeFileSync(privatePath, pair.privateKeyPem, { mode: 0o600, flag: 'wx' });
  chmodSync(privatePath, 0o600);
  writeFileSync(publicPath, pair.publicKeyPem, { flag: 'wx' });

  const trusted: TrustedKey = { keyId: pair.keyId, publicKeyPem: pair.publicKeyPem, label: values.label };
  console.log(`Key ID:      ${pair.keyId}`);
  console.log(`Private key: ${privatePath}   (KEEP OFFLINE, BACK UP SECURELY)`);
  console.log(`Public key:  ${publicPath}`);
  console.log('\nTrusted-key entry for the NxGen Platform build:');
  console.log(JSON.stringify(trusted, null, 2));
}

function parseDate(value: string | undefined, flag: string): Date | null {
  if (!value) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  if (Number.isNaN(d.getTime())) fail(`${flag} must be a date (YYYY-MM-DD)`);
  return d;
}

function parsePositiveInt(value: string | undefined, flag: string): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`${flag} must be a positive integer`);
  return n;
}

function issue(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: 'string' },
      request: { type: 'string' },
      'customer-id': { type: 'string' },
      'customer-name': { type: 'string' },
      site: { type: 'string' },
      type: { type: 'string', default: 'PERPETUAL' },
      expires: { type: 'string' },
      modules: { type: 'string', default: '' },
      users: { type: 'string' },
      devices: { type: 'string' },
      out: { type: 'string' },
      ledger: { type: 'string' },
    },
  });
  for (const req of ['key', 'request', 'customer-id', 'customer-name', 'out'] as const) {
    if (!values[req]) fail(`--${req} is required`);
  }
  if (values.type !== 'PERPETUAL' && values.type !== 'SUBSCRIPTION') fail('--type must be PERPETUAL or SUBSCRIPTION');
  const expiresAt = parseDate(values.expires, '--expires');
  if (values.type === 'SUBSCRIPTION' && !expiresAt) fail('SUBSCRIPTION licenses require --expires');

  const requestInput = existsSync(values.request!) ? readFileSync(values.request!, 'utf8') : values.request!;
  let request;
  try {
    request = parseActivationRequest(requestInput);
  } catch (err) {
    fail(`invalid activation request: ${(err as Error).message}`);
  }

  const modules = values
    .modules!.split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean)
    .map((id) => ({ id, expiresAt: null }));

  const privateKeyPem = readFileSync(values.key!, 'utf8');
  let license;
  try {
    license = issueLicense({
      request,
      privateKeyPem,
      customer: { id: values['customer-id']!, name: values['customer-name']!, site: values.site },
      licenseType: values.type,
      expiresAt,
      modules,
      limits: { users: parsePositiveInt(values.users, '--users'), devices: parsePositiveInt(values.devices, '--devices') },
    });
  } catch (err) {
    fail((err as Error).message);
  }

  const out = resolve(values.out!);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeLicenseFile(license), { flag: 'wx' });

  const ledger = resolve(values.ledger ?? join(dirname(resolve(values.key!)), '..', 'issued-licenses.jsonl'));
  appendFileSync(
    ledger,
    `${JSON.stringify({
      event: 'LICENSE_ISSUED',
      at: new Date().toISOString(),
      licenseId: license.payload.licenseId,
      activationCode: license.payload.activationCode,
      customer: license.payload.customer,
      platformInstanceId: license.payload.platform.instanceId,
      requestId: request.requestId,
      licenseType: license.payload.licenseType,
      expiresAt: license.payload.expiresAt,
      modules: modules.map((m) => m.id),
      keyId: license.signature.keyId,
    })}\n`,
  );

  console.log(`License issued: ${out}`);
  console.log(`Platform:        ${license.payload.platform.instanceId}`);
  console.log(`Activation code: ${license.payload.activationCode}`);
  console.log(`Ledger:          ${ledger}`);
}

function inspect(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { trusted: { type: 'string' } } });
  const file = positionals[0] ?? fail('usage: inspect <file.nxlic> [--trusted keys.json]');
  const envelope = licenseEnvelopeSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!envelope.success) fail('not a valid .nxlic envelope');
  const { payload, signature } = envelope.data;
  console.log(JSON.stringify(payload, null, 2));
  console.log(`\nSigned with key: ${signature.keyId}`);

  if (values.trusted) {
    const keys = JSON.parse(readFileSync(values.trusted, 'utf8')) as TrustedKey[];
    const key = keys.find((k) => k.keyId === signature.keyId && computeKeyId(k.publicKeyPem) === k.keyId);
    const ok =
      !!key &&
      verifyMessage(signingMessage(LICENSE_SIGNATURE_DOMAIN, canonicalize(payload)), signature.value, key.publicKeyPem);
    console.log(ok ? 'Signature: VALID' : `Signature: INVALID — ${LICENSE_ERRORS['NX-LIC-E005'].title}`);
    if (!ok) process.exit(2);
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'keygen':
    keygen(rest);
    break;
  case 'issue':
    issue(rest);
    break;
  case 'inspect':
    inspect(rest);
    break;
  default:
    console.log('usage: nxgen-license <keygen|issue|inspect> [options]   (see source header for details)');
    process.exit(command ? 1 : 0);
}
