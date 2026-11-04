import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createActivationRequest,
  generateActivationCode,
  generateSigningKeyPair,
  hashFingerprint,
  HashedFingerprint,
  issueLicense,
  LicenseErrorCode,
  LicenseFile,
  LicenseState,
  RawFingerprint,
  serializeLicenseFile,
} from '@crescent/licensing';
import { AuditService } from '../audit/audit.service';
import { BootstrapJournal } from '../audit/bootstrap-journal';
import {
  DEFAULT_SECURITY_POLICY,
  NxGenConfig,
  PLATFORM_VERSION,
} from '../config/nxgen.config';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import { LicenseStoreService } from './license-store.service';
import { LicensingService } from './licensing.service';
import { TimeIntegrityService } from './time-integrity.service';

const MACHINE: RawFingerprint = {
  systemUuid: '4C4C4544-0042-3510-8051-B4C04F334E32',
  baseboardSerial: 'CNWS2007A1001M',
  osInstallId: 'a3f1c9d2-5e8b-4c1a-9f7e-2d6b8a0c4e19',
  systemDiskSerial: 'S4EWNX0R123456',
  cpuModel: 'Intel(R) Core(TM) i7-12700',
  primaryMac: 'A4:BB:6D:12:34:56',
};

const vendor = generateSigningKeyPair();

function makeHarness(
  dataDir: string,
  fingerprint: HashedFingerprint = hashFingerprint(MACHINE),
) {
  const config: NxGenConfig = {
    production: false,
    database: null,
    security: DEFAULT_SECURITY_POLICY,
    dataDir,
    platformVersion: PLATFORM_VERSION,
    trustedKeys: [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }],
    clockRollbackToleranceMs: 24 * 3600 * 1000,
  };
  const storage = new SecureStorageService(config);
  const platform = new PlatformIdentityService(config, storage);
  const audit = new AuditService(new BootstrapJournal(config), null);
  const store = new LicenseStoreService(config, storage);
  const time = new TimeIntegrityService(config, storage);
  const service = new LicensingService(
    config,
    platform,
    store,
    time,
    audit,
    () => Promise.resolve(fingerprint),
  );
  return { config, storage, platform, audit, store, service };
}

function install(
  h: ReturnType<typeof makeHarness>,
  verification: 'PASS' | 'FAIL' = 'PASS',
) {
  const identity = h.platform.initializeIdentity();
  h.platform.recordInstallationVerification({
    installationId: 'NXI-2026-000125',
    verification,
    verifiedAt: new Date().toISOString(),
    platformVersion: PLATFORM_VERSION,
  });
  return identity;
}

function provision(
  h: ReturnType<typeof makeHarness>,
  overrides: Partial<Parameters<typeof issueLicense>[0]> = {},
) {
  const identity = h.platform.getIdentity().identity!;
  const request = createActivationRequest({
    platform: identity,
    platformVersion: PLATFORM_VERSION,
    fingerprint: hashFingerprint(MACHINE),
  });
  const license = issueLicense({
    request,
    privateKeyPem: vendor.privateKeyPem,
    customer: { id: 'CUST-1', name: 'Crescent Pharma' },
    licenseType: 'PERPETUAL',
    modules: [{ id: 'tlc', expiresAt: null }],
    ...overrides,
  });
  const text = serializeLicenseFile(license);
  mkdirSync(h.store.inboxDir, { recursive: true });
  writeFileSync(
    join(h.store.inboxDir, `${license.payload.activationCode}.nxlic`),
    text,
  );
  return { code: license.payload.activationCode, text, license };
}

