import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import {
  createRecoveryRequest,
  encodeRecoveryRequest,
  recoveryResponseRequestId,
  verifyRecoveryResponse,
} from '@crescent/licensing';
import { AuditService } from '../audit/audit.service';
import type { RequestOrigin } from '../auth/auth.types';
import { hashPassword } from '../auth/password';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SUPER_ADMIN, UserAdminService } from './user-admin.service';

export const RECOVERY_ACTOR = 'SYSTEM_RECOVERY';
export const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_REQUESTS_PER_HOUR = 3;

interface PendingRow {
  id: string;
  user_id: string | null;
  username: string;
  nonce: string;
  expires_at: Date;
  failed_attempts: number;
}

/**
 * Support-assisted Super Administrator recovery (gap analysis A4).
 *
 * Used only when no Super Administrator can sign in. The request names one
 * account; NxGen does not reveal whether it exists or qualifies. The response
 * must be signed by a trusted vendor key and match this platform, request,
 * nonce and username. Each request is single-use, expires, and allows
 * RECOVERY_MAX_ATTEMPTS wrong responses. The account receives a one-time
 * password that must be changed at first sign-in. Every step is audited.
 */
@Injectable()
export class RecoveryService {
  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly platform: PlatformIdentityService,
    private readonly users: UserAdminService,
  ) {}

  private platformIdentity() {
    const { identity, intact } = this.platform.getIdentity();
    if (!identity || !intact)
      throw new ConflictException(
        'The platform identity is missing or damaged. Contact AICAN support.',
      );
    return identity;
  }

  private actor(
    origin: RequestOrigin,
    reason: string,
    name = 'Administrator recovery',
  ) {
    return {
      actorId: RECOVERY_ACTOR,
      actorName: name,
      reason,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
      platformInstanceId: this.platformIdentity().instanceId,
    };
  }

  private async event(
    action: string,
    result: 'SUCCESS' | 'FAILURE' | 'INFO',
    origin: RequestOrigin,
    who: { username: string; userId?: string | null },
    extra: {
      reason?: string;
      details?: Record<string, string | number | boolean | null>;
    } = {},
  ) {
    await this.audit.record({
      category: 'SECURITY',
      action,
      result,
      actor: RECOVERY_ACTOR,
      actorName: who.username,
      tableName: 'recovery_requests',
      recordId: who.userId ?? null,
      platformInstanceId: this.platformIdentity().instanceId,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
      reason: extra.reason ?? null,
      details: extra.details,
    });
  }

  async createRequest(
    usernameInput: unknown,
    reasonInput: unknown,
    origin: RequestOrigin,
  ) {
    if (!this.db.enabled)
      throw new ConflictException('The NxGen database is not configured.');
    const username =
      typeof usernameInput === 'string'
        ? usernameInput.trim().toLowerCase()
        : '';
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (!username || username.length > 64)
      throw new BadRequestException({
        message: 'Enter the Super Administrator username.',
        field: 'username',
      });
    if (reason.length < 10 || reason.length > 500)
      throw new BadRequestException({
        message:
          'Describe why recovery is needed and who is requesting it (at least 10 characters).',
        field: 'reason',
      });
    const platform = this.platformIdentity();

    const [{ n }] = await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM recovery_requests
        WHERE username = $1 AND created_at > now() - interval '1 hour'`,
      [username],
    );
    if (Number(n) >= RECOVERY_REQUESTS_PER_HOUR)
      throw new HttpException(
        'Too many recovery requests for this account. Try again in an hour.',
        HttpStatus.TOO_MANY_REQUESTS,
      );

    // Resolved but never revealed: the answer is the same for any username.
    const [user] = await this.db.query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE (u.username = $1 OR lower(u.email) = $1)
          AND u.status = 'ACTIVE' AND NOT u.is_deleted
          AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id
                        AND ur.role_code = $2 AND NOT ur.is_deleted)`,
      [username, SUPER_ADMIN],
    );
    const request = createRecoveryRequest({ platform, username });
    await this.db.transaction(this.actor(origin, reason), async (client) => {
      await client.query(
        `UPDATE recovery_requests SET request_status = 'SUPERSEDED'
          WHERE username = $1 AND request_status = 'PENDING'`,
        [username],
      );
      await client.query(
        `INSERT INTO recovery_requests (id, user_id, username, nonce, contact_reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          request.requestId,
          user?.id ?? null,
          username,
          request.nonce,
          reason,
          request.expiresAt,
        ],
      );
    });
    await this.event(
      'ADMIN_RECOVERY_REQUESTED',
      'INFO',
      origin,
      { username, userId: user?.id },
      {
        reason,
        details: {
          requestId: request.requestId,
          eligibleAccount: !!user,
          expiresAt: request.expiresAt,
        },
      },
    );
    return {
      requestId: request.requestId,
      requestCode: encodeRecoveryRequest(request),
      expiresAt: request.expiresAt,
      platformInstanceId: platform.instanceId,
    };
  }

  async complete(responseInput: unknown, origin: RequestOrigin) {
    if (!this.db.enabled)
      throw new ConflictException('The NxGen database is not configured.');
    const code = typeof responseInput === 'string' ? responseInput.trim() : '';
    const requestId = code ? recoveryResponseRequestId(code) : null;
    if (!requestId)
      throw new BadRequestException({
        message: 'The recovery response code is incomplete or was mistyped.',
        field: 'response',
      });
    const [pending] = await this.db.query<PendingRow>(
      `SELECT id, user_id, username, nonce, expires_at, failed_attempts
         FROM recovery_requests WHERE id = $1 AND request_status = 'PENDING'`,
      [requestId],
    );
    if (!pending || pending.expires_at.getTime() <= Date.now())
      throw new BadRequestException({
        message:
          'There is no open recovery request for this response. It may have expired, been used or been replaced. Create a new request.',
        field: 'response',
      });

    const platform = this.platformIdentity();
    const verdict = verifyRecoveryResponse(
      code,
      {
        requestId: pending.id,
        platformInstanceUid: platform.instanceUid,
        username: pending.username,
        nonce: pending.nonce,
      },
      this.config.trustedKeys,
    );
    const ineligible = verdict.ok && !pending.user_id;
    if (!verdict.ok || ineligible) {
      const reason = verdict.ok
        ? 'Account is not an active Super Administrator'
        : verdict.reason;
      const attempts = pending.failed_attempts + 1;
      const exhausted = ineligible || attempts >= RECOVERY_MAX_ATTEMPTS;
      await this.db.transaction(
        this.actor(origin, `Recovery response rejected: ${reason}`),
        (c) =>
          c.query(
            `UPDATE recovery_requests SET failed_attempts = $2,
                  request_status = CASE WHEN $3 THEN 'FAILED' ELSE request_status END
            WHERE id = $1`,
            [pending.id, attempts, exhausted],
          ),
      );
      await this.event(
        'ADMIN_RECOVERY_FAILED',
        'FAILURE',
        origin,
        { username: pending.username, userId: pending.user_id },
        {
          reason,
          details: {
            requestId: pending.id,
            attempts,
            requestClosed: exhausted,
          },
        },
      );
      throw new ForbiddenException({
        code: 'NX-RECOVERY-REJECTED',
        message: ineligible
          ? 'Recovery is not possible for this account. Only an active Super Administrator account can be recovered.'
          : `${verdict.ok ? '' : verdict.message}${exhausted ? ' This request is now closed; create a new one.' : ''}`.trim(),
        field: 'response',
      });
    }

    const p = verdict.payload;
    const reason = `Administrator recovery under support reference ${p.supportReference}`;
    let username = '';
    let temporaryPassword = '';
    await this.db.transaction(
      this.actor(origin, reason, `Administrator recovery (${p.issuedBy})`),
      async (client) => {
        const { rows } = await client.query<{
          id: string;
          username: string;
          full_name: string;
        }>(
          `SELECT u.id, u.username, u.full_name FROM users u
            WHERE u.id = $1 AND u.status = 'ACTIVE' AND NOT u.is_deleted
              AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id
                            AND ur.role_code = $2 AND NOT ur.is_deleted)
            FOR UPDATE`,
          [pending.user_id, SUPER_ADMIN],
        );
        const user = rows[0];
        if (!user)
          throw new ForbiddenException(
            'Recovery is not possible for this account. Only an active Super Administrator account can be recovered.',
          );
        const claimed = await client.query(
          `UPDATE recovery_requests
              SET request_status = 'COMPLETED', completed_at = now(),
                  support_reference = $2, issued_by = $3, signing_key_id = $4
            WHERE id = $1 AND request_status = 'PENDING'`,
          [pending.id, p.supportReference, p.issuedBy, verdict.keyId],
        );
        if (claimed.rowCount !== 1)
          throw new ConflictException(
            'This recovery request was already used.',
          );

        username = user.username;
        temporaryPassword = this.users.generateTemporaryPassword(
          user.username,
          user.full_name,
        );
        const hash = await hashPassword(temporaryPassword);
        await client.query(
          'UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = true WHERE id = $1',
          [user.id, hash],
        );
        await client.query(
          'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
          [user.id, hash],
        );
        await client.query(
          'UPDATE user_security_state SET failed_login_count = 0, locked_until = NULL WHERE user_id = $1',
          [user.id],
        );
        await client.query(
          "UPDATE sessions SET ended_at = now(), end_reason = 'ADMIN_RECOVERY' WHERE user_id = $1 AND ended_at IS NULL",
          [user.id],
        );
        await this.audit.record(
          {
            category: 'SECURITY',
            action: 'ADMIN_RECOVERY_COMPLETED',
            result: 'SUCCESS',
            actor: RECOVERY_ACTOR,
            actorName: `Administrator recovery (${p.issuedBy})`,
            tableName: 'users',
            recordId: user.id,
            reason,
            platformInstanceId: platform.instanceId,
            ipAddress: origin.ipAddress,
            machineName: origin.machineName,
            details: {
              requestId: pending.id,
              username: user.username,
              supportReference: p.supportReference,
              issuedBy: p.issuedBy,
              signingKeyId: verdict.keyId,
            },
          },
          client,
        );
      },
    );
    return { username, temporaryPassword };
  }
}
