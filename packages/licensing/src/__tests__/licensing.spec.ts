import {
  canonicalize,
  createActivationRequest,
  createPlatformIdentity,
  derivePlatformInstanceId,
  encodeRequestCode,
  generateActivationCode,
  generateSigningKeyPair,
  hashFingerprint,
  issueLicense,
  isValidPlatformIdentity,
  LicenseErrorCode,
  matchFingerprint,
  parseActivationCode,
  parseActivationRequest,
  RawFingerprint,
  serializeLicenseFile,
  signLicensePayload,
  verifyLicense,
  VerificationContext,
} from '..';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-04T10:00:00.000Z');

const PC_A: RawFingerprint = {
  systemUuid: '4C4C4544-0042-3510-8051-B4C04F334E32',
  baseboardSerial: '/7B3XQL3/CNWS2007A1001M/',
  osInstallId: 'a3f1c9d2-5e8b-4c1a-9f7e-2d6b8a0c4e19',
  systemDiskSerial: 'S4EWNX0R123456',
  cpuModel: 'Intel(R) Core(TM) i7-12700 CPU @ 2.10GHz',
  primaryMac: 'A4:BB:6D:12:34:56',
};

const PC_B: RawFingerprint = {
  systemUuid: '9D2A1F00-1111-2222-3333-444455556666',
  baseboardSerial: 'PF2ABCDE',
  osInstallId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
  systemDiskSerial: 'WD-WX12A3456789',
  cpuModel: 'AMD Ryzen 7 5800X 8-Core Processor',
  primaryMac: '00:1A:2B:3C:4D:5E',
};

const vendor = generateSigningKeyPair();
const trustedKeys = [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }];
const platformA = createPlatformIdentity();

function issue(overrides: Partial<Parameters<typeof issueLicense>[0]> = {}) {
  const request = createActivationRequest({
    platform: platformA,
    platformVersion: '2.0.0',
    fingerprint: hashFingerprint(PC_A),
    now: NOW,
  });
  return issueLicense({
    request,
    privateKeyPem: vendor.privateKeyPem,
    customer: { id: 'CUST-001', name: 'Crescent Pharma Ltd', site: 'QC Lab 1' },
    licenseType: 'PERPETUAL',
    modules: [
      { id: 'ph', expiresAt: null },
      { id: 'tlc', expiresAt: null },
    ],
    now: new Date(NOW.getTime() - DAY),
    ...overrides,
  });
}

function ctx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    installationVerified: true,
    platform: platformA,
    platformVersion: '2.0.0',
    fingerprint: hashFingerprint(PC_A),
    trustedKeys,
    now: NOW,
    ...overrides,
  };
}

const text = (license: ReturnType<typeof issue>) => serializeLicenseFile(license);

describe('canonical JSON', () => {
  it('is independent of key order and whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [1, 'x', null], c: true } })).toBe(
      canonicalize(JSON.parse('{ "a": { "c": true, "d": [1, "x", null] }, "b": 1 }')),
    );
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('rejects values that cannot be represented deterministically', () => {
    expect(() => canonicalize({ x: NaN })).toThrow();
    expect(() => canonicalize({ x: new Date() })).toThrow();
  });
});

describe('activation codes', () => {
  it('generates codes that validate', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateActivationCode();
      expect(parseActivationCode(code)).toEqual({ valid: true, code });
    }
  });

  it('normalizes case, spacing, missing dashes and Crockford look-alikes', () => {
    const code = generateActivationCode();
    const messy = ` ${code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `;
    expect(parseActivationCode(messy)).toEqual({ valid: true, code });
  });

  it('blocks blank, malformed and mistyped codes inline', () => {
    expect(parseActivationCode('')).toEqual({ valid: false, reason: 'EMPTY' });
    expect(parseActivationCode('ABC-1234')).toEqual({ valid: false, reason: 'FORMAT' });
    expect(parseActivationCode('NXG-1234-5678')).toEqual({ valid: false, reason: 'FORMAT' });

    const code = generateActivationCode();
    const swapped = code.slice(0, 4) + code[5] + code[4] + code.slice(6);
    if (swapped !== code) expect(parseActivationCode(swapped)).toEqual({ valid: false, reason: 'CHECKSUM' });
  });
});

