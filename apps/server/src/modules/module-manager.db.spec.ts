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
      ).toHaveLength(2);
    });

    it('leaves the audit chain intact', async () => {
      expect(await audit.verifyChain()).toEqual({ valid: true });
    });
  },
);