describe('LicensingService', () => {
  let dataDir: string;
  beforeEach(() => (dataDir = mkdtempSync(join(tmpdir(), 'nxgen-lic-'))));
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('starts NOT_ACTIVATED and exposes the Screen 1 data without module entitlements', async () => {
    const h = makeHarness(dataDir);
    const identity = install(h);
    await h.service.onApplicationBootstrap();

    const status = h.service.getStatus();
    expect(status.license.state).toBe(LicenseState.NOT_ACTIVATED);
    expect(status.platform.instanceId).toBe(identity.instanceId);
    expect(status.installation).toEqual({
      verification: 'PASS',
      environment: 'Verified',
      status: 'Complete',
      simulated: false,
    });
    expect(JSON.stringify(status)).not.toMatch(/tlc|entitlement/i);
  });

  it('validates activation code format inline before doing anything', async () => {
    const h = makeHarness(dataDir);
    install(h);
    expect(await h.service.activate('')).toMatchObject({
      ok: false,
      inputError: 'EMPTY',
    });
    expect(await h.service.activate('NXG-1234')).toMatchObject({
      ok: false,
      inputError: 'FORMAT',
    });
    expect(await h.audit.readAll()).toHaveLength(0);
  });

  it('blocks activation when installation verification has not passed (E013)', async () => {
    const h = makeHarness(dataDir);
    install(h, 'FAIL');
    const { code } = provision(h);
    const r = await h.service.activate(code);
    expect(r).toMatchObject({
      ok: false,
      errorCode: LicenseErrorCode.INSTALLATION_NOT_VERIFIED,
    });
    expect(h.store.hasActive()).toBe(false);
  });

  it('asks for the license file when no provisioned package matches (E001) and stays on Screen 1', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const r = await h.service.activate(generateActivationCode());
    expect(r).toMatchObject({
      ok: false,
      errorCode: LicenseErrorCode.LICENSE_NOT_FOUND,
      licensePackageRequired: true,
    });
    expect(r.state).toBe(LicenseState.NOT_ACTIVATED);
  });

  it('activates from the provisioning inbox, stores the license encrypted and audits every step', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h);

    const r = await h.service.activate(code.toLowerCase().replace(/-/g, ' '));
    expect(r.ok).toBe(true);
    expect(r.state).toBe(LicenseState.ACTIVE);
    expect(r.checks.every((c) => c.status === 'PASS')).toBe(true);
    expect(h.service.hasModule('tlc')).toBe(true);
    expect(h.service.hasModule('hptlc')).toBe(false);

    const stored = readFileSync(
      join(dataDir, 'licensing', 'active.nxlic.enc'),
      'utf8',
    );
    expect(stored).not.toContain(code);
    expect(stored).toContain('AES-256-GCM');

    const actions = (await h.audit.readAll()).map((e) => e.action);
    expect(actions).toEqual([
      'ACTIVATION_INITIATED',
      'LICENSE_PACKAGE_FOUND',
      'PLATFORM_INSTANCE_VERIFIED',
      'LICENSE_VERIFICATION_SUCCESS',
      'LOCAL_LICENSE_STORED',
      'ACTIVATION_SUCCESSFUL',
    ]);
    expect(
      (await h.audit.readAll()).every(
        (e) => e.actor === 'SYSTEM_LICENSE_SERVICE',
      ),
    ).toBe(true);
    expect(await h.audit.verifyChain()).toEqual({ valid: true });
  });

  it('accepts a manually selected license file', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code, text } = provision(h);
    rmSync(h.store.inboxDir, { recursive: true });
    const r = await h.service.activate(code, text, 'customer.nxlic');
    expect(r.ok).toBe(true);
    expect((await h.audit.readAll()).map((e) => e.action)).toContain(
      'LICENSE_PACKAGE_SELECTED_MANUALLY',
    );
  });

  it('re-validates the stored license on restart, offline', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h);
    await h.service.activate(code);

    const restarted = makeHarness(dataDir);
    await restarted.service.onApplicationBootstrap();
    expect(restarted.service.getState()).toBe(LicenseState.ACTIVE);
    expect(restarted.service.hasModule('tlc')).toBe(true);
  });

  it('rejects a license issued for another platform and stores nothing (E006)', async () => {
    const other = makeHarness(mkdtempSync(join(tmpdir(), 'nxgen-other-')));
    install(other);
    const { text, code } = provision(other);

    const h = makeHarness(dataDir);
    install(h);
    const r = await h.service.activate(code, text);
    expect(r).toMatchObject({
      ok: false,
      errorCode: LicenseErrorCode.WRONG_PLATFORM_INSTANCE,
    });
    expect(r.state).toBe(LicenseState.ACTIVATION_ERROR);
    expect(h.store.hasActive()).toBe(false);
    rmSync(other.config.dataDir, { recursive: true, force: true });
  });

  it('rejects a tampered license file (E005)', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code, text } = provision(h);
    const tampered = JSON.parse(text) as LicenseFile;
    tampered.payload.entitlements.modules.push({
      id: 'hptlc',
      expiresAt: null,
    });
    const r = await h.service.activate(code, JSON.stringify(tampered));
    expect(r.errorCode).toBe(LicenseErrorCode.INVALID_SIGNATURE);
  });

  it('is transactional: if the audit write fails, the stored license is rolled back', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h);
    const original = h.audit.record.bind(h.audit);
    jest.spyOn(h.audit, 'record').mockImplementation((e) => {
      if (e.action === 'ACTIVATION_SUCCESSFUL') throw new Error('disk full');
      return original(e);
    });

    const r = await h.service.activate(code);
    expect(r).toMatchObject({
      ok: false,
      errorCode: LicenseErrorCode.SERVICE_UNAVAILABLE,
    });
    expect(r.state).not.toBe(LicenseState.ACTIVE);
    expect(h.store.hasActive()).toBe(false);
  });

  it('a failed re-activation never downgrades an ACTIVE platform', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h);
    await h.service.activate(code);
    const bad = await h.service.activate(
      generateActivationCode(),
      '{"broken":',
    );
    expect(bad.ok).toBe(false);
    expect(h.service.getState()).toBe(LicenseState.ACTIVE);
  });

  it('motherboard replacement → REACTIVATION_REQUIRED on restart, restricted mode, audit preserved', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h);
    await h.service.activate(code);
    const eventsBefore = (await h.audit.readAll()).length;

    const newBoard = hashFingerprint({
      ...MACHINE,
      systemUuid: 'NEW-UUID-1',
      baseboardSerial: 'NEWBOARD',
      primaryMac: 'DE:AD:BE:EF:00:01',
    });
    const restarted = makeHarness(dataDir, newBoard);
    await restarted.service.onApplicationBootstrap();

    const status = restarted.service.getStatus();
    expect(status.license.state).toBe(LicenseState.REACTIVATION_REQUIRED);
    expect(status.license.errorCode).toBe(LicenseErrorCode.HARDWARE_CHANGED);
    expect(status.license.restricted).toBe(true);
    expect(restarted.service.hasModule('tlc')).toBe(false);
    expect((await restarted.audit.readAll()).length).toBe(eventsBefore + 1);
    expect(await restarted.audit.verifyChain()).toEqual({ valid: true });
  });

  it('expired subscription → EXPIRED on restart', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h, {
      licenseType: 'SUBSCRIPTION',
      expiresAt: new Date(Date.now() + 1500),
    });
    expect((await h.service.activate(code)).ok).toBe(true);

    await new Promise((r) => setTimeout(r, 1600));
    const restarted = makeHarness(dataDir);
    await restarted.service.onApplicationBootstrap();
    expect(restarted.service.getState()).toBe(LicenseState.EXPIRED);
  });

  it('detects a modified stored license on restart', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h);
    await h.service.activate(code);

    const path = join(dataDir, 'licensing', 'active.nxlic.enc');
    const box = JSON.parse(readFileSync(path, 'utf8')) as { data: string };
    box.data = Buffer.from('x'.repeat(40)).toString('base64');
    writeFileSync(path, JSON.stringify(box));

    const restarted = makeHarness(dataDir);
    await restarted.service.onApplicationBootstrap();
    expect(restarted.service.getStatus().license).toMatchObject({
      state: LicenseState.ACTIVATION_ERROR,
      errorCode: LicenseErrorCode.PACKAGE_CORRUPTED,
    });
  });

  it('audit chain detects an edited record', async () => {
    const h = makeHarness(dataDir);
    install(h);
    const { code } = provision(h);
    await h.service.activate(code);
    const path = join(dataDir, 'audit', 'system-audit.jsonl');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'ACTIVATION_SUCCESSFUL',
        'ACTIVATION_FAILED',
      ),
    );
    expect(
      (
        await new AuditService(
          new BootstrapJournal(h.config),
          null,
        ).verifyChain()
      ).valid,
    ).toBe(false);
  });

  it('generates an activation request for the License Authority (service function)', async () => {
    const h = makeHarness(dataDir);
    const identity = install(h);
    const req = await h.service.generateActivationRequest();
    expect(req.requestCode).toMatch(/^NXR1\./);
    expect(req.fileName).toBe(`${identity.instanceId}.nxreq`);
    expect(req.fileContent).not.toContain(MACHINE.systemDiskSerial);
  });

  it('System Information shows license details and entitlements; certificate only when ACTIVE', async () => {
    const h = makeHarness(dataDir);
    const identity = install(h);
    expect(h.service.getActiveCertificate()).toBeNull();

    const { code, license } = provision(h);
    await h.service.activate(code);

    const info = await h.service.getSystemInformation();
    expect(info.platform.instanceId).toBe(identity.instanceId);
    expect(info.installation).toMatchObject({
      installationId: 'NXI-2026-000125',
      simulated: false,
    });
    expect(info.license.details).toMatchObject({
      licenseId: license.payload.licenseId,
      activationCode: code,
      licenseType: 'PERPETUAL',
      versionScope: '2.x',
      signingKeyId: vendor.keyId,
    });
    expect(info.license.hardwareBinding).toMatchObject({
      score: 100,
      changed: 0,
    });
    expect(info.entitlements.map((m) => m.id)).toEqual(['tlc']);
    expect(info.audit).toMatchObject({ chain: 'INTACT' });

    const cert = h.service.getActiveCertificate();
    expect(cert).not.toBeNull();
    expect((JSON.parse(cert!) as LicenseFile).payload.licenseId).toBe(
      license.payload.licenseId,
    );
  });

  it('flags installation records written by the development simulator', async () => {
    const h = makeHarness(dataDir);
    h.platform.initializeIdentity();
    h.platform.recordInstallationVerification({
      installationId: 'NXI-DEV',
      verification: 'PASS',
      verifiedAt: new Date().toISOString(),
      platformVersion: PLATFORM_VERSION,
      source: 'DEV_SIMULATION',
    });
    await h.service.onApplicationBootstrap();
    expect(h.service.getStatus().installation.simulated).toBe(true);
  });
});
