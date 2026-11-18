import { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Pool } from 'pg';
import {
  computeKeyId,
  createActivationRequest,
  createPlatformIdentity,
  generateActivationCode,
  generateSigningKeyPair,
  hashFingerprint,
  HashedFingerprint,
  verifyLicense,
} from '@crescent/licensing';
// The bundled PostgreSQL the desktop app uses, for a real database without a server.
import { LocalDatabase } from '../../../../apps/desktop/src/local-database';
import { createPortalApp } from '../app';
import { activate, PortalRefusal } from '../portal';
import { PortalStore } from '../store';

const PLATFORM_PACKAGE = { win32: 'windows-x64', linux: 'linux-x64', darwin: 'darwin-arm64' }[process.platform as string];
const binaries = resolve(__dirname, '..', '..', '..', '..', 'node_modules', '@embedded-postgres', PLATFORM_PACKAGE ?? 'none', 'native');
const runnable = !!PLATFORM_PACKAGE && LocalDatabase.available(binaries) && process.getuid?.() !== 0;

const fingerprint = (seed: string): HashedFingerprint =>
  hashFingerprint({
    systemUuid: `${seed}-uuid`,
    baseboardSerial: `${seed}-board`,
    osInstallId: `${seed}-os`,
    systemDiskSerial: `${seed}-disk`,
    cpuModel: 'Intel(R) Core(TM) i5',
    primaryMac: `${seed}-mac`,
  });

