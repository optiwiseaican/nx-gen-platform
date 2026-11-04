import { Inject, Injectable } from '@nestjs/common';
import { join } from 'path';
import {
  createPlatformIdentity,
  isValidPlatformIdentity,
  PlatformIdentity,
} from '@crescent/licensing';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { SecureStorageService } from '../security/secure-storage.service';

export type InstallationVerification =
  'PASS' | 'PASS_WITH_WARNING' | 'FAIL' | 'NOT_RUN';

export interface InstallationRecord {
  installationId: string;
  verification: InstallationVerification;
  verifiedAt: string | null;
  platformVersion: string;
  /** Who produced this record. DEV_SIMULATION comes from `npm run platform:init` and must never reach a customer. */
  source?: 'SMART_INSTALLER' | 'DEV_SIMULATION';
}

export interface IdentityState {
  identity: PlatformIdentity | null;
  /** false when the identity file exists but was modified or is malformed. */
  intact: boolean;
}

/**
 * Platform Instance identity and installation-verification state.
 *
 * Both are written by the Smart Installer during secure initialization and
 * post-installation verification. Until the installer exists,
 * `npm run platform:init` simulates those two steps for development.
 */
@Injectable()
export class PlatformIdentityService {
  private readonly identityPath: string;
  private readonly installationPath: string;

  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly storage: SecureStorageService,
  ) {
    this.identityPath = join(config.dataDir, 'platform', 'identity.json');
    this.installationPath = join(
      config.dataDir,
      'platform',
      'installation.json',
    );
  }

  getIdentity(): IdentityState {
    const sealed = this.storage.readSealedJson<
      PlatformIdentity & { createdAt: string }
    >(this.identityPath);
    if (!sealed) return { identity: null, intact: true };
    const identity = sealed.value
      ? {
          instanceUid: sealed.value.instanceUid,
          instanceId: sealed.value.instanceId,
        }
      : null;
    return {
      identity,
      intact: sealed.intact && isValidPlatformIdentity(identity),
    };
  }

  getInstallation(): InstallationRecord | null {
    const sealed = this.storage.readSealedJson<InstallationRecord>(
      this.installationPath,
    );
    if (!sealed) return null;
    // A modified installation record is treated as unverified.
    return sealed.intact
      ? sealed.value
      : { ...sealed.value, verification: 'NOT_RUN', verifiedAt: null };
  }

  isInstallationVerified(): boolean {
    const v = this.getInstallation()?.verification;
    return v === 'PASS' || v === 'PASS_WITH_WARNING';
  }

  /** Secure initialization: creates the Platform Instance identity exactly once. */
  initializeIdentity(): PlatformIdentity {
    if (this.getIdentity().identity)
      throw new Error(
        'Platform identity already exists; it is never regenerated',
      );
    const identity = createPlatformIdentity();
    this.storage.writeSealedJson(this.identityPath, {
      ...identity,
      createdAt: new Date().toISOString(),
    });
    return identity;
  }

  recordInstallationVerification(record: InstallationRecord): void {
    this.storage.writeSealedJson(this.installationPath, { ...record });
  }
}
