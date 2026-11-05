import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { verifyPassword } from '../auth/password';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';

/** What the client sends to sign: both identity components every time (11.200(a)(1)). */
export interface SignatureInput {
  username?: unknown;
  password?: unknown;
  meaning?: unknown;
}

export interface SignaturePolicy {
  actionCode: string;
  description: string;
  required: boolean;
  defaultMeaning: string;
  locked: boolean;
  versionNo: number;
}

export interface SignatureMeaning {
  code: string;
  label: string;
  statement: string;
}

/** A signer whose identity has just been verified; valid for one apply() call. */
export interface VerifiedSigner {
  readonly userId: string;
  readonly username: string;
  readonly fullName: string;
  readonly sessionId: string;
  readonly meaning: SignatureMeaning;
  readonly actionCode: string;
  readonly reason: string;
}

/** Manifestation of a signature (11.50): printed name, date/time, meaning. */
export interface SignatureRecord {
  id: string;
  signedAt: string;
  signerUserId: string;
  signerUsername: string;
  signerFullName: string;
  meaningCode: string;
  meaningLabel: string;
  meaningStatement: string;
  reason: string;
  actionCode: string;
  tableName: string;
  recordId: string;
  recordVersion: number | null;
  signedContent: unknown;
  contentHash: string;
  intact: boolean;
}

interface SignatureRow {
  id: string;
  signed_at: Date;
  signer_user_id: string;
  signer_username: string;
  signer_full_name: string;
  meaning_code: string;
  meaning_label: string;
  meaning_statement: string;
  reason: string;
  action_code: string;
  table_name: string;
  record_id: string;
  record_version: number | null;
  signed_content: unknown;
  content_hash: string;
  intact: boolean;
}

const toRecord = (r: SignatureRow): SignatureRecord => ({
  id: r.id,
  signedAt: r.signed_at.toISOString(),
  signerUserId: r.signer_user_id,
  signerUsername: r.signer_username,
  signerFullName: r.signer_full_name,
  meaningCode: r.meaning_code,
  meaningLabel: r.meaning_label,
  meaningStatement: r.meaning_statement,
  reason: r.reason,
  actionCode: r.action_code,
  tableName: r.table_name,
  recordId: r.record_id,
  recordVersion: r.record_version,
  signedContent: r.signed_content,
  contentHash: r.content_hash,
  intact: r.intact,
});

export const SIGNATURE_REQUIRED = 'NX-ESIG-REQUIRED';
export const SIGNATURE_POLICY_CHANGE = 'SIGNATURE_POLICY_CHANGE';

/**
 * Electronic signatures (master spec §7, 21 CFR Part 11 Subpart C).
 *
 *  - The signer must be the signed-in user and re-enter username AND password
 *    for every signature (11.100(a), 11.200(a)(1)).
 *  - Failed attempts are audited and count toward account lockout; on lockout
 *    the user's sessions end (11.300(d)).
 *  - The signature row is written in the SAME transaction as the change it
 *    approves, binds to a hash of exactly what was signed, and is immutable
 *    (11.70). If the change rolls back, so does the signature.
 */