(runnable ? describe : describe.skip)('AICAN License Portal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nxgen-portal-'));
  const db = new LocalDatabase({ binariesDir: binaries, dir, port: 47950 + Math.floor(Math.random() * 40) });
  const vendor = generateSigningKeyPair();
  let store: PortalStore;

  const computer = (seed: string) => {
    const platform = createPlatformIdentity();
    const fp = fingerprint(seed);
    return { platform, fp, request: createActivationRequest({ platform, platformVersion: '2.0.0', fingerprint: fp }) };
  };
  const newKey = (over: Partial<Parameters<PortalStore['createKey']>[0]> = {}) =>
    store.createKey({
      code: generateActivationCode(),
      customerId: 'C-100',
      customerName: 'QC Laboratory',
      site: 'Plant 2',
      licenseType: 'PERPETUAL',
      expiresAt: null,
      modules: ['tlc', 'ph'],
      deviceLimit: 1,
      userLimit: null,
      instrumentLimit: null,
      note: null,
      ...over,
    });
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof PortalRefusal) return err.errorCode;
      throw err;
    }
    throw new Error('expected a refusal');
  };

  beforeAll(async () => {
    const url = await db.start();
    store = new PortalStore(new Pool({ connectionString: url }), 'portal_test');
    await store.migrate();
    await store.migrate(); // idempotent
  }, 180_000);

  afterAll(async () => {
    await store?.pool.end();
    await db.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('issues a licence bound to the requesting computer, carrying the key as its activation code', async () => {
    const key = await newKey();
    const pc = computer('lab-pc-1');
    const issued = await activate(store, vendor.privateKeyPem, { activationCode: key.code.toLowerCase(), request: pc.request, channel: 'ONLINE' });
    const license = JSON.parse(issued.licenseText);
    expect(license.signature.keyId).toBe(computeKeyId(vendor.publicKeyPem));
    expect(license.payload).toMatchObject({
      activationCode: key.code,
      customer: { id: 'C-100', name: 'QC Laboratory', site: 'Plant 2' },
      platform: { instanceUid: pc.platform.instanceUid, instanceId: pc.platform.instanceId },
      entitlements: { platform: true, modules: [{ id: 'tlc', expiresAt: null }, { id: 'ph', expiresAt: null }] },
    });
    // The NxGen client accepts it on that computer.
    const check = verifyLicense(issued.licenseText, {
      installationVerified: true,
      platform: pc.platform,
      platformVersion: '2.0.0',
      fingerprint: pc.fp,
      trustedKeys: [{ keyId: computeKeyId(vendor.publicKeyPem), publicKeyPem: vendor.publicKeyPem, label: 'test' }],
      now: new Date(),
      lastTrustedTime: null,
      clockRollbackToleranceMs: 0,
      expectedActivationCode: key.code,
    });
    expect(check.ok).toBe(true);
    expect(issued.fileName).toBe(`${pc.platform.instanceId}.nxlic`);
  });

  it('the same computer may activate again; another one needs a free slot', async () => {
    const key = await newKey({ deviceLimit: 2 });
    const a = computer('a');
    await activate(store, vendor.privateKeyPem, { activationCode: key.code, request: a.request, channel: 'ONLINE' });
    await activate(store, vendor.privateKeyPem, { activationCode: key.code, request: computer('a2').request, channel: 'OFFLINE' });
    await activate(store, vendor.privateKeyPem, { activationCode: key.code, request: a.request, channel: 'ONLINE' });
    expect(await refusal(activate(store, vendor.privateKeyPem, { activationCode: key.code, request: computer('c').request, channel: 'ONLINE' }))).toBe('NX-LIC-E018');
    const rows = await store.activations(key.code);
    expect(rows.map((r) => r.channel)).toEqual(['ONLINE', 'OFFLINE', 'ONLINE']);
    expect((await store.listKeys()).find((k) => k.code === key.code)?.computers).toBe(2);
  });

  it('two computers racing for the last slot: exactly one wins', async () => {
    const key = await newKey({ deviceLimit: 1 });
    const results = await Promise.allSettled(
      ['r1', 'r2', 'r3'].map((s) => activate(store, vendor.privateKeyPem, { activationCode: key.code, request: computer(s).request, channel: 'ONLINE' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses unknown, malformed, withdrawn and expired keys', async () => {
    const pc = computer('x').request;
    expect(await refusal(activate(store, vendor.privateKeyPem, { activationCode: generateActivationCode(), request: pc, channel: 'ONLINE' }))).toBe('NX-LIC-E017');
    expect(await refusal(activate(store, vendor.privateKeyPem, { activationCode: 'NXG-1234', request: pc, channel: 'ONLINE' }))).toBe('NX-LIC-E017');
    const revoked = await newKey();
    await store.revokeKey(revoked.code);
    expect(await refusal(activate(store, vendor.privateKeyPem, { activationCode: revoked.code, request: pc, channel: 'ONLINE' }))).toBe('NX-LIC-E017');
    const expired = await newKey({ licenseType: 'SUBSCRIPTION', expiresAt: new Date(Date.now() - 1000) });
    expect(await refusal(activate(store, vendor.privateKeyPem, { activationCode: expired.code, request: pc, channel: 'ONLINE' }))).toBe('NX-LIC-E004');
    expect(await refusal(activate(store, vendor.privateKeyPem, { activationCode: (await newKey()).code, request: { nonsense: 1 }, channel: 'ONLINE' }))).toBe('NX-LIC-E007');
  });

  it('HTTP: issues over POST /api/v1/activate and answers refusals with the error catalogue', async () => {
    const server = createPortalApp(store, vendor.privateKeyPem).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const key = await newKey();
      const ok = await fetch(`${base}/api/v1/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activationCode: key.code, request: JSON.stringify(computer('http').request) }),
      });
      expect(ok.status).toBe(200);
      expect(JSON.parse((await ok.json()).license).payload.activationCode).toBe(key.code);
      const no = await fetch(`${base}/api/v1/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activationCode: key.code, request: computer('http-2').request }),
      });
      expect(no.status).toBe(409);
      expect(await no.json()).toMatchObject({ errorCode: 'NX-LIC-E018', title: 'Activation Key Already Used' });
      expect((await fetch(`${base}/`)).headers.get('content-type')).toMatch(/text\/html/);
    } finally {
      server.close();
    }
  });
});
