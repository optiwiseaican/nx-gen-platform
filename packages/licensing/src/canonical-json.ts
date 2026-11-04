/**
 * Deterministic JSON serialization used for everything that is signed.
 *
 * Signatures must be computed over bytes that every implementation reproduces
 * exactly, regardless of key insertion order or whitespace. For the value types
 * we allow (plain objects, arrays, strings, finite numbers, booleans, null) this
 * output matches RFC 8785 (JSON Canonicalization Scheme): keys sorted by UTF-16
 * code units, no insignificant whitespace, ECMAScript number formatting.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Canonical JSON: non-finite numbers are not allowed');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('Canonical JSON: only plain objects are allowed');
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
        .join(',')}}`;
    }
    default:
      throw new TypeError(`Canonical JSON: unsupported type "${typeof value}"`);
  }
}
