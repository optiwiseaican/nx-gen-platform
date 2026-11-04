import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { peekActivationCode } from '@crescent/licensing';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { SecureStorageService } from '../security/secure-storage.service';

/**
 * Where licenses live on the workstation.
 *
 *  licensing/inbox/*.nxlic      provisioning location (License PRD §14) — packages
 *                               placed by commissioning staff / approved media.
 *  licensing/active.nxlic.enc   the activated license: the ORIGINAL signed text,
 *                               AES-256-GCM encrypted and bound (AAD) to the
 *                               Platform Instance UID. It is re-verified from the
 *                               signature at every start, never trusted as-is.
 */
@Injectable()
export class LicenseStoreService {
  readonly inboxDir: string;
  private readonly activePath: string;

  constructor(
    @Inject(NXGEN_CONFIG) config: NxGenConfig,
    private readonly storage: SecureStorageService,
  ) {
    this.inboxDir = join(config.dataDir, 'licensing', 'inbox');
    this.activePath = join(config.dataDir, 'licensing', 'active.nxlic.enc');
  }

  /** Finds a provisioned package whose (unverified) activation code matches. */
  findProvisioned(activationCode: string): string | null {
    if (!existsSync(this.inboxDir)) return null;
    for (const name of readdirSync(this.inboxDir)) {
      if (!name.toLowerCase().endsWith('.nxlic')) continue;
      const text = readFileSync(join(this.inboxDir, name), 'utf8');
      if (peekActivationCode(text) === activationCode) return text;
    }
    return null;
  }

  hasActive(): boolean {
    return existsSync(this.activePath);
  }

  /** Throws if the stored file was modified or belongs to another platform. */
  loadActive(instanceUid: string): string | null {
    if (!existsSync(this.activePath)) return null;
    return this.storage.decrypt(
      readFileSync(this.activePath, 'utf8'),
      `nxgen-license:${instanceUid}`,
    );
  }

  /**
   * Atomically replaces the active license and returns an undo function that
   * restores the previous state, so activation can be rolled back if a later
   * step (e.g. writing the audit event) fails.
   */
  saveActive(licenseText: string, instanceUid: string): () => void {
    const previous = existsSync(this.activePath)
      ? readFileSync(this.activePath)
      : null;
    this.storage.writeAtomic(
      this.activePath,
      this.storage.encrypt(licenseText, `nxgen-license:${instanceUid}`),
    );
    return () => {
      if (previous) this.storage.writeAtomic(this.activePath, previous);
      else rmSync(this.activePath, { force: true });
    };
  }
}
