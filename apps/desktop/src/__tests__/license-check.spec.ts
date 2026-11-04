import {
  createActivationRequest,
  createPlatformIdentity,
  generateSigningKeyPair,
  hashFingerprint,
  issueLicense,
  serializeLicenseFile,
} from '@crescent/licensing';
import { ServiceStatus, verifyCertificate } from '../license-check';

const vendor = generateSigningKeyPair();
const trustedKeys = [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }];
const platform = createPlatformIdentity();
const machine = hashFingerprint({ systemUuid: 'UUID-1', baseboardSerial: 'BOARD-1', cpuModel: 'CPU', primaryMac: 'A4:BB:6D:12:34:56' });
const certificate = serializeLicenseFile(
  issueLicense({
    request: createActivationRequest({ platform, platformVersion: '2.0.0', fingerprint: machine }),
    privateKeyPem: vendor.privateKeyPem,
    customer: { id: 'C1', name: 'Customer' },
    licenseType: 'PERPETUAL',
  }),
);
const status: ServiceStatus = {
  platform: { instanceId: platform.instanceId, version: '2.0.0' },
  installation: { verification: 'PASS' },
  license: { state: 'ACTIVE', errorCode: null },
};
const ctx = { trustedKeys, fingerprint: machine, platformVersion: '2.0.0' };

describe('desktop shell independent license verification', () => {
  it('verifies a genuine certificate on the bound machine', () => {
    expect(verifyCertificate(certificate, status, ctx).kind).toBe('VERIFIED');
  });

  it.each([
    ['installation copied to another PC', certificate, status, { ...ctx, fingerprint: hashFingerprint({ systemUuid: 'OTHER', baseboardSerial: 'OTHER', cpuModel: 'x', primaryMac: '11:22:33:44:55:66' }) }, 'NX-LIC-E011'],
    ['signing key not trusted by the shell', certificate, status, { ...ctx, trustedKeys: [] }, 'NX-LIC-E005'],
    ['service misreports the platform identity', certificate, { ...status, platform: { ...status.platform, instanceId: 'NXG-PLT-AAAA-BBBB' } }, ctx, 'NX-LIC-E015'],
    ['service serves garbage', 'not json', status, ctx, 'NX-LIC-E008'],
  ])('%s → rejected', (_name, cert, st, c, code) => {
    expect(verifyCertificate(cert, st, c)).toMatchObject({ kind: 'REJECTED', errorCode: code });
  });

  it('service serves a tampered certificate → rejected', () => {
    const t = JSON.parse(certificate) as { payload: { limits: { users: number } } };
    t.payload.limits.users = 999;
    expect(verifyCertificate(JSON.stringify(t), status, ctx)).toMatchObject({ errorCode: 'NX-LIC-E005' });
  });
});
