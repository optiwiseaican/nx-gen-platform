import { randomUUID } from 'crypto';
import { canonicalize } from './canonical-json';
import { generateActivationCode } from './activation-code';
import { bindingWeight, DEFAULT_MATCH_THRESHOLD, MIN_BINDING_WEIGHT } from './fingerprint';
import { computeKeyId, publicKeyFromPrivate, signingMessage, signMessage } from './keys';
import { ActivationRequest } from './request';
import {
  LICENSE_FORMAT,
  LICENSE_FORMAT_VERSION,
  LICENSE_SIGNATURE_DOMAIN,
  LicenseFile,
  LicensePayload,
  licensePayloadSchema,
  ModuleEntitlement,
  PRODUCT_CODE,
} from './schema';

/**
 * License issuance — used ONLY by the vendor License Authority
 * (tools/license-authority). The code is harmless on a customer machine
 * because it is useless without the private key, which never ships.
 */
export interface IssueLicenseInput {
  request: ActivationRequest;
  privateKeyPem: string;
  customer: { id: string; name: string; site?: string };
  licenseType: 'PERPETUAL' | 'SUBSCRIPTION';
  expiresAt?: Date | null;
  validFrom?: Date;
  modules?: ModuleEntitlement[];
  limits?: { users: number | null; devices: number | null };
  /** Defaults to the major version in the request. */
  versionMajor?: number;
  matchThreshold?: number;
  activationCode?: string;
  now?: Date;
}

export function signLicensePayload(payload: LicensePayload, privateKeyPem: string): LicenseFile {
  const validated = licensePayloadSchema.parse(payload);
  const keyId = computeKeyId(publicKeyFromPrivate(privateKeyPem));
  const value = signMessage(signingMessage(LICENSE_SIGNATURE_DOMAIN, canonicalize(validated)), privateKeyPem);
  return {
    format: LICENSE_FORMAT,
    formatVersion: LICENSE_FORMAT_VERSION,
    payload: validated,
    signature: { algorithm: 'Ed25519', keyId, value },
  };
}

export function issueLicense(input: IssueLicenseInput): LicenseFile {
  const { request } = input;
  const components = request.machineFingerprint.components;
  if (bindingWeight(components) < MIN_BINDING_WEIGHT) {
    throw new Error(
      `Activation request has too few stable machine identifiers (weight ${bindingWeight(components)}, ` +
        `minimum ${MIN_BINDING_WEIGHT}). Collect the request on the target workstation with administrator rights.`,
    );
  }

  const now = input.now ?? new Date();
  const payload: LicensePayload = {
    licenseId: randomUUID(),
    activationCode: input.activationCode ?? generateActivationCode(),
    product: PRODUCT_CODE,
    customer: input.customer,
    licenseType: input.licenseType,
    versionScope: { major: input.versionMajor ?? Number(request.platform.version.split('.')[0]) },
    issuedAt: now.toISOString(),
    validFrom: (input.validFrom ?? now).toISOString(),
    expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    platform: { instanceId: request.platform.instanceId, instanceUid: request.platform.instanceUid },
    machineBinding: {
      algorithm: request.machineFingerprint.algorithm,
      threshold: input.matchThreshold ?? DEFAULT_MATCH_THRESHOLD,
      components,
    },
    entitlements: { platform: true, modules: input.modules ?? [] },
    limits: input.limits ?? { users: null, devices: null },
  };
  return signLicensePayload(payload, input.privateKeyPem);
}

export function serializeLicenseFile(license: LicenseFile): string {
  return `${JSON.stringify(license, null, 2)}\n`;
}
