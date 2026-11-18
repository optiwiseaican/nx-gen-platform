import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateSigningKeyPair } from '@crescent/licensing';
import { BootstrapJournal } from '../audit/bootstrap-journal';
import { DEFAULT_SECURITY_POLICY, NxGenConfig, PLATFORM_VERSION } from '../config/nxgen.config';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { SecureStorageService } from '../security/secure-storage.service';
import { runSmartInstaller } from './smart-installer';

describe('Smart Installer step (first start of an installed NxGen)', () => {
  const vendor = generateSigningKeyPair();
  let dataDir: string;
  let serviceDir: string;
  let config: NxGenConfig;
  const ok = () => Promise.resolve('PostgreSQL 16.15');

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nxgen-inst-'));
    serviceDir = mkdtempSync(join(tmpdir(), 'nxgen-svc-'));
    mkdirSync(join(serviceDir, 'dist', 'database', 'migrations'), { recursive: true });
    writeFileSync(join(serviceDir, 'dist', 'main.js'), '');
    writeFileSync(join(serviceDir, 'dist', 'database', 'migrations', '001_compliance_core.sql'), 'SELECT 1;\n');
    config = {
      production: true,
      database: null,
      security: { ...DEFAULT_SECURITY_POLICY },
      dataDir,
      platformVersion: PLATFORM_VERSION,
      trustedKeys: [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }],
      clockRollbackToleranceMs: 86_400_000,
    };
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
  });

  const platformOf = () => new PlatformIdentityService(config, new SecureStorageService(config));

  it('creates the identity and a PASS record from the Smart Installer (not simulated), with a report', async () => {
    const { ran, report } = await runSmartInstaller(config, { serviceDir, checkDatabase: ok });
    expect(ran).toBe(true);
    expect(report!.verification).toBe('PASS');
    expect(report!.checks.map((c) => c.id)).toEqual(['IDENTITY', 'DATA_FOLDER', 'SERVICE_FILES', 'DATABASE', 'LICENSE_KEYS']);
    const platform = platformOf();
    expect(platform.isInstallationVerified()).toBe(true);
    expect(platform.getInstallation()).toMatchObject({ verification: 'PASS', source: 'SMART_INSTALLER', platformVersion: PLATFORM_VERSION });
    expect(platform.getIdentity().identity!.instanceId).toBe(report!.platformInstanceId);
    const saved = JSON.parse(readFileSync(join(dataDir, 'platform', 'installation-report.json'), 'utf8'));
    expect(saved.installationId).toMatch(/^NXI-\d{4}-[0-9A-F]{6}$/);
    const actions = new BootstrapJournal(config).readAll().map((r) => r.action);
    expect(actions).toEqual(['PLATFORM_IDENTITY_CREATED', 'INSTALLATION_VERIFICATION_RECORDED']);
  });

  it('later starts skip it; an update re-verifies and keeps the identity', async () => {
    const first = await runSmartInstaller(config, { serviceDir, checkDatabase: ok });
    expect((await runSmartInstaller(config, { serviceDir, checkDatabase: ok })).ran).toBe(false);
    const updated = await runSmartInstaller({ ...config, platformVersion: '2.1.0' }, { serviceDir, checkDatabase: ok });
    expect(updated.ran).toBe(true);
    expect(updated.report!.platformInstanceId).toBe(first.report!.platformInstanceId);
    expect(updated.report!.installationId).toBe(first.report!.installationId);
  });

  it('a failed check records FAIL (activation stays closed) and passes on a later start', async () => {
    const down = () => Promise.reject(new Error('connection refused'));
    const failed = await runSmartInstaller(config, { serviceDir, checkDatabase: down });
    expect(failed.report!.verification).toBe('FAIL');
    expect(failed.report!.checks.find((c) => c.id === 'DATABASE')).toMatchObject({ status: 'FAIL', detail: 'connection refused' });
    expect(platformOf().isInstallationVerified()).toBe(false);
    expect((await runSmartInstaller(config, { serviceDir, checkDatabase: ok })).report!.verification).toBe('PASS');
    expect(platformOf().isInstallationVerified()).toBe(true);
  });

  it('replaces a development (simulated) record, and never regenerates a damaged identity', async () => {
    const platform = platformOf();
    platform.initializeIdentity();
    platform.recordInstallationVerification({ installationId: 'NXI-2026-DEVAB12', verification: 'PASS', verifiedAt: new Date().toISOString(), platformVersion: PLATFORM_VERSION, source: 'DEV_SIMULATION' });
    const replaced = await runSmartInstaller(config, { serviceDir, checkDatabase: ok });
    expect(replaced.ran).toBe(true);
    expect(platformOf().getInstallation()!.source).toBe('SMART_INSTALLER');

    const identityFile = join(dataDir, 'platform', 'identity.json');
    writeFileSync(identityFile, readFileSync(identityFile, 'utf8').replace(/"instanceId": "[^"]+"/, '"instanceId": "NXG-PLT-0000-0000"'));
    const damaged = await runSmartInstaller({ ...config, platformVersion: '2.1.0' }, { serviceDir, checkDatabase: ok });
    expect(damaged.report!.checks.find((c) => c.id === 'IDENTITY')!.status).toBe('FAIL');
    expect(damaged.report!.verification).toBe('FAIL');
  });
});
