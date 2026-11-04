import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { AuditEntry } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import {
  checkPasswordPolicy,
  hashPassword,
  USERNAME_PATTERN,
} from '../auth/password';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { ActorContext, DatabaseService } from '../database/database.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';

export const SUPER_ADMIN = 'SUPER_ADMINISTRATOR';

export interface UserSummary {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  status: 'ACTIVE' | 'DISABLED';
  roles: string[];
  locked: boolean;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  failedLoginCount: number;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  versionNo: number;
}

export interface RoleSummary {
  code: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  activeUsers: number;
  versionNo: number;
}

interface UserRow {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  status: 'ACTIVE' | 'DISABLED';
  roles: string[] | null;
  locked_until: Date | null;
  must_change_password: boolean;
  password_changed_at: Date | null;
  last_login_at: Date | null;
  failed_login_count: number | null;
  created_at: Date;
  created_by: string;
  created_by_name: string | null;
  version_no: number;
}

const USER_SELECT = `
  SELECT u.id, u.username, u.full_name, u.email, u.status, u.must_change_password, u.password_changed_at,
         u.created_at, u.created_by, u.version_no,
         (SELECT full_name FROM users c WHERE c.id::text = u.created_by) AS created_by_name,
         (SELECT array_agg(ur.role_code ORDER BY ur.role_code) FROM user_roles ur
           WHERE ur.user_id = u.id AND NOT ur.is_deleted) AS roles,
         s.locked_until, s.last_login_at, s.failed_login_count
    FROM users u LEFT JOIN user_security_state s ON s.user_id = u.id
   WHERE NOT u.is_deleted`;

const toSummary = (r: UserRow): UserSummary => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  email: r.email,
  status: r.status,
  roles: r.roles ?? [],
  locked: !!r.locked_until && r.locked_until.getTime() > Date.now(),
  lockedUntil: r.locked_until?.toISOString() ?? null,
  mustChangePassword: r.must_change_password,
  passwordChangedAt: r.password_changed_at?.toISOString() ?? null,
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
  failedLoginCount: r.failed_login_count ?? 0,
  createdAt: r.created_at.toISOString(),
  createdBy: r.created_by,
  createdByName:
    r.created_by_name ??
    (r.created_by === 'SYSTEM_SETUP' ? 'Initial setup' : null),
  versionNo: r.version_no,
});

const TEMP_ALPHABET = {
  lower: 'abcdefghijkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digit: '23456789',
  symbol: '!#%+=?@',
};

/**
 * User & Role Management (master spec §5).
 *
 * Every mutation:
 *  - requires a written reason (recorded on the audit trail by the database triggers),
 *  - runs in one transaction with the acting user's identity,
 *  - also writes a semantic USER_MANAGEMENT event so the trail reads like a log.
 *
 * Rules enforced here (never only in the UI):
 *  - users are disabled, never deleted (identities are never reused)
 *  - nobody changes their own roles or status (segregation of duties)
 *  - only a Super Administrator can grant the Super Administrator role or
 *    modify a Super Administrator account
 *  - the last active Super Administrator cannot be disabled or demoted
 *  - administrator-set passwords are temporary: the user must change them at next sign-in
 */
