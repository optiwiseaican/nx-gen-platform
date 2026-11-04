import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, KeyObject } from 'crypto';

/**
 * Ed25519 signing (Technical Architecture §2).
 *
 * The private key lives only in the vendor License Authority. Customer
 * installations ship trusted PUBLIC keys only (NX-LIC-SEC-002/003). Every
 * signature carries a keyId so signing keys can be rotated without breaking
 * licenses issued under older keys.
 */
export interface TrustedKey {
  keyId: string;
  publicKeyPem: string;
  label?: string;
}

export interface SigningKeyPair {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function assertEd25519(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Expected an Ed25519 key, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }
}

export function computeKeyId(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  assertEd25519(key);
  const der = key.export({ type: 'spki', format: 'der' });
  return `nxk-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { keyId: computeKeyId(publicKeyPem), publicKeyPem, privateKeyPem };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
}

/** Domain-separated message so a license signature can never be replayed as a module-package signature. */
export function signingMessage(domain: string, canonicalPayload: string): Buffer {
  return Buffer.concat([Buffer.from(`${domain}\n`, 'utf8'), Buffer.from(canonicalPayload, 'utf8')]);
}

export function signMessage(message: Buffer, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  assertEd25519(key);
  return sign(null, message, key).toString('base64');
}

export function verifyMessage(message: Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64) return false;
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
