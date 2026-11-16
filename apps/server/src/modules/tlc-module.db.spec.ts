import { createHash, randomBytes } from 'crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve, sep } from 'path';
import { generateSigningKeyPair, packModule } from '@crescent/licensing';
import { RgbImage, argb } from '../../../../modules/tlc/src/engine';
import { encodePng } from '../../../../modules/tlc/src/api/images';
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
import { DevicesService } from '../devices/devices.service';
import { GatewayService } from '../gateway/gateway.service';
import type { LicensingService } from '../licensing/licensing.service';
import { MethodsService } from '../methods/methods.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import { SignatureService } from '../signatures/signature.service';
import { UserAdminService } from '../users/user-admin.service';
import { WorkflowService } from '../workflow/workflow.service';
import { ModuleManagerService } from './module-manager.service';
import { ModuleRegistry } from './module-registry';

loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(240_000);

const TLC_DIST = resolve(__dirname, '../../../../modules/tlc/dist');
const ORIGIN: RequestOrigin = {
  ipAddress: '10.0.0.11',
  machineName: 'QC-LAB-PC',
  userAgent: 'jest',
};
const ROOT_PW = 'Lab-Secure-Key-71!';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const vendor = generateSigningKeyPair();

function readDist(dir: string) {
  const files: { path: string; data: Buffer }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else
        files.push({
          path: relative(dir, f).split(sep).join('/'),
          data: readFileSync(f),
        });
    }
  };
  for (const s of ['api', 'ui', 'migrations']) walk(join(dir, s));
  return {
    manifest: JSON.parse(
      readFileSync(join(dir, 'module.json'), 'utf8'),
    ) as Record<string, unknown>,
    files,
  };
}

