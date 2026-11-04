import { z } from 'zod';
import { ACTIVATION_CODE_PATTERN } from './activation-code';
import { FINGERPRINT_ALGORITHM, FINGERPRINT_COMPONENTS, FingerprintComponent } from './fingerprint';
import { PLATFORM_INSTANCE_ID_PATTERN } from './platform-identity';

/**
 * .nxlic — NxGen signed license certificate, format version 1.
 *
 * {
 *   "format": "NXLIC",
 *   "formatVersion": 1,
 *   "payload":   { ...LicensePayload },
 *   "signature": { "algorithm": "Ed25519", "keyId": "nxk-…", "value": "<base64>" }
 * }
 *
 * The signature covers SIGNATURE_DOMAIN + canonicalize(payload), so the file
 * itself may be pretty-printed or re-serialized without breaking it, while any
 * change to a payload value invalidates it.
 */
export const LICENSE_FORMAT = 'NXLIC';
export const LICENSE_FORMAT_VERSION = 1;
export const LICENSE_SIGNATURE_DOMAIN = 'NXGEN-LICENSE-v1';
export const PRODUCT_CODE = 'NXGEN_PLATFORM';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z.string().datetime({ offset: true });

const componentShape = Object.fromEntries(
  FINGERPRINT_COMPONENTS.map((name) => [name, sha256Hex.optional()]),
) as Record<FingerprintComponent, z.ZodOptional<typeof sha256Hex>>;

export const hashedFingerprintSchema = z.object(componentShape).strict();

export const moduleEntitlementSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    expiresAt: isoDate.nullable(),
  })
  .strict();

export const licensePayloadSchema = z
  .object({
    licenseId: z.string().uuid(),
    activationCode: z.string().regex(ACTIVATION_CODE_PATTERN),
    product: z.literal(PRODUCT_CODE),
    customer: z
      .object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        site: z.string().max(200).optional(),
      })
      .strict(),
    licenseType: z.enum(['PERPETUAL', 'SUBSCRIPTION']),
    versionScope: z.object({ major: z.number().int().positive() }).strict(),
    issuedAt: isoDate,
    validFrom: isoDate,
    expiresAt: isoDate.nullable(),
    platform: z
      .object({
        instanceId: z.string().regex(PLATFORM_INSTANCE_ID_PATTERN),
        instanceUid: z.string().uuid(),
      })
      .strict(),
    machineBinding: z
      .object({
        algorithm: z.literal(FINGERPRINT_ALGORITHM),
        threshold: z.number().gt(0).max(1),
        components: hashedFingerprintSchema,
      })
      .strict(),
    entitlements: z
      .object({
        platform: z.boolean(),
        modules: z.array(moduleEntitlementSchema).max(64),
      })
      .strict(),
    limits: z
      .object({
        users: z.number().int().positive().nullable(),
        devices: z.number().int().positive().nullable(),
      })
      .strict(),
  })
  .strict()
  .refine((p) => p.licenseType !== 'SUBSCRIPTION' || p.expiresAt !== null, {
    message: 'SUBSCRIPTION licenses must have an expiry date',
    path: ['expiresAt'],
  });

export type LicensePayload = z.infer<typeof licensePayloadSchema>;
export type ModuleEntitlement = z.infer<typeof moduleEntitlementSchema>;

export const licenseEnvelopeSchema = z
  .object({
    format: z.literal(LICENSE_FORMAT),
    formatVersion: z.number().int(),
    payload: z.record(z.string(), z.unknown()),
    signature: z
      .object({
        algorithm: z.literal('Ed25519'),
        keyId: z.string().regex(/^nxk-[0-9a-f]{16}$/),
        value: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export interface LicenseFile {
  format: typeof LICENSE_FORMAT;
  formatVersion: number;
  payload: LicensePayload;
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
}
