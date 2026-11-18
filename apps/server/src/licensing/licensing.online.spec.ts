import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ActivationRequest,
  createActivationRequest,
  generateActivationCode,
  generateSigningKeyPair,
  hashFingerprint,
  issueLicense,
  LicenseState,
  parseActivationRequest,
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

const FINGERPRINT = hashFingerprint({
  systemUuid: '4C4C4544-0042-3510-8051-B4C04F334E32',
  baseboardSerial: 'CNWS2007A1001M',
  osInstallId: 'a3f1c9d2-5e8b-4c1a-9f7e-2d6b8a0c4e19',
  systemDiskSerial: 'S4EWNX0R123456',
  cpuModel: 'Intel(R) Core(TM) i7-12700',
  primaryMac: 'A4:BB:6D:12:34:56',
});
const vendor = generateSigningKeyPair();

/** A stand-in AICAN License Portal: answers like tools/license-portal. */
function fakePortal(answer: (code: string, request: ActivationRequest) => { status: number; body: unknown }) {
  const seen: { code: string; request: ActivationRequest }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { activationCode: string; request: unknown };
      const request = parseActivationRequest(JSON.stringify(body.request));
      seen.push({ code: body.activationCode, request });
      const out = answer(body.activationCode, request);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return { server, seen };
}

const issue = (code: string, request: ActivationRequest) =>
  serializeLicenseFile(
    issueLicense({
      request,
      privateKeyPem: vendor.privateKeyPem,
      customer: { id: 'C-1', name: 'QC Lab' },
      licenseType: 'PERPETUAL',
      modules: [{ id: 'tlc', expiresAt: null }],
      activationCode: code,
    }),
  );

