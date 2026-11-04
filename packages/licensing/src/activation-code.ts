import { randomInt } from 'crypto';

/**
 * User-facing activation codes: NXG-XXXX-XXXX-XXXX.
 *
 * The code is an identifier that selects the matching signed license package;
 * it is NOT the trust anchor (the Ed25519 signature on the .nxlic is). It uses
 * the Crockford Base32 alphabet (no I, L, O, U) so codes survive being read
 * aloud or retyped, and the last character is a Luhn mod-32 check character so
 * typos are caught inline before any license lookup happens.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_LENGTH = 11;
const PREFIX = 'NXG';

export const ACTIVATION_CODE_PATTERN = /^NXG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function luhnMod32(chars: string, includesCheck: boolean): number {
  let factor = includesCheck ? 1 : 2;
  let sum = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const codePoint = ALPHABET.indexOf(chars[i]);
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return sum % 32;
}

function format(chars12: string): string {
  return `${PREFIX}-${chars12.slice(0, 4)}-${chars12.slice(4, 8)}-${chars12.slice(8, 12)}`;
}

export function generateActivationCode(): string {
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i++) body += ALPHABET[randomInt(32)];
  const check = ALPHABET[(32 - luhnMod32(body, false)) % 32];
  return format(body + check);
}

export type ActivationCodeCheck =
  | { valid: true; code: string }
  | { valid: false; reason: 'EMPTY' | 'FORMAT' | 'CHECKSUM' };

/**
 * Normalizes user input (case, spaces, missing dashes, Crockford look-alikes)
 * and validates format + check character.
 */
export function parseActivationCode(input: string): ActivationCodeCheck {
  const raw = (input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (raw.length === 0) return { valid: false, reason: 'EMPTY' };
  if (!raw.startsWith(PREFIX)) return { valid: false, reason: 'FORMAT' };

  const body = raw
    .slice(PREFIX.length)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (body.length !== BODY_LENGTH + 1 || [...body].some((c) => !ALPHABET.includes(c))) {
    return { valid: false, reason: 'FORMAT' };
  }
  if (luhnMod32(body, true) !== 0) return { valid: false, reason: 'CHECKSUM' };
  return { valid: true, code: format(body) };
}
