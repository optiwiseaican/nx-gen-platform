import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig, SecurityPolicy } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { LicensingService } from '../licensing/licensing.service';
import { Principal, RequestOrigin, SETUP_ACTOR } from './auth.types';
import {
  checkPasswordPolicy,
  hashPassword,
  USERNAME_PATTERN,
  verifyPassword,
} from './password';

interface UserRow {
  id: string;
  username: string;
  full_name: string;
  password_hash: string | null;
  password_changed_at: Date | null;
  must_change_password: boolean;
  status: 'ACTIVE' | 'DISABLED';
  is_deleted: boolean;
  failed_login_count: number | null;
  locked_until: Date | null;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  last_seen_at: Date;
  expires_at: Date;
  now: Date;
}

const GENERIC_LOGIN_FAILURE = 'Invalid username or password.';
const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/**
 * Identity, authentication and sessions (master spec §5; 21 CFR 11.10(d),
 * 11.10(g), 11.300). Local accounts only for now; AD/LDAP plug in behind
 * the same login() contract later.
 */
@Injectable()
export class IdentityService {
  private administratorExistsCache = false;
  private readonly policy: SecurityPolicy;

  constructor(
    @Inject(NXGEN_CONFIG) config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly platform: PlatformIdentityService,
    @Inject(LicensingService)
    private readonly licensing: Pick<LicensingService, 'isActive'>,
  ) {
    this.policy = config.security;
  }

  get securityPolicy(): SecurityPolicy {
    return this.policy;
  }

  private platformId(): string | null {
    return this.platform.getIdentity().identity?.instanceId ?? null;
  }

  // ---------------------------------------------------------------------------
  // First-run setup
  // ---------------------------------------------------------------------------

