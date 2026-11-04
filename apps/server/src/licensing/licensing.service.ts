import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ACTIVATION_STEPS,
  ActivationStepId,
  createActivationRequest,
  encodeRequestCode,
  HashedFingerprint,
  isValidPlatformIdentity,
  LICENSE_ERRORS,
  LicenseErrorCode,
  LicenseErrorInfo,
  LicensePayload,
  LicenseState,
  ModuleEntitlement,
  parseActivationCode,
  VerificationCheck,
  VerificationContext,
  verifyLicense,
} from '@crescent/licensing';
import {
  AuditEventInput,
  AuditService,
  SYSTEM_LICENSE_SERVICE,
} from '../audit/audit.service';
import { NXGEN_CONFIG, PLATFORM_NAME } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { LicenseStoreService } from './license-store.service';
import { TimeIntegrityService } from './time-integrity.service';

export const FINGERPRINT_PROVIDER = Symbol('FINGERPRINT_PROVIDER');
export type FingerprintProvider = () => Promise<HashedFingerprint>;

export interface ActivationOutcome {
  ok: boolean;
  state: LicenseState;
  checks: VerificationCheck[];
  errorCode?: LicenseErrorCode;
  error?: LicenseErrorInfo;
  /** Screen 1 should offer "Select License File" (PRD §15). */
  licensePackageRequired?: boolean;
  /** Inline activation-code validation failure (PRD §16). */
  inputError?: 'EMPTY' | 'FORMAT' | 'CHECKSUM';
}

export interface LicensingStatus {
  platform: { name: string; version: string; instanceId: string | null };
  installation: {
    verification: string;
    environment: 'Verified' | 'Not verified';
    status: 'Complete' | 'Not installed';
  };
  license: {
    state: LicenseState;
    /** Previously activated platform that is no longer ACTIVE → restricted (preservation) mode, PRD §40. */
    restricted: boolean;
    errorCode: LicenseErrorCode | null;
    error: LicenseErrorInfo | null;
  };
  warnings: LicenseErrorCode[];
}

/** States in which a failed re-activation attempt must not overwrite the current state. */
const STICKY_STATES: LicenseState[] = [
  LicenseState.ACTIVE,
  LicenseState.REACTIVATION_REQUIRED,
  LicenseState.EXPIRED,
];

function checksFailingAt(
  failed: ActivationStepId | null,
  passedThrough?: ActivationStepId,
): VerificationCheck[] {
  let reached = false;
  return ACTIVATION_STEPS.map((s) => {
    if (s.id === failed) {
      reached = true;
      return { ...s, status: 'FAIL' };
    }
    const status = reached ? 'NOT_RUN' : 'PASS';
    if (passedThrough && s.id === passedThrough) reached = true;
    return { ...s, status };
  });
}

/**
 * NxGen License & Entitlement Service.
 *
 * Owns the platform license state. Activation is transactional (PRD §48):
 * verify everything → store → audit → commit ACTIVE; any failure leaves the
 * previous state and stored license untouched. Licensing never touches
 * regulated data (PRD §39).
 */
