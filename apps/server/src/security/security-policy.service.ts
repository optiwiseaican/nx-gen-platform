import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { NXGEN_CONFIG, SECURITY_POLICY_LIMITS } from '../config/nxgen.config';
import type { NxGenConfig, SecurityPolicy } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import {
  COLUMNS,
  KEYS,
  POLICY_LABELS,
  readSecurityPolicy,
} from './security-policy.store';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SignatureService } from '../signatures/signature.service';
import type { SignatureInput } from '../signatures/signature.service';

export const SECURITY_POLICY_CHANGE = 'SECURITY_POLICY_CHANGE';

/**
 * Password, lockout and session rules (master spec §5; Annex 11 §12;
 * 21 CFR 11.300). Changed only by a user with security.manage, with a reason
 * and an electronic signature (SECURITY_POLICY_CHANGE is locked as required).
 * The new values take effect immediately for every service in the process,
 * because they all read the same config.security object.
 */
@Injectable()
export class SecurityPolicyService {
  private readonly logger = new Logger('SecurityPolicy');

  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly platform: PlatformIdentityService,
    private readonly signatures: SignatureService,
  ) {}

  async current() {
    const stored = this.db.enabled ? await readSecurityPolicy(this.db) : null;
    if (stored) Object.assign(this.config.security, stored.policy);
    return {
      policy: { ...this.config.security },
      limits: SECURITY_POLICY_LIMITS,
      labels: POLICY_LABELS,
      version: stored?.version ?? null,
      modifiedBy: stored?.modifiedBy ?? null,
      modifiedAt: stored?.modifiedAt ?? null,
    };
  }

  async update(
    principal: Principal,
    changesInput: unknown,
    reasonInput: unknown,
    signature: SignatureInput | undefined,
    origin: RequestOrigin,
  ) {
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 5)
      throw new BadRequestException({
        message: 'Enter a reason for this change (at least 5 characters).',
        field: 'reason',
      });
    if (!changesInput || typeof changesInput !== 'object')
      throw new BadRequestException('No changes supplied.');

    const before = (await this.current()).policy;
    const after: SecurityPolicy = { ...before };
    for (const [key, value] of Object.entries(changesInput)) {
      if (!KEYS.includes(key as keyof SecurityPolicy))
        throw new BadRequestException(`Unknown setting ${key}.`);
      const k = key as keyof SecurityPolicy;
      const { min, max } = SECURITY_POLICY_LIMITS[k];
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < min ||
        value > max
      )
        throw new BadRequestException({
          message: `${POLICY_LABELS[k]} must be a whole number from ${min} to ${max}.`,
          field: k,
        });
      after[k] = value;
    }
    const changed = KEYS.filter((k) => after[k] !== before[k]);
    if (!changed.length)
      throw new BadRequestException('The security policy is unchanged.');

    const signer = await this.signatures.authorize(
      SECURITY_POLICY_CHANGE,
      principal,
      signature,
      reason,
      origin,
    );
    const diff = Object.fromEntries(
      changed.map((k) => [k, { from: before[k], to: after[k] }]),
    );
    await this.db.transaction(
      {
        actorId: principal.userId,
        actorName: principal.fullName,
        reason,
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        platformInstanceId: this.platformId(),
      },
      async (client) => {
        await client.query(
          `UPDATE security_settings SET ${changed
            .map((k, i) => `${COLUMNS[k]} = $${i + 1}`)
            .join(', ')} WHERE id = 1`,
          changed.map((k) => after[k]),
        );
        await this.audit.record(
          {
            category: 'SECURITY',
            action: 'SECURITY_POLICY_CHANGED',
            result: 'SUCCESS',
            actor: principal.userId,
            actorName: principal.fullName,
            tableName: 'security_settings',
            recordId: '1',
            reason,
            platformInstanceId: this.platformId(),
            ipAddress: origin.ipAddress,
            machineName: origin.machineName,
            details: Object.fromEntries(
              changed.map((k) => [k, `${before[k]} → ${after[k]}`]),
            ),
          },
          client,
        );
        const { rows } = await client.query<{ version_no: number }>(
          'SELECT version_no FROM security_settings WHERE id = 1',
        );
        await this.signatures.apply(
          client,
          signer!,
          {
            tableName: 'security_settings',
            recordId: '1',
            recordVersion: rows[0].version_no,
            content: { action: SECURITY_POLICY_CHANGE, changes: diff },
          },
          origin,
        );
      },
    );
    Object.assign(this.config.security, after);
    this.logger.log(`Security policy changed: ${changed.join(', ')}`);
    return this.current();
  }

  private platformId(): string | null {
    return this.platform.getIdentity().identity?.instanceId ?? null;
  }
}