  /** True once any user account exists; from then on, setup-only routes are closed for good. */
  async administratorExists(): Promise<boolean> {
    if (this.administratorExistsCache) return true;
    if (!this.db.enabled) return false;
    const [row] = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users) AS exists',
    );
    this.administratorExistsCache = row.exists;
    return row.exists;
  }

  async setupStatus() {
    return {
      databaseConfigured: this.db.enabled,
      licenseActive: this.licensing.isActive(),
      administratorExists: await this.administratorExists(),
      passwordPolicy: {
        minLength: this.policy.passwordMinLength,
        maxAgeDays: this.policy.passwordMaxAgeDays,
        history: this.policy.passwordHistory,
      },
    };
  }

  async createInitialAdministrator(
    input: {
      username: string;
      fullName: string;
      email?: string | null;
      password: string;
    },
    origin: RequestOrigin,
  ): Promise<{ userId: string; username: string }> {
    if (!this.db.enabled)
      throw new ConflictException('The NxGen database is not configured.');
    if (!this.licensing.isActive()) {
      throw new ForbiddenException(
        'NxGen must be activated before the administrator can be created.',
      );
    }
    const username = this.validateIdentity(
      input.username,
      input.fullName,
      input.email,
    );
    this.assertPasswordPolicy(input.password, username, input.fullName);
    const passwordHash = await hashPassword(input.password);

    const user = await this.db.transaction(
      {
        actorId: SETUP_ACTOR,
        actorName: 'Initial setup',
        reason: 'Initial administrator creation',
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        platformInstanceId: this.platformId(),
      },
      async (client) => {
        // Serialize concurrent attempts; only the very first account can be created here.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.initial_administrator'))",
        );
        const { rows } = await client.query<{ exists: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM users) AS exists',
        );
        if (rows[0].exists)
          throw new ConflictException(
            'An administrator already exists. Initial setup is closed.',
          );

        const created = await this.insertUser(client, {
          username,
          fullName: input.fullName.trim(),
          email: input.email?.trim() || null,
          passwordHash,
          mustChangePassword: false,
          roles: ['SUPER_ADMINISTRATOR'],
        });
        await this.audit.record(
          {
            category: 'USER_MANAGEMENT',
            action: 'INITIAL_ADMINISTRATOR_CREATED',
            result: 'SUCCESS',
            actor: SETUP_ACTOR,
            actorName: 'Initial setup',
            tableName: 'users',
            recordId: created.id,
            platformInstanceId: this.platformId(),
            ipAddress: origin.ipAddress,
            machineName: origin.machineName,
            details: { username, role: 'SUPER_ADMINISTRATOR' },
          },
          client,
        );
        return created;
      },
    );
    this.administratorExistsCache = true;
    return { userId: user.id, username };
  }

  private validateIdentity(
    rawUsername: string,
    fullName: string,
    email?: string | null,
  ): string {
    const username = (rawUsername ?? '').trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username)) {
      throw new BadRequestException({
        message:
          'Username must be 3–32 characters: lowercase letters, digits, dot, dash or underscore.',
        field: 'username',
      });
    }
    if (
      !fullName ||
      fullName.trim().length < 2 ||
      fullName.trim().length > 200
    ) {
      throw new BadRequestException({
        message: 'Enter the full name of the person using this account.',
        field: 'fullName',
      });
    }
    if (email && !/^[^@\s]+@[^@\s]+$/.test(email.trim())) {
      throw new BadRequestException({
        message: 'Enter a valid email address.',
        field: 'email',
      });
    }
    return username;
  }

  private assertPasswordPolicy(
    password: string,
    username: string,
    fullName: string,
  ) {
    const problems = checkPasswordPolicy(password ?? '', this.policy, {
      username,
      fullName,
    });
    if (problems.length)
      throw new BadRequestException({
        message: problems.join(' '),
        field: 'password',
        problems,
      });
  }

  private async insertUser(
    client: PoolClient,
    u: {
      username: string;
      fullName: string;
      email: string | null;
      passwordHash: string;
      mustChangePassword: boolean;
      roles: string[];
    },
  ): Promise<{ id: string }> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (username, full_name, email, password_hash, password_changed_at, must_change_password)
       VALUES ($1, $2, $3, $4, now(), $5) RETURNING id`,
      [u.username, u.fullName, u.email, u.passwordHash, u.mustChangePassword],
    );
    const id = rows[0].id;
    for (const role of u.roles) {
      await client.query(
        'INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)',
        [id, role],
      );
    }
    await client.query(
      'INSERT INTO user_security_state (user_id) VALUES ($1)',
      [id],
    );
    await client.query(
      'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
      [id, u.passwordHash],
    );
    return { id };
  }

  // ---------------------------------------------------------------------------
  // Login / logout
  // ---------------------------------------------------------------------------

  private async findUser(username: string): Promise<UserRow | null> {
    const [row] = await this.db.query<UserRow>(
      `SELECT u.id, u.username, u.full_name, u.password_hash, u.password_changed_at, u.must_change_password,
              u.status, u.is_deleted, s.failed_login_count, s.locked_until
         FROM users u LEFT JOIN user_security_state s ON s.user_id = u.id
        WHERE u.username = $1`,
      [username],
    );
    return row ?? null;
  }

  private async securityEvent(
    action: string,
    result: 'SUCCESS' | 'FAILURE' | 'INFO',
    origin: RequestOrigin,
    who: { actor: string; actorName?: string | null; recordId?: string | null },
    extra: {
      reason?: string;
      details?: Record<string, string | number | boolean | null>;
    } = {},
  ) {
    await this.audit.record({
      category: 'SECURITY',
      action,
      result,
      actor: who.actor,
      actorName: who.actorName ?? null,
      tableName: 'users',
      recordId: who.recordId ?? null,
      platformInstanceId: this.platformId(),
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
      reason: extra.reason ?? null,
      details: extra.details,
    });
  }

  async login(
    rawUsername: string,
    password: string,
    origin: RequestOrigin,
  ): Promise<{ token: string; principal: Principal }> {
    if (!this.db.enabled)
      throw new ConflictException('The NxGen database is not configured.');
    const username = (rawUsername ?? '').trim().toLowerCase();
    const user = USERNAME_PATTERN.test(username)
      ? await this.findUser(username)
      : null;

    if (!user || user.is_deleted || user.status !== 'ACTIVE') {
      await verifyPassword(password ?? '', null); // equalize timing
      await this.securityEvent(
        'LOGIN_FAILED',
        'FAILURE',
        origin,
        {
          actor: 'UNAUTHENTICATED',
          actorName: username || null,
          recordId: user?.id,
        },
        {
          reason: !user ? 'Unknown username' : 'Account disabled or deleted',
        },
      );
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    const who = {
      actor: user.id,
      actorName: user.full_name,
      recordId: user.id,
    };
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      await this.securityEvent('LOGIN_FAILED', 'FAILURE', origin, who, {
        reason: 'Account locked',
      });
      throw new UnauthorizedException(
        'This account is temporarily locked after repeated failed sign-in attempts. Try again later or contact your administrator.',
      );
    }

    if (!(await verifyPassword(password ?? '', user.password_hash))) {
      const { rows } = await this.db.transaction({ actorId: user.id }, (c) =>
        c.query<{ failed_login_count: number; locked_until: Date | null }>(
          `UPDATE user_security_state
              SET failed_login_count = failed_login_count + 1,
                  last_failed_login_at = now(),
                  locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE user_id = $1
        RETURNING failed_login_count, locked_until`,
          [user.id, this.policy.maxFailedLogins, this.policy.lockoutMinutes],
        ),
      );
      const attempts = rows[0]?.failed_login_count ?? 0;
      await this.securityEvent('LOGIN_FAILED', 'FAILURE', origin, who, {
        reason: 'Wrong password',
        details: { attempts },
      });
      if (attempts >= this.policy.maxFailedLogins) {
        await this.securityEvent('ACCOUNT_LOCKED', 'INFO', origin, who, {
          reason: `${attempts} consecutive failed sign-in attempts`,
          details: { lockedUntil: rows[0].locked_until?.toISOString() ?? null },
        });
      }
      throw new UnauthorizedException(GENERIC_LOGIN_FAILURE);
    }

    const token = randomBytes(32).toString('base64url');
    const sessionId = await this.db.transaction(
      { actorId: user.id, actorName: user.full_name },
      async (c) => {
        await c.query(
          'UPDATE user_security_state SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE user_id = $1',
          [user.id],
        );
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, machine_name, user_agent)
         VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5, $6) RETURNING id`,
          [
            user.id,
            hashToken(token),
            this.policy.sessionMaxHours,
            origin.ipAddress,
            origin.machineName,
            origin.userAgent,
          ],
        );
        return rows[0].id;
      },
    );
    await this.securityEvent('LOGIN', 'SUCCESS', origin, who, {
      details: { sessionId },
    });
    return { token, principal: await this.loadPrincipal(user.id, sessionId) };
  }

  async logout(principal: Principal, origin: RequestOrigin): Promise<void> {
    await this.endSession(principal.sessionId, 'LOGOUT');
    await this.securityEvent('LOGOUT', 'SUCCESS', origin, {
      actor: principal.userId,
      actorName: principal.fullName,
      recordId: principal.userId,
    });
  }

  private async endSession(sessionId: string, reason: string) {
    await this.db.query(
      'UPDATE sessions SET ended_at = now(), end_reason = $2 WHERE id = $1 AND ended_at IS NULL',
      [sessionId, reason],
    );
  }

  /**
   * Resolves a session token. Sessions end after `sessionIdleMinutes` without
   * activity (21 CFR 11 — unattended workstation) or `sessionMaxHours` total.
   */
  async authenticate(
    token: string,
    origin: RequestOrigin,
  ): Promise<Principal | null> {
    if (!this.db.enabled || !token) return null;
    const [s] = await this.db.query<
      SessionRow & { status: string; is_deleted: boolean; full_name: string }
    >(
      `SELECT s.id AS session_id, s.user_id, s.last_seen_at, s.expires_at, now() AS now,
              u.status, u.is_deleted, u.full_name
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.ended_at IS NULL`,
      [hashToken(token)],
    );
    if (!s) return null;

    const idleMs = this.policy.sessionIdleMinutes * 60_000;
    const endReason =
      s.status !== 'ACTIVE' || s.is_deleted
        ? 'ACCOUNT_DISABLED'
        : s.now.getTime() > s.expires_at.getTime()
          ? 'EXPIRED'
          : s.now.getTime() - s.last_seen_at.getTime() > idleMs
            ? 'IDLE_TIMEOUT'
            : null;
    if (endReason) {
      await this.endSession(s.session_id, endReason);
      await this.securityEvent(
        'SESSION_ENDED',
        'INFO',
        origin,
        { actor: s.user_id, actorName: s.full_name, recordId: s.user_id },
        {
          reason: endReason,
        },
      );
      return null;
    }
    if (s.now.getTime() - s.last_seen_at.getTime() > 30_000) {
      await this.db.query(
        'UPDATE sessions SET last_seen_at = now() WHERE id = $1',
        [s.session_id],
      );
    }
    return this.loadPrincipal(s.user_id, s.session_id);
  }

  async loadPrincipal(userId: string, sessionId: string): Promise<Principal> {
    const [u] = await this.db.query<{
      username: string;
      full_name: string;
      must_change_password: boolean;
      password_changed_at: Date | null;
      roles: string[] | null;
      permissions: string[] | null;
    }>(
      `SELECT u.username, u.full_name, u.must_change_password, u.password_changed_at,
              (SELECT array_agg(ur.role_code ORDER BY ur.role_code) FROM user_roles ur
                WHERE ur.user_id = u.id AND NOT ur.is_deleted) AS roles,
              (SELECT array_agg(DISTINCT rp.permission_code) FROM user_roles ur
                 JOIN role_permissions rp ON rp.role_code = ur.role_code AND NOT rp.is_deleted
                WHERE ur.user_id = u.id AND NOT ur.is_deleted) AS permissions
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    const expiresAt = u.password_changed_at
      ? new Date(
          u.password_changed_at.getTime() +
            this.policy.passwordMaxAgeDays * 86_400_000,
        )
      : null;
    return {
      userId,
      sessionId,
      username: u.username,
      fullName: u.full_name,
      roles: u.roles ?? [],
      permissions: u.permissions ?? [],
      mustChangePassword:
        u.must_change_password ||
        !expiresAt ||
        expiresAt.getTime() <= Date.now(),
      passwordExpiresAt: expiresAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Password change
  // ---------------------------------------------------------------------------

  async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
    origin: RequestOrigin,
  ) {
    const user = await this.findUser(principal.username);
    if (
      !user ||
      !(await verifyPassword(currentPassword ?? '', user.password_hash))
    ) {
      await this.securityEvent(
        'PASSWORD_CHANGE_FAILED',
        'FAILURE',
        origin,
        {
          actor: principal.userId,
          actorName: principal.fullName,
          recordId: principal.userId,
        },
        { reason: 'Current password incorrect' },
      );
      throw new BadRequestException({
        message: 'The current password is incorrect.',
        field: 'currentPassword',
      });
    }
    this.assertPasswordPolicy(newPassword, user.username, user.full_name);

    const history = await this.db.query<{ password_hash: string }>(
      'SELECT password_hash FROM password_history WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
      [user.id, this.policy.passwordHistory],
    );
    for (const h of history) {
      if (await verifyPassword(newPassword, h.password_hash)) {
        throw new BadRequestException({
          message: `The new password must differ from your last ${this.policy.passwordHistory} passwords.`,
          field: 'newPassword',
        });
      }
    }

    const hash = await hashPassword(newPassword);
    await this.db.transaction(
      {
        actorId: principal.userId,
        actorName: principal.fullName,
        reason: 'Password changed by account owner',
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        platformInstanceId: this.platformId(),
      },
      async (c) => {
        await c.query(
          'UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE id = $1',
          [user.id, hash],
        );
        await c.query(
          'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
          [user.id, hash],
        );
        // Sign out every other session of this user.
        await c.query(
          "UPDATE sessions SET ended_at = now(), end_reason = 'PASSWORD_CHANGED' WHERE user_id = $1 AND id <> $2 AND ended_at IS NULL",
          [user.id, principal.sessionId],
        );
      },
    );
    await this.securityEvent('PASSWORD_CHANGED', 'SUCCESS', origin, {
      actor: principal.userId,
      actorName: principal.fullName,
      recordId: principal.userId,
    });
    return this.loadPrincipal(principal.userId, principal.sessionId);
  }
}