describe('platform identity', () => {
  it('derives a display ID from the UID and detects tampering', () => {
    const id = createPlatformIdentity();
    expect(id.instanceId).toMatch(/^NXG-PLT-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(isValidPlatformIdentity(id)).toBe(true);
    expect(isValidPlatformIdentity({ ...id, instanceId: 'NXG-PLT-0000-0000' })).toBe(false);
    expect(derivePlatformInstanceId(id.instanceUid)).toBe(id.instanceId);
  });
});

describe('activation request', () => {
  it('round-trips through the compact code and rejects transcription errors', () => {
    const request = createActivationRequest({
      platform: platformA,
      platformVersion: '2.0.0',
      fingerprint: hashFingerprint(PC_A),
    });
    const code = encodeRequestCode(request);
    expect(parseActivationRequest(code)).toEqual(request);
    expect(parseActivationRequest(JSON.stringify(request))).toEqual(request);
    expect(() => parseActivationRequest(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'))).toThrow();
  });

  it('never contains raw hardware serials', () => {
    const code = encodeRequestCode(
      createActivationRequest({ platform: platformA, platformVersion: '2.0.0', fingerprint: hashFingerprint(PC_A) }),
    );
    const decoded = Buffer.from(code.split('.')[1], 'base64url').toString();
    expect(decoded).not.toContain(PC_A.systemDiskSerial);
    expect(decoded).not.toContain(PC_A.primaryMac);
  });

  it('refuses to issue a license for a machine with too few identifiers', () => {
    const request = createActivationRequest({
      platform: platformA,
      platformVersion: '2.0.0',
      fingerprint: hashFingerprint({ cpuModel: 'x', primaryMac: 'A4:BB:6D:12:34:56' }),
    });
    expect(() =>
      issueLicense({ request, privateKeyPem: vendor.privateKeyPem, customer: { id: 'C', name: 'C' }, licenseType: 'PERPETUAL' }),
    ).toThrow(/too few stable machine identifiers/);
  });
});

describe('license verification (PRD §52 negative test cases)', () => {
  it('accepts a valid license with no Internet access involved', () => {
    const result = verifyLicense(text(issue()), ctx());
    expect(result.ok).toBe(true);
    expect(result.errorCode).toBeUndefined();
    expect(result.checks.filter((c) => c.status === 'PASS').map((c) => c.id)).toEqual([
      'INSTALLATION',
      'PLATFORM_INSTANCE',
      'LICENSE',
      'ENTITLEMENT',
      'AUTHORIZED',
      'BINDING',
    ]);
    expect(result.license?.entitlements.modules.map((m) => m.id)).toEqual(['ph', 'tlc']);
  });

  it('survives pretty-printing / re-serialization of the file', () => {
    const reformatted = JSON.stringify(JSON.parse(text(issue())));
    expect(verifyLicense(reformatted, ctx()).ok).toBe(true);
  });

  it('installation not verified → activation unavailable (E013)', () => {
    const r = verifyLicense(text(issue()), ctx({ installationVerified: false }));
    expect(r).toMatchObject({ ok: false, errorCode: LicenseErrorCode.INSTALLATION_NOT_VERIFIED });
    expect(r.checks.slice(1).every((c) => c.status === 'NOT_RUN')).toBe(true);
  });

  it('damaged platform identity → E015', () => {
    const r = verifyLicense(text(issue()), ctx({ platform: { ...platformA, instanceId: 'NXG-PLT-FFFF-FFFF' } }));
    expect(r.errorCode).toBe(LicenseErrorCode.PLATFORM_IDENTITY_INVALID);
  });

  it('corrupted license → rejected (E008)', () => {
    const t = text(issue());
    expect(verifyLicense(t.slice(0, t.length / 2), ctx()).errorCode).toBe(LicenseErrorCode.PACKAGE_CORRUPTED);
    const noSig = JSON.parse(t);
    delete noSig.signature;
    expect(verifyLicense(JSON.stringify(noSig), ctx()).errorCode).toBe(LicenseErrorCode.PACKAGE_CORRUPTED);
  });

  it('unsupported license format → E007', () => {
    const t = JSON.parse(text(issue()));
    expect(verifyLicense(JSON.stringify({ ...t, formatVersion: 2 }), ctx()).errorCode).toBe(
      LicenseErrorCode.UNSUPPORTED_FORMAT,
    );
    expect(verifyLicense(JSON.stringify({ hello: 'world' }), ctx()).errorCode).toBe(LicenseErrorCode.UNSUPPORTED_FORMAT);
  });

  it.each([
    ['extend expiry', (p: any) => (p.expiresAt = '2099-01-01T00:00:00.000Z')],
    ['add a module', (p: any) => p.entitlements.modules.push({ id: 'hptlc', expiresAt: null })],
    ['raise user limit', (p: any) => (p.limits.users = 999)],
    ['rebind to another platform', (p: any) => (p.platform.instanceUid = createPlatformIdentity().instanceUid)],
    ['lower the match threshold', (p: any) => (p.machineBinding.threshold = 0.01)],
  ])('modified certificate (%s) → signature failure (E005)', (_name, mutate) => {
    const t = JSON.parse(text(issue()));
    mutate(t.payload);
    expect(verifyLicense(JSON.stringify(t), ctx()).errorCode).toBe(LicenseErrorCode.INVALID_SIGNATURE);
  });

  it('license signed by an untrusted key → E005', () => {
    const attacker = generateSigningKeyPair();
    const forged = issue({ privateKeyPem: attacker.privateKeyPem });
    expect(verifyLicense(text(forged), ctx()).errorCode).toBe(LicenseErrorCode.INVALID_SIGNATURE);

    // Same keyId label but attacker's signature
    const relabelled = { ...forged, signature: { ...forged.signature, keyId: vendor.keyId } };
    expect(verifyLicense(JSON.stringify(relabelled), ctx()).errorCode).toBe(LicenseErrorCode.INVALID_SIGNATURE);
  });

  it('supports key rotation: licenses from any trusted key verify', () => {
    const next = generateSigningKeyPair();
    const keys = [...trustedKeys, { keyId: next.keyId, publicKeyPem: next.publicKeyPem }];
    expect(verifyLicense(text(issue({ privateKeyPem: next.privateKeyPem })), ctx({ trustedKeys: keys })).ok).toBe(true);
    expect(verifyLicense(text(issue()), ctx({ trustedKeys: keys })).ok).toBe(true);
  });

  it('activation code that does not match the package → E014', () => {
    const r = verifyLicense(text(issue()), ctx({ expectedActivationCode: generateActivationCode() }));
    expect(r.errorCode).toBe(LicenseErrorCode.CODE_MISMATCH);
  });

  it('missing platform entitlement → E002', () => {
    const lic = issue();
    const signed = signLicensePayload(
      { ...lic.payload, entitlements: { ...lic.payload.entitlements, platform: false } },
      vendor.privateKeyPem,
    );
    expect(verifyLicense(text(signed), ctx()).errorCode).toBe(LicenseErrorCode.PLATFORM_ENTITLEMENT_MISSING);
  });

  it('license for a different major version → E012', () => {
    expect(verifyLicense(text(issue({ versionMajor: 1 })), ctx()).errorCode).toBe(LicenseErrorCode.VERSION_NOT_COVERED);
    expect(verifyLicense(text(issue()), ctx({ platformVersion: '3.0.0' })).errorCode).toBe(
      LicenseErrorCode.VERSION_NOT_COVERED,
    );
  });

  it('expired license → rejected (E004)', () => {
    const lic = issue({ licenseType: 'SUBSCRIPTION', expiresAt: new Date(NOW.getTime() - 1000) });
    expect(verifyLicense(text(lic), ctx()).errorCode).toBe(LicenseErrorCode.LICENSE_EXPIRED);
  });

  it('subscription still within term → accepted', () => {
    const lic = issue({ licenseType: 'SUBSCRIPTION', expiresAt: new Date(NOW.getTime() + 300 * DAY) });
    expect(verifyLicense(text(lic), ctx()).ok).toBe(true);
  });

  it('license not yet valid → E003', () => {
    const lic = issue({ validFrom: new Date(NOW.getTime() + 2 * DAY) });
    expect(verifyLicense(text(lic), ctx()).errorCode).toBe(LicenseErrorCode.LICENSE_INACTIVE);
  });

  it('clock rolled back: blocks time-limited licenses (E009), only warns for perpetual', () => {
    const lastTrustedTime = new Date(NOW.getTime() + 30 * DAY); // we have seen a later date before
    const subscription = issue({ licenseType: 'SUBSCRIPTION', expiresAt: new Date(NOW.getTime() + 300 * DAY) });
    expect(verifyLicense(text(subscription), ctx({ lastTrustedTime })).errorCode).toBe(LicenseErrorCode.TIME_INTEGRITY);

    const perpetual = verifyLicense(text(issue()), ctx({ lastTrustedTime }));
    expect(perpetual.ok).toBe(true);
    expect(perpetual.warnings).toContain(LicenseErrorCode.TIME_INTEGRITY);
  });

  it('wrong Platform Instance → rejected (E006)', () => {
    const r = verifyLicense(text(issue()), ctx({ platform: createPlatformIdentity() }));
    expect(r.errorCode).toBe(LicenseErrorCode.WRONG_PLATFORM_INSTANCE);
  });

  it('license copied from PC A to PC B → rejected', () => {
    const pcB = verifyLicense(text(issue()), ctx({ platform: createPlatformIdentity(), fingerprint: hashFingerprint(PC_B) }));
    expect(pcB.ok).toBe(false);
    expect(pcB.errorCode).toBe(LicenseErrorCode.WRONG_PLATFORM_INSTANCE);

    // Even if someone also cloned the platform identity file onto PC B, the hardware binding catches it.
    const cloned = verifyLicense(text(issue()), ctx({ fingerprint: hashFingerprint(PC_B) }));
    expect(cloned.errorCode).toBe(LicenseErrorCode.HARDWARE_CHANGED);
  });

  it('minor hardware change (RAM upgrade / extra disk / new NIC) → remains valid', () => {
    expect(verifyLicense(text(issue()), ctx()).ok).toBe(true); // RAM is not part of the fingerprint
    const newNic = hashFingerprint({ ...PC_A, primaryMac: '11:22:33:44:55:66' });
    expect(verifyLicense(text(issue()), ctx({ fingerprint: newNic })).ok).toBe(true);
  });

  it('system disk replaced and Windows reinstalled → remains valid', () => {
    const fp = hashFingerprint({ ...PC_A, systemDiskSerial: 'NEWDISK999', osInstallId: 'new-install-guid' });
    expect(verifyLicense(text(issue()), ctx({ fingerprint: fp })).ok).toBe(true);
  });

  it('motherboard replacement → reactivation required (E011)', () => {
    const fp = hashFingerprint({
      ...PC_A,
      systemUuid: 'NEW-BOARD-UUID-0001',
      baseboardSerial: 'NEWBOARD123',
      primaryMac: 'DE:AD:BE:EF:00:01',
    });
    const r = verifyLicense(text(issue()), ctx({ fingerprint: fp }));
    expect(r.errorCode).toBe(LicenseErrorCode.HARDWARE_CHANGED);
    expect(r.fingerprint?.changed).toEqual(expect.arrayContaining(['systemUuid', 'baseboardSerial']));
  });

  it('module entitlements are present in the result but activation never depends on them', () => {
    const r = verifyLicense(text(issue({ modules: [] })), ctx());
    expect(r.ok).toBe(true);
    expect(r.license?.entitlements.modules).toEqual([]);
  });
});

describe('fingerprint normalization', () => {
  it('ignores firmware placeholder values', () => {
    const fp = hashFingerprint({ systemUuid: '00000000-0000-0000-0000-000000000000', baseboardSerial: 'To be filled by O.E.M.' });
    expect(fp).toEqual({});
  });

  it('scores motherboard swap below threshold and RAM upgrade at 100%', () => {
    const bound = hashFingerprint(PC_A);
    expect(matchFingerprint(bound, bound).score).toBe(1);
    expect(
      matchFingerprint(bound, hashFingerprint({ ...PC_A, systemUuid: 'X1', baseboardSerial: 'X2', primaryMac: 'X3' })).pass,
    ).toBe(false);
  });
});
