import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import {
  appendFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve, sep } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { generateSigningKeyPair, packModule } from '@crescent/licensing';
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
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import { SignatureService } from '../signatures/signature.service';
import { UserAdminService } from '../users/user-admin.service';
import { WorkflowService } from '../workflow/workflow.service';
import { lintModuleSql } from './migration-lint';
import { ModuleManagerService } from './module-manager.service';
import { ModuleRegistry } from './module-registry';

loadEnvFile();
const baseDb = process.env.DATABASE_URL ? loadDatabaseConfig() : null;
const describeDb = baseDb ? describe : describe.skip;
jest.setTimeout(240_000);

const PH_DIST = resolve(__dirname, '../../../../modules/ph/dist');
/** The version being built (the tests follow it). */
const PH_VERSION = existsSync(join(PH_DIST, 'module.json'))
  ? (
      JSON.parse(readFileSync(join(PH_DIST, 'module.json'), 'utf8')) as {
        version: string;
      }
    ).version
  : '0.0.0';
const NEXT_VERSION = PH_VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORIGIN: RequestOrigin = {
  ipAddress: '10.0.0.9',
  machineName: 'QC-LAB-PC',
  userAgent: 'jest',
};
const ROOT_PW = 'Lab-Secure-Key-71!';
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

describe('module migration lint', () => {
  it('allows the module’s own objects and references to core tables, nothing else', () => {
    const ok = `CREATE TABLE ph_x (id uuid PRIMARY KEY, device_id uuid REFERENCES devices (id));
      CREATE UNIQUE INDEX ph_x_idx ON ph_x (id);
      CREATE TRIGGER ph_x_before BEFORE INSERT OR UPDATE OR DELETE ON ph_x FOR EACH ROW EXECUTE FUNCTION master_before_write();
      INSERT INTO ph_x (id) VALUES (gen_random_uuid()) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id;
      UPDATE ph_x SET id = id;`;
    expect(lintModuleSql(ok, 'ph_')).toEqual([]);
    expect(lintModuleSql('UPDATE users SET status = 1;', 'ph_')).toEqual([
      'Write to users: must start with "ph_"',
    ]);
    expect(
      lintModuleSql('INSERT INTO role_permissions VALUES (1);', 'ph_')[0],
    ).toMatch(/role_permissions/);
    expect(lintModuleSql('DROP TABLE audit_trail;', 'ph_')[0]).toMatch(
      /audit_trail/,
    );
    expect(
      lintModuleSql(
        'CREATE TRIGGER ph_t BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION f();',
        'ph_',
      )[0],
    ).toMatch(/Trigger on users/);
    expect(
      lintModuleSql('CREATE TABLE public.ph_x (id int);', 'ph_')[0],
    ).toMatch(/schema-qualified/);
    expect(lintModuleSql('GRANT ALL ON ph_x TO public;', 'ph_')[0]).toMatch(
      /GRANT/,
    );
    expect(
      lintModuleSql(
        'CREATE TRIGGER ph_t BEFORE TRUNCATE ON ph_x FOR EACH STATEMENT EXECUTE FUNCTION ph_f();',
        'ph_',
      ),
    ).toEqual([]);
    expect(lintModuleSql('TRUNCATE users;', 'ph_')[0]).toMatch(/users/);
    // Pinning a function to the current schema is fine; changing the session is not.
    expect(
      lintModuleSql(
        'CREATE FUNCTION ph_f() RETURNS int LANGUAGE sql SET search_path FROM CURRENT AS $$ SELECT 1 $$;',
        'ph_',
      ),
    ).toEqual([]);
    expect(lintModuleSql('SET search_path TO public;', 'ph_')[0]).toMatch(
      /search_path/,
    );
    expect(lintModuleSql('SET ROLE avnadmin;', 'ph_')[0]).toMatch(
      /search_path or role/,
    );
    expect(
      lintModuleSql(
        'CREATE FUNCTION ph_f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
        'ph_',
      )[0],
    ).toMatch(/SECURITY DEFINER/);
  });
});

