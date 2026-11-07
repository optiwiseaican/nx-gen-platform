import { createHash, randomBytes, randomUUID } from 'crypto';
import { z } from 'zod';
import { canonicalize } from './canonical-json';
import { computeKeyId, publicKeyFromPrivate, signingMessage, signMessage, TrustedKey, verifyMessage } from './keys';
import { PLATFORM_INSTANCE_ID_PATTERN } from './platform-identity';

/**
 * Administrator recovery (support-assisted).
 *
 * When no Super Administrator can sign in, the site creates a recovery REQUEST
 * on the NxGen workstation and sends it to AICAN support. Support verifies the
 * customer through its own process and returns a recovery RESPONSE signed with
 * the vendor Ed25519 key. NxGen accepts the response only if:
 *   - the signature verifies against a trusted vendor key,
 *   - it names this platform instance, this request, its nonce and username,
 *   - it has not expired and the request has not been used.
 *
 * Unlike a shared secret baked into the application, the private key never
 * ships, so a recovery response cannot be forged on site.
 *
 * Request code:  NXRQ1.<base64url(canonical json)>.<check>     (not signed, safe to email)
 * Response code: NXRS1.<base64url(canonical json)>.<check>     (Ed25519 signed)
 */
export const RECOVERY_SIGNATURE_DOMAIN = 'NXGEN-RECOVERY-v1';
export const RECOVERY_REQUEST_TTL_HOURS = 24;
export const RECOVERY_RESPONSE_MAX_TTL_HOURS = 24;

export const recoveryRequestSchema = z
  .object({
    format: z.literal('NXRCV-REQ'),
    formatVersion: z.literal(1),
    requestId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    platform: z
      .object({
        instanceId: z.string().regex(PLATFORM_INSTANCE_ID_PATTERN),
        instanceUid: z.string().uuid(),
      })
      .strict(),
    username: z.string().min(1).max(64),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;

export const recoveryResponsePayloadSchema = z
  .object({
    format: z.literal('NXRCV'),
    formatVersion: z.literal(1),
    requestId: z.string().uuid(),
    platformInstanceUid: z.string().uuid(),
    username: z.string().min(1).max(64),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    supportReference: z.string().min(3).max(64),
    issuedBy: z.string().min(2).max(100),
  })
  .strict();
export type RecoveryResponsePayload = z.infer<typeof recoveryResponsePayloadSchema>;

const recoveryResponseSchema = z
  .object({
    payload: recoveryResponsePayloadSchema,
    signature: z
      .object({ algorithm: z.literal('Ed25519'), keyId: z.string(), value: z.string() })
      .strict(),
  })
  .strict();
export type RecoveryResponse = z.infer<typeof recoveryResponseSchema>;

function check(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 8);
}

function encode(prefix: string, value: unknown): string {
  const body = Buffer.from(canonicalize(value), 'utf8').toString('base64url');
  return `${prefix}.${body}.${check(body)}`;
}

function decode(prefix: string, input: string, what: string): unknown {
  const text = input.replace(/\s+/g, '');
  const [p, body, sum, extra] = text.split('.');
  if (p !== prefix || !body || !sum || extra !== undefined || check(body) !== sum) {
    throw new Error(`The ${what} is incomplete or was mistyped.`);
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`The ${what} is incomplete or was mistyped.`);
  }
}

export function createRecoveryRequest(input: {
  platform: { instanceId: string; instanceUid: string };
  username: string;
  now?: Date;
}): RecoveryRequest {
  const now = input.now ?? new Date();
  return recoveryRequestSchema.parse({
    format: 'NXRCV-REQ',
    formatVersion: 1,
    requestId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RECOVERY_REQUEST_TTL_HOURS * 3_600_000).toISOString(),
    platform: { instanceId: input.platform.instanceId, instanceUid: input.platform.instanceUid },
    username: input.username,
    nonce: randomBytes(16).toString('hex'),
  });
}