describeDb(
  'TLC module (plate analyses with original images and signed approval)',
  () => {
    const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
    const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-tlc-'));
    let config: NxGenConfig;
    let db: DatabaseService;
    let audit: AuditService;
    let identity: IdentityService;
    let signatures: SignatureService;
    let workflow: WorkflowService;
    let devices: DevicesService;
    let methods: MethodsService;
    let registry: ModuleRegistry;
    let manager: ModuleManagerService;
    type Actor = { p: Principal; pw: string };
    const people: Record<string, Actor> = {};
    const sign = (a: Actor) => ({ username: a.p.username, password: a.pw });
    const act = (who: string, id: string, step: string, comment?: string) =>
      workflow.act(
        people[who].p,
        id,
        step,
        { signature: sign(people[who]), comment },
        ORIGIN,
      );
    const relogin = async (who: string) => {
      people[who].p = (
        await identity.login(people[who].p.username, people[who].pw, ORIGIN)
      ).principal;
    };
    const call = async (
      who: string,
      method: string,
      path: string,
      body?: unknown,
      query: Record<string, string> = {},
    ) => {
      const hit = manager.route('tlc', method, path);
      if (!hit) throw new Error(`no route ${method} ${path}`);
      const p = people[who].p;
      if (!p.permissions.includes(hit.route.permission))
        throw Object.assign(new Error(`forbidden: ${hit.route.permission}`), {
          status: 403,
        });
      return hit.route.handler({
        principal: p,
        params: hit.params,
        query,
        body,
        origin: ORIGIN,
      }) as Promise<Record<string, unknown>>;
    };
    let deviceId: string;
    let methodVersionId: string;
    let analysisId: string;
    let workflowId: string;

    beforeAll(async () => {
      if (!existsSync(join(TLC_DIST, 'module.json')))
        throw new Error('Build the TLC module first: npm run build:module:tlc');
      config = {
        production: false,
        database: { ...baseDb!, schema },
        security: { ...DEFAULT_SECURITY_POLICY },
        dataDir,
        platformVersion: PLATFORM_VERSION,
        trustedKeys: [
          { keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem },
        ],
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
      workflow = new WorkflowService(db, audit, platform, signatures, config);
      registry = new ModuleRegistry();
      devices = new DevicesService(db, audit, signatures, workflow, registry);
      devices.onModuleInit();
      methods = new MethodsService(db, audit, workflow);
      methods.onModuleInit();
      const gateway = new GatewayService(config, db, audit, registry);
      const licensing = {
        hasModule: (id: string) => id === 'tlc',
      } as unknown as LicensingService;
      manager = new ModuleManagerService(
        config,
        db,
        audit,
        signatures,
        licensing,
        registry,
        devices,
        gateway,
        workflow,
      );
      const admin = new UserAdminService(
        config,
        db,
        audit,
        platform,
        signatures,
      );
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
        ['reviewer', 'Ravi Reviewer', ['QA_REVIEWER']],
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
      for (const m of registry.all()) registry.remove(m.id);
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.onModuleDestroy();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('installs the signed TLC module with its workflow, permissions and tables', async () => {
      const { manifest, files } = readDist(TLC_DIST);
      const staged = await manager.stage(
        people.itadmin.p,
        packModule({ manifest, files, privateKeyPem: vendor.privateKeyPem }),
        'nxgen-tlc-1.0.0.nxmod',
      );
      expect(staged.problems).toEqual([]);
      const out = await manager.install(
        people.itadmin.p,
        staged.stagingId,
        'Install TLC module per CC-2026-052',
        sign(people.itadmin),
        ORIGIN,
      );
      expect(out).toMatchObject({
        loaded: true,
        module: { id: 'tlc', runtime: { state: 'RUNNING' } },
      });
      expect(await workflow.definition('TLC_ANALYSIS_APPROVAL')).toMatchObject({
        editPermission: 'tlc.analyze',
        reviewPermission: 'tlc.review',
        approvePermission: 'tlc.approve',
        requireReview: true,
      });
      for (const who of ['analyst', 'analyst2', 'reviewer', 'manager'])
        await relogin(who);
      expect(people.analyst.p.permissions).toEqual(
        expect.arrayContaining(['tlc.view', 'tlc.analyze']),
      );
      expect(people.analyst.p.permissions).not.toContain('tlc.approve');
      expect(people.manager.p.permissions).toEqual(
        expect.arrayContaining(['tlc.review', 'tlc.approve']),
      );
    });

    it('a TLC analysis needs a usable instrument: register, instrument check, approval', async () => {
      const d = await devices.register(
        people.itadmin.p,
        {
          instrumentType: 'TLC',
          name: 'TLC Scan 10 #1',
          manufacturer: 'AICAN',
          model: 'NxGen TLC Scan 10',
          serialNumber: 'TS10-2026-0007',
          reason: 'New TLC scanner, PO-2026-402',
        },
        ORIGIN,
        sign(people.itadmin),
      );
      deviceId = d.id;
      expect(d.module).toMatchObject({
        id: 'tlc',
        ui: `/modules/tlc/?device=${d.id}`,
      });
      const cal = (await call(
        'analyst',
        'POST',
        `/instruments/${deviceId}/calibrations`,
        {
          readings: [
            {
              check: 'Camera focus',
              expected: 'Sharp',
              observed: 'Sharp edges',
              pass: true,
            },
            {
              check: 'UV 254 nm lamp',
              expected: 'On',
              observed: 'Fluorescence visible',
              pass: true,
            },
          ],
        },
      )) as { calibrationId: string; code: string };
      const c = (
        await devices.get(deviceId, people.analyst.p)
      ).calibrations.find((x) => x.id === cal.calibrationId)!;
      expect(c).toMatchObject({
        outcome: 'PASS',
        display: [{ label: 'Checks passed', value: '2 of 2' }],
      });
      await act('analyst', c.workflow.id, 'SUBMIT');
      await act('manager', c.workflow.id, 'APPROVE');
      expect(
        (await devices.get(deviceId, people.analyst.p)).readiness.usable,
      ).toBe(true);
    });

    it('only approved TLC methods with Rf windows are offered', async () => {
      let m = await methods.create(
        people.analyst.p,
        {
          instrumentType: 'TLC',
          name: 'Identification of paracetamol and caffeine',
          parameters: [
            { name: 'Paracetamol', value: '0.40–0.50', unit: 'Rf' },
            { name: 'Caffeine', value: '0.62 ± 0.05', unit: 'Rf' },
            { name: 'Chamber saturation', value: '30', unit: 'min' },
          ],
        },
        ORIGIN,
      );
      expect((await call('analyst', 'GET', '/setup')).methods).toEqual([]); // draft is not offered
      const v = m.versions[0];
      await act('analyst', v.workflow.id, 'SUBMIT');
      await act('reviewer', v.workflow.id, 'REVIEW');
      await act('manager', v.workflow.id, 'APPROVE');
      m = await methods.get(m.id, people.analyst.p);
      methodVersionId = m.versions[0].id;
      const setup = (await call('analyst', 'GET', '/setup')) as {
        methods: { versionId: string; windows: unknown[] }[];
        devices: { id: string }[];
      };
      expect(setup.methods).toEqual([
        expect.objectContaining({
          versionId: methodVersionId,
          windows: [
            { compound: 'Paracetamol', min: 0.4, max: 0.5 },
            { compound: 'Caffeine', min: 0.57, max: 0.67 },
          ],
        }),
      ]);
      expect(setup.devices.map((d) => d.id)).toEqual([deviceId]);
    });

    it('creates an analysis (TLC-0001); it cannot be submitted without an image and an evaluation', async () => {
      await expect(
        call('analyst', 'POST', '/analyses', {
          deviceId,
          methodVersionId: 'nope',
          name: 'Nope',
          sampleId: 'S',
          plateType: 'Silica',
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        call('analyst', 'POST', '/analyses', {
          deviceId,
          methodVersionId,
          sampleId: 'SMP-2026-1187',
        }),
      ).rejects.toMatchObject({ status: 400, field: 'name' });
      const a = (await call('analyst', 'POST', '/analyses', {
        deviceId,
        methodVersionId,
        name: 'Paracetamol & caffeine identification',
        department: 'QC',
        sampleId: 'SMP-2026-1187',
        batch: 'B-24-0311',
        plateType: 'Silica gel 60 F254 (glass)',
        plateLot: 'HX38412',
        mobilePhase: 'Toluene : ethyl acetate : formic acid (5:4:1)',
      })) as { id: string; code: string; conclusion: string };
      analysisId = a.id;
      expect(a).toMatchObject({ code: 'TLC-0001', conclusion: 'INCOMPLETE' });
      const view = (await call(
        'analyst',
        'GET',
        `/analyses/${analysisId}`,
      )) as { workflow: { id: string; state: string } };
      workflowId = view.workflow.id;
      expect(view.workflow.state).toBe('DRAFT');
      await expect(act('analyst', workflowId, 'SUBMIT')).rejects.toMatchObject({
        response: {
          code: 'NX-WF-INCOMPLETE',
          message: 'Add at least one plate image before submitting.',
        },
      });
    });

    it('stores original plate images with their SHA-256; only real images, only by the analyst', async () => {
      await expect(
        call(
          'analyst',
          'POST',
          `/analyses/${analysisId}/images`,
          Buffer.from('<svg/>'),
          { illumination: 'UV254' },
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        call('analyst', 'POST', `/analyses/${analysisId}/images`, PNG, {
          illumination: 'INFRARED',
        }),
      ).rejects.toMatchObject({ field: 'illumination' });
      await expect(
        call('analyst2', 'POST', `/analyses/${analysisId}/images`, PNG, {
          illumination: 'UV254',
        }),
      ).rejects.toMatchObject({ status: 403 });
      const img = (await call(
        'analyst',
        'POST',
        `/analyses/${analysisId}/images`,
        PNG,
        { illumination: 'UV254', name: 'plate-uv254.png' },
      )) as { id: string; sha256: string };
      expect(img.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
      const file = (await call(
        'reviewer',
        'GET',
        `/images/${img.id}`,
      )) as unknown as { kind: string; contentType: string; data: Buffer };
      expect(file).toMatchObject({ kind: 'file', contentType: 'image/png' });
      expect(file.data.equals(PNG)).toBe(true);
      await expect(act('analyst', workflowId, 'SUBMIT')).rejects.toMatchObject({
        response: {
          message: expect.stringMatching(/Evaluate the plate/) as unknown,
        },
      });
    });

    it('evaluates the plate on the server: Rf, suitability and identification', async () => {
      const tracks = [
        {
          label: 'S1',
          role: 'STANDARD',
          spots: [
            { distanceMm: 36, compound: 'Paracetamol' },
            { distanceMm: 49.6, compound: 'Caffeine' },
          ],
        },
        {
          label: 'T1',
          role: 'SAMPLE',
          spots: [
            { distanceMm: 36.8, compound: 'Paracetamol' },
            { distanceMm: 50.4, compound: 'Caffeine' },
          ],
        },
      ];
      await expect(
        call('analyst2', 'PUT', `/analyses/${analysisId}/evaluation`, {
          solventFrontMm: 80,
          tracks,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        call('analyst', 'PUT', `/analyses/${analysisId}/evaluation`, {
          solventFrontMm: 40,
          tracks,
        }),
      ).rejects.toMatchObject({ status: 400 });
      const a = (await call(
        'analyst',
        'PUT',
        `/analyses/${analysisId}/evaluation`,
        { solventFrontMm: 80, tracks },
      )) as {
        conclusion: string;
        results: {
          identification: { compound: string; rf: number; pass: boolean }[];
        };
      };
      expect(a.conclusion).toBe('CONFORMS');
      expect(a.results.identification).toEqual([
        expect.objectContaining({
          compound: 'Paracetamol',
          rf: 0.46,
          pass: true,
        }),
        expect.objectContaining({ compound: 'Caffeine', rf: 0.63, pass: true }),
      ]);
    });

    it('submission locks the analysis and its images, in the module and in the database', async () => {
      await expect(act('analyst2', workflowId, 'SUBMIT')).rejects.toThrow(
        /Only the person who recorded/,
      );
      await act('analyst', workflowId, 'SUBMIT', 'Ready for QA review');
      await expect(
        call('analyst', 'PUT', `/analyses/${analysisId}/evaluation`, {
          solventFrontMm: 80,
          tracks: [],
        }),
      ).rejects.toMatchObject({ response: { code: 'NX-WF-LOCKED' } });
      await expect(
        call('analyst', 'POST', `/analyses/${analysisId}/images`, PNG, {
          illumination: 'WHITE',
        }),
      ).rejects.toMatchObject({ response: { code: 'NX-WF-LOCKED' } });
      const sha = createHash('sha256').update(PNG).digest('hex');
      await expect(
        db.query(
          `INSERT INTO tlc_images (analysis_id, illumination, file_name, content_type, size_bytes, sha256, data, uploaded_by) VALUES ($1, 'WHITE', 'x.png', 'image/png', $2, $3, $4, $5)`,
          [analysisId, PNG.length, sha, PNG, people.analyst.p.userId],
        ),
      ).rejects.toThrow(/NXGEN-TLC-002/);
      await expect(
        db.query("UPDATE tlc_images SET file_name = 'renamed.png'"),
      ).rejects.toThrow(/NXGEN-TLC-001/);
      await expect(db.query('DELETE FROM tlc_images')).rejects.toThrow(
        /NXGEN-TLC-001/,
      );
      await expect(
        db.transaction({ actorId: people.analyst.p.userId }, (c) =>
          c.query(
            "UPDATE tlc_analyses SET conclusion = 'CONFORMS' WHERE id = $1",
            [analysisId],
          ),
        ),
      ).rejects.toThrow(/NXGEN-WF-001/);
    });

    it('is reviewed and approved with signatures that bind the record and the image hashes', async () => {
      const tasks = await workflow.tasks(people.reviewer.p);
      expect(tasks.map((t) => [t.title, t.link])).toEqual([
        [
          'TLC-0001 · Paracetamol & caffeine identification (B-24-0311)',
          `/modules/tlc/?analysis=${analysisId}`,
        ],
      ]);
      await expect(act('analyst', workflowId, 'REVIEW')).rejects.toThrow(
        /cannot review/,
      );
      await act(
        'reviewer',
        workflowId,
        'REVIEW',
        'Rf values checked against the plate image',
      );
      await act('manager', workflowId, 'APPROVE', 'Identification conforms');
      const view = (await call(
        'analyst',
        'GET',
        `/analyses/${analysisId}`,
      )) as { workflow: { state: string; approvedBy: { name: string } } };
      expect(view.workflow).toMatchObject({
        state: 'APPROVED',
        approvedBy: { name: 'Meera Manager' },
      });
      const sigs = await signatures.list({
        tableName: 'tlc_analyses',
        recordId: analysisId,
      });
      expect(sigs.map((s) => s.meaningCode).reverse()).toEqual([
        'AUTHORED',
        'REVIEWED',
        'APPROVED',
      ]);
      expect(sigs.every((s) => s.intact)).toBe(true);
      expect(sigs[0].signedContent).toMatchObject({
        record: {
          code: 'TLC-0001',
          conclusion: 'CONFORMS',
          images: [
            {
              illumination: 'UV254',
              sha256: createHash('sha256').update(PNG).digest('hex'),
            },
          ],
          method: {
            rfWindows: [
              { compound: 'Paracetamol', min: 0.4, max: 0.5 },
              { compound: 'Caffeine', min: 0.57, max: 0.67 },
            ],
          },
        },
      });
      const list = (await call('analyst', 'GET', '/analyses')) as unknown as {
        code: string;
        workflow: { state: string };
      }[];
      expect(list.map((a) => [a.code, a.workflow.state])).toEqual([
        ['TLC-0001', 'APPROVED'],
      ]);
      expect(await audit.verifyChain()).toEqual({ valid: true });
    });

    // ---- Image path: a real plate straightened and evaluated by densitometry ----

    const FIXTURES = resolve(
      __dirname,
      '../../../../modules/tlc/src/engine/__fixtures__',
    );
    const PLATE_PNG = readFileSync(join(FIXTURES, 'five_lanes_5x10_uv254.png'));
    let analysis2: string;
    let workflow2: string;
    let plateId: string;
    let lanes: number[];
    let evaluationId: string;
    const layoutOf = (l: {
      baselineMm: number;
      solventFrontMm: number;
      trackWidthMm: number;
    }) => ({
      baselineMm: l.baselineMm,
      solventFrontMm: l.solventFrontMm,
      trackWidthMm: l.trackWidthMm,
      baselineSource: 'DETECTED',
      frontSource: 'DETECTED',
    });
    let layout: {
      baselineMm: number;
      solventFrontMm: number;
      trackWidthMm: number;
    };

    it('straightens a real plate image into a plate record (the original is kept, the plate is append-only)', async () => {
      let m = await methods.create(
        people.analyst.p,
        {
          instrumentType: 'TLC',
          name: 'Identification of compounds A and B',
          parameters: [
            { name: 'Compound A', value: '0.40–0.46', unit: 'Rf' },
            { name: 'Compound B', value: '0.60–0.66', unit: 'Rf' },
          ],
        },
        ORIGIN,
      );
      const v = m.versions[0];
      await act('analyst', v.workflow.id, 'SUBMIT');
      await act('reviewer', v.workflow.id, 'REVIEW');
      await act('manager', v.workflow.id, 'APPROVE');
      m = await methods.get(m.id, people.analyst.p);
      const a = (await call('analyst', 'POST', '/analyses', {
        deviceId,
        methodVersionId: m.versions[0].id,
        name: 'Compounds A and B, five-lane plate',
        sampleId: 'SMP-2026-1203',
        plateType: 'Silica gel 60 F254 (aluminium)',
      })) as { id: string; code: string; name: string; projectStatus: string };
      analysis2 = a.id;
      expect(a).toMatchObject({
        code: 'TLC-0002',
        name: 'Compounds A and B, five-lane plate',
        projectStatus: 'ACTIVE',
      });
      // Plate info and project fields can be changed while it is a draft.
      const d = (await call('analyst', 'PUT', `/analyses/${analysis2}/details`, {
        stationaryPhase: 'Silica gel 60',
        mobilePhase: 'Toluene : ethyl acetate (9:1)',
        staining: 'None (UV 254 nm)',
        projectStatus: 'ON_HOLD',
      })) as { stationaryPhase: string; mobilePhase: string; staining: string; projectStatus: string; name: string };
      expect(d).toMatchObject({
        stationaryPhase: 'Silica gel 60',
        mobilePhase: 'Toluene : ethyl acetate (9:1)',
        staining: 'None (UV 254 nm)',
        projectStatus: 'ON_HOLD',
        name: 'Compounds A and B, five-lane plate',
      });
      await expect(
        call('analyst2', 'PUT', `/analyses/${analysis2}/details`, { name: 'X' }),
      ).rejects.toMatchObject({ status: 403 });
      workflow2 = (
        (await call('analyst', 'GET', `/analyses/${analysis2}`)) as {
          workflow: { id: string };
        }
      ).workflow.id;
      const img = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/images`,
        PLATE_PNG,
        { illumination: 'UV254', name: 'five-lanes.png' },
      )) as {
        id: string;
        qc: { verdict: string; items: { check: string; status: string }[] };
      };
      // The capture quality gate ran on the upload and is kept with the image.
      expect(img.qc.verdict).not.toBe('RECAPTURE_REQUIRED');
      expect(img.qc.items.map((i) => i.check)).toContain('EXPOSURE');

      // An image that fails the gate (far too dark) cannot be straightened
      // without a reason; with one, the reason stays with the plate.
      const dark = encodePng(
        new RgbImage(200, 400, new Int32Array(200 * 400).fill(argb(8, 9, 8))),
      );
      const darkImg = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/images`,
        dark,
        { illumination: 'UV254', name: 'dark.png' },
      )) as { id: string; qc: { verdict: string } };
      expect(darkImg.qc.verdict).toBe('RECAPTURE_REQUIRED');
      const darkCorners = [
        { x: 0, y: 0 },
        { x: 199, y: 0 },
        { x: 199, y: 399 },
        { x: 0, y: 399 },
      ];
      await expect(
        call('analyst', 'POST', `/analyses/${analysis2}/plate`, {
          imageId: darkImg.id,
          corners: darkCorners,
          widthMm: 50,
          heightMm: 100,
        }),
      ).rejects.toMatchObject({ status: 409, field: 'qcOverrideReason' });
      const overridden = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/plate`,
        {
          imageId: darkImg.id,
          corners: darkCorners,
          widthMm: 50,
          heightMm: 100,
          qcOverrideReason: 'Reference plate from the validation set, deliberately dark',
        },
      )) as { qcOverrideReason: string };
      expect(overridden.qcOverrideReason).toBe(
        'Reference plate from the validation set, deliberately dark',
      );

      const outline = (await call(
        'analyst',
        'GET',
        `/analyses/${analysis2}/outline`,
        undefined,
        { imageId: img.id },
      )) as {
        image: { width: number; height: number };
        outline: { corners: { x: number; y: number }[] };
      };
      expect(outline.image).toEqual({
        id: img.id,
        width: 626,
        height: 1251,
        illumination: 'UV254',
      });
      expect(outline.outline.corners).toEqual([
        { x: 0, y: 0 },
        { x: 625, y: 0 },
        { x: 625, y: 1250 },
        { x: 0, y: 1250 },
      ]);

      const whole = [
        { x: 0, y: 0 },
        { x: 625, y: 0 },
        { x: 625, y: 1250 },
        { x: 0, y: 1250 },
      ];
      await expect(
        call('analyst2', 'POST', `/analyses/${analysis2}/plate`, {
          imageId: img.id,
          corners: whole,
          widthMm: 50,
          heightMm: 100,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        call('analyst', 'POST', `/analyses/${analysis2}/plate`, {
          imageId: img.id,
          corners: whole.slice(0, 3),
          widthMm: 50,
          heightMm: 100,
        }),
      ).rejects.toMatchObject({ field: 'corners' });
      const plate = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/plate`,
        {
          imageId: img.id,
          corners: whole,
          widthMm: 50,
          heightMm: 100,
          outlineSource: 'MANUAL',
        },
      )) as {
        id: string;
        widthPx: number;
        heightPx: number;
        pixelsSha256: string;
        isCurrent: boolean;
      };
      plateId = plate.id;
      expect(plate).toMatchObject({
        widthPx: 625,
        heightPx: 1250,
        isCurrent: true,
        channel: 'INTENSITY',
      });
      const file = (await call(
        'reviewer',
        'GET',
        `/plates/${plateId}/image`,
      )) as unknown as { kind: string; contentType: string; data: Buffer };
      expect(file).toMatchObject({ kind: 'file', contentType: 'image/png' });
      expect(file.data.subarray(1, 4).toString()).toBe('PNG');
      const processed = (await call(
        'reviewer',
        'GET',
        `/plates/${plateId}/image`,
        undefined,
        { processed: '1' },
      )) as unknown as { data: Buffer };
      expect(processed.data.subarray(1, 4).toString()).toBe('PNG');

      await expect(
        db.query('UPDATE tlc_plates SET width_mm = 60 WHERE id = $1', [
          plateId,
        ]),
      ).rejects.toThrow(/NXGEN-TLC-003/);
      await expect(db.query('DELETE FROM tlc_plates')).rejects.toThrow(
        /NXGEN-TLC-003/,
      );
    });

    it('finds the baseline, the solvent front and the five lanes automatically', async () => {
      const l = (await call('analyst', 'GET', `/plates/${plateId}/layout`)) as {
        baselineMm: number;
        solventFrontMm: number;
        trackWidthMm: number;
        baselineFound: boolean;
        frontFound: boolean;
        lanes: { centerMm: number; spots: { rf: number }[] }[];
      };
      layout = l;
      expect([l.baselineFound, l.frontFound]).toEqual([true, true]);
      expect(Math.abs(l.baselineMm - 11.8)).toBeLessThan(0.5);
      expect(Math.abs(l.solventFrontMm - 90.7)).toBeLessThan(0.5);
      expect(l.trackWidthMm).toBe(7);
      lanes = l.lanes.map((x) => x.centerMm);
      expect(lanes.map((c) => Math.round(c))).toEqual([7, 16, 25, 34, 43]);
      expect(l.lanes.map((x) => x.spots.length)).toEqual([3, 2, 2, 2, 2]);
    });

    it('evaluates the plate by densitometry into immutable snapshots E01, E02…', async () => {
      const tracks = [
        {
          name: 'Std',
          role: 'STANDARD',
          centerMm: lanes[0],
          source: 'DETECTED',
          sampleVolumeUl: 2,
          concentration: 1,
        },
        { name: 'S5', role: 'SAMPLE', centerMm: lanes[4], source: 'DETECTED' },
      ];
      await expect(
        call('analyst2', 'POST', `/analyses/${analysis2}/evaluations`, {
          layout: layoutOf(layout),
          tracks,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const e1 = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/evaluations`,
        { layout: layoutOf(layout), tracks },
      )) as {
        id: string;
        code: string;
        conclusion: string;
        contentSha256: string;
        results: {
          tracks: {
            name: string;
            spots: { rf: number; compound: string; source: string }[];
            profile: { hRf: number[]; processed: number[] };
          }[];
          rf: { suitability: { pass: boolean }[] };
        };
      };
      expect(e1).toMatchObject({ code: 'E01', conclusion: 'CONFORMS' });
      // The straightened plate is the fixture resampled by one pixel, so Rf
      // values agree with the tablet's to ±0.002.
      const expected = [
        [
          [0.34, ''],
          [0.425, 'Compound A'],
          [0.62, 'Compound B'],
        ],
        [
          [0.437, 'Compound A'],
          [0.635, 'Compound B'],
        ],
      ];
      expect(
        e1.results.tracks.map((t) => t.spots.map((s) => s.compound)),
      ).toEqual(expected.map((t) => t.map((s) => s[1])));
      e1.results.tracks.forEach((t, i) =>
        t.spots.forEach((s, k) =>
          expect(Math.abs(s.rf - (expected[i][k][0] as number))).toBeLessThan(
            0.0025,
          ),
        ),
      );
      expect(e1.results.tracks[0].profile.hRf.length).toBeGreaterThan(900);
      expect(e1.results.rf.suitability.every((s) => s.pass)).toBe(true);

      const e2 = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/evaluations`,
        {
          layout: layoutOf(layout),
          tracks: [
            ...tracks,
            {
              name: 'S2',
              role: 'SAMPLE',
              centerMm: lanes[1],
              source: 'DETECTED',
            },
          ],
          manualSpots: { '3': [{ startHrf: 30, endHrf: 38 }] },
        },
      )) as {
        id: string;
        code: string;
        conclusion: string;
        reasons: string[];
        results: { tracks: { name: string; spots: { source: string }[] }[] };
      };
      evaluationId = e2.id;
      expect(e2).toMatchObject({ code: 'E02', conclusion: 'DOES_NOT_CONFORM' });
      expect(e2.reasons).toEqual([
        'Sample S2: Compound A not found outside 0.4–0.46.',
        'Sample S2: Compound B not found outside 0.6–0.66.',
      ]);
      expect(e2.results.tracks[2].spots.map((s) => s.source)).toEqual([
        'MANUAL',
      ]);

      const view = (await call('analyst', 'GET', `/analyses/${analysis2}`)) as {
        conclusion: string;
        currentEvaluationId: string;
        evaluations: { code: string; conclusion: string }[];
        results: { conclusion: string };
      };
      expect(view).toMatchObject({
        conclusion: 'DOES_NOT_CONFORM',
        currentEvaluationId: e2.id,
      });
      expect(view.evaluations.map((e) => e.code)).toEqual(['E02', 'E01']);

      await expect(
        db.query("UPDATE tlc_evaluations SET conclusion = 'CONFORMS'"),
      ).rejects.toThrow(/NXGEN-TLC-004/);
      await expect(db.query('DELETE FROM tlc_evaluations')).rejects.toThrow(
        /NXGEN-TLC-004/,
      );
    });

    it('recomputes a snapshot from the original image and finds it intact', async () => {
      const v = (await call(
        'reviewer',
        'GET',
        `/evaluations/${evaluationId}/verify`,
      )) as {
        ok: boolean;
        code: string;
        checks: Record<
          string,
          { ok: boolean; stored?: string; recomputed?: string }
        >;
      };
      expect(v).toMatchObject({
        ok: true,
        code: 'E02',
        checks: {
          storedPlate: { ok: true },
          plateFromOriginal: { ok: true },
          evaluation: { ok: true },
        },
      });
      expect(v.checks.evaluation.stored).toBe(v.checks.evaluation.recomputed);
    });

    it('straightening the plate again retires the old plate and requires a new evaluation before submission', async () => {
      const img = (
        (await call('analyst', 'GET', `/analyses/${analysis2}`)) as {
          images: { id: string }[];
        }
      ).images[0];
      const plate2 = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/plate`,
        {
          imageId: img.id,
          corners: [
            { x: 2, y: 2 },
            { x: 623, y: 2 },
            { x: 623, y: 1248 },
            { x: 2, y: 1248 },
          ],
          widthMm: 50,
          heightMm: 100,
        },
      )) as { id: string };
      const rows = await db.query<{ id: string; is_current: boolean }>(
        'SELECT id, is_current FROM tlc_plates WHERE analysis_id = $1 ORDER BY created_at',
        [analysis2],
      );
      // The overridden dark plate, the five-lane plate and now plate 2.
      expect(rows.slice(1).map((r) => [r.id, r.is_current])).toEqual([
        [plateId, false],
        [plate2.id, true],
      ]);
      expect(rows[0].is_current).toBe(false);
      await expect(act('analyst', workflow2, 'SUBMIT')).rejects.toMatchObject({
        response: {
          message: expect.stringMatching(/evaluate it again/) as unknown,
        },
      });
      const e3 = (await call(
        'analyst',
        'POST',
        `/analyses/${analysis2}/evaluations`,
        {
          layout: layoutOf(layout),
          tracks: [
            {
              name: 'Std',
              role: 'STANDARD',
              centerMm: lanes[0] - 0.16,
              source: 'MANUAL',
              sampleVolumeUl: 2,
              concentration: 1,
            },
            {
              name: 'S5',
              role: 'SAMPLE',
              centerMm: lanes[4] - 0.16,
              source: 'MANUAL',
            },
          ],
        },
      )) as {
        id: string;
        code: string;
        conclusion: string;
        contentSha256: string;
      };
      expect(e3).toMatchObject({ code: 'E03', conclusion: 'CONFORMS' });
      evaluationId = e3.id;
    });

    it('is reviewed and approved with signatures over the plate and evaluation hashes; nothing can be added afterwards', async () => {
      await act('analyst', workflow2, 'SUBMIT', 'Ready for QA review');
      await act('reviewer', workflow2, 'REVIEW', 'Densitograms checked');
      await act('manager', workflow2, 'APPROVE', 'Identification conforms');
      const sigs = await signatures.list({
        tableName: 'tlc_analyses',
        recordId: analysis2,
      });
      expect(sigs.map((s) => s.meaningCode).reverse()).toEqual([
        'AUTHORED',
        'REVIEWED',
        'APPROVED',
      ]);
      expect(sigs.every((s) => s.intact)).toBe(true);
      const e = (await call(
        'reviewer',
        'GET',
        `/evaluations/${evaluationId}`,
      )) as {
        contentSha256: string;
        plateId: string;
      };
      const plate = (await call(
        'reviewer',
        'GET',
        `/analyses/${analysis2}`,
      )) as {
        plate: { pixelsSha256: string };
      };
      expect(sigs[0].signedContent).toMatchObject({
        record: {
          code: 'TLC-0002',
          conclusion: 'CONFORMS',
          evaluation: { code: 'E03', contentSha256: e.contentSha256 },
          straightenedPlate: { pixelsSha256: plate.plate.pixelsSha256 },
        },
      });
      await expect(
        call('analyst', 'POST', `/analyses/${analysis2}/evaluations`, {
          layout: layoutOf(layout),
          tracks: [{ name: 'X', role: 'SAMPLE', centerMm: 10 }],
        }),
      ).rejects.toMatchObject({ response: { code: 'NX-WF-LOCKED' } });
      await expect(
        db.transaction({ actorId: people.analyst.p.userId }, (c) =>
          c.query(
            `INSERT INTO tlc_evaluations (analysis_id, plate_id, number, code, input, results, conclusion, engine_version, content_sha256, created_by)
             VALUES ($1, $2, 9, 'E09', '{}', '{}', 'CONFORMS', 'x', 'y', $3)`,
            [analysis2, e.plateId, people.analyst.p.userId],
          ),
        ),
      ).rejects.toThrow(/NXGEN-TLC-002/);
      expect(
        (
          (await call(
            'reviewer',
            'GET',
            `/evaluations/${evaluationId}/verify`,
          )) as {
            ok: boolean;
          }
        ).ok,
      ).toBe(true);
      expect(await audit.verifyChain()).toEqual({ valid: true });
    });

    it('with independent approval switched off in the security policy, the author may review and approve', async () => {
      const m = await methods.create(
        people.root.p,
        {
          instrumentType: 'TLC',
          name: 'Single-analyst method',
          parameters: [{ name: 'Compound C', value: '0.30–0.36', unit: 'Rf' }],
        },
        ORIGIN,
      );
      const wf = m.versions[0].workflow.id;
      await act('root', wf, 'SUBMIT');
      await expect(act('root', wf, 'REVIEW')).rejects.toThrow(
        /someone else must review/,
      );
      config.security.independentApproval = false;
      try {
        await act('root', wf, 'REVIEW', 'Reviewed by the author');
        await act('root', wf, 'APPROVE', 'Approved by the author');
      } finally {
        config.security.independentApproval = true;
      }
      const approved = await methods.get(m.id, people.root.p);
      expect(approved.versions[0].workflow.state).toBe('APPROVED');
      const sigs = await signatures.list({
        tableName: 'method_versions',
        recordId: m.versions[0].id,
      });
      expect(sigs.map((s) => s.meaningCode).reverse()).toEqual([
        'AUTHORED',
        'REVIEWED',
        'APPROVED',
      ]);
      expect(new Set(sigs.map((s) => s.signerUsername))).toEqual(
        new Set(['root.admin']),
      );
    });
  },
);
