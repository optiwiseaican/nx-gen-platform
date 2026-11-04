import { canonicalize } from './canonical-json';
import { LicenseErrorCode } from './errors';
import { FingerprintMatch, HashedFingerprint, matchFingerprint } from './fingerprint';
import { signingMessage, TrustedKey, verifyMessage } from './keys';
import { isValidPlatformIdentity, PlatformIdentity } from './platform-identity';
import {
  LICENSE_FORMAT,
  LICENSE_FORMAT_VERSION,
  LICENSE_SIGNATURE_DOMAIN,
  licenseEnvelopeSchema,
  LicensePayload,
  licensePayloadSchema,
} from './schema';

/**
 * Local, offline license verification (License PRD §19–§22, §35).
 *
 * This is a pure function: no I/O, no clock reads, no network. Everything it
 * needs is passed in, which makes it identical at activation time and at every
 * application start, and fully testable.
 *
 * The step list mirrors the progress shown on activation Screen 2 (PRD §18).
 * STORED and FINALIZED are completed by the caller after it has persisted the
 * license.
 */
export const ACTIVATION_STEPS = [
  { id: 'INSTALLATION', label: 'Installation verified' },
  { id: 'PLATFORM_INSTANCE', label: 'Platform Instance verified' },
  { id: 'LICENSE', label: 'License verified' },
  { id: 'ENTITLEMENT', label: 'Commercial entitlement verified' },
  { id: 'AUTHORIZED', label: 'Platform license authorized' },
  { id: 'BINDING', label: 'Platform binding verified' },
  { id: 'STORED', label: 'License stored securely' },
  { id: 'FINALIZED', label: 'Finalizing activation' },
] as const;

export type ActivationStepId = (typeof ACTIVATION_STEPS)[number]['id'];
export type CheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export interface VerificationCheck {
  id: ActivationStepId;
  label: string;
  status: CheckStatus;
}

export interface VerificationContext {
  installationVerified: boolean;
  platform: PlatformIdentity | null;
  /** Installed NxGen Platform version, e.g. "2.0.0". */
  platformVersion: string;
  fingerprint: HashedFingerprint;
  trustedKeys: TrustedKey[];
  now: Date;
  /** Latest time this installation has previously observed (clock-rollback evidence). */
  lastTrustedTime?: Date | null;
  clockRollbackToleranceMs?: number;
  /** When set, the license must carry exactly this activation code. */
  expectedActivationCode?: string;
}

export interface VerificationResult {
  ok: boolean;
  errorCode?: LicenseErrorCode;
  checks: VerificationCheck[];
  warnings: LicenseErrorCode[];
  license?: LicensePayload;
  fingerprint?: FingerprintMatch;
}

export const DEFAULT_CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const VALID_FROM_SKEW_MS = 5 * 60 * 1000;

class StepFailure extends Error {
  constructor(readonly code: LicenseErrorCode) {
    super(code);
  }
}

