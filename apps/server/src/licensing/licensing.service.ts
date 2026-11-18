import { existsSync, readFileSync, rmSync } from 'fs';
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
  FingerprintMatch,
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
  /** The License Portal could not be reached: offer the offline route (save request → licence file). */
  offlineActivation?: boolean;
  /** Inline activation-code validation failure (PRD §16). */
  inputError?: 'EMPTY' | 'FORMAT' | 'CHECKSUM';
}

export interface LicensingStatus {
  platform: { name: string; version: string; instanceId: string | null };
  installation: {
    verification: string;
    environment: 'Verified' | 'Not verified';
    status: 'Complete' | 'Not installed';
    /** Installation record was written by the development simulator, not the Smart Installer. */
    simulated: boolean;
  };
  license: {
    state: LicenseState;
    /** Previously activated platform that is no longer ACTIVE → restricted (preservation) mode, PRD §40. */
    restricted: boolean;
    errorCode: LicenseErrorCode | null;
    error: LicenseErrorInfo | null;
  };
  warnings: LicenseErrorCode[];
  activation: {
    /** Activation key the installer saved, while it has not been used successfully. */
    pendingActivationCode: string | null;
    /** The License Portal's offline page, for activating a computer without internet. */
    portalUrl: string | null;
  };
}

/** How long online activation waits for the License Portal before offering the offline route. */
const PORTAL_TIMEOUT_MS = 15_000;

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
  private licenseText: string | null = null;
  private fingerprintMatch: FingerprintMatch | null = null;
  private lastErrorCode: LicenseErrorCode | null = null;
  private readonly changeListeners = new Set<() => void>();
  /** False until the stored licence has been checked once at start-up. */
  private checked = false;
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
    await this.activateWithInstallerKey();
  }

  /** The activation key typed into the installer: activates once, at the first start, without any screen. */
  private pendingActivationCode(): string | null {
    const file = this.config.activationKeyFile;
    if (!file || !existsSync(file)) return null;
    try {
      const parsed = parseActivationCode(readFileSync(file, 'utf8'));
      return parsed.valid ? parsed.code : null;
    } catch {
      return null;
    }
  }

  private async activateWithInstallerKey(): Promise<void> {
    if (this.state !== LicenseState.NOT_ACTIVATED) return;
    const code = this.pendingActivationCode();
    if (!code) return;
    this.logger.log(`Activating with the key from the installer (${code})`);
    const outcome = await this.activate(code);
    if (!outcome.ok)
      this.logger.warn(
        `Activation with the installer key did not complete (${outcome.errorCode ?? outcome.inputError}); the activation screen offers it again`,
      );
  }

  /** Once activated, the saved key has done its job. */
  private forgetInstallerKey(code: string): void {
    const file = this.config.activationKeyFile;
    if (file && this.pendingActivationCode() === code) rmSync(file, { force: true });
  }

  /**
   * Online activation (master specification §11 steps 3–8 without carrying files): send this computer's
   * activation request with the key to the AICAN License Portal and receive the licence bound to it.
   */
  private async requestFromPortal(
    code: string,
  ): Promise<
    | { text: string }
    | { refused: LicenseErrorCode }
    | { unreachable: string }
  > {
    const { identity } = this.platform.getIdentity();
    const request = createActivationRequest({
      platform: identity!,
      platformVersion: this.config.platformVersion,
      fingerprint: await this.fingerprint(),
    });
    let res: Response;
    try {
      res = await fetch(`${this.config.licensePortalUrl}/api/v1/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activationCode: code, request, channel: 'ONLINE' }),
        signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
      });
    } catch (err) {
      return { unreachable: (err as Error).message };
    }
    let body: { license?: unknown; errorCode?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* not the portal answering */
    }
    if (res.ok && typeof body.license === 'string') return { text: body.license };
    const errorCode = body.errorCode as LicenseErrorCode;
    if (res.status >= 400 && res.status < 500 && errorCode in LICENSE_ERRORS)
      return { refused: errorCode };
    return { unreachable: `HTTP ${res.status}` };
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

  private async event(
    e: Omit<AuditEventInput, 'category' | 'actor' | 'platformInstanceId'>,
  ): Promise<void> {
    await this.audit.record({
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
          this.setState(LicenseState.ACTIVE, result.license!, null, {
            text,
            fingerprint: result.fingerprint ?? null,
          });
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

      await this.event({
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
    active?: { text: string; fingerprint: FingerprintMatch | null },
  ) {
    this.state = state;
    this.license = license;
    this.lastErrorCode = errorCode;
    this.licenseText = active?.text ?? null;
    this.fingerprintMatch = active?.fingerprint ?? null;
    this.checked = true;
    for (const listener of this.changeListeners) listener();
  }

  /** Whether the stored licence has been checked yet (it is checked at application bootstrap). */
  hasChecked(): boolean {
    return this.checked;
  }

  /**
   * Called whenever the licence in force is (re)validated, activated or lost,
   * so module entitlements can be re-checked. The licence is validated at
   * application bootstrap, after modules were first loaded.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
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
    await this.event({
      action: 'ACTIVATION_INITIATED',
      result: 'INFO',
      licenseReference: code,
      previousState,
    });
    const ctx = this.context(await this.fingerprint(), code);
    const failedState = STICKY_STATES.includes(previousState)
      ? previousState
      : LicenseState.ACTIVATION_ERROR;

    const gateFailure = async (
      errorCode: LicenseErrorCode,
      step: ActivationStepId,
    ) => {
      this.state = failedState;
      await this.event({
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
      return await gateFailure(
        LicenseErrorCode.INSTALLATION_NOT_VERIFIED,
        'INSTALLATION',
      );
    if (!isValidPlatformIdentity(ctx.platform))
      return await gateFailure(
        LicenseErrorCode.PLATFORM_IDENTITY_INVALID,
        'PLATFORM_INSTANCE',
      );

    let text = licenseFileText;
    if (text) {
      await this.event({
        action: 'LICENSE_PACKAGE_SELECTED_MANUALLY',
        result: 'INFO',
        licenseReference: code,
        details: { fileName: licenseFileName ?? null },
      });
    } else {
      text = this.store.findProvisioned(code) ?? undefined;
      if (!text && this.config.licensePortalUrl) {
        await this.event({
          action: 'LICENSE_PORTAL_REQUESTED',
          result: 'INFO',
          licenseReference: code,
          details: { portal: this.config.licensePortalUrl },
        });
        const portal = await this.requestFromPortal(code);
        if ('text' in portal) {
          text = portal.text;
          await this.event({
            action: 'LICENSE_ISSUED_BY_PORTAL',
            result: 'SUCCESS',
            licenseReference: code,
          });
        } else if ('refused' in portal) {
          await this.event({
            action: 'LICENSE_PORTAL_REFUSED',
            result: 'FAILURE',
            licenseReference: code,
            errorCode: portal.refused,
          });
          return await gateFailure(portal.refused, 'LICENSE');
        } else {
          // Not an activation error: stay on Screen 1 with the offline route.
          this.state = previousState;
          await this.event({
            action: 'LICENSE_PORTAL_UNREACHABLE',
            result: 'FAILURE',
            licenseReference: code,
            errorCode: LicenseErrorCode.PORTAL_UNREACHABLE,
            details: { reason: portal.unreachable.slice(0, 200) },
          });
          return this.failure(
            LicenseErrorCode.PORTAL_UNREACHABLE,
            checksFailingAt(null, 'PLATFORM_INSTANCE'),
            { licensePackageRequired: true, offlineActivation: true },
          );
        }
      }
      if (!text) {
        // Remain on Screen 1 and offer "Select License File" — not an activation error.
        this.state = previousState;
        await this.event({
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
      await this.event({
        action: 'LICENSE_PACKAGE_FOUND',
        result: 'INFO',
        licenseReference: code,
      });
    }

    await this.event({
      action: 'PLATFORM_INSTANCE_VERIFIED',
      result: 'SUCCESS',
      licenseReference: code,
    });
    const result = verifyLicense(text, ctx);
    if (!result.ok) {
      this.state = failedState;
      await this.event({
        action: 'LICENSE_VERIFICATION_FAILURE',
        result: 'FAILURE',
        licenseReference: code,
        certificateId: result.license?.licenseId ?? null,
        errorCode: result.errorCode,
      });
      await this.event({
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
    await this.event({
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
      await this.event({
        action: 'LOCAL_LICENSE_STORED',
        result: 'SUCCESS',
        licenseReference: code,
        certificateId: license.licenseId,
      });
      await this.event({
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
        await this.event({
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
    this.forgetInstallerKey(code);
    this.setState(LicenseState.ACTIVE, license, null, {
      text,
      fingerprint: result.fingerprint ?? null,
    });
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
    await this.event({
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

  /**
   * The active signed certificate, so the Electron main process can verify it
   * independently (Technical Architecture §2). Contains no secrets.
   */
  getActiveCertificate(): string | null {
    return this.isActive() ? this.licenseText : null;
  }

  /**
   * System Information (License PRD §7): Platform Instance ID and license
   * details for administrators and support. Unlike Screens 1–3, this view may
   * show module entitlements.
   */
  async getSystemInformation() {
    const status = this.getStatus();
    const installation = this.platform.getInstallation();
    const lic = this.license;
    const signingKeyId = this.licenseText
      ? ((JSON.parse(this.licenseText) as { signature?: { keyId?: string } })
          .signature?.keyId ?? null)
      : null;
    return {
      platform: status.platform,
      installation: {
        installationId: installation?.installationId ?? null,
        verification: status.installation.verification,
        verifiedAt: installation?.verifiedAt ?? null,
        simulated: status.installation.simulated,
      },
      license: {
        ...status.license,
        details: lic
          ? {
              licenseId: lic.licenseId,
              activationCode: lic.activationCode,
              customer: lic.customer,
              licenseType: lic.licenseType,
              versionScope: `${lic.versionScope.major}.x`,
              issuedAt: lic.issuedAt,
              validFrom: lic.validFrom,
              expiresAt: lic.expiresAt,
              limits: lic.limits,
              signingKeyId,
            }
          : null,
        hardwareBinding: this.fingerprintMatch
          ? {
              score: Math.round(this.fingerprintMatch.score * 100),
              matched: this.fingerprintMatch.matched.length,
              changed: this.fingerprintMatch.changed.length,
              missing: this.fingerprintMatch.missing.length,
            }
          : null,
      },
      entitlements: this.getEntitlements(),
      audit: {
        events: await this.audit.count(),
        chain: (await this.audit.verifyChain()).valid ? 'INTACT' : 'BROKEN',
      },
      warnings: status.warnings,
    };
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
        simulated: installation?.source === 'DEV_SIMULATION',
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
      activation: {
        pendingActivationCode: this.isActive()
          ? null
          : this.pendingActivationCode(),
        portalUrl: this.config.licensePortalUrl
          ? `${this.config.licensePortalUrl}/`
          : null,
      },
    };
  }
}
