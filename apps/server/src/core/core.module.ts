import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { BootstrapJournal } from '../audit/bootstrap-journal';
import { loadConfig, NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { readSecurityPolicy } from '../security/security-policy.store';
import { migrate } from '../database/migrator';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';

/**
 * Brings the database to the expected schema before anything else runs
 * (OnModuleInit precedes every OnApplicationBootstrap), then registers the
 * bootstrap journal into the audit trail. A database that cannot be reached
 * or verified stops startup: NxGen never runs without its audit trail.
 */
@Injectable()
export class DatabaseInitializer implements OnModuleInit {
  private readonly logger = new Logger('Database');

  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.db.enabled) {
      this.logger.warn(
        'No DATABASE_URL configured: audit events go to the bootstrap journal only.',
      );
      return;
    }
    const client = await this.db.connect();
    try {
      const result = await migrate(client, this.config.database!.schema);
      this.logger.log(
        `Schema "${this.config.database!.schema}" at version ${result.current}` +
          (result.applied.length
            ? ` (applied ${result.applied.join(', ')})`
            : ''),
      );
    } finally {
      client.release();
    }
    // Password, lockout and session rules in force (editable since migration 005).
    const stored = await readSecurityPolicy(this.db);
    if (stored) Object.assign(this.config.security, stored.policy);
    await this.audit.importBootstrapJournal();
    const chain = await this.audit.verifyChain();
    if (!chain.valid) {
      this.logger.error(
        `AUDIT TRAIL CHAIN BROKEN at sequence ${chain.brokenAtSequence}`,
      );
    }
  }
}

/** Compliance Core services shared by every feature module. */
@Global()
@Module({
  providers: [
    { provide: NXGEN_CONFIG, useFactory: loadConfig },
    SecureStorageService,
    BootstrapJournal,
    DatabaseService,
    {
      provide: AuditService,
      useFactory: (journal: BootstrapJournal, db: DatabaseService) =>
        new AuditService(journal, db),
      inject: [BootstrapJournal, DatabaseService],
    },
    PlatformIdentityService,
    DatabaseInitializer,
  ],
  exports: [
    NXGEN_CONFIG,
    SecureStorageService,
    BootstrapJournal,
    DatabaseService,
    AuditService,
    PlatformIdentityService,
  ],
})
export class CoreModule {}
