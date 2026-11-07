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
 *   nxgen-license recover --key <private.pem> --request <NXRQ1-code> --ticket <support ref>
 *                         --issued-by <support engineer> [--hours N (default 4, max 24)] [--ledger <file.jsonl>]
 *       Administrator recovery: verify the customer through the support process FIRST,
 *       then sign a one-time response bound to that platform, request and username.
 *   nxgen-license module-pack --key <private.pem> --dir <built module dir> --out <file.nxmod>
 *       Sign a module build (module.json + api/ + ui/ + migrations/) as a .nxmod package.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { parseArgs } from 'util';
import {
  canonicalize,
  computeKeyId,
  generateSigningKeyPair,
  issueLicense,
  issueRecoveryResponse,
  packModule,
  publicKeyFromPrivate,
  verifyModulePackage,
  parseRecoveryRequest,
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

function recover(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: 'string' },
      request: { type: 'string' },
      ticket: { type: 'string' },
      'issued-by': { type: 'string' },
      hours: { type: 'string' },
      ledger: { type: 'string' },
    },
  });
  if (!values.key || !values.request || !values.ticket || !values['issued-by']) {
    fail('usage: recover --key <private.pem> --request <NXRQ1-code|file> --ticket <ref> --issued-by <name> [--hours N]');
  }
  const raw = existsSync(values.request) ? readFileSync(values.request, 'utf8') : values.request;
  let request;
  try {
    request = parseRecoveryRequest(raw);
  } catch (e) {
    fail((e as Error).message);
  }
  const hours = values.hours ? parsePositiveInt(values.hours, '--hours') ?? 4 : 4;
  let code: string;
  try {
    code = issueRecoveryResponse({
      request,
      privateKeyPem: readFileSync(values.key, 'utf8'),
      supportReference: values.ticket,
      issuedBy: values['issued-by'],
      validHours: hours,
    });
  } catch (e) {
    fail((e as Error).message);
  }
  const ledger = resolve(values.ledger ?? join(dirname(resolve(values.key)), '..', 'issued-recoveries.jsonl'));
  appendFileSync(
    ledger,
    JSON.stringify({
      issuedAt: new Date().toISOString(),
      requestId: request.requestId,
      platformInstanceId: request.platform.instanceId,
      username: request.username,
      ticket: values.ticket,
      issuedBy: values['issued-by'],
    }) + '\n',
    { mode: 0o600 },
  );
  console.log(`Platform:  ${request.platform.instanceId}`);
  console.log(`Username:  ${request.username}`);
  console.log(`Request:   ${request.requestId} (created ${request.createdAt})`);
  console.log(`Ledger:    ${ledger}`);
  console.log('\nRecovery response code (single use, give only to the verified customer contact):\n');
  console.log(code);
}

function modulePack(args: string[]) {
  const { values } = parseArgs({ args, options: { key: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' } } });
  if (!values.key || !values.dir || !values.out) fail('usage: module-pack --key <private.pem> --dir <built module dir> --out <file.nxmod>');
  const dir = resolve(values.dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')) as unknown;
  const files: { path: string; data: Buffer }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path: relative(dir, full).split(sep).join('/'), data: readFileSync(full) });
    }
  };
  for (const sub of ['api', 'ui', 'migrations']) if (existsSync(join(dir, sub))) walk(join(dir, sub));
  const privateKeyPem = readFileSync(values.key, 'utf8');
  let pkg: Buffer;
  try {
    pkg = packModule({ manifest, files, privateKeyPem });
  } catch (e) {
    fail((e as Error).message);
  }
  const check = verifyModulePackage(pkg, [{ keyId: computeKeyId(publicKeyFromPrivate(privateKeyPem)), publicKeyPem: publicKeyFromPrivate(privateKeyPem) }]);
  if (!check.ok) fail(`self-check failed: ${check.message}`);
  writeFileSync(values.out, pkg);
  console.log(`Module:   ${check.pkg.manifest.id} ${check.pkg.manifest.version} (${files.length} files)`);
  console.log(`Signed:   ${check.pkg.keyId}`);
  console.log(`SHA-256:  ${check.pkg.packageSha256}`);
  console.log(`Package:  ${resolve(values.out)}`);
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
  case 'recover':
    recover(rest);
    break;
  case 'module-pack':
    modulePack(rest);
    break;
  default:
    console.log('usage: nxgen-license <keygen|issue|inspect|recover|module-pack> [options]   (see source header for details)');
    process.exit(command ? 1 : 0);
}
