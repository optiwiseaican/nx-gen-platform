import { createHash } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import { z } from 'zod';
import { canonicalize } from './canonical-json';
import { computeKeyId, publicKeyFromPrivate, signingMessage, signMessage, TrustedKey, verifyMessage } from './keys';

/**
 * Signed module packages (.nxmod) — Technical Architecture §3–§6, Option B.
 *
 * A package carries module.json, a compiled API bundle, a static UI bundle and
 * SQL migrations. The vendor signs the manifest together with the SHA-256 of
 * every file, so the core can prove on install AND at every start-up that the
 * code it runs is exactly what AICAN released.
 *
 * File layout: gzip( canonical JSON {
 *   format: "NXMOD", formatVersion: 1,
 *   manifest, files: [{ path, sha256, size, content(base64) }],
 *   signature: { algorithm: "Ed25519", keyId, value } } )
 * Signed message: "NXGEN-MODULE-v1\n" + canonical({ manifest, files: [{path, sha256, size}] })
 */
export const MODULE_SIGNATURE_DOMAIN = 'NXGEN-MODULE-v1';
export const MODULE_CORE_API_VERSION = 1;
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

const SEMVER = /^\d+\.\d+\.\d+$/;
const PERMISSION = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/;
/** Files a package may contain. */
export const MODULE_FILE_PATH = /^(api\/[A-Za-z0-9._/-]+\.js|ui\/[A-Za-z0-9._/@-]+|migrations\/\d{3}_[a-z0-9_]+\.sql)$/;

export const moduleManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    name: z.string().min(2).max(80),
    version: z.string().regex(SEMVER),
    description: z.string().max(500).default(''),
    /** Core API contract this module was built against. */
    coreApi: z.literal(MODULE_CORE_API_VERSION),
    minCoreVersion: z.string().regex(SEMVER),
    /** Licence entitlement that must be present (normally equal to id). */
    entitlement: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    /** All tables the module creates must start with this. */
    tablePrefix: z.string().regex(/^[a-z][a-z0-9]{1,15}_$/),
    apiEntry: z.string().regex(/^api\/[A-Za-z0-9._/-]+\.js$/),
    uiEntry: z.string().regex(/^ui\/[A-Za-z0-9._/-]+\.html$/).nullable(),
    instrumentTypes: z
      .array(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,15}$/), label: z.string().min(2).max(60) }).strict())
      .max(8),
    permissions: z
      .array(
        z
          .object({
            code: z.string().regex(PERMISSION),
            description: z.string().min(3).max(200),
            defaultRoles: z.array(z.string().regex(/^[A-Z][A-Z_]{1,40}$/)).max(10),
          })
          .strict(),
      )
      .max(40),
    menu: z
      .array(
        z
          .object({
            label: z.string().min(2).max(40),
            path: z.string().regex(/^\/[A-Za-z0-9._/?=&-]*$/),
            permission: z.string().regex(PERMISSION),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.tablePrefix !== `${m.id.replace(/-/g, '')}_`)
      ctx.addIssue({ code: 'custom', message: 'tablePrefix must be the module id followed by "_"' });
    for (const p of m.permissions)
      if (!p.code.startsWith(`${m.id}.`)) ctx.addIssue({ code: 'custom', message: `Permission ${p.code} must start with "${m.id}."` });
  });
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

const fileSchema = z
  .object({
    path: z.string().regex(MODULE_FILE_PATH),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    content: z.string(),
  })
  .strict();

const packageSchema = z
  .object({
    format: z.literal('NXMOD'),
    formatVersion: z.literal(1),
    manifest: z.unknown(),
    files: z.array(fileSchema).min(1).max(2000),
    signature: z.object({ algorithm: z.literal('Ed25519'), keyId: z.string(), value: z.string() }).strict(),
  })
  .strict();

export interface ModuleFile {
  path: string;
  data: Buffer;
}

