import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  collectFingerprint,
  computeKeyId,
  HashedFingerprint,
  LICENSE_ERRORS,
  LicenseErrorCode,
  licenseEnvelopeSchema,
  TrustedKey,
  verifyLicense,
} from '@crescent/licensing';

/**
 * Independent license verification in the Electron main process
 * (Technical Architecture §2: "Validate in the Electron main process and
 * NestJS API").
 *
 * The shell does not take the License Service's word for it. It fetches the
 * signed certificate and re-verifies it with:
 *   - its OWN bundled trusted public keys,
 *   - its OWN hardware fingerprint of the machine it is running on,
 *   - its OWN clock.
 * A replaced/tampered API process or an installation copied to another PC
 * therefore still fails here.
 */

export interface ServiceStatus {
  platform: { instanceId: string | null; version: string };
  installation: { verification: string };
  license: { state: string; errorCode: string | null };
}

export type ShellLicenseResult =
  | { kind: 'SERVICE_UNAVAILABLE' }
  | { kind: 'NOT_ACTIVE'; state: string; errorCode: string | null }
  | { kind: 'VERIFIED'; instanceId: string; licenseId: string }
  | { kind: 'REJECTED'; errorCode: LicenseErrorCode; title: string; message: string };

export function loadShellTrustedKeys(configDir: string, production: boolean): TrustedKey[] {
  const files = ['trusted-license-keys.json', ...(production ? [] : ['trusted-license-keys.dev.json'])];
  const keys: TrustedKey[] = [];
  for (const file of files) {
    const path = join(configDir, file);
    if (!existsSync(path)) continue;
    for (const entry of JSON.parse(readFileSync(path, 'utf8')) as TrustedKey[]) {
      if (computeKeyId(entry.publicKeyPem) === entry.keyId) keys.push(entry);
    }
  }
  return keys;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function verifyCertificate(
  certificate: string,
  status: ServiceStatus,
  ctx: { trustedKeys: TrustedKey[]; fingerprint: HashedFingerprint; platformVersion: string; now?: Date },
): ShellLicenseResult {
  const reject = (errorCode: LicenseErrorCode): ShellLicenseResult => ({
    kind: 'REJECTED',
    errorCode,
    title: LICENSE_ERRORS[errorCode].title,
    message: LICENSE_ERRORS[errorCode].message,
  });

  const envelope = licenseEnvelopeSchema.safeParse(
    (() => {
      try {
        return JSON.parse(certificate) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!envelope.success) return reject(LicenseErrorCode.PACKAGE_CORRUPTED);

  // The certificate names the platform UID it was issued for; it must derive the
  // Platform Instance ID the service reports, and the signature covers both.
  const platform = envelope.data.payload.platform as { instanceUid?: unknown } | undefined;
  const instanceUid = typeof platform?.instanceUid === 'string' ? platform.instanceUid : '';
  if (!status.platform.instanceId) return reject(LicenseErrorCode.PLATFORM_IDENTITY_INVALID);

  const result = verifyLicense(certificate, {
    installationVerified: status.installation.verification.startsWith('PASS'),
    platform: { instanceUid, instanceId: status.platform.instanceId },
    platformVersion: ctx.platformVersion,
    fingerprint: ctx.fingerprint,
    trustedKeys: ctx.trustedKeys,
    now: ctx.now ?? new Date(),
  });
  if (!result.ok) return reject(result.errorCode!);
  return { kind: 'VERIFIED', instanceId: status.platform.instanceId, licenseId: result.license!.licenseId };
}

export async function checkLicense(
  apiBase: string,
  trustedKeys: TrustedKey[],
  fingerprint: () => Promise<HashedFingerprint> = collectFingerprint,
): Promise<ShellLicenseResult> {
  let status: ServiceStatus;
  try {
    status = await getJson<ServiceStatus>(`${apiBase}/api/licensing/status`);
  } catch {
    return { kind: 'SERVICE_UNAVAILABLE' };
  }
  if (status.license.state !== 'ACTIVE') {
    return { kind: 'NOT_ACTIVE', state: status.license.state, errorCode: status.license.errorCode };
  }

  let certificate: string | null;
  try {
    certificate = (await getJson<{ license: string | null }>(`${apiBase}/api/licensing/certificate`)).license;
  } catch {
    return { kind: 'SERVICE_UNAVAILABLE' };
  }
  // Service claims ACTIVE but cannot produce a certificate: do not trust the claim.
  if (!certificate) return { kind: 'NOT_ACTIVE', state: 'ACTIVATION_ERROR', errorCode: LicenseErrorCode.LICENSE_NOT_FOUND };

  return verifyCertificate(certificate, status, {
    trustedKeys,
    fingerprint: await fingerprint(),
    platformVersion: status.platform.version,
  });
}