export function verifyLicense(licenseText: string, ctx: VerificationContext): VerificationResult {
  const checks: VerificationCheck[] = ACTIVATION_STEPS.map((s) => ({ ...s, status: 'NOT_RUN' as CheckStatus }));
  const warnings: LicenseErrorCode[] = [];
  let license: LicensePayload | undefined;
  let fingerprint: FingerprintMatch | undefined;

  const step = (id: ActivationStepId, fn: () => void) => {
    const check = checks.find((c) => c.id === id)!;
    try {
      fn();
      check.status = 'PASS';
    } catch (err) {
      check.status = 'FAIL';
      throw err;
    }
  };

  try {
    step('INSTALLATION', () => {
      if (!ctx.installationVerified) throw new StepFailure(LicenseErrorCode.INSTALLATION_NOT_VERIFIED);
    });

    step('PLATFORM_INSTANCE', () => {
      if (!isValidPlatformIdentity(ctx.platform)) throw new StepFailure(LicenseErrorCode.PLATFORM_IDENTITY_INVALID);
    });

    step('LICENSE', () => {
      license = readAndVerifySignature(licenseText, ctx.trustedKeys);
      if (ctx.expectedActivationCode && license.activationCode !== ctx.expectedActivationCode) {
        throw new StepFailure(LicenseErrorCode.CODE_MISMATCH);
      }
    });
    const lic = license!;

    step('ENTITLEMENT', () => {
      if (!lic.entitlements.platform) throw new StepFailure(LicenseErrorCode.PLATFORM_ENTITLEMENT_MISSING);
      const installedMajor = Number(ctx.platformVersion.split('.')[0]);
      if (lic.versionScope.major !== installedMajor) throw new StepFailure(LicenseErrorCode.VERSION_NOT_COVERED);
    });

    step('AUTHORIZED', () => {
      const now = ctx.now.getTime();
      const tolerance = ctx.clockRollbackToleranceMs ?? DEFAULT_CLOCK_ROLLBACK_TOLERANCE_MS;
      const evidence = Math.max(ctx.lastTrustedTime?.getTime() ?? 0, Date.parse(lic.issuedAt));
      if (now < evidence - tolerance) {
        // Only time-limited licenses depend on the clock; for perpetual ones this is a warning (PRD §38).
        if (lic.expiresAt !== null) throw new StepFailure(LicenseErrorCode.TIME_INTEGRITY);
        warnings.push(LicenseErrorCode.TIME_INTEGRITY);
      }
      if (Date.parse(lic.validFrom) > now + VALID_FROM_SKEW_MS) throw new StepFailure(LicenseErrorCode.LICENSE_INACTIVE);
      if (lic.expiresAt !== null && Date.parse(lic.expiresAt) <= now) {
        throw new StepFailure(LicenseErrorCode.LICENSE_EXPIRED);
      }
    });

    step('BINDING', () => {
      const p = ctx.platform!;
      if (lic.platform.instanceUid !== p.instanceUid || lic.platform.instanceId !== p.instanceId) {
        throw new StepFailure(LicenseErrorCode.WRONG_PLATFORM_INSTANCE);
      }
      fingerprint = matchFingerprint(lic.machineBinding.components, ctx.fingerprint, lic.machineBinding.threshold);
      if (!fingerprint.pass) throw new StepFailure(LicenseErrorCode.HARDWARE_CHANGED);
    });

    return { ok: true, checks, warnings, license, fingerprint };
  } catch (err) {
    const errorCode = err instanceof StepFailure ? err.code : LicenseErrorCode.SERVICE_UNAVAILABLE;
    return { ok: false, errorCode, checks, warnings, license, fingerprint };
  }
}

function readAndVerifySignature(licenseText: string, trustedKeys: TrustedKey[]): LicensePayload {
  let raw: unknown;
  try {
    raw = JSON.parse(licenseText);
  } catch {
    throw new StepFailure(LicenseErrorCode.PACKAGE_CORRUPTED);
  }

  const header = raw as { format?: unknown; formatVersion?: unknown } | null;
  if (!header || typeof header !== 'object' || header.format !== LICENSE_FORMAT) {
    throw new StepFailure(LicenseErrorCode.UNSUPPORTED_FORMAT);
  }
  if (header.formatVersion !== LICENSE_FORMAT_VERSION) throw new StepFailure(LicenseErrorCode.UNSUPPORTED_FORMAT);

  const envelope = licenseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new StepFailure(LicenseErrorCode.PACKAGE_CORRUPTED);

  // Signature first: never interpret payload contents that the vendor did not sign.
  const { keyId, value } = envelope.data.signature;
  const key = trustedKeys.find((k) => k.keyId === keyId);
  if (!key) throw new StepFailure(LicenseErrorCode.INVALID_SIGNATURE);

  let message: Buffer;
  try {
    message = signingMessage(LICENSE_SIGNATURE_DOMAIN, canonicalize(envelope.data.payload));
  } catch {
    throw new StepFailure(LicenseErrorCode.INVALID_SIGNATURE);
  }
  if (!verifyMessage(message, value, key.publicKeyPem)) throw new StepFailure(LicenseErrorCode.INVALID_SIGNATURE);

  const payload = licensePayloadSchema.safeParse(envelope.data.payload);
  if (!payload.success) throw new StepFailure(LicenseErrorCode.UNSUPPORTED_FORMAT);
  return payload.data;
}

/** Lightweight peek used for package discovery; does NOT establish trust. */
export function peekActivationCode(licenseText: string): string | null {
  try {
    const raw = JSON.parse(licenseText) as { payload?: { activationCode?: unknown } };
    return typeof raw?.payload?.activationCode === 'string' ? raw.payload.activationCode : null;
  } catch {
    return null;
  }
}
