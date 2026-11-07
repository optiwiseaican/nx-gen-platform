import {
  createRecoveryRequest,
  encodeRecoveryRequest,
  generateSigningKeyPair,
  issueRecoveryResponse,
  parseRecoveryRequest,
  verifyRecoveryResponse,
} from '..';

const NOW = new Date('2026-11-07T10:00:00.000Z');
const vendor = generateSigningKeyPair();
const trusted = [{ keyId: vendor.keyId, publicKeyPem: vendor.publicKeyPem }];
const platform = { instanceId: 'NXG-PLT-1182-58B8', instanceUid: '0b4c6c1e-9a52-4f43-8a39-2f0f6a6b1c11' };

function setup() {
  const request = createRecoveryRequest({ platform, username: 'vishal', now: NOW });
  const expected = {
    requestId: request.requestId,
    platformInstanceUid: platform.instanceUid,
    username: 'vishal',
    nonce: request.nonce,
  };
  return { request, expected };
}

describe('administrator recovery codes', () => {
  it('round-trips a request code and tolerates line breaks from email', () => {
    const { request } = setup();
    const code = encodeRecoveryRequest(request);
    expect(code).toMatch(/^NXRQ1\./);
    const wrapped = code.replace(/(.{40})/g, '$1\n');
    expect(parseRecoveryRequest(wrapped)).toEqual(request);
    expect(() => parseRecoveryRequest(code.slice(0, -1) + 'x')).toThrow(/mistyped/);
  });

  it('accepts a vendor-signed response for exactly this request', () => {
    const { request, expected } = setup();
    const code = issueRecoveryResponse({
      request,
      privateKeyPem: vendor.privateKeyPem,
      supportReference: 'SUP-2026-0042',
      issuedBy: 'AICAN Support',
      now: NOW,
    });
    const r = verifyRecoveryResponse(code, expected, trusted, new Date(NOW.getTime() + 60_000));
    expect(r).toMatchObject({ ok: true, payload: { supportReference: 'SUP-2026-0042' } });
  });

  it('rejects untrusted keys, tampering, other requests and expired responses', () => {
    const { request, expected } = setup();
    const issue = (privateKeyPem = vendor.privateKeyPem, validHours?: number) =>
      issueRecoveryResponse({ request, privateKeyPem, supportReference: 'SUP-1', issuedBy: 'AICAN Support', validHours, now: NOW });

    const rogue = generateSigningKeyPair();
    expect(verifyRecoveryResponse(issue(rogue.privateKeyPem), expected, trusted, NOW)).toMatchObject({
      ok: false,
      reason: 'UNTRUSTED_KEY',
    });

    // Re-encode with a changed username but the original signature.
    const code = issue();
    const body = JSON.parse(Buffer.from(code.split('.')[1], 'base64url').toString());
    body.payload.username = 'someone.else';
    const { canonicalize } = jest.requireActual('..');
    const b = Buffer.from(canonicalize(body)).toString('base64url');
    const { createHash } = jest.requireActual('crypto');
    const forged = `NXRS1.${b}.${createHash('sha256').update(b).digest('hex').slice(0, 8)}`;
    expect(verifyRecoveryResponse(forged, expected, trusted, NOW)).toMatchObject({ ok: false, reason: 'BAD_SIGNATURE' });

    expect(verifyRecoveryResponse(code, { ...expected, nonce: '0'.repeat(32) }, trusted, NOW)).toMatchObject({
      ok: false,
      reason: 'MISMATCH',
    });
    expect(verifyRecoveryResponse(issue(undefined, 1), expected, trusted, new Date(NOW.getTime() + 2 * 3_600_000))).toMatchObject({
      ok: false,
      reason: 'EXPIRED',
    });
    expect(verifyRecoveryResponse('NXRS1.abc.def', expected, trusted, NOW)).toMatchObject({ ok: false, reason: 'FORMAT' });
  });

  it('a license signature can never be replayed as a recovery response (domain separation)', () => {
    // Signing the same bytes under the license domain yields a signature the recovery verifier rejects.
    const { request, expected } = setup();
    const code = issueRecoveryResponse({ request, privateKeyPem: vendor.privateKeyPem, supportReference: 'SUP-1', issuedBy: 'AICAN', now: NOW });
    const body = JSON.parse(Buffer.from(code.split('.')[1], 'base64url').toString());
    const { signMessage, signingMessage, canonicalize } = jest.requireActual('..');
    body.signature.value = signMessage(signingMessage('NXGEN-LICENSE-v1', canonicalize(body.payload)), vendor.privateKeyPem);
    const b = Buffer.from(canonicalize(body)).toString('base64url');
    const { createHash } = jest.requireActual('crypto');
    const replay = `NXRS1.${b}.${createHash('sha256').update(b).digest('hex').slice(0, 8)}`;
    expect(verifyRecoveryResponse(replay, expected, trusted, NOW)).toMatchObject({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses to issue for an expired request', () => {
    const { request } = setup();
    expect(() =>
      issueRecoveryResponse({
        request,
        privateKeyPem: vendor.privateKeyPem,
        supportReference: 'SUP-1',
        issuedBy: 'AICAN',
        now: new Date(NOW.getTime() + 25 * 3_600_000),
      }),
    ).toThrow(/expired/);
  });
});
