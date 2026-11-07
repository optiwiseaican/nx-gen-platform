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
import { SignatureService } from '../signatures/signature.service';
import { UserAdminService } from '../users/user-admin.service';
import { WorkflowService } from '../workflow/workflow.service';
import { ModuleRegistry } from '../modules/module-registry';
import { DevicesService } from './devices.service';

loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(180_000);

const ORIGIN: RequestOrigin = {
  ipAddress: '10.0.0.8',
  machineName: 'QC-LAB-PC',
  userAgent: 'jest',
};
const ROOT_PW = 'Lab-Secure-Key-71!';
const REASON = 'New pH meter for QC lab 2, PO-2026-311';

/** Checklist calibration (core type OTHER); `fail` marks one check failed. */
const checks = (fail = false) => [
  {
    check: 'Zero with no load',
    expected: '0.0000 g',
    observed: '0.0000 g',
    pass: true,
  },
  {
    check: 'Span 100 g reference weight',
    expected: '100.0000 ± 0.0005 g',
    observed: fail ? '100.0021 g' : '100.0002 g',
    pass: !fail,
  },
];

describeDb('Device register and calibration (spec §4 Device Layer, §9)', () => {
  const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-dev-'));
  let db: DatabaseService;
  let audit: AuditService;
  let signatures: SignatureService;
  let workflow: WorkflowService;
  let devices: DevicesService;
  type Actor = { p: Principal; pw: string };
  const people: Record<string, Actor> = {};
  const sign = (a: Actor) => ({ username: a.p.username, password: a.pw });
  const act = (
    who: string,
    instanceId: string,
    step: string,
    comment?: string,
  ) =>
    workflow.act(
      people[who].p,
      instanceId,
      step,
      { signature: sign(people[who]), comment },
      ORIGIN,
    );
  let deviceId: string;

  const register = (who: string, extra: Record<string, unknown> = {}) =>
    devices.register(
      people[who].p,
      {
        instrumentType: 'OTHER',
        name: 'Balance QC-2',
        manufacturer: 'AICAN',
        model: 'XPR-205',
        serialNumber: 'PH7-2026-0042',
        assetTag: 'QC-INS-0101',
        location: 'QC Lab 2, bench 3',
        reason: REASON,
        ...extra,
      },
      ORIGIN,
      sign(people[who]),
    );

  const calibrate = async (
    who: string,
    readings: unknown[] = checks(),
    extra: Record<string, unknown> = {},
  ) => {
    const { calibrationId, device } = await devices.recordCalibration(
      people[who].p,
      deviceId,
      { readings, ...extra },
      ORIGIN,
    );
    return device.calibrations.find((c) => c.id === calibrationId)!;
  };
  const approve = async (c: { workflow: { id: string } }) => {
    await act('analyst', c.workflow.id, 'SUBMIT');
    await act('manager', c.workflow.id, 'APPROVE');
  };

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
    const identity = new IdentityService(config, db, audit, platform, {
      isActive: () => true,
    });
    signatures = new SignatureService(config, db, audit, platform);
    workflow = new WorkflowService(db, audit, platform, signatures);
    devices = new DevicesService(
      db,
      audit,
      signatures,
      workflow,
      new ModuleRegistry(),
    );
    devices.onModuleInit();
    const admin = new UserAdminService(config, db, audit, platform, signatures);
    await identity.createInitialAdministrator(
      { username: 'root.admin', fullName: 'Rita Root', password: ROOT_PW },
      ORIGIN,
    );
    people.root = {
      p: (await identity.login('root.admin', ROOT_PW, ORIGIN)).principal,
      pw: ROOT_PW,
    };
    for (const [username, fullName, roles] of [
      ['itadmin', 'Ivan IT', ['IT_ADMINISTRATOR']],
      ['analyst', 'Asha Analyst', ['ANALYST']],
      ['analyst2', 'Arun Analyst', ['ANALYST']],
      ['manager', 'Meera Manager', ['QA_MANAGER']],
    ] as const) {
      const { temporaryPassword } = await admin.createUser(
        people.root.p,
        {
          username,
          fullName,
          roles: [...roles],
          reason: 'QC lab staffing CR-2026-090',
        },
        ORIGIN,
        sign(people.root),
      );
      people[username] = {
        p: (await identity.login(username, temporaryPassword, ORIGIN))
          .principal,
        pw: temporaryPassword,
      };
    }
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.onModuleDestroy();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('registers an instrument (IT administrator, reason, signature); serial and asset tag are unique', async () => {
    await expect(register('analyst')).rejects.toThrow(/permission/);
    await expect(
      devices.register(
        people.itadmin.p,
        {
          instrumentType: 'OTHER',
          name: 'Spare balance',
          manufacturer: 'A',
          model: 'B',
          serialNumber: 'C',
          reason: REASON,
        },
        ORIGIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'NX-ESIG-REQUIRED' } });
    const d = await register('itadmin');
    deviceId = d.id;
    expect(d).toMatchObject({
      code: 'DEV-0001',
      status: 'ACTIVE',
      calibrationIntervalDays: 30,
    });
    expect(d.readiness).toMatchObject({
      state: 'NOT_CALIBRATED',
      usable: false,
    });
    await expect(
      register('itadmin', { assetTag: 'other' }),
    ).rejects.toMatchObject({ response: { field: 'serialNumber' } });
    await expect(
      register('itadmin', { serialNumber: 'X-1', assetTag: 'qc-ins-0101' }),
    ).rejects.toMatchObject({
      response: { field: 'assetTag' },
    });
    const [sig] = await signatures.list({
      tableName: 'devices',
      recordId: d.id,
    });
    expect(sig).toMatchObject({ actionCode: 'DEVICE_REGISTER', intact: true });
  });

  it('records a checklist calibration; only the performer may correct or submit it', async () => {
    const c = await calibrate('analyst');
    expect(c).toMatchObject({
      code: 'CAL-00001',
      outcome: 'PASS',
      dataSource: 'MANUAL',
      workflow: { state: 'DRAFT' },
    });
    expect(c.display).toEqual([{ label: 'Checks passed', value: '2 of 2' }]);

    await expect(calibrate('analyst2')).rejects.toThrow(
      /already has a calibration in progress/,
    );
    await expect(
      devices.updateCalibration(
        people.analyst2.p,
        deviceId,
        c.id,
        { readings: checks() },
        ORIGIN,
      ),
    ).rejects.toThrow(/Only the person who performed/);
    await expect(act('analyst2', c.workflow.id, 'SUBMIT')).rejects.toThrow(
      /Only the person who recorded/,
    );
    const view = await devices.get(deviceId, people.analyst2.p);
    expect(view.calibrations[0].allowedSteps).not.toContain('SUBMIT');

    await expect(
      devices.updateCalibration(
        people.analyst.p,
        deviceId,
        c.id,
        { readings: [{ check: 'Zero', observed: '' }] },
        ORIGIN,
      ),
    ).rejects.toThrow(/Check 1/);
    const corrected = await devices.updateCalibration(
      people.analyst.p,
      deviceId,
      c.id,
      { readings: checks(), remarks: 'Weights W-100 cert 2026-07' },
      ORIGIN,
    );
    expect(corrected.calibrations[0].remarks).toBe(
      'Weights W-100 cert 2026-07',
    );
  });

  it('is approved by an independent QA manager (no review stage) and makes the instrument ready', async () => {
    const [c] = (await devices.get(deviceId, people.analyst.p)).calibrations;
    await act('analyst', c.workflow.id, 'SUBMIT');
    await expect(
      db.transaction({ actorId: people.analyst.p.userId }, (q) =>
        q.query(
          "UPDATE calibration_records SET outcome = 'PASS', remarks = 'edited' WHERE id = $1",
          [c.id],
        ),
      ),
    ).rejects.toThrow(/NXGEN-WF-001/);
    const tasks = await workflow.tasks(people.manager.p);
    expect(tasks.map((t) => [t.step, t.title])).toEqual([
      ['APPROVE', 'CAL-00001 · DEV-0001 Balance QC-2'],
    ]);
    expect(tasks[0].link).toBe(`/devices/view/?calibration=${c.id}`);
    await expect(act('analyst', c.workflow.id, 'APPROVE')).rejects.toThrow(
      /cannot approve/,
    );
    await act('manager', c.workflow.id, 'APPROVE');

    const d = await devices.get(deviceId, people.analyst.p);
    expect(d.readiness).toMatchObject({
      state: 'READY',
      usable: true,
      lastCalibration: { code: 'CAL-00001', outcome: 'PASS' },
    });
    expect(
      new Date(d.readiness.dueAt!).getTime() -
        new Date(c.performedAt).getTime(),
    ).toBe(30 * 86_400_000);
    const [sig] = await signatures.list({
      tableName: 'calibration_records',
      recordId: c.id,
    });
    expect(sig).toMatchObject({
      meaningCode: 'APPROVED',
      signerFullName: 'Meera Manager',
    });
  });

  it('an approved failed calibration blocks the instrument', async () => {
    const c = await calibrate('analyst', checks(true));
    expect(c.outcome).toBe('FAIL');
    await approve(c);
    expect(
      (await devices.get(deviceId, people.analyst.p)).readiness,
    ).toMatchObject({
      state: 'CALIBRATION_FAILED',
      usable: false,
    });
  });

  it('an overdue calibration blocks the instrument; one due soon warns but allows use', async () => {
    // A second, daily-checked instrument; calibrations are back-dated as performed.
    const first = deviceId;
    const d2 = await register('itadmin', {
      serialNumber: 'PH7-2026-0043',
      assetTag: 'QC-INS-0102',
      calibrationIntervalDays: 3,
      calibrationWarningDays: 2,
    });
    deviceId = d2.id;
    try {
      const old = await calibrate('analyst', checks(), {
        performedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      });
      await approve(old);
      expect(
        (await devices.get(deviceId, people.analyst.p)).readiness,
      ).toMatchObject({ state: 'OVERDUE', usable: false });

      const recent = await calibrate('analyst', checks(), {
        performedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      });
      await approve(recent);
      expect(
        (await devices.get(deviceId, people.analyst.p)).readiness,
      ).toMatchObject({ state: 'DUE_SOON', usable: true });

      const updated = await devices.update(
        people.itadmin.p,
        deviceId,
        {
          calibrationIntervalDays: 30,
          reason: 'Weekly use only per SOP-QC-005 rev 2',
        },
        ORIGIN,
      );
      expect(updated.readiness.state).toBe('READY');
    } finally {
      deviceId = first;
    }
  });

  it('status changes are signed with a reason; out-of-service cannot be calibrated; retirement is final', async () => {
    await expect(
      devices.setStatus(
        people.itadmin.p,
        deviceId,
        'OUT_OF_SERVICE',
        'short',
        ORIGIN,
        sign(people.itadmin),
      ),
    ).rejects.toThrow(/at least 10/);
    let d = await devices.setStatus(
      people.itadmin.p,
      deviceId,
      'OUT_OF_SERVICE',
      'Electrode cracked, ticket MNT-2026-77',
      ORIGIN,
      sign(people.itadmin),
    );
    expect(d.readiness).toMatchObject({
      state: 'OUT_OF_SERVICE',
      usable: false,
    });
    expect(d.canCalibrate).toBe(false);
    await expect(calibrate('analyst')).rejects.toThrow(
      /Only an active instrument/,
    );

    d = await devices.setStatus(
      people.itadmin.p,
      deviceId,
      'RETIRED',
      'Replaced by DEV-0002 per CC-2026-12',
      ORIGIN,
      sign(people.itadmin),
    );
    expect(d.readiness.state).toBe('RETIRED');
    await expect(
      devices.setStatus(
        people.itadmin.p,
        deviceId,
        'ACTIVE',
        'Bring it back into use',
        ORIGIN,
        sign(people.itadmin),
      ),
    ).rejects.toThrow(/cannot return to service/);
    await expect(
      db.transaction({ actorId: people.itadmin.p.userId }, (q) =>
        q.query("UPDATE devices SET device_status = 'ACTIVE' WHERE id = $1", [
          deviceId,
        ]),
      ),
    ).rejects.toThrow(/NXGEN-DEV-001/);
    const changes = await audit.list({ action: 'DEVICE_STATUS_CHANGED' });
    expect(changes.map((e) => e.details?.to)).toEqual([
      'RETIRED',
      'OUT_OF_SERVICE',
    ]);
  });

  it('leaves the audit chain intact', async () => {
    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});
