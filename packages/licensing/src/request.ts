import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { canonicalize } from './canonical-json';
import { FINGERPRINT_ALGORITHM, HashedFingerprint } from './fingerprint';
import { PlatformIdentity, PLATFORM_INSTANCE_ID_PATTERN } from './platform-identity';
import { hashedFingerprintSchema } from './schema';

/**
 * Activation request (.nxreq) — produced on the lab workstation by a service /
 * commissioning function (License PRD §6), carried to the License Authority on
 * approved media, and turned into a bound .nxlic.
 *
 * It contains only identifiers and hashed fingerprint components: no secrets,
 * so it is safe to email. It is not signed: the License Authority decides what
 * to issue, and the resulting license is what gets signed.
 *
 * Compact code form for copy/paste: NXR1.<base64url(canonical json)>.<check>
 */
export const REQUEST_FORMAT = 'NXREQ';

export const activationRequestSchema = z
  .object({
    format: z.literal(REQUEST_FORMAT),
    formatVersion: z.literal(1),
    requestId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    platform: z
      .object({
        instanceId: z.string().regex(PLATFORM_INSTANCE_ID_PATTERN),
        instanceUid: z.string().uuid(),
        version: z.string().regex(/^\d+\.\d+\.\d+/),
      })
      .strict(),
    machineFingerprint: z
      .object({
        algorithm: z.literal(FINGERPRINT_ALGORITHM),
        components: hashedFingerprintSchema,
      })
      .strict(),
  })
  .strict();

export type ActivationRequest = z.infer<typeof activationRequestSchema>;

export function createActivationRequest(input: {
  platform: PlatformIdentity;
  platformVersion: string;
  fingerprint: HashedFingerprint;
  now?: Date;
}): ActivationRequest {
  return {
    format: REQUEST_FORMAT,
    formatVersion: 1,
    requestId: randomUUID(),
    createdAt: (input.now ?? new Date()).toISOString(),
    platform: {
      instanceId: input.platform.instanceId,
      instanceUid: input.platform.instanceUid,
      version: input.platformVersion,
    },
    machineFingerprint: { algorithm: FINGERPRINT_ALGORITHM, components: input.fingerprint },
  };
}

function check(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 8);
}

export function encodeRequestCode(request: ActivationRequest): string {
  const body = Buffer.from(canonicalize(request), 'utf8').toString('base64url');
  return `NXR1.${body}.${check(body)}`;
}

/** Accepts either a compact request code or the JSON contents of a .nxreq file. */
export function parseActivationRequest(input: string): ActivationRequest {
  const text = input.trim();
  let json: unknown;
  if (text.startsWith('NXR1.')) {
    const [, body, sum] = text.split('.');
    if (!body || !sum || check(body) !== sum) {
      throw new Error('Activation request code is incomplete or was mistyped');
    }
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } else {
    json = JSON.parse(text);
  }
  return activationRequestSchema.parse(json);
}
