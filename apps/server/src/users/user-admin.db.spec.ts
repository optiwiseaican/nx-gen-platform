import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { BootstrapJournal } from '../audit/bootstrap-journal';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { IdentityService } from '../auth/identity.service';
import { checkPasswordPolicy } from '../auth/password';
import {
  DEFAULT_SECURITY_POLICY,
  loadDatabaseConfig,
  loadEnvFile,
  NxGenConfig,
  PLATFORM_VERSION,
} from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { migrate } from '../database/migrator';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import { UserAdminService } from './user-admin.service';

loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(90_000);

const ORIGIN: RequestOrigin = {
  ipAddress: '127.0.0.1',
  machineName: 'TEST-PC',
  userAgent: 'jest',
};
const REASON = 'Approved by QA change request CR-101';
const ROOT_PW = 'Lab-Secure-Key-71!';
const USER_PW = 'Fresh-Bench-Key-58!';

describeDb('User & Role Management on PostgreSQL', () => {
  const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-users-'));
  let db: DatabaseService;
  let audit: AuditService;
  let identity: IdentityService;
  let admin: UserAdminService;
  let superAdmin: Principal;

  /** Signs a user in, handling the forced first password change. */
  async function signIn(
    username: string,
    password: string,
    newPassword?: string,
  ): Promise<Principal> {
    const { principal } = await identity.login(username, password, ORIGIN);
    if (principal.mustChangePassword && newPassword) {
      return identity.changePassword(principal, password, newPassword, ORIGIN);
    }
    return principal;
  }

  async function createAndSignIn(
    by: Principal,
    username: string,
    fullName: string,
    roles: string[],
  ) {
    const { user, temporaryPassword } = await admin.createUser(
      by,
      { username, fullName, roles, reason: REASON },
      ORIGIN,
    );
    const principal = await signIn(username, temporaryPassword, USER_PW);
    return { user, principal };
  }

  beforeAll(async () => {
    const config: NxGenConfig = {
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
    const platform = new PlatformIdentityService(
      config,
      new SecureStorageService(config),
    );
    identity = new IdentityService(config, db, audit, platform, {
      isActive: () => true,
    });
    admin = new UserAdminService(config, db, audit, platform);
    await identity.createInitialAdministrator(
      { username: 'root.admin', fullName: 'Root Admin', password: ROOT_PW },
      ORIGIN,
    );
    superAdmin = await signIn('root.admin', ROOT_PW);
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('migration 002 grants roles.manage to Super Administrator only', async () => {
    expect(superAdmin.permissions).toContain('roles.manage');
    const roles = await admin.listRoles();
    expect(
      roles
        .filter((r) => r.permissions.includes('roles.manage'))
        .map((r) => r.code),
    ).toEqual(['SUPER_ADMINISTRATOR']);
  });

  it('generated temporary passwords always satisfy the policy', () => {
    for (let i = 0; i < 50; i++) {
      expect(
        checkPasswordPolicy(
          admin.generateTemporaryPassword('lab.user', 'Lab User'),
          DEFAULT_SECURITY_POLICY,
          { username: 'lab.user', fullName: 'Lab User' },
        ),
      ).toEqual([]);
    }
  });

  it('creates a user with a one-time temporary password that must be changed at first sign-in', async () => {
    const { user, temporaryPassword } = await admin.createUser(
      superAdmin,
      {
        username: 'Priya.Analyst',
        fullName: 'Priya Sharma',
        email: 'priya@lab.example',
        roles: ['ANALYST'],
        reason: REASON,
      },
      ORIGIN,
    );
    expect(user).toMatchObject({
      username: 'priya.analyst',
      roles: ['ANALYST'],
      status: 'ACTIVE',
      mustChangePassword: true,
    });
    expect(user.createdByName).toBe('Root Admin');

    const { principal } = await identity.login(
      'priya.analyst',
      temporaryPassword,
      ORIGIN,
    );
    expect(principal.mustChangePassword).toBe(true);

    const history = await admin.userHistory(user.id);
    const created = history.find((e) => e.action === 'USER_CREATED')!;
    expect(created).toMatchObject({
      actor: superAdmin.userId,
      actorName: 'Root Admin',
      reason: REASON,
    });
    expect(
      history.some(
        (e) => e.action === 'CREATE' && e.tableName === 'user_roles',
      ),
    ).toBe(true);
  });

  it('requires a reason for every change', async () => {
    await expect(
      admin.createUser(
        superAdmin,
        {
          username: 'x.user',
          fullName: 'X User',
          roles: ['OPERATOR'],
          reason: '',
        },
        ORIGIN,
      ),
    ).rejects.toThrow(/reason/);
    const users = await admin.listUsers();
    const priya = users.find((u) => u.username === 'priya.analyst')!;
    await expect(
      admin.setRoles(
        superAdmin,
        priya.id,
        { roles: ['QA_REVIEWER'], reason: 'ok' },
        ORIGIN,
      ),
    ).rejects.toThrow(/reason/);
  });

  it('never reuses a username', async () => {
    await expect(
      admin.createUser(
        superAdmin,
        {
          username: 'priya.analyst',
          fullName: 'Someone Else',
          roles: ['OPERATOR'],
          reason: REASON,
        },
        ORIGIN,
      ),
    ).rejects.toThrow(/never reused/);
  });

  it('changes roles with old/new values on the trail, effective immediately for the user', async () => {
    const { user, principal } = await createAndSignIn(
      superAdmin,
      'qa.mgr',
      'Quinn Manager',
      ['QA_REVIEWER'],
    );
    expect(principal.permissions).not.toContain('users.view');

    await admin.setRoles(
      superAdmin,
      user.id,
      { roles: ['QA_MANAGER', 'QA_REVIEWER'], reason: REASON },
      ORIGIN,
    );
    const refreshed = await identity.loadPrincipal(
      user.id,
      principal.sessionId,
    );
    expect(refreshed.roles).toEqual(['QA_MANAGER', 'QA_REVIEWER']);
    expect(refreshed.permissions).toContain('users.view');

    const changed = (await admin.userHistory(user.id)).find(
      (e) => e.action === 'USER_ROLES_CHANGED',
    )!;
    expect(changed.details).toMatchObject({
      from: 'QA_REVIEWER',
      to: 'QA_MANAGER,QA_REVIEWER',
    });
  });

  it('segregation of duties: nobody changes their own roles or status', async () => {
    await expect(
      admin.setRoles(
        superAdmin,
        superAdmin.userId,
        { roles: ['AUDITOR'], reason: REASON },
        ORIGIN,
      ),
    ).rejects.toThrow(/your own/);
    await expect(
      admin.setStatus(
        superAdmin,
        superAdmin.userId,
        'DISABLED',
        REASON,
        ORIGIN,
      ),
    ).rejects.toThrow(/your own/);
    await expect(
      admin.resetPassword(superAdmin, superAdmin.userId, REASON, ORIGIN),
    ).rejects.toThrow(/your own/);
  });

  it('an IT Administrator cannot grant Super Administrator or touch Super Administrator accounts', async () => {
    const { principal: it } = await createAndSignIn(
      superAdmin,
      'it.admin',
      'Ivan Tech',
      ['IT_ADMINISTRATOR'],
    );
    await expect(
      admin.createUser(
        it,
        {
          username: 'sneaky',
          fullName: 'Sneaky Person',
          roles: ['SUPER_ADMINISTRATOR'],
          reason: REASON,
        },
        ORIGIN,
      ),
    ).rejects.toThrow(/Only a Super Administrator/);
    await expect(
      admin.setStatus(it, superAdmin.userId, 'DISABLED', REASON, ORIGIN),
    ).rejects.toThrow(/Only a Super Administrator/);
    await expect(
      admin.resetPassword(it, superAdmin.userId, REASON, ORIGIN),
    ).rejects.toThrow(/Only a Super Administrator/);

    // …but can manage ordinary accounts.
    const { user } = await admin.createUser(
      it,
      {
        username: 'op.one',
        fullName: 'Olga Operator',
        roles: ['OPERATOR'],
        reason: REASON,
      },
      ORIGIN,
    );
    expect(user.createdByName).toBe('Ivan Tech');
  });

  it('protects the last active Super Administrator', async () => {
    const { user: second, principal: secondP } = await createAndSignIn(
      superAdmin,
      'second.sa',
      'Sam Second',
      ['SUPER_ADMINISTRATOR'],
    );
    // With two, one may demote the other…
    await admin.setRoles(
      secondP,
      superAdmin.userId,
      { roles: ['IT_ADMINISTRATOR'], reason: REASON },
      ORIGIN,
    );
    // root is now IT admin; second is the only SA → root cannot demote or disable second.
    const root = await identity.loadPrincipal(
      superAdmin.userId,
      superAdmin.sessionId,
    );
    expect(root.roles).toEqual(['IT_ADMINISTRATOR']);
    await expect(
      admin.setStatus(root, second.id, 'DISABLED', REASON, ORIGIN),
    ).rejects.toThrow(/Only a Super Administrator/);

    // Restore root as SA (by second), then verify last-SA protection directly.
    await admin.setRoles(
      secondP,
      superAdmin.userId,
      { roles: ['SUPER_ADMINISTRATOR'], reason: REASON },
      ORIGIN,
    );
    superAdmin = await identity.loadPrincipal(
      superAdmin.userId,
      superAdmin.sessionId,
    );
    await admin.setStatus(superAdmin, second.id, 'DISABLED', REASON, ORIGIN);
    const { principal: third } = await createAndSignIn(
      superAdmin,
      'third.sa',
      'Tara Third',
      ['SUPER_ADMINISTRATOR'],
    );
    await admin.setStatus(third, superAdmin.userId, 'DISABLED', REASON, ORIGIN);
    await expect(
      admin.setRoles(
        superAdmin,
        third.userId,
        { roles: ['AUDITOR'], reason: REASON },
        ORIGIN,
      ),
    ).rejects.toThrow();
    // third is now the only active SA: it cannot be demoted by anyone.
    await admin.setStatus(third, superAdmin.userId, 'ACTIVE', REASON, ORIGIN);
    superAdmin = await signIn('root.admin', ROOT_PW);
    await admin.setRoles(
      superAdmin,
      third.userId,
      { roles: ['AUDITOR'], reason: REASON },
      ORIGIN,
    );
    await expect(
      admin.setStatus(third, superAdmin.userId, 'DISABLED', REASON, ORIGIN),
    ).rejects.toThrow();
  });

  it('disabling a user ends their sessions and blocks sign-in; enabling restores it', async () => {
    const { user, principal } = await createAndSignIn(
      superAdmin,
      'temp.worker',
      'Tom Worker',
      ['OPERATOR'],
    );
    const { token } = await identity.login('temp.worker', USER_PW, ORIGIN);
    expect(principal.userId).toBe(user.id);

    await admin.setStatus(
      superAdmin,
      user.id,
      'DISABLED',
      'Left the company',
      ORIGIN,
    );
    expect(await identity.authenticate(token, ORIGIN)).toBeNull();
    await expect(
      identity.login('temp.worker', USER_PW, ORIGIN),
    ).rejects.toThrow('Invalid username or password.');

    await admin.setStatus(
      superAdmin,
      user.id,
      'ACTIVE',
      'Rehired, ticket HR-77',
      ORIGIN,
    );
    await expect(
      identity.login('temp.worker', USER_PW, ORIGIN),
    ).resolves.toBeDefined();
    const actions = (await admin.userHistory(user.id)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['USER_DISABLED', 'USER_ENABLED']),
    );
  });

  it('unlocks a locked account and resets passwords to a new temporary password', async () => {
    const { user } = await createAndSignIn(
      superAdmin,
      'locked.out',
      'Lee Locked',
      ['ANALYST'],
    );
    for (let i = 0; i < 5; i++)
      await expect(
        identity.login('locked.out', 'Wrong-Pass-123!', ORIGIN),
      ).rejects.toThrow();
    expect((await admin.getUser(user.id)).locked).toBe(true);

    await admin.unlock(
      superAdmin,
      user.id,
      'User confirmed identity by phone',
      ORIGIN,
    );
    expect((await admin.getUser(user.id)).locked).toBe(false);

    const { temporaryPassword } = await admin.resetPassword(
      superAdmin,
      user.id,
      'Forgot password, ticket IT-9',
      ORIGIN,
    );
    await expect(
      identity.login('locked.out', USER_PW, ORIGIN),
    ).rejects.toThrow();
    const { principal } = await identity.login(
      'locked.out',
      temporaryPassword,
      ORIGIN,
    );
    expect(principal.mustChangePassword).toBe(true);
  });

  it('edits role permissions (audited) but never the Super Administrator role', async () => {
    await expect(
      admin.setRolePermissions(
        superAdmin,
        'SUPER_ADMINISTRATOR',
        { permissions: [], reason: REASON },
        ORIGIN,
      ),
    ).rejects.toThrow(/cannot be edited/);

    const role = await admin.setRolePermissions(
      superAdmin,
      'OPERATOR',
      { permissions: ['system.view'], reason: REASON },
      ORIGIN,
    );
    expect(role.permissions).toEqual(['system.view']);
    await expect(
      admin.setRolePermissions(
        superAdmin,
        'OPERATOR',
        { permissions: ['made.up'], reason: REASON },
        ORIGIN,
      ),
    ).rejects.toThrow(/Unknown permission/);

    const created = await admin.createRole(
      superAdmin,
      {
        code: 'lab supervisor',
        name: 'Lab Supervisor',
        description: 'Supervises bench analysts',
        permissions: ['audit.view', 'users.view'],
        reason: REASON,
      },
      ORIGIN,
    );
    expect(created).toMatchObject({
      code: 'LAB_SUPERVISOR',
      isSystem: false,
      permissions: ['audit.view', 'users.view'],
    });
    const trail = await audit.list({ recordId: 'LAB_SUPERVISOR' });
    expect(trail.map((e) => e.action)).toContain('ROLE_CREATED');
  });

  it('leaves the audit chain intact', async () => {
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});