@Injectable()
export class SignatureService {
  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly platform: PlatformIdentityService,
  ) {}

  async meanings(): Promise<SignatureMeaning[]> {
    return this.db.query<SignatureMeaning>(
      'SELECT code, label, statement FROM signature_meanings WHERE NOT is_deleted ORDER BY label',
    );
  }

  async policies(): Promise<SignaturePolicy[]> {
    const rows = await this.db.query<{
      action_code: string;
      description: string;
      required: boolean;
      default_meaning: string;
      locked: boolean;
      version_no: number;
    }>(
      'SELECT * FROM signature_policies WHERE NOT is_deleted ORDER BY action_code',
    );
    return rows.map((r) => ({
      actionCode: r.action_code,
      description: r.description,
      required: r.required,
      defaultMeaning: r.default_meaning,
      locked: r.locked,
      versionNo: r.version_no,
    }));
  }

  private async policy(actionCode: string): Promise<SignaturePolicy | null> {
    return (
      (await this.policies()).find((p) => p.actionCode === actionCode) ?? null
    );
  }

  private platformId() {
    return this.platform.getIdentity().identity?.instanceId ?? null;
  }

  /**
   * Returns a verified signer when the action requires (or the user supplied)
   * a signature, null when no signature is needed. Throws when a required
   * signature is missing or fails verification. Runs OUTSIDE the change's
   * transaction so failed-attempt counting persists even when it throws.
   */
  async authorize(
    actionCode: string,
    principal: Principal,
    input: SignatureInput | undefined,
    reason: string,
    origin: RequestOrigin,
  ): Promise<VerifiedSigner | null> {
    const policy = await this.policy(actionCode);
    const supplied =
      !!input && (input.password !== undefined || input.username !== undefined);
    if (!policy?.required && !supplied) return null;
    if (!supplied) {
      throw new BadRequestException({
        code: SIGNATURE_REQUIRED,
        message: 'This action requires your electronic signature.',
        action: actionCode,
        defaultMeaning: policy?.defaultMeaning ?? 'APPROVED',
      });
    }

    const username =
      typeof input.username === 'string'
        ? input.username.trim().toLowerCase()
        : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const meaningCode =
      typeof input.meaning === 'string'
        ? input.meaning
        : (policy?.defaultMeaning ?? 'APPROVED');
    const meaning = (await this.meanings()).find((m) => m.code === meaningCode);
    if (!meaning)
      throw new BadRequestException({
        message: 'Choose the meaning of your signature.',
        field: 'meaning',
      });

    const [user] = await this.db.query<{
      email: string | null;
      password_hash: string | null;
      status: string;
      is_deleted: boolean;
    }>(
      'SELECT email, password_hash, status, is_deleted FROM users WHERE id = $1',
      [principal.userId],
    );

    // 11.100(a): a signature belongs to exactly one individual — you can only sign as yourself
    // (identified by your username or your email).
    const ownIdentifier =
      username === principal.username ||
      (!!user?.email && username === user.email.toLowerCase());
    if (!ownIdentifier) {
      await this.failure(
        principal,
        origin,
        actionCode,
        'Signature username does not match the signed-in user',
      );
      throw new ForbiddenException({
        code: 'NX-ESIG-NOT-OWN',
        message: 'You can only sign with your own credentials.',
        field: 'signatureUsername',
      });
    }

    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.is_deleted ||
      !(await verifyPassword(password, user.password_hash))
    ) {
      await this.failure(principal, origin, actionCode, 'Wrong password');
      // 403, not 401: the session is still valid; only this signature failed.
      throw new ForbiddenException({
        code: 'NX-ESIG-FAILED',
        message:
          'Signature verification failed. Check your password and try again.',
        field: 'signaturePassword',
      });
    }

    await this.db.query(
      'UPDATE user_security_state SET failed_login_count = 0 WHERE user_id = $1',
      [principal.userId],
    );
    return {
      userId: principal.userId,
      username: principal.username,
      fullName: principal.fullName,
      sessionId: principal.sessionId,
      meaning,
      actionCode,
      reason,
    };
  }

  private async failure(
    principal: Principal,
    origin: RequestOrigin,
    actionCode: string,
    why: string,
  ) {
    const { rows } = await this.db.transaction(
      { actorId: principal.userId },
      (c) =>
        c.query<{ failed_login_count: number }>(
          `UPDATE user_security_state
            SET failed_login_count = failed_login_count + 1,
                last_failed_login_at = now(),
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE user_id = $1 RETURNING failed_login_count`,
          [
            principal.userId,
            this.config.security.maxFailedLogins,
            this.config.security.lockoutMinutes,
          ],
        ),
    );
    const attempts = rows[0]?.failed_login_count ?? 0;
    const base = {
      category: 'SECURITY' as const,
      actor: principal.userId,
      actorName: principal.fullName,
      tableName: 'users',
      recordId: principal.userId,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
      platformInstanceId: this.platformId(),
    };
    await this.audit.record({
      ...base,
      action: 'ESIGNATURE_FAILED',
      result: 'FAILURE',
      reason: why,
      details: { actionCode, attempts },
    });
    if (attempts >= this.config.security.maxFailedLogins) {
      await this.db.query(
        "UPDATE sessions SET ended_at = now(), end_reason = 'SIGNATURE_LOCKOUT' WHERE user_id = $1 AND ended_at IS NULL",
        [principal.userId],
      );
      await this.audit.record({
        ...base,
        action: 'ACCOUNT_LOCKED',
        result: 'INFO',
        reason: `${attempts} consecutive failed signature or sign-in attempts`,
      });
    }
  }

  /** Writes the signature inside the change's transaction and audits it. */
  async apply(
    client: PoolClient,
    signer: VerifiedSigner,
    target: {
      tableName: string;
      recordId: string;
      recordVersion?: number | null;
      content: Record<string, unknown>;
    },
    origin: RequestOrigin,
  ): Promise<SignatureRecord> {
    const { rows } = await client.query<SignatureRow>(
      `INSERT INTO electronic_signatures
         (signer_user_id, signer_username, signer_full_name, meaning_code, meaning_label, meaning_statement, reason,
          action_code, table_name, record_id, record_version, signed_content, content_hash, signature_hash,
          session_id, ip_address, machine_name, platform_instance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '', '', $13, $14, $15, $16)
       RETURNING *, true AS intact`,
      [
        signer.userId,
        signer.username,
        signer.fullName,
        signer.meaning.code,
        signer.meaning.label,
        signer.meaning.statement,
        signer.reason,
        signer.actionCode,
        target.tableName,
        target.recordId,
        target.recordVersion ?? null,
        JSON.stringify({ action: signer.actionCode, ...target.content }),
        signer.sessionId,
        origin.ipAddress,
        origin.machineName,
        this.platformId(),
      ],
    );
    const record = toRecord(rows[0]);
    await this.audit.record(
      {
        category: 'SECURITY',
        action: 'ESIGNATURE_APPLIED',
        result: 'SUCCESS',
        actor: signer.userId,
        actorName: signer.fullName,
        tableName: target.tableName,
        recordId: target.recordId,
        reason: signer.reason,
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        platformInstanceId: this.platformId(),
        details: {
          signatureId: record.id,
          meaning: record.meaningCode,
          actionCode: signer.actionCode,
          contentHash: record.contentHash,
        },
      },
      client,
    );
    return record;
  }

  async list(
    filter: { tableName?: string; recordId?: string; limit?: number } = {},
  ): Promise<SignatureRecord[]> {
    const rows = await this.db.query<SignatureRow>(
      `SELECT s.*, verify_signature(s) AS intact FROM electronic_signatures s
        WHERE ($1::text IS NULL OR s.table_name = $1)
          AND ($2::text IS NULL OR s.record_id = $2 OR s.record_id LIKE $2 || ':%')
        ORDER BY s.signed_at DESC LIMIT $3`,
      [
        filter.tableName ?? null,
        filter.recordId ?? null,
        Math.min(filter.limit ?? 100, 500),
      ],
    );
    return rows.map(toRecord);
  }

  /** Changes which actions require a signature — itself always signed. */
  async updatePolicies(
    principal: Principal,
    changes: unknown,
    reasonInput: unknown,
    signature: SignatureInput | undefined,
    origin: RequestOrigin,
  ): Promise<SignaturePolicy[]> {
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 5) {
      throw new BadRequestException({
        message: 'Enter a reason for this change (at least 5 characters).',
        field: 'reason',
      });
    }
    if (!Array.isArray(changes) || changes.length === 0)
      throw new BadRequestException('No policy changes supplied.');
    const current = await this.policies();
    const updates = (
      changes as {
        actionCode?: unknown;
        required?: unknown;
        defaultMeaning?: unknown;
      }[]
    ).map((c) => {
      const p = current.find((x) => x.actionCode === c.actionCode);
      if (!p)
        throw new BadRequestException(`Unknown action ${String(c.actionCode)}`);
      const required =
        typeof c.required === 'boolean' ? c.required : p.required;
      const defaultMeaning =
        typeof c.defaultMeaning === 'string'
          ? c.defaultMeaning
          : p.defaultMeaning;
      if (p.locked && !required) {
        throw new ForbiddenException(
          `"${p.description}" always requires an electronic signature.`,
        );
      }
      return { p, required, defaultMeaning };
    });
    const effective = updates.filter(
      (u) =>
        u.required !== u.p.required || u.defaultMeaning !== u.p.defaultMeaning,
    );
    if (!effective.length)
      throw new BadRequestException(
        'The signature requirements are unchanged.',
      );

    const signer = await this.authorize(
      SIGNATURE_POLICY_CHANGE,
      principal,
      signature,
      reason,
      origin,
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
        for (const u of effective) {
          await client.query(
            'UPDATE signature_policies SET required = $2, default_meaning = $3 WHERE action_code = $1',
            [u.p.actionCode, u.required, u.defaultMeaning],
          );
        }
        await this.audit.record(
          {
            category: 'SYSTEM',
            action: 'SIGNATURE_POLICY_CHANGED',
            result: 'SUCCESS',
            actor: principal.userId,
            actorName: principal.fullName,
            tableName: 'signature_policies',
            reason,
            details: {
              changes: effective
                .map(
                  (u) =>
                    `${u.p.actionCode}:${u.required ? 'required' : 'optional'}`,
                )
                .join(','),
            },
          },
          client,
        );
        await this.apply(
          client,
          signer!,
          {
            tableName: 'signature_policies',
            recordId: 'POLICY',
            content: {
              changes: effective.map((u) => ({
                actionCode: u.p.actionCode,
                required: { from: u.p.required, to: u.required },
                defaultMeaning: {
                  from: u.p.defaultMeaning,
                  to: u.defaultMeaning,
                },
              })),
            },
          },
          origin,
        );
      },
    );
    return this.policies();
  }
}