@Injectable()
export class LicensingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LicensingService.name);
  private state: LicenseState = LicenseState.NOT_ACTIVATED;
  private license: LicensePayload | null = null;
  private lastErrorCode: LicenseErrorCode | null = null;
  private warnings: LicenseErrorCode[] = [];
  private activating = false;

  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly platform: PlatformIdentityService,
    private readonly store: LicenseStoreService,
    private readonly time: TimeIntegrityService,
    private readonly audit: AuditService,
    @Inject(FINGERPRINT_PROVIDER)
    private readonly fingerprint: FingerprintProvider,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.trustedKeys.length === 0) {
      this.logger.warn(
        'No trusted license-signing keys configured; activation will fail with NX-LIC-E005.',
      );
    }
    await this.validateStoredLicense();
  }

  private context(
    fingerprint: HashedFingerprint,
    expectedActivationCode?: string,
  ): VerificationContext {
    const { identity, intact } = this.platform.getIdentity();
    return {
      installationVerified: this.platform.isInstallationVerified(),
      platform: intact ? identity : null,
      platformVersion: this.config.platformVersion,
      fingerprint,
      trustedKeys: this.config.trustedKeys,
      now: new Date(),
      lastTrustedTime: this.time.lastTrustedTime(),
      clockRollbackToleranceMs: this.config.clockRollbackToleranceMs,
      expectedActivationCode,
    };
  }

  private event(
    e: Omit<AuditEventInput, 'category' | 'actor' | 'platformInstanceId'>,
  ): void {
    this.audit.record({
      category: 'LICENSING',
      actor: SYSTEM_LICENSE_SERVICE,
      platformInstanceId:
        this.platform.getIdentity().identity?.instanceId ?? null,
      ...e,
    });
  }

  // ---------------------------------------------------------------------------
  // Runtime validation (PRD §35): at every start, from the signature, offline.
  // ---------------------------------------------------------------------------

  async validateStoredLicense(): Promise<LicenseState> {
    const previousState = this.state;
    try {
      if (!this.store.hasActive()) {
        this.setState(LicenseState.NOT_ACTIVATED, null, null);
        return this.state;
      }

      const { identity, intact } = this.platform.getIdentity();
      let text: string | null = null;
      let errorCode: LicenseErrorCode | null = null;
      if (!identity || !intact)
        errorCode = LicenseErrorCode.PLATFORM_IDENTITY_INVALID;
      else {
        try {
          text = this.store.loadActive(identity.instanceUid);
        } catch {
          errorCode = LicenseErrorCode.PACKAGE_CORRUPTED;
        }
      }

      if (text) {
        const result = verifyLicense(
          text,
          this.context(await this.fingerprint()),
        );
        this.warnings = result.warnings;
        if (result.ok) {
          this.setState(LicenseState.ACTIVE, result.license!, null);
        } else {
          errorCode = result.errorCode!;
        }
      }

      if (errorCode) {
        const state =
          errorCode === LicenseErrorCode.HARDWARE_CHANGED
            ? LicenseState.REACTIVATION_REQUIRED
            : errorCode === LicenseErrorCode.LICENSE_EXPIRED
              ? LicenseState.EXPIRED
              : LicenseState.ACTIVATION_ERROR;
        this.setState(state, null, errorCode);
      }

      this.event({
        action:
          this.state === LicenseState.REACTIVATION_REQUIRED
            ? 'REACTIVATION_REQUIRED'
            : 'RUNTIME_LICENSE_VALIDATION',
        result: this.state === LicenseState.ACTIVE ? 'SUCCESS' : 'FAILURE',
        previousState,
        newState: this.state,
        errorCode: this.lastErrorCode,
        certificateId: this.license?.licenseId ?? null,
        details: this.warnings.length
          ? { warnings: this.warnings.join(',') }
          : undefined,
      });
      return this.state;
    } catch (err) {
      this.logger.error(
        `Runtime license validation failed: ${(err as Error).message}`,
      );
      this.setState(
        LicenseState.ACTIVATION_ERROR,
        null,
        LicenseErrorCode.SERVICE_UNAVAILABLE,
      );
      return this.state;
    } finally {
      this.time.observe();
    }
  }

  private setState(
    state: LicenseState,
    license: LicensePayload | null,
    errorCode: LicenseErrorCode | null,
  ) {
    this.state = state;
    this.license = license;
    this.lastErrorCode = errorCode;
  }

  // ---------------------------------------------------------------------------
  // Activation (PRD §10–§26, §48)
  // ---------------------------------------------------------------------------

  async activate(
    rawCode: string,
    licenseFileText?: string,
    licenseFileName?: string,
  ): Promise<ActivationOutcome> {
    const parsed = parseActivationCode(rawCode);
    if (!parsed.valid)
      return {
        ok: false,
        state: this.state,
        checks: [],
        inputError: parsed.reason,
      };

    if (this.activating)
      throw new ConflictException('An activation is already in progress');
    this.activating = true;
    const previousState = this.state;
    this.state = LicenseState.ACTIVATING;
    try {
      return await this.runActivation(
        parsed.code,
        previousState,
        licenseFileText,
        licenseFileName,
      );
    } catch (err) {
      this.logger.error(
        `Activation failed unexpectedly: ${(err as Error).message}`,
      );
      this.state = previousState;
      return this.failure(
        LicenseErrorCode.SERVICE_UNAVAILABLE,
        checksFailingAt('LICENSE'),
      );
    } finally {
      this.activating = false;
    }
  }

  private failure(
    code: LicenseErrorCode,
    checks: VerificationCheck[],
    extra: Partial<ActivationOutcome> = {},
  ) {
    return {
      ok: false,
      state: this.state,
      checks,
      errorCode: code,
      error: LICENSE_ERRORS[code],
      ...extra,
    };
  }

  private async runActivation(
    code: string,
    previousState: LicenseState,
    licenseFileText?: string,
    licenseFileName?: string,
  ): Promise<ActivationOutcome> {
    this.event({
      action: 'ACTIVATION_INITIATED',
      result: 'INFO',
      licenseReference: code,
      previousState,
    });
    const ctx = this.context(await this.fingerprint(), code);
    const failedState = STICKY_STATES.includes(previousState)
      ? previousState
      : LicenseState.ACTIVATION_ERROR;

    const gateFailure = (
      errorCode: LicenseErrorCode,
      step: ActivationStepId,
    ) => {
      this.state = failedState;
      this.event({
        action: 'ACTIVATION_FAILED',
        result: 'FAILURE',
        licenseReference: code,
        previousState,
        newState: this.state,
        errorCode,
      });
      return this.failure(errorCode, checksFailingAt(step));
    };

    // Screen 1 validation order (PRD §16): installation and identity before package discovery.
    if (!ctx.installationVerified)
      return gateFailure(
        LicenseErrorCode.INSTALLATION_NOT_VERIFIED,
        'INSTALLATION',
      );
    if (!isValidPlatformIdentity(ctx.platform))
      return gateFailure(
        LicenseErrorCode.PLATFORM_IDENTITY_INVALID,
        'PLATFORM_INSTANCE',
      );

    let text = licenseFileText;
    if (text) {
      this.event({
        action: 'LICENSE_PACKAGE_SELECTED_MANUALLY',
        result: 'INFO',
        licenseReference: code,
        details: { fileName: licenseFileName ?? null },
      });
    } else {
      text = this.store.findProvisioned(code) ?? undefined;
      if (!text) {
        // Remain on Screen 1 and offer "Select License File" — not an activation error.
        this.state = previousState;
        this.event({
          action: 'LICENSE_PACKAGE_NOT_FOUND',
          result: 'FAILURE',
          licenseReference: code,
          errorCode: LicenseErrorCode.LICENSE_NOT_FOUND,
        });
        return this.failure(
          LicenseErrorCode.LICENSE_NOT_FOUND,
          checksFailingAt(null, 'PLATFORM_INSTANCE'),
          {
            licensePackageRequired: true,
          },
        );
      }
      this.event({
        action: 'LICENSE_PACKAGE_FOUND',
        result: 'INFO',
        licenseReference: code,
      });
    }

    this.event({
      action: 'PLATFORM_INSTANCE_VERIFIED',
      result: 'SUCCESS',
      licenseReference: code,
    });
    const result = verifyLicense(text, ctx);
    if (!result.ok) {
      this.state = failedState;
      this.event({
        action: 'LICENSE_VERIFICATION_FAILURE',
        result: 'FAILURE',
        licenseReference: code,
        certificateId: result.license?.licenseId ?? null,
        errorCode: result.errorCode,
      });
      this.event({
        action: 'ACTIVATION_FAILED',
        result: 'FAILURE',
        licenseReference: code,
        previousState,
        newState: this.state,
        errorCode: result.errorCode,
      });
      return this.failure(result.errorCode!, result.checks);
    }

    const license = result.license!;
    this.event({
      action: 'LICENSE_VERIFICATION_SUCCESS',
      result: 'SUCCESS',
      licenseReference: code,
      certificateId: license.licenseId,
    });

    // Commit: store → audit → ACTIVE. Undo the store if auditing fails, so we never
    // end up "partially activated" or activated without an audit record.
    const checks = result.checks;
    const mark = (id: ActivationStepId, status: 'PASS' | 'FAIL') =>
      (checks.find((c) => c.id === id)!.status = status);
    let undo: (() => void) | null = null;
    try {
      undo = this.store.saveActive(text, ctx.platform!.instanceUid);
      mark('STORED', 'PASS');
      this.event({
        action: 'LOCAL_LICENSE_STORED',
        result: 'SUCCESS',
        licenseReference: code,
        certificateId: license.licenseId,
      });
      this.event({
        action: 'ACTIVATION_SUCCESSFUL',
        result: 'SUCCESS',
        licenseReference: code,
        certificateId: license.licenseId,
        previousState,
        newState: LicenseState.ACTIVE,
        details: result.warnings.length
          ? { warnings: result.warnings.join(',') }
          : undefined,
      });
    } catch (err) {
      this.logger.error(
        `Activation commit failed, rolling back: ${(err as Error).message}`,
      );
      try {
        undo?.();
      } catch (undoErr) {
        this.logger.error(
          `Rollback of stored license failed: ${(undoErr as Error).message}`,
        );
      }
      this.state = failedState;
      mark(
        checks.find((c) => c.id === 'STORED')!.status === 'PASS'
          ? 'FINALIZED'
          : 'STORED',
        'FAIL',
      );
      try {
        this.event({
          action: 'ACTIVATION_FAILED',
          result: 'FAILURE',
          licenseReference: code,
          previousState,
          newState: this.state,
          errorCode: LicenseErrorCode.SERVICE_UNAVAILABLE,
        });
      } catch {
        /* audit itself may be what failed */
      }
      return this.failure(LicenseErrorCode.SERVICE_UNAVAILABLE, checks);
    }

    mark('FINALIZED', 'PASS');
    this.setState(LicenseState.ACTIVE, license, null);
    this.warnings = result.warnings;
    this.time.observe();
    return { ok: true, state: this.state, checks };
  }

  // ---------------------------------------------------------------------------
  // Service / commissioning function (PRD §6): produce the activation request.
  // ---------------------------------------------------------------------------

  async generateActivationRequest(): Promise<{
    requestCode: string;
    fileName: string;
    fileContent: string;
  }> {
    const { identity, intact } = this.platform.getIdentity();
    if (!identity || !intact)
      throw new ConflictException(
        LICENSE_ERRORS[LicenseErrorCode.PLATFORM_IDENTITY_INVALID],
      );
    const request = createActivationRequest({
      platform: identity,
      platformVersion: this.config.platformVersion,
      fingerprint: await this.fingerprint(),
    });
    this.event({
      action: 'ACTIVATION_REQUEST_GENERATED',
      result: 'SUCCESS',
      details: { requestId: request.requestId },
    });
    return {
      requestCode: encodeRequestCode(request),
      fileName: `${identity.instanceId}.nxreq`,
      fileContent: `${JSON.stringify(request, null, 2)}\n`,
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getState(): LicenseState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === LicenseState.ACTIVE;
  }

  /** Module applications query this; they never read license files themselves (PRD §25). */
  getEntitlements(now = new Date()): ModuleEntitlement[] {
    if (!this.isActive() || !this.license) return [];
    return this.license.entitlements.modules.filter(
      (m) => m.expiresAt === null || Date.parse(m.expiresAt) > now.getTime(),
    );
  }

  hasModule(moduleId: string): boolean {
    return this.getEntitlements().some((m) => m.id === moduleId);
  }

  getStatus(): LicensingStatus {
    const { identity, intact } = this.platform.getIdentity();
    const installation = this.platform.getInstallation();
    const verified = this.platform.isInstallationVerified();
    return {
      platform: {
        name: PLATFORM_NAME,
        version: this.config.platformVersion,
        instanceId: intact ? (identity?.instanceId ?? null) : null,
      },
      installation: {
        verification: installation?.verification ?? 'NOT_RUN',
        environment: verified ? 'Verified' : 'Not verified',
        status: installation ? 'Complete' : 'Not installed',
      },
      license: {
        state: this.state,
        restricted:
          !this.isActive() &&
          this.state !== LicenseState.NOT_ACTIVATED &&
          this.store.hasActive(),
        errorCode: this.lastErrorCode,
        error: this.lastErrorCode ? LICENSE_ERRORS[this.lastErrorCode] : null,
      },
      warnings: this.warnings,
    };
  }
}
