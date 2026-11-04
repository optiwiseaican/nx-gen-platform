import { Inject, Injectable } from '@nestjs/common';
import { join } from 'path';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { SecureStorageService } from '../security/secure-storage.service';

/**
 * Offline clock-rollback evidence (License PRD §38).
 *
 * Keeps the latest time this installation has observed, integrity-protected.
 * If the clock later reads much earlier than that, time-limited licenses fail
 * with NX-LIC-E009. This is best effort by nature: restoring a full disk image
 * also restores this file (Technical Architecture §7).
 */
@Injectable()
export class TimeIntegrityService {
  private readonly path: string;

  constructor(
    @Inject(NXGEN_CONFIG) config: NxGenConfig,
    private readonly storage: SecureStorageService,
  ) {
    this.path = join(config.dataDir, 'licensing', 'time-state.json');
  }

  /** Latest trusted time, or null if none/tampered (a tampered file gives no evidence either way). */
  lastTrustedTime(): Date | null {
    const sealed = this.storage.readSealedJson<{ lastSeenAt: string }>(
      this.path,
    );
    if (!sealed?.intact) return null;
    const t = Date.parse(sealed.value.lastSeenAt);
    return Number.isNaN(t) ? null : new Date(t);
  }

  /** Records `now` only if it moves time forward; never moves the evidence backwards. */
  observe(now: Date = new Date()): void {
    const last = this.lastTrustedTime();
    if (last && last.getTime() >= now.getTime()) return;
    this.storage.writeSealedJson(this.path, { lastSeenAt: now.toISOString() });
  }
}