@Injectable()
export class UserAdminService {
  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly platform: PlatformIdentityService,
  ) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async listUsers(): Promise<UserSummary[]> {
    const rows = await this.db.query<UserRow>(
      `${USER_SELECT} ORDER BY u.status, lower(u.full_name)`,
    );
    return rows.map(toSummary);
  }

  async getUser(id: string, client?: PoolClient): Promise<UserSummary> {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new NotFoundException('User not found');
    const rows = client
      ? (await client.query<UserRow>(`${USER_SELECT} AND u.id = $1`, [id])).rows
      : await this.db.query<UserRow>(`${USER_SELECT} AND u.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('User not found');
    return toSummary(rows[0]);
  }

  async userHistory(id: string): Promise<AuditEntry[]> {
    await this.getUser(id);
    return this.audit.list({ recordId: id, limit: 200 });
  }

  async listRoles(): Promise<RoleSummary[]> {
    const rows = await this.db.query<{
      code: string;
      name: string;
      description: string;
      is_system: boolean;
      permissions: string[] | null;
      active_users: string;
      version_no: number;
    }>(
      `SELECT r.code, r.name, r.description, r.is_system, r.version_no,
              (SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM role_permissions rp
                WHERE rp.role_code = r.code AND NOT rp.is_deleted) AS permissions,
              (SELECT count(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id
                WHERE ur.role_code = r.code AND NOT ur.is_deleted AND u.status = 'ACTIVE' AND NOT u.is_deleted) AS active_users
         FROM roles r WHERE NOT r.is_deleted
        ORDER BY r.is_system DESC, r.name`,
    );
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      description: r.description,
      isSystem: r.is_system,
      permissions: r.permissions ?? [],
      activeUsers: Number(r.active_users),
      versionNo: r.version_no,
    }));
  }

  async listPermissions(): Promise<{ code: string; description: string }[]> {
    return this.db.query(
      'SELECT code, description FROM permissions WHERE NOT is_deleted ORDER BY code',
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private actor(
    principal: Principal,
    reason: string,
    origin: RequestOrigin,
  ): ActorContext {
    return {
      actorId: principal.userId,
      actorName: principal.fullName,
      reason,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
      platformInstanceId:
        this.platform.getIdentity().identity?.instanceId ?? null,
    };
  }

  private requireReason(reason: unknown): string {
    const r = typeof reason === 'string' ? reason.trim() : '';
    if (r.length < 5) {
      throw new BadRequestException({
        message: 'Enter a reason for this change (at least 5 characters).',
        field: 'reason',
      });
    }
    if (r.length > 500)
      throw new BadRequestException({
        message: 'The reason is too long (500 characters max).',
        field: 'reason',
      });
    return r;
  }

  private async event(
    client: PoolClient,
    principal: Principal,
    origin: RequestOrigin,
    action: string,
    target: { id: string; tableName?: string },
    reason: string,
    details?: Record<string, string | number | boolean | null>,
  ) {
    await this.audit.record(
      {
        category: 'USER_MANAGEMENT',
        action,
        result: 'SUCCESS',
        actor: principal.userId,
        actorName: principal.fullName,
        tableName: target.tableName ?? 'users',
        recordId: target.id,
        reason,
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        platformInstanceId:
          this.platform.getIdentity().identity?.instanceId ?? null,
        details,
      },
      client,
    );
  }

  private assertNotSelf(principal: Principal, targetId: string, what: string) {
    if (principal.userId === targetId) {
      throw new ForbiddenException(
        `You cannot ${what} your own account. Another administrator must do this.`,
      );
    }
  }

  private assertCanManage(principal: Principal, target: UserSummary) {
    if (
      target.roles.includes(SUPER_ADMIN) &&
      !principal.roles.includes(SUPER_ADMIN)
    ) {
      throw new ForbiddenException(
        'Only a Super Administrator can modify a Super Administrator account.',
      );
    }
  }

  private async lockUser(client: PoolClient, id: string): Promise<UserSummary> {
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
    return this.getUser(id, client);
  }

  /** Serializes changes that could remove the last Super Administrator. */
  private async assertAnotherSuperAdmin(
    client: PoolClient,
    excludingUserId: string,
  ) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.super_admins'))",
    );
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id
        WHERE ur.role_code = $1 AND NOT ur.is_deleted AND u.status = 'ACTIVE' AND NOT u.is_deleted AND u.id <> $2`,
      [SUPER_ADMIN, excludingUserId],
    );
    if (Number(rows[0].n) === 0) {
      throw new ConflictException(
        'This is the last active Super Administrator. Assign the role to another user first.',
      );
    }
  }

  private async validRoles(
    client: PoolClient,
    roles: unknown,
  ): Promise<string[]> {
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string')) {
      throw new BadRequestException({
        message: 'Roles must be a list of role codes.',
        field: 'roles',
      });
    }
    const unique = [...new Set(roles as string[])].sort();
    if (unique.length === 0)
      throw new BadRequestException({
        message: 'Assign at least one role.',
        field: 'roles',
      });
    const { rows } = await client.query<{ code: string }>(
      'SELECT code FROM roles WHERE code = ANY($1) AND NOT is_deleted',
      [unique],
    );
    const known = new Set(rows.map((r) => r.code));
    const unknown = unique.filter((r) => !known.has(r));
    if (unknown.length)
      throw new BadRequestException({
        message: `Unknown role: ${unknown.join(', ')}`,
        field: 'roles',
      });
    return unique;
  }

  /** Policy-compliant one-time password, shown to the administrator once. */
  generateTemporaryPassword(username: string, fullName: string): string {
    const all = Object.values(TEMP_ALPHABET).join('');
    for (;;) {
      const chars = Object.values(TEMP_ALPHABET).map(
        (set) => set[randomInt(set.length)],
      );
      while (chars.length < 16) chars.push(all[randomInt(all.length)]);
      for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
      }
      const candidate = chars.join('');
      if (
        checkPasswordPolicy(candidate, this.config.security, {
          username,
          fullName,
        }).length === 0
      )
        return candidate;
    }
  }

  private async syncRoles(client: PoolClient, userId: string, roles: string[]) {
    const { rows } = await client.query<{
      role_code: string;
      is_deleted: boolean;
    }>('SELECT role_code, is_deleted FROM user_roles WHERE user_id = $1', [
      userId,
    ]);
    const existing = new Map(rows.map((r) => [r.role_code, r.is_deleted]));
    for (const role of roles) {
      if (!existing.has(role))
        await client.query(
          'INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)',
          [userId, role],
        );
      else if (existing.get(role)) {
        await client.query(
          'UPDATE user_roles SET is_deleted = false WHERE user_id = $1 AND role_code = $2',
          [userId, role],
        );
      }
    }
    for (const [role, deleted] of existing) {
      if (!deleted && !roles.includes(role)) {
        await client.query(
          'UPDATE user_roles SET is_deleted = true WHERE user_id = $1 AND role_code = $2',
          [userId, role],
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // User mutations
  // ---------------------------------------------------------------------------

  async createUser(
    principal: Principal,
    input: {
      username: unknown;
      fullName: unknown;
      email?: unknown;
      roles: unknown;
      reason: unknown;
    },
    origin: RequestOrigin,
  ): Promise<{ user: UserSummary; temporaryPassword: string }> {
    const reason = this.requireReason(input.reason);
    const username =
      typeof input.username === 'string'
        ? input.username.trim().toLowerCase()
        : '';
    const fullName =
      typeof input.fullName === 'string' ? input.fullName.trim() : '';
    const email =
      typeof input.email === 'string' && input.email.trim()
        ? input.email.trim()
        : null;
    if (!USERNAME_PATTERN.test(username)) {
      throw new BadRequestException({
        message:
          'Username must be 3–32 characters: lowercase letters, digits, dot, dash or underscore.',
        field: 'username',
      });
    }
    if (fullName.length < 2 || fullName.length > 200) {
      throw new BadRequestException({
        message: 'Enter the full name of the person using this account.',
        field: 'fullName',
      });
    }
    if (email && !/^[^@\s]+@[^@\s]+$/.test(email))
      throw new BadRequestException({
        message: 'Enter a valid email address.',
        field: 'email',
      });

    const temporaryPassword = this.generateTemporaryPassword(
      username,
      fullName,
    );
    const hash = await hashPassword(temporaryPassword);

    const id = await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const roles = await this.validRoles(client, input.roles);
        if (
          roles.includes(SUPER_ADMIN) &&
          !principal.roles.includes(SUPER_ADMIN)
        ) {
          throw new ForbiddenException(
            'Only a Super Administrator can grant the Super Administrator role.',
          );
        }
        const taken = await client.query(
          'SELECT 1 FROM users WHERE username = $1',
          [username],
        );
        if (taken.rows.length) {
          throw new ConflictException({
            message:
              'This username is already in use or belonged to a former user. Usernames are never reused.',
            field: 'username',
          });
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (username, full_name, email, password_hash, password_changed_at, must_change_password)
         VALUES ($1, $2, $3, $4, now(), true) RETURNING id`,
          [username, fullName, email, hash],
        );
        const userId = rows[0].id;
        for (const role of roles)
          await client.query(
            'INSERT INTO user_roles (user_id, role_code) VALUES ($1, $2)',
            [userId, role],
          );
        await client.query(
          'INSERT INTO user_security_state (user_id) VALUES ($1)',
          [userId],
        );
        await client.query(
          'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
          [userId, hash],
        );
        await this.event(
          client,
          principal,
          origin,
          'USER_CREATED',
          { id: userId },
          reason,
          { username, roles: roles.join(',') },
        );
        return userId;
      },
    );
    return { user: await this.getUser(id), temporaryPassword };
  }

  async updateProfile(
    principal: Principal,
    id: string,
    input: { fullName?: unknown; email?: unknown; reason: unknown },
    origin: RequestOrigin,
  ): Promise<UserSummary> {
    const reason = this.requireReason(input.reason);
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const target = await this.lockUser(client, id);
        this.assertCanManage(principal, target);
        const fullName =
          typeof input.fullName === 'string'
            ? input.fullName.trim()
            : target.fullName;
        const email =
          input.email === undefined
            ? target.email
            : typeof input.email === 'string' && input.email.trim()
              ? input.email.trim()
              : null;
        if (fullName.length < 2 || fullName.length > 200) {
          throw new BadRequestException({
            message: 'Enter the full name of the person using this account.',
            field: 'fullName',
          });
        }
        if (email && !/^[^@\s]+@[^@\s]+$/.test(email))
          throw new BadRequestException({
            message: 'Enter a valid email address.',
            field: 'email',
          });
        if (fullName === target.fullName && email === target.email)
          throw new BadRequestException('Nothing changed.');
        await client.query(
          'UPDATE users SET full_name = $2, email = $3 WHERE id = $1',
          [id, fullName, email],
        );
        await this.event(
          client,
          principal,
          origin,
          'USER_PROFILE_UPDATED',
          { id },
          reason,
        );
      },
    );
    return this.getUser(id);
  }

  async setRoles(
    principal: Principal,
    id: string,
    input: { roles: unknown; reason: unknown },
    origin: RequestOrigin,
  ) {
    const reason = this.requireReason(input.reason);
    this.assertNotSelf(principal, id, 'change the roles of');
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const target = await this.lockUser(client, id);
        this.assertCanManage(principal, target);
        const roles = await this.validRoles(client, input.roles);
        const granting =
          roles.includes(SUPER_ADMIN) && !target.roles.includes(SUPER_ADMIN);
        const revoking =
          !roles.includes(SUPER_ADMIN) && target.roles.includes(SUPER_ADMIN);
        if ((granting || revoking) && !principal.roles.includes(SUPER_ADMIN)) {
          throw new ForbiddenException(
            'Only a Super Administrator can grant or revoke the Super Administrator role.',
          );
        }
        if (revoking && target.status === 'ACTIVE')
          await this.assertAnotherSuperAdmin(client, id);
        if (roles.join(',') === [...target.roles].sort().join(','))
          throw new BadRequestException('The roles are unchanged.');
        await this.syncRoles(client, id, roles);
        await this.event(
          client,
          principal,
          origin,
          'USER_ROLES_CHANGED',
          { id },
          reason,
          {
            from: target.roles.join(',') || null,
            to: roles.join(','),
          },
        );
      },
    );
    return this.getUser(id);
  }

  async setStatus(
    principal: Principal,
    id: string,
    status: 'ACTIVE' | 'DISABLED',
    reasonInput: unknown,
    origin: RequestOrigin,
  ) {
    const reason = this.requireReason(reasonInput);
    this.assertNotSelf(
      principal,
      id,
      status === 'DISABLED' ? 'disable' : 'enable',
    );
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const target = await this.lockUser(client, id);
        this.assertCanManage(principal, target);
        if (target.status === status)
          throw new BadRequestException(
            `The account is already ${status === 'ACTIVE' ? 'enabled' : 'disabled'}.`,
          );
        if (status === 'DISABLED' && target.roles.includes(SUPER_ADMIN))
          await this.assertAnotherSuperAdmin(client, id);
        await client.query('UPDATE users SET status = $2 WHERE id = $1', [
          id,
          status,
        ]);
        if (status === 'DISABLED') {
          await client.query(
            "UPDATE sessions SET ended_at = now(), end_reason = 'ACCOUNT_DISABLED' WHERE user_id = $1 AND ended_at IS NULL",
            [id],
          );
        }
        await this.event(
          client,
          principal,
          origin,
          status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED',
          { id },
          reason,
        );
      },
    );
    return this.getUser(id);
  }

  async unlock(
    principal: Principal,
    id: string,
    reasonInput: unknown,
    origin: RequestOrigin,
  ) {
    const reason = this.requireReason(reasonInput);
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const target = await this.lockUser(client, id);
        this.assertCanManage(principal, target);
        if (!target.locked && target.failedLoginCount === 0)
          throw new BadRequestException('The account is not locked.');
        await client.query(
          'UPDATE user_security_state SET failed_login_count = 0, locked_until = NULL WHERE user_id = $1',
          [id],
        );
        await this.event(
          client,
          principal,
          origin,
          'ACCOUNT_UNLOCKED',
          { id },
          reason,
          { failedAttempts: target.failedLoginCount },
        );
      },
    );
    return this.getUser(id);
  }

  async resetPassword(
    principal: Principal,
    id: string,
    reasonInput: unknown,
    origin: RequestOrigin,
  ) {
    const reason = this.requireReason(reasonInput);
    this.assertNotSelf(principal, id, 'reset the password of');
    let temporaryPassword = '';
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const target = await this.lockUser(client, id);
        this.assertCanManage(principal, target);
        temporaryPassword = this.generateTemporaryPassword(
          target.username,
          target.fullName,
        );
        const hash = await hashPassword(temporaryPassword);
        await client.query(
          'UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = true WHERE id = $1',
          [id, hash],
        );
        await client.query(
          'INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)',
          [id, hash],
        );
        await client.query(
          'UPDATE user_security_state SET failed_login_count = 0, locked_until = NULL WHERE user_id = $1',
          [id],
        );
        await client.query(
          "UPDATE sessions SET ended_at = now(), end_reason = 'PASSWORD_RESET' WHERE user_id = $1 AND ended_at IS NULL",
          [id],
        );
        await this.event(
          client,
          principal,
          origin,
          'PASSWORD_RESET',
          { id },
          reason,
        );
      },
    );
    return { user: await this.getUser(id), temporaryPassword };
  }

  // ---------------------------------------------------------------------------
  // Role mutations (roles.manage)
  // ---------------------------------------------------------------------------

  private async validPermissions(
    client: PoolClient,
    permissions: unknown,
  ): Promise<string[]> {
    if (
      !Array.isArray(permissions) ||
      permissions.some((p) => typeof p !== 'string')
    ) {
      throw new BadRequestException({
        message: 'Permissions must be a list of permission codes.',
        field: 'permissions',
      });
    }
    const unique = [...new Set(permissions as string[])].sort();
    const { rows } = await client.query<{ code: string }>(
      'SELECT code FROM permissions WHERE code = ANY($1) AND NOT is_deleted',
      [unique],
    );
    const unknown = unique.filter((p) => !rows.some((r) => r.code === p));
    if (unknown.length)
      throw new BadRequestException({
        message: `Unknown permission: ${unknown.join(', ')}`,
        field: 'permissions',
      });
    return unique;
  }

  private async syncPermissions(
    client: PoolClient,
    role: string,
    permissions: string[],
  ) {
    const { rows } = await client.query<{
      permission_code: string;
      is_deleted: boolean;
    }>(
      'SELECT permission_code, is_deleted FROM role_permissions WHERE role_code = $1',
      [role],
    );
    const existing = new Map(
      rows.map((r) => [r.permission_code, r.is_deleted]),
    );
    for (const p of permissions) {
      if (!existing.has(p))
        await client.query(
          'INSERT INTO role_permissions (role_code, permission_code) VALUES ($1, $2)',
          [role, p],
        );
      else if (existing.get(p)) {
        await client.query(
          'UPDATE role_permissions SET is_deleted = false WHERE role_code = $1 AND permission_code = $2',
          [role, p],
        );
      }
    }
    for (const [p, deleted] of existing) {
      if (!deleted && !permissions.includes(p)) {
        await client.query(
          'UPDATE role_permissions SET is_deleted = true WHERE role_code = $1 AND permission_code = $2',
          [role, p],
        );
      }
    }
  }

  async setRolePermissions(
    principal: Principal,
    code: string,
    input: { permissions: unknown; reason: unknown },
    origin: RequestOrigin,
  ) {
    const reason = this.requireReason(input.reason);
    if (code === SUPER_ADMIN) {
      throw new ForbiddenException(
        'The Super Administrator role always holds every permission and cannot be edited.',
      );
    }
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const { rows } = await client.query(
          'SELECT code FROM roles WHERE code = $1 AND NOT is_deleted FOR UPDATE',
          [code],
        );
        if (!rows.length) throw new NotFoundException('Role not found');
        const permissions = await this.validPermissions(
          client,
          input.permissions,
        );
        const before =
          (
            await client.query<{ p: string[] | null }>(
              'SELECT array_agg(permission_code ORDER BY permission_code) AS p FROM role_permissions WHERE role_code = $1 AND NOT is_deleted',
              [code],
            )
          ).rows[0].p ?? [];
        if (before.join(',') === permissions.join(','))
          throw new BadRequestException('The permissions are unchanged.');
        await this.syncPermissions(client, code, permissions);
        await this.event(
          client,
          principal,
          origin,
          'ROLE_PERMISSIONS_CHANGED',
          { id: code, tableName: 'roles' },
          reason,
          {
            from: before.join(',') || null,
            to: permissions.join(',') || null,
          },
        );
      },
    );
    return (await this.listRoles()).find((r) => r.code === code)!;
  }

  async createRole(
    principal: Principal,
    input: {
      code: unknown;
      name: unknown;
      description: unknown;
      permissions: unknown;
      reason: unknown;
    },
    origin: RequestOrigin,
  ) {
    const reason = this.requireReason(input.reason);
    const code =
      typeof input.code === 'string'
        ? input.code
            .trim()
            .toUpperCase()
            .replace(/[\s-]+/g, '_')
        : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const description =
      typeof input.description === 'string' ? input.description.trim() : '';
    if (!/^[A-Z][A-Z_]{1,40}$/.test(code)) {
      throw new BadRequestException({
        message: 'Role code: 2–41 letters or underscores, e.g. LAB_SUPERVISOR.',
        field: 'code',
      });
    }
    if (name.length < 2 || name.length > 80)
      throw new BadRequestException({
        message: 'Enter a role name.',
        field: 'name',
      });
    if (description.length < 5)
      throw new BadRequestException({
        message: 'Describe what this role is for.',
        field: 'description',
      });
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const exists = await client.query(
          'SELECT 1 FROM roles WHERE code = $1',
          [code],
        );
        if (exists.rows.length)
          throw new ConflictException({
            message: 'A role with this code already exists.',
            field: 'code',
          });
        const permissions = await this.validPermissions(
          client,
          input.permissions,
        );
        await client.query(
          'INSERT INTO roles (code, name, description, is_system) VALUES ($1, $2, $3, false)',
          [code, name, description],
        );
        for (const p of permissions)
          await client.query(
            'INSERT INTO role_permissions (role_code, permission_code) VALUES ($1, $2)',
            [code, p],
          );
        await this.event(
          client,
          principal,
          origin,
          'ROLE_CREATED',
          { id: code, tableName: 'roles' },
          reason,
          {
            permissions: permissions.join(',') || null,
          },
        );
      },
    );
    return (await this.listRoles()).find((r) => r.code === code)!;
  }
}
