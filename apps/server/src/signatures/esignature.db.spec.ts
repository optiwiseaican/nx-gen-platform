import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { BootstrapJournal } from '../audit/bootstrap-journal';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { IdentityService } from '../auth/identity.service';
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
import { UserAdminService } from '../users/user-admin.service';
import { SignatureService } from './signature.service';

loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(90_000);

const ORIGIN: RequestOrigin = {
  ipAddress: '10.0.0.5',
  machineName: 'QC-LAB-PC',
  userAgent: 'jest',
};
const ROOT_PW = 'Lab-Secure-Key-71!';
const REASON = 'Access approved under CR-2026-031';

describeDb('Electronic signatures on PostgreSQL (21 CFR 11 Subpart C)', () => {
  const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-esig-'));
  let config: NxGenConfig;
  let db: DatabaseService;
  let audit: AuditService;
  let identity: IdentityService;
  let signatures: SignatureService;
  let admin: UserAdminService;
  let root: Principal;
  let rootToken: string;

  const sign = (password = ROOT_PW, extra: Record<string, unknown> = {}) => ({
    username: 'root.admin',
    password,
    meaning: 'APPROVED',
    ...extra,
  });

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
    const platform = new PlatformIdentityService(
      config,
      new SecureStorageService(config),
    );
    identity = new IdentityService(config, db, audit, platform, {
      isActive: () => true,
    });
    signatures = new SignatureService(config, db, audit, platform);
    admin = new UserAdminService(config, db, audit, platform, signatures);
    await identity.createInitialAdministrator(
      {
        username: 'root.admin',
        fullName: 'Rita Root',
        email: 'rita.root@example.com',
        password: ROOT_PW,
      },
      ORIGIN,
    );
    const login = await identity.login('root.admin', ROOT_PW, ORIGIN);
    root = login.principal;
    rootToken = login.token;
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const newUser = (username: string, signature?: ReturnType<typeof sign>) =>
    admin.createUser(
      root,
      {
        username,
        fullName: 'Nora Newhire',
        roles: ['ANALYST'],
        reason: REASON,
      },
      ORIGIN,
      signature,
    );

  it('seeds meanings and a signature policy; the policy change itself is locked as required', async () => {
    expect((await signatures.meanings()).map((m) => m.code)).toEqual(
      expect.arrayContaining([
        'APPROVED',
        'REVIEWED',
        'AUTHORED',
        'VERIFIED',
        'RESPONSIBLE',
      ]),
    );
    const policies = await signatures.policies();
    expect(
      policies.find((p) => p.actionCode === 'USER_ROLES_CHANGE'),
    ).toMatchObject({ required: true });
    expect(
      policies.find((p) => p.actionCode === 'SIGNATURE_POLICY_CHANGE'),
    ).toMatchObject({ required: true, locked: true });
    expect(root.permissions).toContain('security.manage');
  });

  it('refuses a required action without a signature and changes nothing', async () => {
    await expect(newUser('no.signature')).rejects.toMatchObject({
      response: { code: 'NX-ESIG-REQUIRED' },
    });
    expect(
      (await admin.listUsers()).some((u) => u.username === 'no.signature'),
    ).toBe(false);
  });

  it('rejects a wrong password, audits the attempt and changes nothing', async () => {
    await expect(
      newUser('bad.password', sign('Not-My-Password-1')),
    ).rejects.toMatchObject({ response: { code: 'NX-ESIG-FAILED' } });
    expect(
      (await admin.listUsers()).some((u) => u.username === 'bad.password'),
    ).toBe(false);
    const [failed] = await audit.list({ action: 'ESIGNATURE_FAILED' });
    expect(failed).toMatchObject({
      actor: root.userId,
      reason: 'Wrong password',
    });
  });

  it('only lets you sign as yourself (11.100)', async () => {
    await expect(
      newUser('impostor', sign(ROOT_PW, { username: 'someone.else' })),
    ).rejects.toMatchObject({
      response: { code: 'NX-ESIG-NOT-OWN' },
    });
  });

  it('applies a signature linked to exactly what was signed, with full manifestation (11.50, 11.70)', async () => {
    const { user } = await newUser('nora.newhire', sign());
    const [sig] = await signatures.list({
      tableName: 'users',
      recordId: user.id,
    });
    expect(sig).toMatchObject({
      signerFullName: 'Rita Root',
      signerUsername: 'root.admin',
      meaningCode: 'APPROVED',
      meaningStatement: 'I approve this record or change.',
      reason: REASON,
      actionCode: 'USER_CREATE',
      recordVersion: 1,
      intact: true,
    });
    expect(sig.signedContent).toMatchObject({
      action: 'USER_CREATE',
      username: 'nora.newhire',
      roles: ['ANALYST'],
    });
    expect(sig.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const [applied] = await audit.list({ action: 'ESIGNATURE_APPLIED' });
    expect(applied.details).toMatchObject({
      signatureId: sig.id,
      meaning: 'APPROVED',
      actionCode: 'USER_CREATE',
    });
  });

  it("accepts the signer's own email in place of the username", async () => {
    const { user } = await newUser(
      'email.signed',
      sign(ROOT_PW, { username: 'Rita.Root@Example.com' }),
    );
    const [sig] = await signatures.list({ recordId: user.id });
    expect(sig).toMatchObject({ signerUsername: 'root.admin', intact: true });
  });

  it('signatures cannot be modified, deleted or truncated', async () => {
    await expect(
      db.query("UPDATE electronic_signatures SET reason = 'x'"),
    ).rejects.toThrow(/NXGEN-ESIG-001/);
    await expect(db.query('DELETE FROM electronic_signatures')).rejects.toThrow(
      /NXGEN-ESIG-001/,
    );
    await expect(db.query('TRUNCATE electronic_signatures')).rejects.toThrow(
      /NXGEN-ESIG-001/,
    );
  });

  it('detects a signature transferred to another record by bypassing the trigger', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'ALTER TABLE electronic_signatures DISABLE TRIGGER electronic_signatures_no_update',
      );
      await client.query(
        `UPDATE electronic_signatures SET record_id = gen_random_uuid()::text`,
      );
      await client.query(
        'ALTER TABLE electronic_signatures ENABLE TRIGGER electronic_signatures_no_update',
      );
      const { rows } = await client.query<{ intact: boolean }>(
        'SELECT verify_signature(s) AS intact FROM electronic_signatures s',
      );
      expect(rows.every((r) => r.intact === false)).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await signatures.list()).every((s) => s.intact)).toBe(true);
  });

  it('rolls the signature back together with a change that fails', async () => {
    const before = (await signatures.list()).length;
    // Same username again → the change fails inside the transaction, after the signature was verified.
    await expect(newUser('nora.newhire', sign())).rejects.toThrow(
      /never reused/,
    );
    expect((await signatures.list()).length).toBe(before);
  });

  it('optional actions work unsigned, and are signed when the user chooses to', async () => {
    const [nora] = (await admin.listUsers()).filter(
      (u) => u.username === 'nora.newhire',
    );
    await admin.updateProfile(
      root,
      nora.id,
      { fullName: 'Nora N. Newhire', reason: 'Legal name change' },
      ORIGIN,
    );
    await admin.updateProfile(
      root,
      nora.id,
      { fullName: 'Nora Newhire', reason: 'Reverted per HR' },
      ORIGIN,
      {
        ...sign(),
        meaning: 'RESPONSIBLE',
      },
    );
    const sigs = await signatures.list({ recordId: nora.id });
    expect(
      sigs
        .filter((s) => s.actionCode === 'USER_PROFILE_UPDATE')
        .map((s) => s.meaningCode),
    ).toEqual(['RESPONSIBLE']);
  });

  it('changing the signature policy requires a signature and cannot unlock locked actions', async () => {
    await expect(
      signatures.updatePolicies(
        root,
        [{ actionCode: 'USER_UNLOCK', required: true }],
        REASON,
        undefined,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'NX-ESIG-REQUIRED' } });
    await expect(
      signatures.updatePolicies(
        root,
        [{ actionCode: 'SIGNATURE_POLICY_CHANGE', required: false }],
        REASON,
        sign(),
        ORIGIN,
      ),
    ).rejects.toThrow(/always requires/);

    const updated = await signatures.updatePolicies(
      root,
      [{ actionCode: 'USER_UNLOCK', required: true }],
      REASON,
      sign(),
      ORIGIN,
    );
    expect(updated.find((p) => p.actionCode === 'USER_UNLOCK')?.required).toBe(
      true,
    );
    const [policySig] = await signatures.list({
      tableName: 'signature_policies',
    });
    expect(policySig.signedContent).toMatchObject({
      changes: [
        { actionCode: 'USER_UNLOCK', required: { from: false, to: true } },
      ],
    });
    const trail = await audit.list({ recordId: 'USER_UNLOCK' });
    expect(
      trail.some(
        (e) => e.tableName === 'signature_policies' && e.action === 'UPDATE',
      ),
    ).toBe(true);
  });

  it('repeated signature failures lock the account and end its sessions (11.300(d))', async () => {
    expect(await identity.authenticate(rootToken, ORIGIN)).not.toBeNull();
    for (let i = 0; i < DEFAULT_SECURITY_POLICY.maxFailedLogins; i++) {
      await expect(
        newUser(`attempt.${i}`, sign('Wrong-Password-9!')),
      ).rejects.toThrow();
    }
    expect(await identity.authenticate(rootToken, ORIGIN)).toBeNull();
    await expect(identity.login('root.admin', ROOT_PW, ORIGIN)).rejects.toThrow(
      /locked/,
    );
    const [locked] = await audit.list({ action: 'ACCOUNT_LOCKED' });
    expect(locked.reason).toMatch(/failed signature/);
  });

  it('leaves the audit chain intact', async () => {
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});
