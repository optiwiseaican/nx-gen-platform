import { gunzipSync, gzipSync } from 'zlib';
import { compareVersions, generateSigningKeyPair, packModule, verifyModulePackage } from '..';

const vendor = generateSigningKeyPair();
const trusted = [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }];
const manifest = {
  id: 'ph',
  name: 'pH',
  version: '1.0.0',
  description: 'pH meters',
  coreApi: 1,
  minCoreVersion: '2.0.0',
  entitlement: 'ph',
  tablePrefix: 'ph_',
  apiEntry: 'api/index.js',
  uiEntry: 'ui/index.html',
  instrumentTypes: [{ code: 'PH', label: 'pH meter' }],
  permissions: [{ code: 'ph.view', description: 'View pH data', defaultRoles: ['ANALYST'] }],
  menu: [{ label: 'pH', path: '/', permission: 'ph.view' }],
};
const files = [
  { path: 'api/index.js', data: Buffer.from('module.exports = {};') },
  { path: 'ui/index.html', data: Buffer.from('<!doctype html>') },
  { path: 'migrations/001_init.sql', data: Buffer.from('CREATE TABLE ph_x (id int);') },
];

describe('signed module packages (.nxmod)', () => {
  it('packs, signs and verifies a module with every file hash', () => {
    const r = verifyModulePackage(packModule({ manifest, files, privateKeyPem: vendor.privateKeyPem }), trusted);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pkg.manifest.id).toBe('ph');
    expect(Object.keys(r.pkg.fileHashes).sort()).toEqual(['api/index.js', 'migrations/001_init.sql', 'ui/index.html']);
    expect(r.pkg.files.find((f) => f.path === 'api/index.js')!.data.toString()).toBe('module.exports = {};');
  });

  it('rejects untrusted signers and any altered byte', () => {
    const rogue = generateSigningKeyPair();
    expect(verifyModulePackage(packModule({ manifest, files, privateKeyPem: rogue.privateKeyPem }), trusted)).toMatchObject({
      ok: false,
      reason: 'UNTRUSTED_KEY',
    });
    const pkg = JSON.parse(gunzipSync(packModule({ manifest, files, privateKeyPem: vendor.privateKeyPem })).toString());
    // Swap the code but keep the signed hash: file mismatch.
    pkg.files[0].content = Buffer.from('module.exports = { evil: true };').toString('base64');
    expect(verifyModulePackage(gzipSync(JSON.stringify(pkg)), trusted)).toMatchObject({ ok: false, reason: 'FILE_MISMATCH' });
    // Raise the version in the manifest: signature breaks.
    const pkg2 = JSON.parse(gunzipSync(packModule({ manifest, files, privateKeyPem: vendor.privateKeyPem })).toString());
    pkg2.manifest.version = '9.9.9';
    expect(verifyModulePackage(gzipSync(JSON.stringify(pkg2)), trusted)).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyModulePackage(Buffer.from('not a package'), trusted)).toMatchObject({ ok: false, reason: 'FORMAT' });
  });

  it('enforces the table prefix, permission namespace and allowed file paths', () => {
    expect(() => packModule({ manifest: { ...manifest, tablePrefix: 'core_' }, files, privateKeyPem: vendor.privateKeyPem })).toThrow(/tablePrefix/);
    expect(() =>
      packModule({
        manifest: { ...manifest, permissions: [{ code: 'users.manage', description: 'steal', defaultRoles: [] }] },
        files,
        privateKeyPem: vendor.privateKeyPem,
      }),
    ).toThrow(/must start with/);
    expect(() =>
      packModule({ manifest, files: [...files, { path: '../core/main.js', data: Buffer.from('x') }], privateKeyPem: vendor.privateKeyPem }),
    ).toThrow(/not allowed/);
  });

  it('compares core versions numerically', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
});