export interface VerifiedModulePackage {
  manifest: ModuleManifest;
  files: ModuleFile[];
  /** path → sha256, kept by the core to re-check installed files at start-up. */
  fileHashes: Record<string, string>;
  keyId: string;
  packageSha256: string;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function signedBody(manifest: unknown, files: { path: string; sha256: string; size: number }[]) {
  return canonicalize({ manifest, files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) });
}

/** Vendor side (tools/license-authority): build and sign a package. */
export function packModule(input: { manifest: unknown; files: ModuleFile[]; privateKeyPem: string }): Buffer {
  const manifest = moduleManifestSchema.parse(input.manifest);
  const files = [...input.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      if (!MODULE_FILE_PATH.test(f.path)) throw new Error(`File not allowed in a module package: ${f.path}`);
      return { path: f.path, sha256: sha256(f.data), size: f.data.length, content: f.data.toString('base64') };
    });
  for (const required of [manifest.apiEntry, ...(manifest.uiEntry ? [manifest.uiEntry] : [])])
    if (!files.some((f) => f.path === required)) throw new Error(`Package is missing ${required}`);
  const keyId = computeKeyId(publicKeyFromPrivate(input.privateKeyPem));
  const value = signMessage(signingMessage(MODULE_SIGNATURE_DOMAIN, signedBody(manifest, files)), input.privateKeyPem);
  return gzipSync(canonicalize({ format: 'NXMOD', formatVersion: 1, manifest, files, signature: { algorithm: 'Ed25519', keyId, value } }));
}

export type ModuleVerification =
  | { ok: true; pkg: VerifiedModulePackage }
  | { ok: false; reason: 'FORMAT' | 'UNTRUSTED_KEY' | 'BAD_SIGNATURE' | 'FILE_MISMATCH' | 'MANIFEST'; message: string };

/** Customer side: verify a package before anything is extracted or run. */
export function verifyModulePackage(data: Buffer, trustedKeys: TrustedKey[]): ModuleVerification {
  if (data.length > MAX_PACKAGE_BYTES) return { ok: false, reason: 'FORMAT', message: 'The module package is larger than 50 MB.' };
  let parsed: z.infer<typeof packageSchema>;
  try {
    parsed = packageSchema.parse(JSON.parse(gunzipSync(data, { maxOutputLength: 4 * MAX_PACKAGE_BYTES }).toString('utf8')));
  } catch {
    return { ok: false, reason: 'FORMAT', message: 'This file is not a valid NxGen module package (.nxmod).' };
  }
  const key = trustedKeys.find((k) => k.keyId === parsed.signature.keyId);
  if (!key) return { ok: false, reason: 'UNTRUSTED_KEY', message: 'The module package was not signed by AICAN.' };
  if (!verifyMessage(signingMessage(MODULE_SIGNATURE_DOMAIN, signedBody(parsed.manifest, parsed.files)), parsed.signature.value, key.publicKeyPem))
    return { ok: false, reason: 'BAD_SIGNATURE', message: 'The module package signature is not valid. It may have been altered.' };

  const files: ModuleFile[] = [];
  const fileHashes: Record<string, string> = {};
  const seen = new Set<string>();
  for (const f of parsed.files) {
    const buf = Buffer.from(f.content, 'base64');
    if (seen.has(f.path) || buf.length !== f.size || sha256(buf) !== f.sha256)
      return { ok: false, reason: 'FILE_MISMATCH', message: `File ${f.path} does not match its signed hash.` };
    seen.add(f.path);
    files.push({ path: f.path, data: buf });
    fileHashes[f.path] = f.sha256;
  }
  const manifest = moduleManifestSchema.safeParse(parsed.manifest);
  if (!manifest.success)
    return { ok: false, reason: 'MANIFEST', message: `module.json is not valid: ${manifest.error.issues.map((i) => i.message).join('; ')}` };
  if (!seen.has(manifest.data.apiEntry))
    return { ok: false, reason: 'MANIFEST', message: `The package is missing ${manifest.data.apiEntry}.` };
  return { ok: true, pkg: { manifest: manifest.data, files, fileHashes, keyId: key.keyId, packageSha256: sha256(data) } };
}

/** a < b → negative. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
