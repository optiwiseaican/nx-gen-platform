import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import type { SecurityPolicy } from '../config/nxgen.config';

/**
 * Password hashing with scrypt (memory-hard, built into Node — no native
 * add-on to ship and qualify). Stored as:
 *   scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 * Parameters are stored with each hash so they can be raised later without
 * invalidating existing passwords.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 128 * N * R * 2;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: MAX_MEM * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Burn comparable time so unknown users are not distinguishable by timing.
    await derive(password, randomBytes(16), N, R, P);
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64'),
    Number(n),
    Number(r),
    Number(p),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Returns human-readable policy violations (empty = acceptable). */
export function checkPasswordPolicy(
  password: string,
  policy: SecurityPolicy,
  context: { username?: string; fullName?: string } = {},
): string[] {
  const problems: string[] = [];
  if (password.length < policy.passwordMinLength) {
    problems.push(`Use at least ${policy.passwordMinLength} characters.`);
  }
  if (password.length > 128) problems.push('Use at most 128 characters.');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 3) {
    problems.push(
      'Use at least three of: lowercase letters, uppercase letters, digits, symbols.',
    );
  }
  const lower = password.toLowerCase();
  if (
    context.username &&
    context.username.length >= 3 &&
    lower.includes(context.username.toLowerCase())
  ) {
    problems.push('The password must not contain the username.');
  }
  const nameParts = (context.fullName ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length >= 4);
  if (nameParts.some((part) => lower.includes(part)))
    problems.push('The password must not contain your name.');
  if (/^(.)\1+$/.test(password))
    problems.push('The password must not be a single repeated character.');
  return problems;
}

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;
