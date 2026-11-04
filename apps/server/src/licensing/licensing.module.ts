import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { collectFingerprint } from '@crescent/licensing';
import { AuditService } from '../audit/audit.service';
import { loadConfig, NXGEN_CONFIG } from '../config/nxgen.config';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import { LicenseGuard } from './license.guard';
import { LicenseStoreService } from './license-store.service';
import { LicensingController } from './licensing.controller';
import { FINGERPRINT_PROVIDER, LicensingService } from './licensing.service';
import { TimeIntegrityService } from './time-integrity.service';

/**
 * Core platform services needed by licensing. Config, storage, audit and
 * platform identity will move to their own modules as the Compliance Core grows.
 */
@Global()
@Module({
  controllers: [LicensingController],
  providers: [
    { provide: NXGEN_CONFIG, useFactory: loadConfig },
    { provide: FINGERPRINT_PROVIDER, useValue: collectFingerprint },
    SecureStorageService,
    AuditService,
    PlatformIdentityService,
    TimeIntegrityService,
    LicenseStoreService,
    LicensingService,
    { provide: APP_GUARD, useClass: LicenseGuard },
  ],
  exports: [
    NXGEN_CONFIG,
    SecureStorageService,
    AuditService,
    PlatformIdentityService,
    LicensingService,
  ],
})
export class LicensingModule {}
