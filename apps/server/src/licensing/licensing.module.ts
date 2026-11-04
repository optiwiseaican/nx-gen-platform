import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { collectFingerprint } from '@crescent/licensing';
import { LicenseGuard } from './license.guard';
import { LicenseStoreService } from './license-store.service';
import { LicensingController } from './licensing.controller';
import { FINGERPRINT_PROVIDER, LicensingService } from './licensing.service';
import { TimeIntegrityService } from './time-integrity.service';

/** License & Entitlement Service. Core services come from CoreModule. */
@Global()
@Module({
  controllers: [LicensingController],
  providers: [
    { provide: FINGERPRINT_PROVIDER, useValue: collectFingerprint },
    TimeIntegrityService,
    LicenseStoreService,
    LicensingService,
    { provide: APP_GUARD, useClass: LicenseGuard },
  ],
  exports: [LicensingService],
})
export class LicensingModule {}
