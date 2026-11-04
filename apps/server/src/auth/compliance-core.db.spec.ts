import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { BootstrapJournal } from '../audit/bootstrap-journal';
import {
  DEFAULT_SECURITY_POLICY,
  loadDatabaseConfig,
  loadEnvFile,
  NxGenConfig,
  PLATFORM_VERSION,
} from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { loadMigrations, migrate } from '../database/migrator';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import type { RequestOrigin } from './auth.types';
import { IdentityService } from './identity.service';

/**
 * Integration tests against a real PostgreSQL (DATABASE_URL from .env), each
 * run in its own throw-away schema. Skipped when no database is configured.
 */
loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(60_000);

const ORIGIN: RequestOrigin = {
  ipAddress: '127.0.0.1',
  machineName: 'TEST-PC',
  userAgent: 'jest',
};
const STRONG = 'Correct-Horse-42!';

describeDb('Compliance Core on PostgreSQL', () => {
  const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-db-'));
  const licensing = {
    active: true,
    isActive(): boolean {
      return licensing.active;
    },
  };
  let config: NxGenConfig;
  let db: DatabaseService;
  let audit: AuditService;
  let identity: IdentityService;

  const newIdentity = (policy = DEFAULT_SECURITY_POLICY) => {
    const cfg = { ...config, security: policy };
    const storage = new SecureStorageService(cfg);
    return new IdentityService(
      cfg,
      db,
      audit,
      new PlatformIdentityService(cfg, storage),
      licensing,
    );
  };

  beforeAll(async () => {
    config = {
      production: false,
      database: { ...baseDb!, schema },
      security: DEFAULT_SECURITY_POLICY,
      dataDir,
      platformVersion: PLATFORM_VERSION,
      trustedKeys: [],
      clockRollbackToleranceMs: 86_400_000,
    };
    db = new DatabaseService(config);
    audit = new AuditService(new BootstrapJournal(config), db);
    const client = await db.connect();
    try {
      await migrate(client, schema);
    } finally {
      client.release();
    }
    identity = newIdentity();
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('migrations', () => {
    it('are idempotent and record themselves in the audit trail', async () => {
      const client = await db.connect();
      try {
        expect((await migrate(client, schema)).applied).toEqual([]);
      } finally {
        client.release();
      }
      const entries = await audit.list({ action: 'SCHEMA_MIGRATION_APPLIED' });
      expect(entries.map((e) => e.recordId)).toEqual(['1']);
    });

    it('refuse to start if an applied migration was modified', async () => {
      const tampered = loadMigrations().map((m) =>
        m.version === 1 ? { ...m, checksum: 'f'.repeat(64) } : m,
      );
      const client = await db.connect();
      try {
        await expect(migrate(client, schema, tampered)).rejects.toThrow(
          /modified after it was applied/,
        );
      } finally {
        client.release();
      }
    });

    it('seed the seven system roles, themselves audited', async () => {
      const roles = await db.query<{ code: string }>(
        'SELECT code FROM roles ORDER BY code',
      );
      expect(roles.map((r) => r.code)).toEqual([
        'ANALYST',
        'AUDITOR',
        'IT_ADMINISTRATOR',
        'OPERATOR',
        'QA_MANAGER',
        'QA_REVIEWER',
        'SUPER_ADMINISTRATOR',
      ]);
      const created = await db.query(
        "SELECT 1 FROM audit_trail WHERE table_name = 'roles' AND action = 'CREATE'",
      );
      expect(created).toHaveLength(7);
    });
  });

  describe('audit trail (master spec §6)', () => {
    it('is append-only: UPDATE, DELETE and TRUNCATE are rejected by the database', async () => {
      await expect(
        db.query("UPDATE audit_trail SET action = 'X' WHERE sequence = 1"),
      ).rejects.toThrow(/NXGEN-AUDIT-001/);
      await expect(
        db.query('DELETE FROM audit_trail WHERE sequence = 1'),
      ).rejects.toThrow(/NXGEN-AUDIT-001/);
      await expect(db.query('TRUNCATE audit_trail')).rejects.toThrow(
        /NXGEN-AUDIT-001/,
      );
    });

    it('chains every record; bypassing the trigger to edit a record is detected', async () => {
      await audit.record({
        category: 'SYSTEM',
        action: 'TEST_EVENT',
        result: 'INFO',
        actor: 'TEST',
      });
      expect(await audit.verifyChain()).toEqual({ valid: true });

      // A table owner can disable triggers. The hash chain still exposes the edit.
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'ALTER TABLE audit_trail DISABLE TRIGGER audit_trail_no_update',
        );
        await client.query(
          "UPDATE audit_trail SET reason = 'tampered' WHERE action = 'TEST_EVENT'",
        );
        await client.query(
          'ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_no_update',
        );
        const { rows } = await client.query<{ broken: string | null }>(
          'SELECT verify_audit_chain() AS broken',
        );
        expect(rows[0].broken).not.toBeNull();
        await client.query('ROLLBACK'); // undo so later tests see an intact chain
      } finally {
        client.release();
      }
      expect(await audit.verifyChain()).toEqual({ valid: true });
    });

    it('timestamps come from the database clock, not the application', async () => {
      const [row] = await db.query<{ skew: number }>(
        'SELECT abs(extract(epoch FROM (now() - max(occurred_at)))) AS skew FROM audit_trail',
      );
      expect(Number(row.skew)).toBeLessThan(60);
    });
  });

  describe('master-table rules (master spec §8)', () => {
    it('reject changes without an actor in the transaction', async () => {
      await expect(
        db.query("UPDATE roles SET description = 'x' WHERE code = 'OPERATOR'"),
      ).rejects.toThrow(/NXGEN-DB-001/);
    });

    it('reject physical deletes', async () => {
      await expect(
        db.transaction({ actorId: 'TEST' }, (c) =>
          c.query("DELETE FROM roles WHERE code = 'OPERATOR'"),
        ),
      ).rejects.toThrow(/NXGEN-DB-002/);
    });

    it('maintain version_no / modified_by and audit old and new values with the reason', async () => {
      await db.transaction(
        {
          actorId: 'TEST-USER',
          actorName: 'Test User',
          reason: 'Clarify wording',
        },
        (c) =>
          c.query(
            "UPDATE roles SET description = 'Operates instruments.' WHERE code = 'OPERATOR'",
          ),
      );
      const [role] = await db.query<{
        version_no: number;
        modified_by: string;
      }>("SELECT version_no, modified_by FROM roles WHERE code = 'OPERATOR'");
      expect(role).toEqual({ version_no: 2, modified_by: 'TEST-USER' });

      const [entry] = await audit.list({ action: 'UPDATE' });
      expect(entry).toMatchObject({
        tableName: 'roles',
        recordId: 'OPERATOR',
        actor: 'TEST-USER',
        reason: 'Clarify wording',
      });
      expect((entry.oldValue as { description: string }).description).toBe(
        'Operates instruments and acquires data.',
      );
      expect((entry.newValue as { description: string }).description).toBe(
        'Operates instruments.',
      );
    });

    it('soft delete stamps deleted_by/deleted_at and is audited as DELETE', async () => {
      await db.transaction({ actorId: 'TEST-USER', reason: 'Not used' }, (c) =>
        c.query(
          "UPDATE role_permissions SET is_deleted = true WHERE role_code = 'QA_REVIEWER' AND permission_code = 'audit.view'",
        ),
      );
      const [rp] = await db.query<{ deleted_by: string; deleted_at: Date }>(
        "SELECT deleted_by, deleted_at FROM role_permissions WHERE role_code = 'QA_REVIEWER'",
      );
      expect(rp.deleted_by).toBe('TEST-USER');
      expect(rp.deleted_at).toBeInstanceOf(Date);
      expect((await audit.list({ action: 'DELETE' }))[0].recordId).toBe(
        'QA_REVIEWER:audit.view',
      );
    });
  });

  describe('administrator setup, login and sessions (master spec §5)', () => {
    it('refuses to create the administrator before NxGen is activated', async () => {
      licensing.active = false;
      await expect(
        identity.createInitialAdministrator(
          { username: 'admin', fullName: 'Asha Rao', password: STRONG },
          ORIGIN,
        ),
      ).rejects.toThrow(/activated/);
      licensing.active = true;
    });

    it('enforces the password policy', async () => {
      await expect(
        identity.createInitialAdministrator(
          { username: 'admin', fullName: 'Asha Rao', password: 'short' },
          ORIGIN,
        ),
      ).rejects.toThrow(/at least 12 characters/);
      await expect(
        identity.createInitialAdministrator(
          {
            username: 'admin',
            fullName: 'Asha Rao',
            password: 'admin-Password-1',
          },
          ORIGIN,
        ),
      ).rejects.toThrow(/username/);
    });

    it('creates exactly one initial Super Administrator, audited, never exposing the hash', async () => {
      expect(await identity.administratorExists()).toBe(false);
      const created = await identity.createInitialAdministrator(
        {
          username: 'Admin',
          fullName: 'Asha Rao',
          email: 'asha@example.com',
          password: STRONG,
        },
        ORIGIN,
      );
      expect(created.username).toBe('admin');
      expect(await identity.administratorExists()).toBe(true);

      await expect(
        newIdentity().createInitialAdministrator(
          { username: 'second', fullName: 'Other Person', password: STRONG },
          ORIGIN,
        ),
      ).rejects.toThrow(/already exists/);

      const trail = await audit.readAll();
      const userCreate = trail.find(
        (e) => e.tableName === 'users' && e.action === 'CREATE',
      )!;
      expect(userCreate.actor).toBe('SYSTEM_SETUP');
      expect(JSON.stringify(userCreate.newValue)).not.toContain('scrypt');
      expect(
        trail.some((e) => e.action === 'INITIAL_ADMINISTRATOR_CREATED'),
      ).toBe(true);
    });

    it('signs in with the right password and resolves the session to a principal with permissions', async () => {
      const { token, principal } = await identity.login(
        'ADMIN ',
        STRONG,
        ORIGIN,
      );
      expect(principal).toMatchObject({
        username: 'admin',
        fullName: 'Asha Rao',
        roles: ['SUPER_ADMINISTRATOR'],
        mustChangePassword: false,
      });
      expect(principal.permissions).toEqual(
        expect.arrayContaining([
          'users.manage',
          'audit.view',
          'licensing.manage',
        ]),
      );
      expect((await identity.authenticate(token, ORIGIN))?.userId).toBe(
        principal.userId,
      );
      expect(await identity.authenticate('not-a-token', ORIGIN)).toBeNull();
    });

    it('gives the same answer for unknown users and wrong passwords, and audits both', async () => {
      await expect(identity.login('nobody', STRONG, ORIGIN)).rejects.toThrow(
        'Invalid username or password.',
      );
      await expect(
        identity.login('admin', 'Wrong-Password-1', ORIGIN),
      ).rejects.toThrow('Invalid username or password.');
      const failures = await audit.list({ action: 'LOGIN_FAILED' });
      expect(failures.map((f) => f.reason)).toEqual(
        expect.arrayContaining(['Unknown username', 'Wrong password']),
      );
    });

    it('locks the account after repeated failures, even for the right password', async () => {
      const strict = newIdentity({
        ...DEFAULT_SECURITY_POLICY,
        maxFailedLogins: 3,
      });
      await db.query('UPDATE user_security_state SET failed_login_count = 0');
      for (let i = 0; i < 3; i++)
        await expect(
          strict.login('admin', 'Wrong-Password-1', ORIGIN),
        ).rejects.toThrow();
      await expect(strict.login('admin', STRONG, ORIGIN)).rejects.toThrow(
        /locked/,
      );
      expect((await audit.list({ action: 'ACCOUNT_LOCKED' })).length).toBe(1);
      await db.query(
        'UPDATE user_security_state SET locked_until = NULL, failed_login_count = 0',
      );
    });

    it('ends idle sessions', async () => {
      const { token } = await identity.login('admin', STRONG, ORIGIN);
      await db.query(
        "UPDATE sessions SET last_seen_at = now() - interval '20 minutes' WHERE ended_at IS NULL",
      );
      expect(await identity.authenticate(token, ORIGIN)).toBeNull();
      const [ended] = await audit.list({ action: 'SESSION_ENDED' });
      expect(ended.reason).toBe('IDLE_TIMEOUT');
    });

    it('changes password, rejects reuse, and signs out other sessions', async () => {
      const a = await identity.login('admin', STRONG, ORIGIN);
      const b = await identity.login('admin', STRONG, ORIGIN);
      await expect(
        identity.changePassword(
          a.principal,
          'wrong',
          'Another-Secret-77',
          ORIGIN,
        ),
      ).rejects.toThrow(/incorrect/);
      await expect(
        identity.changePassword(a.principal, STRONG, STRONG, ORIGIN),
      ).rejects.toThrow(/differ/);

      await identity.changePassword(
        a.principal,
        STRONG,
        'Another-Secret-77',
        ORIGIN,
      );
      expect(await identity.authenticate(a.token, ORIGIN)).not.toBeNull();
      expect(await identity.authenticate(b.token, ORIGIN)).toBeNull();
      await expect(identity.login('admin', STRONG, ORIGIN)).rejects.toThrow();
      await expect(
        identity.login('admin', 'Another-Secret-77', ORIGIN),
      ).resolves.toBeDefined();

      const pwAudit = (await audit.readAll()).filter(
        (e) => e.tableName === 'users' && e.action === 'UPDATE',
      );
      expect(pwAudit.at(-1)?.newValue).toMatchObject({
        password_changed: true,
      });
      expect(JSON.stringify(pwAudit)).not.toContain('scrypt$');
    });

    it('forces a password change once the password has expired', async () => {
      await db.transaction({ actorId: 'TEST' }, (c) =>
        c.query(
          "UPDATE users SET password_changed_at = now() - interval '91 days'",
        ),
      );
      const { principal } = await identity.login(
        'admin',
        'Another-Secret-77',
        ORIGIN,
      );
      expect(principal.mustChangePassword).toBe(true);
    });

    it('leaves the audit chain intact after all of the above', async () => {
      expect(await audit.verifyChain()).toEqual({ valid: true });
    });
  });
});