describe('LicensingService — activation with the key alone (AICAN License Portal)', () => {
  let dataDir: string;
  let server: Server | null = null;
  beforeEach(() => (dataDir = mkdtempSync(join(tmpdir(), 'nxgen-online-'))));
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function harness(portal: ReturnType<typeof fakePortal> | 'unreachable' | 'none', keyFile?: string) {
    let url: string | null = portal === 'none' ? null : 'http://127.0.0.1:9'; // discard port: nothing listens
    if (portal !== 'unreachable' && portal !== 'none') {
      server = portal.server.listen(0, '127.0.0.1');
      await new Promise((r) => server!.once('listening', r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    const config: NxGenConfig = {
      production: false,
      database: null,
      security: { ...DEFAULT_SECURITY_POLICY },
      dataDir,
      platformVersion: PLATFORM_VERSION,
      trustedKeys: [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }],
      clockRollbackToleranceMs: 24 * 3600 * 1000,
      licensePortalUrl: url,
      activationKeyFile: keyFile ?? null,
    };
    const storage = new SecureStorageService(config);
    const platform = new PlatformIdentityService(config, storage);
    const identity = platform.initializeIdentity();
    platform.recordInstallationVerification({
      installationId: 'NXI-2026-000200',
      verification: 'PASS',
      verifiedAt: new Date().toISOString(),
      platformVersion: PLATFORM_VERSION,
      source: 'SMART_INSTALLER',
    });
    const journal = new BootstrapJournal(config);
    const service = new LicensingService(
      config,
      platform,
      new LicenseStoreService(config, storage),
      new TimeIntegrityService(config, storage),
      new AuditService(journal, null),
      () => Promise.resolve(FINGERPRINT),
    );
    await service.onApplicationBootstrap();
    return { service, identity, journal };
  }

  it('activates with only the key: the portal issues a licence bound to this computer', async () => {
    const code = generateActivationCode();
    const portal = fakePortal((c, request) => ({ status: 200, body: { license: issue(c, request), fileName: 'x.nxlic' } }));
    const { service, identity, journal } = await harness(portal);

    const outcome = await service.activate(code.toLowerCase());
    expect(outcome.ok).toBe(true);
    expect(service.getState()).toBe(LicenseState.ACTIVE);
    expect(service.hasModule('tlc')).toBe(true);
    expect(portal.seen).toHaveLength(1);
    expect(portal.seen[0].code).toBe(code);
    expect(portal.seen[0].request.platform.instanceUid).toBe(identity.instanceUid);
    expect(portal.seen[0].request.machineFingerprint.components).toEqual(FINGERPRINT);
    const actions = journal.readAll().map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['LICENSE_PORTAL_REQUESTED', 'LICENSE_ISSUED_BY_PORTAL', 'ACTIVATION_SUCCESSFUL']));
  });

  it('uses the key saved by the installer at the first start, then forgets it', async () => {
    const code = generateActivationCode();
    const keyFile = join(dataDir, 'activation-key.txt');
    writeFileSync(keyFile, `${code}\r\n`);
    const portal = fakePortal((c, request) => ({ status: 200, body: { license: issue(c, request) } }));
    const { service } = await harness(portal, keyFile);
    expect(service.getState()).toBe(LicenseState.ACTIVE);
    expect(existsSync(keyFile)).toBe(false);
    expect(service.getStatus().activation.pendingActivationCode).toBeNull();
  });

  it('a key the portal refuses: the catalogue error, and the installer key is kept for the activation screen', async () => {
    const code = generateActivationCode();
    const keyFile = join(dataDir, 'activation-key.txt');
    writeFileSync(keyFile, code);
    const portal = fakePortal(() => ({ status: 409, body: { errorCode: 'NX-LIC-E018', title: 'Activation Key Already Used' } }));
    const { service } = await harness(portal, keyFile);
    expect(service.getState()).toBe(LicenseState.ACTIVATION_ERROR);
    expect(existsSync(keyFile)).toBe(true);
    expect(service.getStatus().activation.pendingActivationCode).toBe(code);
    const again = await service.activate(code);
    expect(again).toMatchObject({ ok: false, errorCode: 'NX-LIC-E018' });
    expect(again.error?.title).toBe('Activation Key Already Used');
  });

  it('no internet: stays on Screen 1 and offers the offline route', async () => {
    const { service } = await harness('unreachable');
    const outcome = await service.activate(generateActivationCode());
    expect(outcome).toMatchObject({ ok: false, errorCode: 'NX-LIC-E016', licensePackageRequired: true, offlineActivation: true });
    expect(service.getState()).toBe(LicenseState.NOT_ACTIVATED);
    expect(service.getStatus().activation.portalUrl).toBe('http://127.0.0.1:9/');
  });

  it('lab PC build without a portal: the installer key waits on the activation screen for the licence file', async () => {
    const code = generateActivationCode();
    const keyFile = join(dataDir, 'activation-key.txt');
    writeFileSync(keyFile, code);
    const { service, identity, journal } = await harness('none', keyFile);
    expect(service.getState()).toBe(LicenseState.NOT_ACTIVATED);
    expect(journal.readAll().some((r) => r.action === 'ACTIVATION_INITIATED')).toBe(false);
    expect(service.getStatus().activation).toEqual({ pendingActivationCode: code, portalUrl: null });
    const text = issue(code, createActivationRequest({ platform: identity, platformVersion: PLATFORM_VERSION, fingerprint: FINGERPRINT }));
    expect((await service.activate(code, text, 'LAB-PC.nxlic')).ok).toBe(true);
    expect(existsSync(keyFile)).toBe(false);
  });

  it('a portal error that is not a refusal counts as unreachable, never as a licence failure', async () => {
    const portal = fakePortal(() => ({ status: 502, body: { message: 'bad gateway' } }));
    const { service } = await harness(portal);
    expect((await service.activate(generateActivationCode())).errorCode).toBe('NX-LIC-E016');
  });

  it('a licence file selected by hand still works without the portal', async () => {
    const portal = fakePortal(() => ({ status: 500, body: {} }));
    const { service, identity } = await harness(portal);
    const code = generateActivationCode();
    const text = issue(code, createActivationRequest({ platform: identity, platformVersion: PLATFORM_VERSION, fingerprint: FINGERPRINT }));
    expect((await service.activate(code, text, 'offline.nxlic')).ok).toBe(true);
    expect(portal.seen).toHaveLength(0);
  });
});