describeDb(
  'Module system with the real pH module (Technical Architecture §3–§6)',
  () => {
    const schema = `nxgen_test_${randomBytes(4).toString('hex')}`;
    const dataDir = mkdtempSync(join(tmpdir(), 'nxgen-mod-'));
    const entitled = new Set(['ph']);
    let config: NxGenConfig;
    let db: DatabaseService;
    let audit: AuditService;
    let signatures: SignatureService;
    let workflow: WorkflowService;
    let devices: DevicesService;
    let gateway: GatewayService;
    let registry: ModuleRegistry;
    let manager: ModuleManagerService;
    type Actor = { p: Principal; pw: string };
    const people: Record<string, Actor> = {};
    const sign = (a: Actor) => ({ username: a.p.username, password: a.pw });
    let pkg: Buffer;
    let deviceId: string;

    const newManager = () => {
      const licensing = {
        hasModule: (id: string) => entitled.has(id),
      } as unknown as LicensingService;
      return new ModuleManagerService(
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
    };
    const call = async (
      who: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const hit = manager.route('ph', method, path);
      if (!hit) throw new Error(`no route ${method} ${path}`);
      const p = people[who].p;
      if (!p.permissions.includes(hit.route.permission))
        throw new Error(`forbidden: ${hit.route.permission}`);
      return hit.route.handler({
        principal: p,
        params: hit.params,
        query: {},
        body,
        origin: ORIGIN,
      }) as Promise<Record<string, unknown>>;
    };
    const install = async (
      data: Buffer,
      reason = 'Install pH module per CC-2026-031',
    ) => {
      const staged = await manager.stage(
        people.itadmin.p,
        data,
        'nxgen-ph.nxmod',
      );
      if (!staged.stagingId) return staged;
      return {
        ...staged,
        result: await manager.install(
          people.itadmin.p,
          staged.stagingId,
          reason,
          sign(people.itadmin),
          ORIGIN,
        ),
      };
    };
    const feed = (...packets: Record<string, string>[]) =>
      gateway.simulate(
        packets.map((p) => JSON.stringify({ ...p, DEVICE_ID: 'ph_dev_001' })),
      );

    beforeAll(async () => {
      if (!existsSync(join(PH_DIST, 'module.json')))
        throw new Error('Build the pH module first: npm run build:module:ph');
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
      const identity = new IdentityService(config, db, audit, platform, {
        isActive: () => true,
      });
      signatures = new SignatureService(config, db, audit, platform);
      workflow = new WorkflowService(db, audit, platform, signatures);
      registry = new ModuleRegistry();
      devices = new DevicesService(db, audit, signatures, workflow, registry);
      devices.onModuleInit();
      gateway = new GatewayService(config, db, audit, registry);
      manager = newManager();
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
      const { manifest, files } = readDist(PH_DIST);
      pkg = packModule({
        manifest,
        files,
        privateKeyPem: vendor.privateKeyPem,
      });
      // Re-login helpers after install to pick up new module permissions.
      (people as Record<string, unknown>).relogin = async (who: string) => {
        const a = people[who];
        a.p = (await identity.login(a.p.username, a.pw, ORIGIN)).principal;
      };
    });

    afterAll(async () => {
      for (const m of registry.all()) registry.remove(m.id);
      gateway.onModuleDestroy();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.onModuleDestroy();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const relogin = (who: string) =>
      (people as unknown as { relogin: (w: string) => Promise<void> }).relogin(
        who,
      );

    it('without the module, pH instruments cannot be registered', async () => {
      const types = await devices.instrumentTypes();
      expect(types.find((t) => t.code === 'PH')).toMatchObject({
        available: false,
        moduleId: 'ph',
      });
      expect(types.find((t) => t.code === 'OTHER')).toMatchObject({
        available: true,
      });
      await expect(
        devices.register(
          people.itadmin.p,
          {
            instrumentType: 'PH',
            name: 'pH meter',
            manufacturer: 'AICAN',
            model: 'PH-700',
            serialNumber: 'S1',
            reason: 'Register meter',
          },
          ORIGIN,
          sign(people.itadmin),
        ),
      ).rejects.toThrow(/Install and enable the NxGen module/);
    });

    it('refuses packages that are unsigned by AICAN, altered, unlicensed or that touch core tables', async () => {
      const rogue = generateSigningKeyPair();
      const { manifest, files } = readDist(PH_DIST);
      await expect(
        manager.stage(
          people.itadmin.p,
          packModule({ manifest, files, privateKeyPem: rogue.privateKeyPem }),
          'x.nxmod',
        ),
      ).rejects.toMatchObject({
        response: { code: 'NX-MOD-UNTRUSTED_KEY' },
      });
      const tampered = JSON.parse(gunzipSync(pkg).toString()) as {
        files: { path: string; content: string }[];
      };
      const api = tampered.files.find((f) => f.path === 'api/index.js')!;
      api.content = Buffer.from(
        'module.exports={register(){require("child_process")}}',
      ).toString('base64');
      await expect(
        manager.stage(
          people.itadmin.p,
          gzipSync(JSON.stringify(tampered)),
          'x.nxmod',
        ),
      ).rejects.toMatchObject({
        response: { code: 'NX-MOD-FILE_MISMATCH' },
      });

      entitled.delete('ph');
      const unlicensed = await manager.stage(people.itadmin.p, pkg, 'x.nxmod');
      expect(unlicensed.stagingId).toBeNull();
      expect(unlicensed.problems[0]).toMatch(/licence does not include/);
      entitled.add('ph');

      const evil = packModule({
        manifest,
        files: [
          ...files,
          {
            path: 'migrations/002_escalate.sql',
            data: Buffer.from(
              "INSERT INTO role_permissions (role_code, permission_code) VALUES ('ANALYST', 'users.manage');",
            ),
          },
        ],
        privateKeyPem: vendor.privateKeyPem,
      });
      const staged = await manager.stage(people.itadmin.p, evil, 'x.nxmod');
      expect(staged.stagingId).toBeNull();
      expect(staged.problems.join(' ')).toMatch(
        /role_permissions: must start with "ph_"/,
      );
      const rejected = await audit.list({ action: 'MODULE_PACKAGE_REJECTED' });
      expect(rejected.length).toBe(2);
    });

    it('installs the signed pH module (reason + signature): migrations, permissions, instrument type, routes', async () => {
      const staged = await manager.stage(
        people.itadmin.p,
        pkg,
        'nxgen-ph-1.0.0.nxmod',
      );
      expect(staged.problems).toEqual([]);
      expect(staged.module).toMatchObject({
        id: 'ph',
        version: PH_VERSION,
        installedVersion: null,
        migrations: [
          { name: '001_ph_buffer_sets.sql', applied: false },
          { name: '002_ph_measurements.sql', applied: false },
          { name: '003_ph_acceptance_profiles.sql', applied: false },
          { name: '004_ph_guided_calibration.sql', applied: false },
          { name: '005_ph_logs.sql', applied: false },
          { name: '006_ph_alarms_alerts.sql', applied: false },
          { name: '007_ph_probes.sql', applied: false },
          { name: '008_ph_sample_lists.sql', applied: false },
        ],
      });
      await expect(
        manager.install(
          people.itadmin.p,
          staged.stagingId,
          'Install pH module per CC-2026-031',
          undefined,
          ORIGIN,
        ),
      ).rejects.toMatchObject({
        response: { code: 'NX-ESIG-REQUIRED' },
      });
      await expect(
        manager.install(
          people.analyst.p,
          staged.stagingId,
          'Install pH module per CC-2026-031',
          sign(people.analyst),
          ORIGIN,
        ),
      ).rejects.toThrow(/expired/);
      const out = await manager.install(
        people.itadmin.p,
        staged.stagingId,
        'Install pH module per CC-2026-031',
        sign(people.itadmin),
        ORIGIN,
      );
      expect(out.loaded).toBe(true);
      expect(out.module).toMatchObject({
        status: 'ENABLED',
        runtime: { state: 'RUNNING' },
        entitled: true,
        ui: '/modules/ph/',
      });

      const [buffers] = await db.query<{ code: string }>(
        'SELECT code FROM ph_buffer_sets WHERE is_default',
      );
      expect(buffers.code).toBe('AICAN_STANDARD');
      expect(
        await db.query(
          'SELECT filename FROM module_migrations WHERE module_id = $1 ORDER BY filename',
          ['ph'],
        ),
      ).toEqual([
        { filename: '001_ph_buffer_sets.sql' },
        { filename: '002_ph_measurements.sql' },
        { filename: '003_ph_acceptance_profiles.sql' },
        { filename: '004_ph_guided_calibration.sql' },
        { filename: '005_ph_logs.sql' },
        { filename: '006_ph_alarms_alerts.sql' },
        { filename: '007_ph_probes.sql' },
        { filename: '008_ph_sample_lists.sql' },
      ]);
      await relogin('analyst');
      expect(people.analyst.p.permissions).toContain('ph.view');
      expect(manager.menu(people.analyst.p)).toEqual([
        { module: 'ph', label: 'pH', href: '/modules/ph/' },
      ]);
      expect(manager.uiFile('ph', '')?.type).toMatch(/text\/html/);
      expect(manager.uiFile('ph', 'instrument/anything')?.type).toMatch(
        /text\/html/,
      ); // SPA fallback
      expect(manager.uiFile('ph', 'nope.js')).toBeNull();
      expect(
        (await devices.instrumentTypes()).find((t) => t.code === 'PH'),
      ).toMatchObject({ available: true, moduleName: 'pH' });

      const [sig] = await signatures.list({
        tableName: 'installed_modules',
        recordId: 'ph',
      });
      expect(sig).toMatchObject({
        actionCode: 'MODULE_INSTALL',
        signerFullName: 'Ivan IT',
        intact: true,
      });
      const [installed] = await audit.list({ action: 'MODULE_INSTALLED' });
      expect(installed.details).toMatchObject({
        version: PH_VERSION,
        signingKeyId: vendor.keyId,
      });
      // Same package again: nothing to do.
      expect(
        (await manager.stage(people.itadmin.p, pkg, 'again.nxmod')).problems[0],
      ).toMatch(/already installed/);
    });

    it('pH packets flow through the gateway to the module; unknown and malformed packets are rejected and kept', async () => {
      const d = await devices.register(
        people.itadmin.p,
        {
          instrumentType: 'PH',
          name: 'pH meter QC-2',
          manufacturer: 'AICAN',
          model: 'PH-700',
          serialNumber: 'PH7-0042',
          deviceIdentifier: 'ph_dev_001',
          reason: 'New pH meter, PO-2026-311',
        },
        ORIGIN,
        sign(people.itadmin),
      );
      deviceId = d.id;
      expect(d.module).toMatchObject({
        id: 'ph',
        ui: `/modules/ph/?device=${d.id}`,
      });
      expect(d.canCalibrate).toBe(false); // pH calibrates in its module

      const r = await feed(
        { PH_VAL: '7.02' },
        { TEMP_VAL: '25.0' },
        { BATTERY: '85' },
        { BATTERY: '85' },
        { PH_VAL: 'seven' },
      );
      expect(r.map((x) => [x.accepted, x.kind])).toEqual([
        [true, 'MEASUREMENT'],
        [true, 'MEASUREMENT'],
        [true, 'STATUS'],
        [true, 'STATUS'],
        [false, undefined],
      ]);
      expect(r[2].messageId).toBeGreaterThan(0); // first battery value stored
      expect(r[3].messageId).toBeNull(); // unchanged battery not stored again
      expect(r[4].reason).toBe('PH_VAL is not a number');
      const unknown = await gateway.simulate([
        JSON.stringify({ PH_VAL: '7', DEVICE_ID: 'stranger' }),
        'not json',
      ]);
      expect(unknown.map((x) => x.reason)).toEqual([
        'Instrument not registered',
        'Not valid JSON',
      ]);

      await relogin('analyst');
      const live = await call(
        'analyst',
        'GET',
        `/instruments/${deviceId}/live`,
      );
      expect(live).toMatchObject({
        live: {
          values: { PH_VAL: 7.02, TEMP_VAL: 25, BATTERY: 85 },
          online: true,
          simulated: true,
        },
        calibration: null,
      });
      const stored = await gateway.messages(deviceId);
      expect(stored.find((m) => !m.accepted)).toMatchObject({
        rejectionReason: 'PH_VAL is not a number',
        raw: expect.stringContaining('seven') as unknown,
      });
      await expect(db.query('DELETE FROM device_messages')).rejects.toThrow(
        /NXGEN-GW-001/,
      );
    });

    it('reads packets from a real serial device (pseudo-terminal standing in for the USB dongle)', async () => {
      // Python opens a pty pair, prints the device path, then forwards stdin lines to it.
      const py = spawn('python3', [
        '-I',
        '-c',
        'import os,pty,sys\nm,s=pty.openpty()\nprint(os.ttyname(s),flush=True)\nfor line in sys.stdin:\n    os.write(m,line.encode())\n',
      ]);
      const tty = await new Promise<string>((ok, bad) => {
        py.stdout.once('data', (b: Buffer) => ok(b.toString().trim()));
        py.once('error', bad);
      });
      try {
        const ports = await gateway.savePort(
          people.itadmin.p,
          null,
          {
            portPath: tty,
            baudRate: 115200,
            label: 'pty dongle',
            reason: 'Test dongle on pseudo-terminal',
          },
          ORIGIN,
        );
        expect(ports.find((x) => x.portPath === tty)).toBeDefined();
        for (
          let i = 0;
          i < 50 &&
          (await gateway.configured()).find((x) => x.portPath === tty)
            ?.status !== 'OPEN';
          i++
        )
          await new Promise((r) => setTimeout(r, 100));
        expect(
          (await gateway.configured()).find((x) => x.portPath === tty)?.status,
        ).toBe('OPEN');
        py.stdin.write(
          '{"PH_VAL":"6.48","DEVICE_ID":"ph_dev_001"}\r\n{"TEMP_VAL":"24.6","DEVICE_ID":"ph_dev_001"}\n',
        );
        let live: Record<string, unknown> = {};
        for (let i = 0; i < 50; i++) {
          live = await call('analyst', 'GET', `/instruments/${deviceId}/live`);
          if (
            (live.live as { values: { PH_VAL: number } }).values.PH_VAL === 6.48
          )
            break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(live.live).toMatchObject({
          values: { PH_VAL: 6.48, TEMP_VAL: 24.6 },
          simulated: false,
        });
        const port = (await gateway.configured()).find(
          (x) => x.portPath === tty,
        )!;
        expect(port).toMatchObject({ packets: 2, rejected: 0 });
        let opened = await audit.list({ action: 'GATEWAY_PORT_OPENED' });
        for (let i = 0; i < 30 && !opened.length; i++) {
          await new Promise((r) => setTimeout(r, 100));
          opened = await audit.list({ action: 'GATEWAY_PORT_OPENED' });
        }
        expect(opened[0].recordId).toBe(port.portPath);
        await gateway.savePort(
          people.itadmin.p,
          port.id,
          { enabled: false, reason: 'Test finished, release port' },
          ORIGIN,
        );
        expect(
          (await gateway.configured()).find((x) => x.portPath === tty)?.status,
        ).toBe('DISABLED');
      } finally {
        py.stdin.end();
        py.kill();
      }
    });

    it('records a calibration from the instrument packets; the core workflow approves it and the instrument becomes ready', async () => {
      // The temperature now comes from the simulator too (the serial test sent 24.6 °C).
      await feed({ TEMP_VAL: '25.0' });
      await feed(
        {
          MV_1: '172.40',
          MV_2: '3.10',
          MV_4: '-171.20',
          DT_1: '2026-11-07 10:00:00',
          DT_2: '2026-11-07 10:02:00',
          DT_4: '2026-11-07 10:04:00',
        },
        { SLOPE: '96.8', OFFSET: '1.8' },
      );
      const live = await call(
        'analyst',
        'GET',
        `/instruments/${deviceId}/live`,
      );
      const cal = live.calibration as {
        readings: unknown[];
        preview: { outcome: string; slopePercent: number };
      };
      expect(cal.readings).toEqual([
        { buffer: 1, bufferPh: 4.01, mv: 172.4 },
        { buffer: 2, bufferPh: 7, mv: 3.1 },
        { buffer: 4, bufferPh: 10.01, mv: -171.2 },
      ]);
      expect(cal.preview.outcome).toBe('PASS');

      // The browser cannot supply "instrument" readings: the module takes them from the stored packets.
      const created = await call(
        'analyst',
        'POST',
        `/instruments/${deviceId}/calibrations`,
        {
          source: 'INSTRUMENT',
          readings: [{ bufferPh: 4, mv: 999 }],
          remarks: 'Lots B-4471, B-7012',
        },
      );
      expect(created).toMatchObject({
        code: 'CAL-00001',
        outcome: 'PASS',
        dataSource: 'SIMULATED',
      });
      const view = await devices.get(deviceId, people.analyst.p);
      const c = view.calibrations[0];
      expect(c).toMatchObject({
        dataSource: 'SIMULATED',
        temperatureC: 25,
        outcome: 'PASS',
      });
      expect(c.readings).toEqual([
        { bufferPh: 4.01, mv: 172.4 },
        { bufferPh: 7, mv: 3.1 },
        { bufferPh: 10.01, mv: -171.2 },
      ]);
      expect(c.sourceMessages.length).toBeGreaterThanOrEqual(3);
      expect(c.display.map((x: { label: string }) => x.label)).toEqual([
        'Slope',
        'Offset at pH 7',
        'Fit r²',
        'Temperature',
        'Acceptance limits',
      ]);
      expect(c.results).toMatchObject({
        temperatureSource: 'INSTRUMENT',
        bufferSet: 'AICAN_STANDARD',
        deviceReported: { slope: 96.8, offset: 1.8 },
      });
      const src = await db.query<{ kind: string; transport: string }>(
        'SELECT kind, transport FROM device_messages WHERE id = ANY($1)',
        [c.sourceMessages],
      );
      expect(new Set(src.map((s) => s.kind))).toEqual(
        new Set(['CALIBRATION', 'MEASUREMENT']),
      );

      // Used once: the same packets cannot make a second record.
      await expect(
        call('analyst', 'POST', `/instruments/${deviceId}/calibrations`, {
          source: 'INSTRUMENT',
        }),
      ).rejects.toMatchObject({ name: 'ModuleError', status: 409 });

      await workflow.act(
        people.analyst.p,
        c.workflow.id,
        'SUBMIT',
        { signature: sign(people.analyst) },
        ORIGIN,
      );
      await workflow.act(
        people.manager.p,
        c.workflow.id,
        'APPROVE',
        { signature: sign(people.manager) },
        ORIGIN,
      );
      expect(
        (await devices.get(deviceId, people.analyst.p)).readiness,
      ).toMatchObject({ state: 'READY', usable: true });
    });

    it('shows the meter status it reports and switches ATC from NxGen', async () => {
      // Flags arrive as JSON booleans in the meter's status frame.
      const [status] = await gateway.simulate([
        JSON.stringify({
          DEVICE_ID: 'ph_dev_001',
          BATTERY_PERCENT: '76',
          IS_CHARGING: false,
          PROBE_CONNECTED: false,
          TEMP_SENSOR_CONNECTED: true,
          DEVICE_STATUS: 'ONLINE',
          ATC: 0,
        }),
      ]);
      expect(status).toMatchObject({ accepted: true, kind: 'STATUS' });
      const view = await call(
        'analyst',
        'GET',
        `/instruments/${deviceId}/live`,
      );
      expect(view).toMatchObject({
        live: {
          values: { BATTERY: 76, IS_CHARGING: 0, PROBE_CONNECTED: 0, ATC: 0 },
          text: { DEVICE_STATUS: 'ONLINE' },
        },
      });

      await expect(
        call('analyst', 'POST', `/instruments/${deviceId}/atc`, {
          enabled: 'yes',
        }),
      ).rejects.toMatchObject({ status: 400, field: 'enabled' });
      await expect(
        call('manager', 'POST', `/instruments/${deviceId}/atc`, {
          enabled: true,
        }),
      ).rejects.toThrow(/forbidden/);
      await expect(
        call('analyst', 'POST', `/instruments/${deviceId}/atc`, {
          enabled: true,
        }),
      ).resolves.toEqual({ sent: true });

      const [sent] = await db.query<{ raw: string; direction: string }>(
        "SELECT raw, direction FROM device_messages WHERE kind = 'COMMAND' ORDER BY id DESC LIMIT 1",
      );
      expect(sent).toEqual({
        raw: '{"ATC":1,"DEVICE_ID":"ph_dev_001"}',
        direction: 'OUT',
      });
      const [audited] = await audit.list({ action: 'PH_ATC_COMMAND' });
      expect(audited).toMatchObject({
        result: 'SUCCESS',
        actor: people.analyst.p.userId,
      });
    });

    it('pH measurements: only a stable reading from the instrument, kept with its packets, then signed review and approval', async () => {
      for (const who of ['analyst', 'reviewer', 'manager']) await relogin(who);
      expect(people.analyst.p.permissions).toContain('ph.measure');
      expect(people.reviewer.p.permissions).toContain('ph.review');
      expect(people.manager.p.permissions).toContain('ph.approve');
      const details = {
        sampleId: 'SMP-2026-1187',
        batch: 'B-24-0311',
        arNumber: 'AR-2026-118',
        product: 'Paracetamol oral suspension',
      };
      const measure = (body: unknown = details) =>
        call('analyst', 'POST', `/instruments/${deviceId}/measurements`, body);

      // A drifting reading is refused, and the refusal is on the audit trail.
      for (const v of ['6.80', '6.90', '6.95', '7.00']) {
        await feed({ PH_VAL: v, TEMP_VAL: '25.1', ATC: '1' });
        await sleep(700);
      }
      await expect(measure()).rejects.toMatchObject({ status: 409 });
      await expect(measure()).rejects.toThrow(/not stable/);
      const [blocked] = await audit.list({ action: 'PH_MEASUREMENT_BLOCKED' });
      expect(blocked.result).toBe('FAILURE');
      expect(blocked.reason).toMatch(/not stable/);

      // Settled for more than 5 s.
      for (const v of [
        '7.01',
        '7.01',
        '7.02',
        '7.01',
        '7.02',
        '7.01',
        '7.01',
      ]) {
        await feed({ PH_VAL: v, TEMP_VAL: '25.1', ATC: '1' });
        await sleep(900);
      }
      const live = (await call(
        'analyst',
        'GET',
        `/instruments/${deviceId}/live`,
      )) as { live: { stability: { state: string } } };
      expect(live.live.stability.state).toBe('STABLE');
      await expect(
        measure({ ...details, arNumber: 'NA' }),
      ).rejects.toMatchObject({ status: 400, field: 'arNumber' });
      await expect(
        call(
          'manager',
          'POST',
          `/instruments/${deviceId}/measurements`,
          details,
        ),
      ).rejects.toThrow(/forbidden: ph.measure/);

      // The browser cannot supply the value: anything it sends besides the details is ignored.
      const m = (await measure({ ...details, ph: 4.0 })) as {
        id: string;
        code: string;
        ph: number;
        temperatureC: number;
        atc: string;
        dataSource: string;
        sourceMessages: number[];
        stability: { state: string; samples: number };
        calibration: { code: string; outcome: string };
      };
      expect(m).toMatchObject({
        code: 'PHM-0001',
        ph: 7.01,
        temperatureC: 25.1,
        atc: 'ON',
        dataSource: 'SIMULATED',
        stability: { state: 'STABLE' },
        calibration: { code: 'CAL-00001', outcome: 'PASS' },
      });
      expect(m.stability.samples).toBeGreaterThanOrEqual(6);
      const packets = await db.query<{
        kind: string;
        received_at: Date;
        raw: string;
      }>(
        'SELECT kind, received_at, raw FROM device_messages WHERE id = ANY($1::bigint[]) ORDER BY id',
        [m.sourceMessages],
      );
      expect(packets.length).toBe(m.sourceMessages.length);
      expect(
        packets.every(
          (x) =>
            ['MEASUREMENT', 'STATUS'].includes(x.kind) &&
            x.raw.includes('"PH_VAL"'),
        ),
      ).toBe(true);
      // Stored with their arrival time, not the time they were saved: they span the stability window.
      const span =
        packets[packets.length - 1].received_at.getTime() -
        packets[0].received_at.getTime();
      expect(span).toBeGreaterThanOrEqual(5000);

      // Measured values are original data, even in a draft; records are never removed.
      await expect(
        db.transaction(
          { actorId: people.analyst.p.userId, reason: 'try to edit' },
          (c) =>
            c.query('UPDATE ph_measurements SET ph = 7.50 WHERE id = $1', [
              m.id,
            ]),
        ),
      ).rejects.toThrow(/NXGEN-PH-001/);
      await expect(
        db.transaction(
          { actorId: people.analyst.p.userId, reason: 'try to delete' },
          (c) => c.query('DELETE FROM ph_measurements WHERE id = $1', [m.id]),
        ),
      ).rejects.toThrow(/NXGEN-DB-002/);
      await expect(
        db.transaction(
          { actorId: people.analyst.p.userId, reason: 'try to soft-delete' },
          (c) =>
            c.query(
              'UPDATE ph_measurements SET is_deleted = true WHERE id = $1',
              [m.id],
            ),
        ),
      ).rejects.toThrow(/NXGEN-PH-002/);

      // Sample details can be corrected in the draft, with a reason, by the person who measured.
      await expect(
        call('analyst', 'PUT', `/measurements/${m.id}/details`, {
          ...details,
          arNumber: 'AR-2026-119',
        }),
      ).rejects.toMatchObject({ field: 'reason' });
      await call('analyst', 'PUT', `/measurements/${m.id}/details`, {
        ...details,
        arNumber: 'AR-2026-119',
        reason: 'AR number mistyped; label reads AR-2026-119',
      });
      const updates = await audit.list({ recordId: m.id, action: 'UPDATE' });
      expect(updates[0].reason).toBe(
        'AR number mistyped; label reads AR-2026-119',
      );

      // Prepared -> Reviewed -> Approved, each signed; the reviewer cannot be the analyst.
      const wf = (await call('analyst', 'GET', `/measurements/${m.id}`)) as {
        workflow: { id: string };
      };
      await workflow.act(
        people.analyst.p,
        wf.workflow.id,
        'SUBMIT',
        { signature: sign(people.analyst) },
        ORIGIN,
      );
      await expect(
        call('analyst', 'PUT', `/measurements/${m.id}/details`, {
          ...details,
          reason: 'Late correction attempt',
        }),
      ).rejects.toThrow(/draft|locked|editable/i);
      await workflow.act(
        people.reviewer.p,
        wf.workflow.id,
        'REVIEW',
        { signature: sign(people.reviewer) },
        ORIGIN,
      );
      await workflow.act(
        people.manager.p,
        wf.workflow.id,
        'APPROVE',
        { signature: sign(people.manager) },
        ORIGIN,
      );
      const done = (await call('reviewer', 'GET', `/measurements/${m.id}`)) as {
        arNumber: string;
        workflow: { state: string };
        packets: { sha256: string }[];
      };
      expect(done).toMatchObject({
        arNumber: 'AR-2026-119',
        workflow: { state: 'APPROVED' },
      });
      expect(done.packets.every((x) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(
        true,
      );
      const sigs = await signatures.list({
        tableName: 'ph_measurements',
        recordId: m.id,
      });
      expect(sigs.map((x) => [x.meaningCode, x.intact])).toEqual(
        expect.arrayContaining([
          ['AUTHORED', true],
          ['REVIEWED', true],
          ['APPROVED', true],
        ]),
      );
      const list = (await call(
        'analyst',
        'GET',
        '/measurements',
      )) as unknown as { code: string }[];
      expect(list.map((x) => x.code)).toContain('PHM-0001');
    });

    it('acceptance limits are edited as approved versions and grade later calibrations', async () => {
      const readings = [
        { bufferPh: 4.01, mv: 165.3 },
        { bufferPh: 7, mv: 0 },
        { bufferPh: 10.01, mv: -165.3 },
      ];
      const calibrate = () =>
        call('analyst', 'POST', `/instruments/${deviceId}/calibrations`, {
          source: 'MANUAL',
          temperatureC: 25,
          readings,
        }) as Promise<{ calibrationId: string; outcome: string }>;
      const limits = {
        slopePassMin: 90,
        slopePassMax: 105,
        slopeWarnMin: 85,
        slopeWarnMax: 108,
        offsetPassMaxAbs: 30,
        offsetWarnMaxAbs: 45,
        deviationMaxPh: 0.05,
      };
      const reason = 'Aligned with SOP QC-114 revision 3';
      const view = () =>
        call('analyst', 'GET', '/acceptance-limits') as Promise<{
          inForce: { version: number | null };
          versions: {
            id: string;
            version: number;
            workflow: { id: string; state: string };
          }[];
        }>;
      const before = await view();
      expect(before.inForce.version).toBeNull();
      expect(
        await call('analyst', 'GET', `/instruments/${deviceId}/live`),
      ).toMatchObject({ limitsVersion: null, limits: { slopePassMin: 95 } });

      await expect(
        call('analyst', 'POST', '/acceptance-limits', { limits, reason }),
      ).rejects.toThrow(/forbidden/);
      await expect(
        call('reviewer', 'POST', '/acceptance-limits', {
          limits: { ...limits, slopeWarnMin: 40 },
          reason,
        }),
      ).rejects.toMatchObject({ status: 400, field: 'limits' });
      await expect(
        call('reviewer', 'POST', '/acceptance-limits', {
          limits,
          reason: 'short',
        }),
      ).rejects.toMatchObject({ status: 400, field: 'reason' });

      await call('reviewer', 'POST', '/acceptance-limits', { limits, reason });
      const [draft] = (await view()).versions;
      expect(draft).toMatchObject({
        version: 1,
        workflow: { state: 'DRAFT' },
      });
      // Only one version at a time, and a draft changes nothing yet.
      await expect(
        call('reviewer', 'POST', '/acceptance-limits', {
          limits: { ...limits, slopePassMax: 104 },
          reason,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await call('analyst', 'GET', `/instruments/${deviceId}/live`),
      ).toMatchObject({ limitsVersion: null, limits: { slopePassMin: 95 } });

      await workflow.act(
        people.reviewer.p,
        draft.workflow.id,
        'SUBMIT',
        { signature: sign(people.reviewer) },
        ORIGIN,
      );
      // The database refuses changes once submitted.
      await expect(
        db.transaction({ actorId: people.reviewer.p.userId }, (q) =>
          q.query(
            'UPDATE ph_acceptance_profiles SET slope_pass_min = 50 WHERE id = $1',
            [draft.id],
          ),
        ),
      ).rejects.toThrow(/NXGEN-WF-/);
      await workflow.act(
        people.manager.p,
        draft.workflow.id,
        'APPROVE',
        { signature: sign(people.manager) },
        ORIGIN,
      );
      expect((await view()).inForce.version).toBe(1);
      const graded = await calibrate();
      expect(graded.outcome).toBe('PASS');
      const [stored] = await db.query<{ limits: { version: number } }>(
        'SELECT limits FROM calibration_records WHERE id = $1',
        [graded.calibrationId],
      );
      expect(stored.limits).toMatchObject({ version: 1, slopePassMin: 90 });
      // Close it: an instrument can have only one calibration open.
      const recorded = (
        await devices.get(deviceId, people.analyst.p)
      ).calibrations.find((c) => c.id === graded.calibrationId)!;
      await workflow.act(
        people.analyst.p,
        recorded.workflow.id,
        'SUBMIT',
        { signature: sign(people.analyst) },
        ORIGIN,
      );
      await workflow.act(
        people.manager.p,
        recorded.workflow.id,
        'APPROVE',
        { signature: sign(people.manager) },
        ORIGIN,
      );

      // The next approved version retires this one.
      const stricter = { ...limits, slopePassMin: 92 };
      await call('reviewer', 'POST', '/acceptance-limits', {
        limits: stricter,
        reason,
      });
      const [second] = (await view()).versions;
      await workflow.act(
        people.reviewer.p,
        second.workflow.id,
        'SUBMIT',
        { signature: sign(people.reviewer) },
        ORIGIN,
      );
      await workflow.act(
        people.manager.p,
        second.workflow.id,
        'APPROVE',
        { signature: sign(people.manager) },
        ORIGIN,
      );
      const after = await view();
      expect(after.inForce.version).toBe(2);
      expect(after.versions.map((v) => v.workflow.state)).toEqual([
        'APPROVED',
        'SUPERSEDED',
      ]);
      await expect(
        db.transaction({ actorId: people.root.p.userId }, (q) =>
          q.query('DELETE FROM ph_acceptance_profiles WHERE id = $1', [
            second.id,
          ]),
        ),
      ).rejects.toThrow(/NXGEN-/);
    });

    it('runs a guided calibration from NxGen, and keeps the commands and replies', async () => {
      const path = `/instruments/${deviceId}/guided-calibration`;
      type Run = {
        points: { slot: number; status: string }[];
        saveProblem: string | null;
      };
      const telemetry = {
        PH_VAL: '7.00',
        TEMP_VAL: '25.0',
        MV_VAL: '0.00',
        STABLE: '1',
        BATTERY: '85',
      };
      const settings = {
        pointCount: 3,
        timerSeconds: 5,
        requireStable: false,
        buffers: { 1: 1.68, 2: 4.01, 3: 7, 4: 10.01, 5: 12.45 },
      };
      await expect(
        call(
          'analyst',
          'PUT',
          `/instruments/${deviceId}/calibration-settings`,
          { settings, reason: 'Three buffers for routine use' },
        ),
      ).rejects.toThrow(/forbidden/);
      await call(
        'reviewer',
        'PUT',
        `/instruments/${deviceId}/calibration-settings`,
        { settings, reason: 'Three buffers for routine use' },
      );

      // A guided calibration needs an active probe assigned.
      await feed(telemetry);
      await expect(call('analyst', 'POST', path, {})).rejects.toThrow(
        /Assign a probe/,
      );
      await relogin('itadmin');
      const reason = 'New probe fitted for QC use';
      const { id: probeId } = (await call('itadmin', 'POST', '/probes', {
        code: 'PRB-1',
        type: 'Glass',
        reason,
      })) as { id: string };
      await call('itadmin', 'PUT', `/instruments/${deviceId}/probe`, {
        probeId,
        temperatureSensorId: 'TS-1',
        reason,
      });

      // An earlier test left the probe reported as disconnected.
      await feed(telemetry);
      await expect(call('analyst', 'POST', path, {})).rejects.toThrow(
        /pH probe/,
      );
      const [blocked] = await audit.list({ action: 'PH_CALIBRATION_BLOCKED' });
      expect(blocked.result).toBe('FAILURE');
      await gateway.simulate([
        JSON.stringify({ DEVICE_ID: 'ph_dev_001', PROBE_CONNECTED: true }),
      ]);
      await feed(telemetry);

      const view = async () =>
        ((await call('analyst', 'GET', path)) as { run: Run }).run;
      await call('analyst', 'POST', path, {});
      expect((await view()).points.map((p) => p.slot)).toEqual([2, 3, 4]);
      await expect(call('analyst', 'POST', path, {})).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        call('reviewer', 'POST', `${path}/measure`, { slot: 2 }),
      ).rejects.toThrow(/forbidden|started by/);

      const replies: [number, string, string][] = [
        [2, '177.30', '4.01'],
        [3, '0.10', '7.00'],
        [4, '-177.80', '10.02'],
      ];
      for (const [slot, mv, post] of replies) {
        await call('analyst', 'POST', `${path}/measure`, { slot });
        for (let i = 0; ; i++) {
          await feed(telemetry);
          const p = (await view()).points.find((x) => x.slot === slot)!;
          if (p.status === 'WAITING') break;
          if (i > 40) throw new Error(`Point ${slot} is ${p.status}`);
          await sleep(500);
        }
        await feed({
          ...telemetry,
          CAL: String(slot * 10 + 1),
          [`MV_${slot}`]: mv,
          [`POST_VAL_${slot}`]: post,
        });
      }
      expect((await view()).saveProblem).toBeNull();

      const saved = (await call('analyst', 'POST', `${path}/save`, {
        remarks: 'Buffer lots B-1, B-2, B-3',
        bufferLot: 'LOT-77',
        bufferExpiry: '2020-01-31',
      })) as { calibrationId: string; outcome: string; dataSource: string };
      expect(saved).toMatchObject({ outcome: 'PASS', dataSource: 'SIMULATED' });
      expect(await view()).toBeNull();

      const commands = await db.query<{ raw: string }>(
        "SELECT raw FROM device_messages WHERE kind = 'COMMAND' ORDER BY id",
      );
      const raw = commands.map((c) => c.raw);
      expect(raw).toContain('{"CAL":20,"DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain('{"B_2":"4.01","DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain('{"CAL":21,"DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain('{"CAL":41,"DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain('{"CAL_SAVE":"1","DEVICE_ID":"ph_dev_001"}');
      // The per-second keep-alive frames are not stored.
      expect(raw.filter((r) => r.includes('"B_2"')).length).toBe(1);

      const [record] = await db.query<{
        limits: { version: number };
        results: { guided: boolean; deviations: unknown[] };
        source_messages: string[];
      }>(
        'SELECT limits, results, source_messages FROM calibration_records WHERE id = $1',
        [saved.calibrationId],
      );
      expect(record.limits.version).toBe(2);
      expect(record.results.guided).toBe(true);
      expect(record.results.deviations).toHaveLength(3);
      const stored = await db.query<{ raw: string }>(
        'SELECT raw FROM device_messages WHERE id = ANY($1::bigint[])',
        [record.source_messages],
      );
      expect(stored.some((m) => m.raw.includes('"CAL":"21"'))).toBe(true);

      const recorded = (
        await devices.get(deviceId, people.analyst.p)
      ).calibrations.find((c) => c.id === saved.calibrationId)!;
      await workflow.act(
        people.analyst.p,
        recorded.workflow.id,
        'SUBMIT',
        { signature: sign(people.analyst) },
        ORIGIN,
      );
      await workflow.act(
        people.manager.p,
        recorded.workflow.id,
        'APPROVE',
        { signature: sign(people.manager) },
        ORIGIN,
      );
    });

    it('logs readings by hand and from the meter, keeps them, and exports them', async () => {
      const base = `/instruments/${deviceId}`;
      const telemetry = {
        PH_VAL: '7.05',
        TEMP_VAL: '25.2',
        MV_VAL: '-2.10',
        STABLE: '1',
        BATTERY: '85',
      };
      type Page = {
        rows: {
          method: string;
          ph: number;
          product: string;
          loggedBy: string;
        }[];
        total: number;
      };
      const logs = (q = '') =>
        call('analyst', 'GET', `/logs${q ? `?${q}` : ''}`) as Promise<Page>;
      const query = async (search: string) =>
        (await manager.route('ph', 'GET', '/logs')!.route.handler({
          principal: people.analyst.p,
          params: {},
          query: { search, pageSize: '100' },
          body: undefined,
          origin: ORIGIN,
        })) as Page;

      await feed({ ...telemetry, MV_VAL: 'nan' });
      await expect(call('analyst', 'POST', `${base}/logs`, {})).rejects.toThrow(
        /millivolt/,
      );
      await feed(telemetry);
      await expect(call('itadmin', 'POST', `${base}/logs`, {})).rejects.toThrow(
        /forbidden/,
      );
      await call('analyst', 'POST', `${base}/logs`, {
        product: '=Paracetamol',
        batch: 'B-77',
      });
      expect((await query('B-77')).rows[0]).toMatchObject({
        method: 'MANUAL',
        ph: 7.05,
      });

      // Button mode: the meter's LOG frame creates an entry, once.
      await call('analyst', 'POST', `${base}/logging/start`, {
        mode: 'BUTTON',
        batch: 'B-BTN',
      });
      await expect(
        call('analyst', 'POST', `${base}/logs`, {}),
      ).rejects.toMatchObject({ status: 409 });
      const press = { ...telemetry, LOG: '1' };
      await feed(press);
      await feed(press);
      expect((await query('B-BTN')).total).toBe(1);
      await call('analyst', 'POST', `${base}/logging/stop`, {});

      // Stable mode: HOLD logs the reading and re-arms the meter.
      await call('analyst', 'POST', `${base}/logging/start`, {
        mode: 'STABLE',
        batch: 'B-HOLD',
      });
      await feed({ ...telemetry, HOLD: '1' });
      expect((await query('B-HOLD')).rows[0]).toMatchObject({
        method: 'STABLE',
      });
      await call('analyst', 'POST', `${base}/logging/stop`, {});

      // Interval mode: timed here, with the interval told to the meter.
      await call('analyst', 'POST', `${base}/logging/start`, {
        mode: 'INTERVAL',
        intervalSeconds: 1,
        batch: 'B-INT',
      });
      for (let i = 0; i < 8; i++) {
        await feed(telemetry);
        await sleep(400);
      }
      await call('analyst', 'POST', `${base}/logging/stop`, {});
      const timed = await query('B-INT');
      expect(timed.total).toBeGreaterThanOrEqual(2);
      const after = timed.total;
      await sleep(1200);
      expect((await query('B-INT')).total).toBe(after);

      const raw = (
        await db.query<{ raw: string }>(
          "SELECT raw FROM device_messages WHERE kind = 'COMMAND' ORDER BY id",
        )
      ).map((c) => c.raw);
      expect(raw).toContain('{"LOG":"3","DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain('{"LOG":"1","DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain('{"HOLD":"0","DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain(
        '{"LOG_INTERVAL":"0.0167","LOG":"2","DEVICE_ID":"ph_dev_001"}',
      );
      expect(raw).toContain('{"LOG":"0","HOLD":"0","DEVICE_ID":"ph_dev_001"}');

      const [started] = await audit.list({ action: 'PH_LOGGING_STOPPED' });
      expect(started.details).toMatchObject({ mode: 'INTERVAL' });

      // Every entry points to a stored original packet, and cannot be changed.
      const [entry] = await db.query<{ id: string; raw: string }>(
        `SELECT e.id, m.raw FROM ph_log_entries e JOIN device_messages m ON m.id = e.source_message ORDER BY e.id LIMIT 1`,
      );
      expect(entry.raw).toContain('"PH_VAL":"7.05"');
      await expect(
        db.query('UPDATE ph_log_entries SET ph = 1 WHERE id = $1', [entry.id]),
      ).rejects.toThrow(/NXGEN-PH-005/);
      await expect(
        db.query('DELETE FROM ph_log_entries WHERE id = $1', [entry.id]),
      ).rejects.toThrow(/NXGEN-PH-005/);

      // Filter by method, and export what the filter shows.
      const exported = (await manager
        .route('ph', 'GET', '/logs/export')!
        .route.handler({
          principal: people.analyst.p,
          params: {},
          query: { method: 'MANUAL' },
          body: undefined,
          origin: ORIGIN,
        })) as { kind: string; data: Buffer; fileName: string };
      expect(exported.kind).toBe('file');
      const csv = exported.data.toString('utf8');
      expect(csv.trim().split('\r\n')).toHaveLength(2);
      expect(csv).toContain(",'=Paracetamol,");
      expect(csv).toContain(',-2.1,');
      const [recorded] = await audit.list({ action: 'PH_LOGS_EXPORTED' });
      expect(recorded.details).toMatchObject({ rows: 1, format: 'CSV' });
      expect((await logs()).total).toBeGreaterThan(3);
    });

    it('raises a range alarm once, closes it when the reading returns, and keeps the record', async () => {
      const base = `/instruments/${deviceId}`;
      type Alert = {
        id: number;
        code: string;
        status: string;
        message: string;
        resolvedBy: string | null;
      };
      const reading = (ph: string) =>
        feed({ PH_VAL: ph, TEMP_VAL: '25.0', MV_VAL: '0.00', BATTERY: '85' });
      const breaches = async () =>
        (
          (await call('analyst', 'GET', '/alerts')) as { rows: Alert[] }
        ).rows.filter((a) => a.code === 'PH-ALARM-LIMIT-BREACH');

      await expect(
        call('analyst', 'POST', `${base}/alarm/start`, {
          minPh: 8,
          maxPh: 7,
        }),
      ).rejects.toMatchObject({ status: 400, field: 'range' });
      await reading('7.00');
      await call('analyst', 'POST', `${base}/alarm/start`, {
        minPh: 6.5,
        maxPh: 7.5,
      });
      expect(await breaches()).toEqual([]);

      await reading('7.80');
      await reading('7.90');
      const [raised, ...others] = await breaches();
      expect(others).toEqual([]);
      expect(raised).toMatchObject({ status: 'OPEN' });
      expect(raised.message).toContain('7.80');
      const shown = (await call(
        'analyst',
        'GET',
        '/alerts/active',
      )) as unknown as Alert[];
      expect(shown.map((a) => a.id)).toEqual([raised.id]);

      await call('analyst', 'POST', `/alerts/${raised.id}/acknowledge`, {});
      expect(await call('analyst', 'GET', '/alerts/active')).toEqual([]);
      await expect(
        call('analyst', 'POST', `/alerts/${raised.id}/resolve`, {
          comment: 'Trying to close it by hand',
        }),
      ).rejects.toMatchObject({ status: 409 });

      await reading('7.20');
      expect((await breaches())[0]).toMatchObject({
        status: 'RESOLVED',
        resolvedBy: 'System',
      });

      // A later excursion is a new alarm; stopping monitoring closes it.
      await reading('6.00');
      expect(await breaches()).toHaveLength(2);
      await call('analyst', 'POST', `${base}/alarm/stop`, {});
      expect((await breaches())[0].status).toBe('RESOLVED');
      await reading('1.00');
      expect(await breaches()).toHaveLength(2);

      // Pre-calibration failures were recorded by the earlier guided test.
      const all = (await call('analyst', 'GET', '/alerts')) as {
        rows: Alert[];
      };
      const probe = all.rows.find(
        (a) => a.code === 'PH-PRECAL-PROBE-NOT-CONNECTED',
      )!;
      expect(probe.status).toBe('OPEN');
      await expect(
        call('analyst', 'POST', `/alerts/${probe.id}/resolve`, {
          comment: 'short',
        }),
      ).rejects.toMatchObject({ status: 400, field: 'comment' });
      await call('analyst', 'POST', `/alerts/${probe.id}/resolve`, {
        comment: 'Probe cable reseated and checked',
      });

      await expect(
        db.query('DELETE FROM ph_alerts WHERE id = $1', [raised.id]),
      ).rejects.toThrow(/NXGEN-PH-006/);
      await expect(
        db.query("UPDATE ph_alerts SET message = 'x' WHERE id = $1", [
          probe.id,
        ]),
      ).rejects.toThrow(/NXGEN-PH-007/);
      await expect(
        db.query("UPDATE ph_alerts SET status = 'OPEN' WHERE id = $1", [
          probe.id,
        ]),
      ).rejects.toThrow(/NXGEN-PH-007/);

      await expect(
        call('analyst', 'GET', `${base}/trend`),
      ).resolves.toMatchObject({
        simulated: true,
        alarm: null,
      });
      const alertsFor = (device: string) => {
        const h = manager.route('ph', 'GET', '/alerts')!;
        return h.route.handler({
          principal: people.analyst.p,
          params: {},
          query: { device },
          body: undefined,
          origin: ORIGIN,
        }) as Promise<{ total: number }>;
      };
      expect((await alertsFor(deviceId)).total).toBeGreaterThan(1);
      expect(
        (await alertsFor('00000000-0000-4000-8000-000000000000')).total,
      ).toBe(0);
      const [event] = await audit.list({ action: 'PH_ALERT_RAISED' });
      expect(event.details).toMatchObject({ code: 'PH-ALARM-LIMIT-BREACH' });
    });

    it('lists calibrations and prints them, with the export recorded', async () => {
      const route = (path: string) => manager.route('ph', 'GET', path)!;
      const list = (await route('/calibrations').route.handler({
        principal: people.analyst.p,
        params: {},
        query: { device: deviceId, pageSize: '100' },
        body: undefined,
        origin: ORIGIN,
      })) as {
        rows: {
          id: string;
          code: string;
          guided: boolean;
          state: string;
          limitsVersion: number | null;
        }[];
        total: number;
      };
      const guided = list.rows.find((r) => r.guided)!;
      expect(guided).toMatchObject({ state: 'APPROVED', limitsVersion: 2 });

      const hit = route(
        `/instruments/${deviceId}/calibrations/${guided.id}/report`,
      );
      const file = (await hit.route.handler({
        principal: people.analyst.p,
        params: hit.params,
        query: {},
        body: undefined,
        origin: ORIGIN,
      })) as { kind: string; data: Buffer; contentType: string };
      expect(file).toMatchObject({
        kind: 'file',
        contentType: 'application/pdf',
      });
      expect(file.data.subarray(0, 5).toString()).toBe('%PDF-');
      const [audited] = await audit.list({
        action: 'PH_CALIBRATION_REPORT_EXPORTED',
      });
      expect(audited.details).toMatchObject({
        code: guided.code,
        format: 'PDF',
      });

      const logsPdf = (await route('/logs/export').route.handler({
        principal: people.analyst.p,
        params: {},
        query: { format: 'pdf' },
        body: undefined,
        origin: ORIGIN,
      })) as { data: Buffer; fileName: string };
      expect(logsPdf.data.subarray(0, 5).toString()).toBe('%PDF-');
      expect(logsPdf.fileName).toMatch(/\.pdf$/);

      const [recorded] = await db.query<{
        results: { bufferLot: string; bufferExpiry: string };
      }>('SELECT results FROM calibration_records WHERE id = $1', [guided.id]);
      expect(recorded.results).toMatchObject({
        bufferLot: 'LOT-77',
        bufferExpiry: '2020-01-31',
      });
      const alerts = (await call('analyst', 'GET', '/alerts')) as {
        rows: { code: string }[];
      };
      expect(alerts.rows.map((a) => a.code)).toContain('PH-CAL-BUFFER-EXPIRED');

      await feed({ PH_VAL: '7.00', TEMP_VAL: '25.0', MV_VAL: '0.00' });
      await expect(
        call('analyst', 'POST', `/instruments/${deviceId}/meter-settings`, {
          thermistor: 'PTC',
        }),
      ).rejects.toThrow(/forbidden/);
      await call(
        'reviewer',
        'POST',
        `/instruments/${deviceId}/meter-settings`,
        { thermistor: 'PTC', atcReferenceC: 25 },
      );
      const raw = (
        await db.query<{ raw: string }>(
          "SELECT raw FROM device_messages WHERE kind = 'COMMAND'",
        )
      ).map((c) => c.raw);
      expect(raw).toContain('{"THERM_VAL":"1","DEVICE_ID":"ph_dev_001"}');
      expect(raw).toContain('{"R_C":25,"DEVICE_ID":"ph_dev_001"}');
    });

    it('keeps a probe register and reports the health of each probe from its own calibrations', async () => {
      const reason = 'Routine probe management';
      const health = () =>
        call(
          'analyst',
          'GET',
          `/instruments/${deviceId}/probe-health`,
        ) as Promise<{
          probe: { code: string } | null;
          health: { status: string; usageCount: number; drift: number | null };
        }>;
      const view = await health();
      expect(view.probe?.code).toBe('PRB-1');
      expect(view.health.usageCount).toBe(1);
      expect(view.health.drift).toBeNull();

      await expect(
        call('analyst', 'POST', '/probes', { code: 'X', reason }),
      ).rejects.toThrow(/forbidden/);
      await expect(
        call('itadmin', 'POST', '/probes', { code: 'PRB-1', reason }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        call('itadmin', 'POST', '/probes', { code: 'PRB-2', reason: 'short' }),
      ).rejects.toMatchObject({ status: 400, field: 'reason' });

      const { id: spare } = (await call('itadmin', 'POST', '/probes', {
        code: 'PRB-2',
        reason,
      })) as { id: string };
      const probes = (await call('analyst', 'GET', '/probes')) as unknown as {
        id: string;
        code: string;
        deviceCode: string | null;
      }[];
      const fitted = probes.find((p) => p.code === 'PRB-1')!;
      expect(fitted.deviceCode).not.toBeNull();

      const edit = (id: string, status: string) =>
        call('itadmin', 'PUT', `/probes/${id}`, { status, reason });
      await expect(edit(fitted.id, 'RETIRED')).rejects.toThrow(/another probe/);

      // A blocked probe stops calibration and shows on the health panel.
      await edit(fitted.id, 'BLOCKED');
      expect((await health()).health.status).toBe('UNAUTHORIZED');
      await feed({
        PH_VAL: '7.00',
        TEMP_VAL: '25.0',
        MV_VAL: '0.00',
        BATTERY: '85',
      });
      await expect(
        call(
          'analyst',
          'POST',
          `/instruments/${deviceId}/guided-calibration`,
          {},
        ),
      ).rejects.toThrow(/PRB-1 is blocked/);
      await edit(fitted.id, 'ACTIVE');

      // The spare has no history, and a retired probe cannot return.
      await call('itadmin', 'PUT', `/instruments/${deviceId}/probe`, {
        probeId: spare,
        temperatureSensorId: 'TS-2',
        reason,
      });
      expect((await health()).health.usageCount).toBe(0);
      await edit(fitted.id, 'RETIRED');
      await expect(edit(fitted.id, 'ACTIVE')).rejects.toThrow(/cannot return/);
      await expect(
        db.transaction({ actorId: people.root.p.userId }, (q) =>
          q.query('DELETE FROM ph_probes WHERE id = $1', [fitted.id]),
        ),
      ).rejects.toThrow(/NXGEN-DB-002/);
    });

    it('a manual pH calibration is validated by the module and marked MANUAL', async () => {
      await expect(
        call('analyst', 'POST', `/instruments/${deviceId}/calibrations`, {
          source: 'MANUAL',
          temperatureC: 25,
          readings: [{ bufferPh: 7, mv: 0 }],
        }),
      ).rejects.toMatchObject({ status: 400 });
      const r = await call(
        'analyst',
        'POST',
        `/instruments/${deviceId}/calibrations`,
        {
          source: 'MANUAL',
          temperatureC: 25,
          readings: [
            { bufferPh: 4.01, mv: 150 },
            { bufferPh: 7, mv: 0 },
            { bufferPh: 10.01, mv: -150 },
          ],
        },
      );
      expect(r).toMatchObject({ outcome: 'FAIL', dataSource: 'MANUAL' });
      // Core-only correction is refused for module calibrations; it can be discarded instead.
      const c = (await devices.get(deviceId, people.analyst.p)).calibrations[0];
      await expect(
        devices.updateCalibration(
          people.analyst.p,
          deviceId,
          c.id,
          { readings: [] },
          ORIGIN,
        ),
      ).rejects.toThrow(/recorded by a module/);
      const after = await devices.discardCalibration(
        people.analyst.p,
        deviceId,
        c.id,
        'Wrong buffer used, recalibrating',
        ORIGIN,
      );
      expect(after.calibrations.find((x) => x.id === c.id)).toBeUndefined();
    });

    it('a module cannot record calibrations for instruments it does not provide', async () => {
      const other = await devices.register(
        people.itadmin.p,
        {
          instrumentType: 'OTHER',
          name: 'Balance B-1',
          manufacturer: 'X',
          model: 'Y',
          serialNumber: 'B1',
          reason: 'Register balance',
        },
        ORIGIN,
        sign(people.itadmin),
      );
      await expect(
        call('analyst', 'GET', `/instruments/${other.id}/live`),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        devices.createCalibration(
          people.analyst.p,
          other.id,
          {
            temperatureC: null,
            readings: [],
            limits: {},
            results: {},
            display: [],
            outcome: 'PASS',
            remarks: '',
            dataSource: 'MANUAL',
            sourceMessages: [],
          },
          ORIGIN,
          'ph',
        ),
      ).rejects.toThrow(/module that provides/);
    });

    it('summarises every instrument for the Dashboard and Devices screens', async () => {
      const dash = (await call('analyst', 'GET', '/dashboard')) as {
        devices: Record<string, unknown>[];
        summary: { total: number; calibration: Record<string, number> };
        locations: string[];
      };
      expect(dash.summary.total).toBe(dash.devices.length);
      const row = dash.devices.find((d) => d.id === deviceId) as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        deviceIdentifier: 'ph_dev_001',
        calibrationBucket: 'VALID',
        batteryCondition: expect.any(String),
        openAlerts: expect.any(Number),
        criticalAlerts: expect.any(Number),
      });
      expect(row.calibration).toMatchObject({
        code: expect.any(String),
        performedBy: expect.any(String),
        state: 'APPROVED',
      });
      expect(typeof row.lastActivityAt).toBe('string');
      expect(dash.summary.calibration.valid).toBeGreaterThanOrEqual(1);
      await call('analyst', 'POST', '/dashboard/refresh');
      const [refreshed] = await audit.list({
        action: 'PH_DASHBOARD_REFRESHED',
      });
      expect(refreshed.details).toMatchObject({ devices: dash.devices.length });
    });

    it('keeps the saved product, batch and AR lists; removing an entry needs a reason', async () => {
      const { id } = (await call('analyst', 'POST', '/sample-lists', {
        kind: 'PRODUCT',
        value: ' Paracetamol oral suspension ',
      })) as { id: string };
      await expect(
        call('analyst', 'POST', '/sample-lists', {
          kind: 'PRODUCT',
          value: 'paracetamol ORAL suspension',
        }),
      ).rejects.toThrow(/already in the list/);
      await expect(
        call('analyst', 'POST', '/sample-lists', { kind: 'BATCH', value: 'NA' }),
      ).rejects.toThrow(/Enter the batch/);
      await expect(
        call('manager', 'POST', '/sample-lists', { kind: 'AR', value: 'AR-1' }),
      ).rejects.toThrow(/forbidden: ph.measure/);
      expect(await call('manager', 'GET', '/sample-lists')).toEqual([
        { id, kind: 'PRODUCT', value: 'Paracetamol oral suspension' },
      ]);
      await expect(
        call('analyst', 'POST', `/sample-lists/${id}/remove`, { reason: 'typo' }),
      ).rejects.toThrow(/reason/);
      await call('analyst', 'POST', `/sample-lists/${id}/remove`, {
        reason: 'Product discontinued in QC Lab 2',
      });
      expect(await call('analyst', 'GET', '/sample-lists')).toEqual([]);
      await expect(
        call('analyst', 'POST', `/sample-lists/${id}/remove`, {
          reason: 'Product discontinued in QC Lab 2',
        }),
      ).rejects.toThrow(/not found/);
      // Once removed, the same value can be saved again.
      await call('analyst', 'POST', '/sample-lists', {
        kind: 'PRODUCT',
        value: 'Paracetamol oral suspension',
      });
      expect(await call('analyst', 'GET', '/sample-lists')).toHaveLength(1);
    });

    it('disabling hides the module and blocks its instruments; data is kept; enabling restores it', async () => {
      await expect(
        manager.setEnabled(
          people.itadmin.p,
          'ph',
          false,
          'Validation of v1.1',
          undefined,
          ORIGIN,
        ),
      ).rejects.toMatchObject({ response: { code: 'NX-ESIG-REQUIRED' } });
      await manager.setEnabled(
        people.itadmin.p,
        'ph',
        false,
        'Suspended pending validation of v1.1',
        sign(people.itadmin),
        ORIGIN,
      );
      expect(manager.route('ph', 'GET', '/instruments')).toBeNull();
      expect(manager.menu(people.analyst.p)).toEqual([]);
      expect(manager.uiFile('ph', '')).toBeNull();
      expect(
        (await devices.get(deviceId, people.analyst.p)).readiness.state,
      ).toBe('MODULE_UNAVAILABLE');
      expect((await feed({ PH_VAL: '7' }))[0].reason).toBe(
        'No module loaded for PH instruments',
      );
      expect(
        (await db.query('SELECT count(*)::int AS n FROM ph_buffer_sets'))[0],
      ).toEqual({ n: 1 });
      await manager.setEnabled(
        people.itadmin.p,
        'ph',
        true,
        'Validation of v1.1 complete',
        sign(people.itadmin),
        ORIGIN,
      );
      expect(
        (await devices.get(deviceId, people.analyst.p)).readiness.state,
      ).toBe('READY');
    });

    it('at start-up, a module whose files were altered on disk is not loaded', async () => {
      const [row] = await db.query<{ install_path: string }>(
        "SELECT install_path FROM installed_modules WHERE module_id = 'ph'",
      );
      const entry = join(row.install_path, 'api', 'index.js');
      const original = readFileSync(entry);
      appendFileSync(entry, '\n// patched on site\n');
      try {
        registry.remove('ph');
        manager = newManager();
        await manager.onModuleInit();
        const [m] = await manager.list();
        expect(m.runtime).toMatchObject({ state: 'INTEGRITY_FAILED' });
        expect(m.runtime.message).toMatch(
          /api\/index.js does not match its signed hash/,
        );
        expect(registry.get('ph')).toBeUndefined();
        const [failed] = await audit.list({ action: 'MODULE_LOAD_FAILED' });
        expect(failed.details).toMatchObject({ state: 'INTEGRITY_FAILED' });
      } finally {
        writeFileSync(entry, original);
      }
      manager = newManager();
      await manager.onModuleInit();
      expect(registry.get('ph')).toBeDefined();

      // Licence no longer includes the module → not loaded at start-up.
      entitled.delete('ph');
      registry.remove('ph');
      manager = newManager();
      await manager.onModuleInit();
      expect((await manager.list())[0].runtime.state).toBe('LICENSE_MISSING');
      entitled.add('ph');
      manager = newManager();
      await manager.onModuleInit();
    });

    it('upgrades keep the previous version for rollback; downgrades are refused', async () => {
      const { manifest, files } = readDist(PH_DIST);
      const v101 = packModule({
        manifest: { ...manifest, version: NEXT_VERSION },
        files,
        privateKeyPem: vendor.privateKeyPem,
      });
      const up = (await install(
        v101,
        `Upgrade to ${NEXT_VERSION} per CC-2026-044`,
      )) as {
        result: { module: { version: string; previousVersion: string } };
      };
      expect(up.result.module).toMatchObject({
        version: NEXT_VERSION,
        previousVersion: PH_VERSION,
      });
      expect(existsSync(join(dataDir, 'modules', 'ph', PH_VERSION))).toBe(true);
      const down = await manager.stage(people.itadmin.p, pkg, 'old.nxmod');
      expect(down.problems[0]).toMatch(
        `downgrading to ${PH_VERSION} is not allowed`,
      );
      // Migrations already applied are not run twice.
      expect(
        await db.query('SELECT filename FROM module_migrations'),
      ).toHaveLength(8);
    });

    it('leaves the audit chain intact', async () => {
      expect(await audit.verifyChain()).toEqual({ valid: true });
    });
  },
);