export const encodeRecoveryRequest = (r: RecoveryRequest) => encode('NXRQ1', r);
export const parseRecoveryRequest = (code: string): RecoveryRequest =>
  recoveryRequestSchema.parse(decode('NXRQ1', code, 'recovery request code'));

/** Vendor side only (tools/license-authority): useless without the private key. */
export function issueRecoveryResponse(input: {
  request: RecoveryRequest;
  privateKeyPem: string;
  supportReference: string;
  issuedBy: string;
  validHours?: number;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const { request } = input;
  if (new Date(request.expiresAt).getTime() <= now.getTime()) {
    throw new Error('This recovery request has expired. Ask the site to create a new one.');
  }
  const hours = Math.min(input.validHours ?? 4, RECOVERY_RESPONSE_MAX_TTL_HOURS);
  const expiresAt = new Date(Math.min(now.getTime() + hours * 3_600_000, new Date(request.expiresAt).getTime()));
  const payload = recoveryResponsePayloadSchema.parse({
    format: 'NXRCV',
    formatVersion: 1,
    requestId: request.requestId,
    platformInstanceUid: request.platform.instanceUid,
    username: request.username,
    nonce: request.nonce,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    supportReference: input.supportReference,
    issuedBy: input.issuedBy,
  });
  const keyId = computeKeyId(publicKeyFromPrivate(input.privateKeyPem));
  const value = signMessage(signingMessage(RECOVERY_SIGNATURE_DOMAIN, canonicalize(payload)), input.privateKeyPem);
  return encode('NXRS1', { payload, signature: { algorithm: 'Ed25519', keyId, value } });
}

export type RecoveryVerification =
  | { ok: true; payload: RecoveryResponsePayload; keyId: string }
  | { ok: false; reason: 'FORMAT' | 'UNTRUSTED_KEY' | 'BAD_SIGNATURE' | 'MISMATCH' | 'EXPIRED'; message: string };

/** Customer side: pure verification of a response against the pending request. */
export function verifyRecoveryResponse(
  code: string,
  expected: { requestId: string; platformInstanceUid: string; username: string; nonce: string },
  trustedKeys: TrustedKey[],
  now: Date = new Date(),
): RecoveryVerification {
  let response: RecoveryResponse;
  try {
    response = recoveryResponseSchema.parse(decode('NXRS1', code, 'recovery response code'));
  } catch (e) {
    return {
      ok: false,
      reason: 'FORMAT',
      message: e instanceof z.ZodError ? 'The recovery response code is not valid.' : (e as Error).message,
    };
  }
  const key = trustedKeys.find((k) => k.keyId === response.signature.keyId);
  if (!key) return { ok: false, reason: 'UNTRUSTED_KEY', message: 'The recovery response was not issued by AICAN.' };
  const message = signingMessage(RECOVERY_SIGNATURE_DOMAIN, canonicalize(response.payload));
  if (!verifyMessage(message, response.signature.value, key.publicKeyPem)) {
    return { ok: false, reason: 'BAD_SIGNATURE', message: 'The recovery response signature is not valid.' };
  }
  const p = response.payload;
  if (
    p.requestId !== expected.requestId ||
    p.platformInstanceUid !== expected.platformInstanceUid ||
    p.username !== expected.username ||
    p.nonce !== expected.nonce
  ) {
    return { ok: false, reason: 'MISMATCH', message: 'The recovery response belongs to a different request.' };
  }
  if (new Date(p.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: 'EXPIRED', message: 'The recovery response has expired. Create a new request.' };
  }
  return { ok: true, payload: p, keyId: key.keyId };
}

/**
 * The request a response claims to answer, read WITHOUT verifying it — only to
 * find the pending request to verify against. Returns null if unreadable.
 */
export function recoveryResponseRequestId(code: string): string | null {
  try {
    const parsed = recoveryResponseSchema.safeParse(decode('NXRS1', code, 'recovery response code'));
    return parsed.success ? parsed.data.payload.requestId : null;
  } catch {
    return null;
  }
}
