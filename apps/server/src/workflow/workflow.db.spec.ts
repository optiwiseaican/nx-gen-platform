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
import { MethodsService } from '../methods/methods.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import { SignatureService } from '../signatures/signature.service';
import { UserAdminService } from '../users/user-admin.service';
import { WorkflowService } from './workflow.service';

loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(180_000);

const ORIGIN: RequestOrigin = {
  ipAddress: '10.0.0.7',
  machineName: 'QC-LAB-PC',
  userAgent: 'jest',
};
const ROOT_PW = 'Lab-Secure-Key-71!';
const REASON = 'Staffing per QA org chart rev 4';

describeDb('Workflow engine with method approval (spec §4, §7)', () => {
  const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-wf-'));
  let db: DatabaseService;
  let audit: AuditService;
  let identity: IdentityService;
  let signatures: SignatureService;
  let workflow: WorkflowService;
  let methods: MethodsService;

  type Actor = { p: Principal; pw: string };
  const people: Record<string, Actor> = {};
  const sign = (a: Actor) => ({ username: a.p.username, password: a.pw });
  const act = (
    who: string,
    instanceId: string,
    step: string,
    extra: Record<string, unknown> = {},
  ) =>
    workflow.act(
      people[who].p,
      instanceId,
      step,
      { signature: sign(people[who]), ...extra },
      ORIGIN,
    );

  let methodId: string;
  const versions = async (who = 'analyst') =>
    (await methods.get(methodId, people[who].p)).versions;

  beforeAll(async () => {
    const config: NxGenConfig = {
      production: false,
      database: { ...baseDb!, schema },
      security: { ...DEFAULT_SECURITY_POLICY },
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
    workflow = new WorkflowService(db, audit, platform, signatures);
    methods = new MethodsService(db, audit, workflow);
    methods.onModuleInit();
    const admin = new UserAdminService(config, db, audit, platform, signatures);

    await identity.createInitialAdministrator(
      { username: 'root.admin', fullName: 'Rita Root', password: ROOT_PW },
      ORIGIN,
    );
    const root = (await identity.login('root.admin', ROOT_PW, ORIGIN))
      .principal;
    people.root = { p: root, pw: ROOT_PW };
    const staff: [string, string, string[]][] = [
      ['analyst', 'Asha Analyst', ['ANALYST']],
      ['reviewer', 'Ravi Reviewer', ['QA_REVIEWER']],
      ['manager', 'Meera Manager', ['QA_MANAGER']],
      ['manager2', 'Mohan Manager', ['QA_MANAGER']],
      ['dual', 'Dev Dual', ['ANALYST', 'QA_MANAGER']],
    ];
    for (const [username, fullName, roles] of staff) {
      const { temporaryPassword } = await admin.createUser(
        root,
        { username, fullName, roles, reason: REASON },
        ORIGIN,
        sign(people.root),
      );
      const { principal } = await identity.login(
        username,
        temporaryPassword,
        ORIGIN,
      );
      people[username] = { p: principal, pw: temporaryPassword };
    }
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('seeds the method workflow with segregated permissions', async () => {
    const d = await workflow.definition('METHOD_APPROVAL');
    expect(d).toMatchObject({
      requireReview: true,
      independentReviewer: true,
      independentApprover: true,
    });
    expect(people.analyst.p.permissions).toEqual(
      expect.arrayContaining(['methods.view', 'methods.edit']),
    );
    expect(people.analyst.p.permissions).not.toContain('methods.approve');
    expect(people.root.p.permissions).toContain('methods.view');
    expect(people.root.p.permissions).not.toContain('methods.edit');
    expect(people.manager.p.permissions).not.toContain('methods.edit');
  });

  it('creates a draft method (MTH-0001 v1) that its author can edit', async () => {
    await expect(
      methods.create(
        people.reviewer.p,
        { instrumentType: 'PH', name: 'pH of purified water' },
        ORIGIN,
      ),
    ).rejects.toThrow(/cannot edit/);
    const m = await methods.create(
      people.analyst.p,
      {
        instrumentType: 'PH',
        name: 'pH of purified water',
        purpose: 'Release testing of PW per USP <791>',
        parameters: [{ name: 'Temperature', value: '25', unit: '°C' }],
      },
      ORIGIN,
    );
    methodId = m.id;
    expect(m.code).toBe('MTH-0001');
    expect(m.versions[0]).toMatchObject({
      versionNumber: 1,
      workflow: { state: 'DRAFT' },
    });
    expect(m.canEditDraft).toBe(true);
    const edited = await methods.updateDraft(
      people.analyst.p,
      methodId,
      m.versions[0].id,
      {
        procedure:
          'Calibrate with pH 4.01, 7.00, 10.01 buffers; measure in triplicate.',
      },
      ORIGIN,
    );
    expect(edited.versions[0].procedure).toMatch(/triplicate/);
    expect(edited.versions[0].allowedSteps).toEqual(['SUBMIT']);
  });

  it('submission is signed (Authored), hashes the content and locks the record — in the service and the database', async () => {
    const [v1] = await versions();
    await expect(
      workflow.act(people.analyst.p, v1.workflow.id, 'SUBMIT', {}, ORIGIN),
    ).rejects.toMatchObject({ response: { code: 'NX-ESIG-REQUIRED' } });
    const i = await act('analyst', v1.workflow.id, 'SUBMIT');
    expect(i).toMatchObject({
      state: 'IN_REVIEW',
      preparedBy: { name: 'Asha Analyst' },
    });
    expect(i.contentHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      methods.updateDraft(
        people.analyst.p,
        methodId,
        v1.id,
        { name: 'Changed after submit' },
        ORIGIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'NX-WF-LOCKED' } });
    await expect(
      db.transaction({ actorId: people.analyst.p.userId }, (c) =>
        c.query(
          "UPDATE method_versions SET name = 'Sneaky edit' WHERE id = $1",
          [v1.id],
        ),
      ),
    ).rejects.toThrow(/NXGEN-WF-001/);
  });

  it('enforces permissions and independence at every step', async () => {
    const [v1] = await versions();
    // Approval before review is refused.
    await expect(act('manager', v1.workflow.id, 'APPROVE')).rejects.toThrow(
      /must be reviewed/,
    );
    // Analyst has no review permission.
    await expect(act('analyst', v1.workflow.id, 'REVIEW')).rejects.toThrow(
      /cannot review/,
    );
    // Only the preparer can withdraw.
    await expect(
      act('reviewer', v1.workflow.id, 'WITHDRAW', {
        comment: 'Not mine to withdraw',
      }),
    ).rejects.toThrow(/Only the person who submitted/);

    // Someone holding both edit and approve rights still cannot review or approve their own work.
    const dual = await methods.create(
      people.dual.p,
      { instrumentType: 'EC', name: 'Conductivity of WFI' },
      ORIGIN,
    );
    const dv = dual.versions[0];
    await act('dual', dv.workflow.id, 'SUBMIT');
    await expect(act('dual', dv.workflow.id, 'REVIEW')).rejects.toThrow(
      /someone else must review/,
    );
    await act('reviewer', dv.workflow.id, 'REVIEW');
    await expect(act('dual', dv.workflow.id, 'APPROVE')).rejects.toThrow(
      /someone else must approve/,
    );
  });

  it('review and approval are signed with fixed meanings; the review queue shows the right people', async () => {
    const [v1] = await versions();
    const reviewerTasks = await workflow.tasks(people.reviewer.p);
    expect(reviewerTasks.map((t) => [t.title, t.step])).toEqual(
      expect.arrayContaining([
        ['MTH-0001 v1 · pH of purified water', 'REVIEW'],
      ]),
    );
    expect(await workflow.tasks(people.analyst.p)).toEqual([]);

    // The meaning sent by the client is ignored: a review is always "Reviewed".
    await act('reviewer', v1.workflow.id, 'REVIEW', {
      signature: { ...sign(people.reviewer), meaning: 'APPROVED' },
    });
    await expect(act('reviewer', v1.workflow.id, 'APPROVE')).rejects.toThrow(
      /cannot approve/,
    );
    const approved = await act('manager', v1.workflow.id, 'APPROVE');
    expect(approved).toMatchObject({
      state: 'APPROVED',
      preparedBy: { name: 'Asha Analyst' },
      reviewedBy: { name: 'Ravi Reviewer' },
      approvedBy: { name: 'Meera Manager' },
    });

    const sigs = await signatures.list({
      tableName: 'method_versions',
      recordId: v1.id,
    });
    expect(
      sigs.map((s) => [s.signerFullName, s.meaningCode]).reverse(),
    ).toEqual([
      ['Asha Analyst', 'AUTHORED'],
      ['Ravi Reviewer', 'REVIEWED'],
      ['Meera Manager', 'APPROVED'],
    ]);
    expect(sigs.every((s) => s.intact)).toBe(true);
    expect(sigs[0].signedContent).toMatchObject({
      step: 'APPROVE',
      contentHash: approved.contentHash,
      record: { methodCode: 'MTH-0001', name: 'pH of purified water' },
    });

    const history = (await versions())[0].history;
    expect(history.map((e) => e.step)).toEqual([
      'CREATE',
      'SUBMIT',
      'REVIEW',
      'APPROVE',
    ]);
    expect(history[3].signature?.meaningLabel).toBe('Approved');
  });

  it('a new version needs a reason; rejection returns it to the chosen stage; approval supersedes the old version', async () => {
    await expect(
      methods.newVersion(people.analyst.p, methodId, 'short', ORIGIN),
    ).rejects.toThrow(/10 characters/);
    let m = await methods.newVersion(
      people.analyst.p,
      methodId,
      'Add buffer lot traceability per CAPA-2026-019',
      ORIGIN,
    );
    const v2 = m.versions[0];
    expect(v2).toMatchObject({
      versionNumber: 2,
      workflow: { state: 'DRAFT' },
      name: 'pH of purified water',
    });
    await expect(
      methods.newVersion(
        people.analyst.p,
        methodId,
        'Second draft at the same time',
        ORIGIN,
      ),
    ).rejects.toThrow(/Finish the version in progress/);

    await methods.updateDraft(
      people.analyst.p,
      methodId,
      v2.id,
      {
        parameters: [
          { name: 'Temperature', value: '25', unit: '°C' },
          { name: 'Buffer lot', value: 'Record on worksheet', unit: '' },
        ],
      },
      ORIGIN,
    );
    await act('analyst', v2.workflow.id, 'SUBMIT');
    await act('reviewer', v2.workflow.id, 'REVIEW');
    await expect(
      act('manager', v2.workflow.id, 'REJECT', { comment: 'no' }),
    ).rejects.toThrow(/at least 10/);
    const back = await act('manager', v2.workflow.id, 'REJECT', {
      comment: 'Reviewer must check the buffer list against SOP-QC-012',
      returnTo: 'IN_REVIEW',
    });
    expect(back).toMatchObject({
      state: 'IN_REVIEW',
      reviewedBy: null,
      preparedBy: { name: 'Asha Analyst' },
    });
    // Still locked: rejection to review does not reopen editing.
    await expect(
      methods.updateDraft(
        people.analyst.p,
        methodId,
        v2.id,
        { name: 'x x x' },
        ORIGIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'NX-WF-LOCKED' } });

    await act('reviewer', v2.workflow.id, 'REVIEW');
    // Meera rejected it, but she neither prepared nor reviewed it, so she may approve; Mohan approves here.
    await act('manager2', v2.workflow.id, 'APPROVE');
    m = await methods.get(methodId, people.analyst.p);
    expect(m.versions.map((v) => [v.versionNumber, v.workflow.state])).toEqual([
      [2, 'APPROVED'],
      [1, 'SUPERSEDED'],
    ]);
    expect((await methods.list()).find((x) => x.id === methodId)).toMatchObject(
      {
        latestVersion: 2,
        effectiveVersion: 2,
        latestState: 'APPROVED',
      },
    );
    expect(m.versions[1].history.map((e) => e.step)).toContain('SUPERSEDE');
  });

  it('rejection to draft reopens editing; withdrawal needs a reason', async () => {
    await methods.newVersion(
      people.analyst.p,
      methodId,
      'Tighten acceptance to ±0.05 pH',
      ORIGIN,
    );
    const v3 = (await versions())[0];
    await act('analyst', v3.workflow.id, 'SUBMIT');
    await expect(act('analyst', v3.workflow.id, 'WITHDRAW')).rejects.toThrow(
      /at least 10/,
    );
    const w = await workflow.act(
      people.analyst.p,
      v3.workflow.id,
      'WITHDRAW',
      { comment: 'Forgot to attach the change summary' },
      ORIGIN,
    );
    expect(w.state).toBe('DRAFT');
    await act('analyst', v3.workflow.id, 'SUBMIT');
    const r = await act('reviewer', v3.workflow.id, 'REJECT', {
      comment: 'Tolerance conflicts with USP <791> section 4',
    });
    expect(r.state).toBe('DRAFT');
    await methods.updateDraft(
      people.analyst.p,
      methodId,
      v3.id,
      { purpose: 'Corrected per review' },
      ORIGIN,
    );
  });

  it('detects content changed behind the engine’s back and refuses to sign it', async () => {
    const v3 = (await versions())[0];
    await act('analyst', v3.workflow.id, 'SUBMIT');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('nxgen.actor_id', 'TAMPER-TEST', true)",
      );
      await client.query(
        'ALTER TABLE method_versions DISABLE TRIGGER method_versions_lock',
      );
      await client.query(
        "UPDATE method_versions SET procedure_text = 'tampered' WHERE id = $1",
        [v3.id],
      );
      await client.query(
        'ALTER TABLE method_versions ENABLE TRIGGER method_versions_lock',
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await expect(
      act('reviewer', v3.workflow.id, 'REVIEW'),
    ).rejects.toMatchObject({
      response: { code: 'NX-WF-CONTENT-CHANGED' },
    });
  });

  it('the approved version can be invalidated (signed, with a reason)', async () => {
    const v2 = (await versions()).find((v) => v.versionNumber === 2)!;
    await expect(
      act('manager', v2.workflow.id, 'INVALIDATE', { comment: 'short' }),
    ).rejects.toThrow(/at least 10/);
    const inv = await act('manager', v2.workflow.id, 'INVALIDATE', {
      comment: 'USP <791> revision withdraws this procedure',
    });
    expect(inv.state).toBe('INVALIDATED');
    const [sig] = await signatures.list({
      tableName: 'method_versions',
      recordId: v2.id,
    });
    expect(sig).toMatchObject({
      meaningCode: 'INVALIDATED',
      reason: 'USP <791> revision withdraws this procedure',
    });
  });

  it('workflow history is append-only and every step is in the audit trail', async () => {
    await expect(db.query('DELETE FROM workflow_events')).rejects.toThrow(
      /NXGEN-WF-002/,
    );
    await expect(
      db.query("UPDATE workflow_events SET comment = 'x'"),
    ).rejects.toThrow(/NXGEN-WF-002/);
    const trail = await audit.list({ category: 'WORKFLOW', limit: 500 });
    expect(new Set(trail.map((e) => e.action))).toEqual(
      new Set([
        'WORKFLOW_SUBMIT',
        'WORKFLOW_REVIEW',
        'WORKFLOW_APPROVE',
        'WORKFLOW_REJECT',
        'WORKFLOW_WITHDRAW',
        'WORKFLOW_INVALIDATE',
      ]),
    );
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});
