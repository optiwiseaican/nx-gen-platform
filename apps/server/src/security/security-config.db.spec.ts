import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  generateSigningKeyPair,
  issueRecoveryResponse,
  parseRecoveryRequest,
} from '@crescent/licensing';
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
import { SecureStorageService } from './secure-storage.service';
import { SignatureService } from '../signatures/signature.service';
import { RecoveryService } from '../users/recovery.service';
import { UserAdminService } from '../users/user-admin.service';
import { SecurityPolicyService } from './security-policy.service';
import { readSecurityPolicy } from './security-policy.store';

loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(120_000);

const ORIGIN: RequestOrigin = {
  ipAddress: '10.0.0.5',
  machineName: 'QC-LAB-PC',
  userAgent: 'jest',
};
const ROOT_PW = 'Lab-Secure-Key-71!';
const REASON = 'Per SOP-SEC-004 rev 3, CR-2026-077';
const vendor = generateSigningKeyPair();

describeDb('Security configuration, session, audit export, recovery', () => {
  const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-secconf-'));
  let config: NxGenConfig;
  let db: DatabaseService;
  let audit: AuditService;
  let identity: IdentityService;
  let signatures: SignatureService;
  let policy: SecurityPolicyService;
  let admin: UserAdminService;
  let recovery: RecoveryService;
  let platform: PlatformIdentityService;
  let root: Principal;

  const sign = (password = ROOT_PW) => ({
    username: 'root.admin',
    password,
    meaning: 'APPROVED',
  });

  beforeAll(async () => {
    config = {
      production: false,
      database: { ...baseDb!, schema },
      security: { ...DEFAULT_SECURITY_POLICY },
      dataDir,
      platformVersion: PLATFORM_VERSION,
      trustedKeys: [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }],
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
    platform = new PlatformIdentityService(
      config,
      new SecureStorageService(config),
    );
    platform.initializeIdentity();
    identity = new IdentityService(config, db, audit, platform, {
      isActive: () => true,
    });
    signatures = new SignatureService(config, db, audit, platform);
    policy = new SecurityPolicyService(config, db, audit, platform, signatures);
    admin = new UserAdminService(config, db, audit, platform, signatures);
    recovery = new RecoveryService(config, db, audit, platform, admin);
    await identity.createInitialAdministrator(
      {
        username: 'root.admin',
        fullName: 'Rita Root',
        email: 'rita@lab.example',
        password: ROOT_PW,
      },
      ORIGIN,
    );
    root = (await identity.login('root.admin', ROOT_PW, ORIGIN)).principal;
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('editable security policy', () => {
    it('is seeded with the values previously fixed at installation', async () => {
      expect((await readSecurityPolicy(db))?.policy).toEqual(
        DEFAULT_SECURITY_POLICY,
      );
      const sigPolicy = (await signatures.policies()).find(
        (p) => p.actionCode === 'SECURITY_POLICY_CHANGE',
      );
      expect(sigPolicy).toMatchObject({ required: true, locked: true });
    });

    it('requires a reason and a signature, and refuses values outside the validated limits', async () => {
      await expect(
        policy.update(root, { lockoutMinutes: 45 }, 'x', sign(), ORIGIN),
      ).rejects.toThrow(/reason/);
      await expect(
        policy.update(root, { lockoutMinutes: 45 }, REASON, undefined, ORIGIN),
      ).rejects.toMatchObject({ response: { code: 'NX-ESIG-REQUIRED' } });
      await expect(
        policy.update(root, { passwordMinLength: 6 }, REASON, sign(), ORIGIN),
      ).rejects.toMatchObject({ response: { field: 'passwordMinLength' } });
      await expect(
        policy.update(
          root,
          { sessionIdleMinutes: 15.5 },
          REASON,
          sign(),
          ORIGIN,
        ),
      ).rejects.toThrow(/whole number/);
      await expect(
        policy.update(root, { bogus: 1 }, REASON, sign(), ORIGIN),
      ).rejects.toThrow(/Unknown setting/);
      await expect(
        policy.update(root, { independentApproval: 0 }, REASON, sign(), ORIGIN),
      ).rejects.toThrow(/on or off/);
    });

    it('independent review and approval is on by default and can be switched off with a signed change', async () => {
      expect(config.security.independentApproval).toBe(true);
      const result = await policy.update(
        root,
        { independentApproval: false },
        'Single-analyst site: the author signs all steps (SOP-QA-012)',
        sign(),
        ORIGIN,
      );
      expect(result.policy.independentApproval).toBe(false);
      expect(config.security.independentApproval).toBe(false);
      expect((await readSecurityPolicy(db))?.policy.independentApproval).toBe(
        false,
      );
      const [changed] = await audit.list({ action: 'SECURITY_POLICY_CHANGED' });
      expect(changed.details).toMatchObject({
        independentApproval: 'true → false',
      });
      await policy.update(
        root,
        { independentApproval: true },
        'Restore independent approval',
        sign(),
        ORIGIN,
      );
      expect(config.security.independentApproval).toBe(true);
    });

    it('the database itself rejects weakening the rules below the limits', async () => {
      await expect(
        db.transaction({ actorId: root.userId, reason: REASON }, (c) =>
          c.query('UPDATE security_settings SET max_failed_logins = 50'),
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('applies a signed change immediately and records old and new values', async () => {
      const result = await policy.update(
        root,
        { maxFailedLogins: 3, sessionIdleMinutes: 10 },
        REASON,
        sign(),
        ORIGIN,
      );
      expect(result.policy).toMatchObject({
        maxFailedLogins: 3,
        sessionIdleMinutes: 10,
      });
      expect(config.security.maxFailedLogins).toBe(3);
      expect(identity.securityPolicy.sessionIdleMinutes).toBe(10);

      const [changed] = await audit.list({ action: 'SECURITY_POLICY_CHANGED' });
      expect(changed).toMatchObject({ reason: REASON, actor: root.userId });
      expect(changed.details).toMatchObject({ maxFailedLogins: '5 → 3' });
      const [rowAudit] = await audit.list({
        action: 'UPDATE',
        recordId: '1',
        category: undefined,
      });
      expect(rowAudit.tableName).toBe('security_settings');

      const [sig] = await signatures.list({ tableName: 'security_settings' });
      expect(sig).toMatchObject({
        intact: true,
        actionCode: 'SECURITY_POLICY_CHANGE',
      });
      expect(sig.signedContent).toMatchObject({
        changes: { maxFailedLogins: { from: 5, to: 3 } },
      });

      // A second service (e.g. after restart) loads the stored values.
      const fresh = { ...DEFAULT_SECURITY_POLICY };
      Object.assign(fresh, (await readSecurityPolicy(db))!.policy);
      expect(fresh.maxFailedLogins).toBe(3);
    });

    it('the new lockout threshold is enforced at sign-in', async () => {
      const { temporaryPassword } = await admin.createUser(
        root,
        {
          username: 'lock.test',
          fullName: 'Lena Lock',
          roles: ['ANALYST'],
          reason: REASON,
        },
        ORIGIN,
        sign(),
      );
      for (let i = 0; i < 3; i++)
        await expect(
          identity.login('lock.test', 'Wrong-Password-1!', ORIGIN),
        ).rejects.toThrow();
      await expect(
        identity.login('lock.test', temporaryPassword, ORIGIN),
      ).rejects.toThrow(/locked/);
    });
  });

  describe('session expiry information', () => {
    it('reports when the session ends and extends only the inactivity timer, audited', async () => {
      const { principal } = await identity.login('root.admin', ROOT_PW, ORIGIN);
      const s = principal.session!;
      const idle = new Date(s.idleExpiresAt).getTime();
      const max = new Date(s.expiresAt).getTime();
      expect(idle - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(idle - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5_000);
      expect(max - Date.now()).toBeGreaterThan(11 * 3_600_000);

      const extended = await identity.extendSession(principal, ORIGIN);
      expect(new Date(extended.session!.expiresAt).getTime()).toBe(max);
      expect(
        new Date(extended.session!.idleExpiresAt).getTime(),
      ).toBeGreaterThanOrEqual(idle);
      const [ev] = await audit.list({ action: 'SESSION_EXTENDED' });
      expect(ev.actor).toBe(principal.userId);
    });
  });

  describe('passive requests', () => {
    it('background polling does not keep an idle session alive; user actions do', async () => {
      const { token, principal } = await identity.login(
        'root.admin',
        ROOT_PW,
        ORIGIN,
      );
      const back = () =>
        db.query(
          "UPDATE sessions SET last_seen_at = now() - interval '5 minutes' WHERE id = $1",
          [principal.sessionId],
        );
      const seen = async () =>
        (
          await db.query<{ age: number }>(
            'SELECT extract(epoch FROM now() - last_seen_at)::int AS age FROM sessions WHERE id = $1',
            [principal.sessionId],
          )
        )[0].age;
      await back();
      expect(
        await identity.authenticate(token, ORIGIN, { activity: false }),
      ).not.toBeNull();
      expect(await seen()).toBeGreaterThanOrEqual(299);
      await identity.authenticate(token, ORIGIN);
      expect(await seen()).toBeLessThan(5);
      await back();
      await identity.touchSession(principal.sessionId);
      expect(await seen()).toBeLessThan(5);
    });
  });

  describe('audit trail export', () => {
    it('exports filtered rows oldest-first with hash-chain columns and a matching SHA-256', async () => {
      const out = await audit.exportCsv({ category: 'SECURITY' });
      expect(out.rows).toBeGreaterThan(3);
      expect(out.csv.startsWith('﻿sequence,event_id,occurred_at_utc')).toBe(
        true,
      );
      expect(out.csv).toContain(',prev_hash,hash\r\n');
      expect(out.sha256).toBe(
        createHash('sha256').update(out.csv, 'utf8').digest('hex'),
      );
      const lines = out.csv.trim().split('\r\n').slice(1);
      const seqs = lines.map((l) => Number(l.split(',')[0]));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(out.csv).not.toContain(',USER_MANAGEMENT,');
      expect(lines.every((l) => /,[0-9a-f]{64},[0-9a-f]{64}$/.test(l))).toBe(
        true,
      );

      const future = await audit.exportCsv({ from: '2099-01-01T00:00:00Z' });
      expect(future.rows).toBe(0);
    });

    it('exports the same selection as a PDF with a matching SHA-256', async () => {
      const filters = { category: 'SECURITY' };
      const out = await audit.exportPdf(filters, {
        generatedBy: 'Test',
        generatedById: root.userId,
        platformInstanceId: null,
        chain: { valid: true },
      });
      expect(out.pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(out.rows).toBe(await audit.countMatching(filters));
      expect(out.sha256).toBe(
        createHash('sha256').update(out.pdf).digest('hex'),
      );
    });

    it('neutralises spreadsheet formulas in exported values', async () => {
      await audit.record({
        category: 'SYSTEM',
        action: 'FORMULA_PROBE',
        result: 'INFO',
        actor: root.userId,
        reason: '=HYPERLINK("http://evil","x")',
      });
      const out = await audit.exportCsv({ action: 'FORMULA_PROBE' });
      expect(out.csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    });
  });

  describe('administrator recovery', () => {
    const respond = (code: string, hours?: number) =>
      issueRecoveryResponse({
        request: parseRecoveryRequest(code),
        privateKeyPem: vendor.privateKeyPem,
        supportReference: 'SUP-2026-0042',
        issuedBy: 'AICAN Support (A. Mehta)',
        validHours: hours,
      });

    it('creates a request bound to this platform without revealing whether the account qualifies', async () => {
      const a = await recovery.createRequest(
        'root.admin',
        'Only administrator forgot password; QA head J. Rao requesting',
        ORIGIN,
      );
      const b = await recovery.createRequest(
        'nobody.here',
        'Only administrator forgot password; QA head J. Rao requesting',
        ORIGIN,
      );
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      const req = parseRecoveryRequest(a.requestCode);
      expect(req).toMatchObject({
        username: 'root.admin',
        platform: { instanceId: platform.getIdentity().identity!.instanceId },
      });
      const events = await audit.list({ action: 'ADMIN_RECOVERY_REQUESTED' });
      expect(events.map((e) => e.details?.eligibleAccount)).toEqual(
        expect.arrayContaining([true, false]),
      );
    });

    it('rejects responses not signed by the vendor, and closes the request after 3 attempts', async () => {
      const { requestCode } = await recovery.createRequest(
        'root.admin',
        'Administrator locked out; ticket SUP-2026-0042',
        ORIGIN,
      );
      const rogue = generateSigningKeyPair();
      const forged = issueRecoveryResponse({
        request: parseRecoveryRequest(requestCode),
        privateKeyPem: rogue.privateKeyPem,
        supportReference: 'SUP-0',
        issuedBy: 'Someone',
      });
      for (let i = 0; i < 2; i++)
        await expect(recovery.complete(forged, ORIGIN)).rejects.toMatchObject({
          response: { code: 'NX-RECOVERY-REJECTED' },
        });
      await expect(recovery.complete(forged, ORIGIN)).rejects.toThrow(
        /now closed/,
      );
      // Even a genuine response no longer works for the closed request.
      await expect(
        recovery.complete(respond(requestCode), ORIGIN),
      ).rejects.toThrow(/no open recovery request/);
    });

    it('a genuine response resets the administrator to a one-time password, once', async () => {
      const { principal } = await identity.login('root.admin', ROOT_PW, ORIGIN);
      const { requestCode } = await recovery.createRequest(
        'rita@lab.example',
        'Administrator locked out; ticket SUP-2026-0042',
        ORIGIN,
      );
      // A newer request supersedes older pending ones.
      const response = respond(requestCode);
      const result = await recovery.complete(response, ORIGIN);
      expect(result.username).toBe('root.admin');
      expect(result.temporaryPassword).toHaveLength(16);

      expect(await identity.authenticate('x', ORIGIN)).toBeNull();
      const login = await identity.login(
        'root.admin',
        result.temporaryPassword,
        ORIGIN,
      );
      expect(login.principal.mustChangePassword).toBe(true);
      await expect(
        identity.login('root.admin', ROOT_PW, ORIGIN),
      ).rejects.toThrow();
      expect(principal.sessionId).not.toBe(login.principal.sessionId);

      await expect(recovery.complete(response, ORIGIN)).rejects.toThrow(
        /no open recovery request/,
      );
      const [done] = await audit.list({ action: 'ADMIN_RECOVERY_COMPLETED' });
      expect(done.details).toMatchObject({
        supportReference: 'SUP-2026-0042',
        signingKeyId: vendor.keyId,
      });
      expect(done.reason).toMatch(/SUP-2026-0042/);
    });

    it('refuses accounts that are not active Super Administrators even with a genuine response', async () => {
      const { requestCode } = await recovery.createRequest(
        'lock.test',
        'Analyst forgot password, wants recovery',
        ORIGIN,
      );
      await expect(
        recovery.complete(respond(requestCode), ORIGIN),
      ).rejects.toThrow(/Only an active Super Administrator/);
    });

    it('limits how often requests can be created', async () => {
      await recovery.createRequest(
        'root.admin',
        'Administrator locked out; ticket SUP-2026-0042',
        ORIGIN,
      );
      await expect(
        recovery.createRequest(
          'root.admin',
          'Administrator locked out; ticket SUP-2026-0042',
          ORIGIN,
        ),
      ).rejects.toThrow(/Too many/);
    });
  });

  it('leaves the audit chain intact', async () => {
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});
