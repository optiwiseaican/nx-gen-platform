/**
 * AICAN instrument serial framing, as forwarded by the USB dongle: one flat
 * JSON object per line with string or number values and a DEVICE_ID
 * (same packets as the LabApp WebSocket application). The core checks only
 * this envelope; the meaning of the fields belongs to the module that
 * provides the instrument type.
 */
export const MAX_LINE = 4096;
export const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

export type EnvelopeResult =
  | {
      ok: true;
      deviceIdentifier: string;
      fields: Record<string, string | number>;
    }
  | { ok: false; reason: string; deviceIdentifier?: string };

/** One command line for an instrument, in the same framing as its packets. */
export function encodeCommand(
  deviceIdentifier: string,
  fields: Record<string, string | number>,
): { ok: true; line: string } | { ok: false; reason: string } {
  if (!IDENTIFIER.test(deviceIdentifier))
    return { ok: false, reason: 'Invalid DEVICE_ID' };
  const entries = Object.entries(fields);
  if (!entries.length) return { ok: false, reason: 'Command has no fields' };
  for (const [k, v] of entries) {
    if (k === 'DEVICE_ID' || !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k))
      return { ok: false, reason: `Invalid field name ${k.slice(0, 40)}` };
    if (typeof v !== 'string' && !Number.isFinite(v))
      return { ok: false, reason: `Field ${k} is not a string or number` };
  }
  const line = JSON.stringify({ ...fields, DEVICE_ID: deviceIdentifier });
  if (line.length > MAX_LINE)
    return { ok: false, reason: 'Command longer than 4096 characters' };
  return { ok: true, line };
}

export function parseEnvelope(line: string): EnvelopeResult {
  if (line.length > MAX_LINE)
    return { ok: false, reason: 'Packet longer than 4096 characters' };
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'Not valid JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    return { ok: false, reason: 'Not a JSON object' };
  const record = obj as Record<string, unknown>;
  const id = record.DEVICE_ID;
  if (typeof id !== 'string' || !IDENTIFIER.test(id))
    return { ok: false, reason: 'Missing or invalid DEVICE_ID' };
  const fields: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'DEVICE_ID') continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k))
      return {
        ok: false,
        reason: `Invalid field name ${k.slice(0, 40)}`,
        deviceIdentifier: id,
      };
    if (
      typeof v !== 'string' &&
      typeof v !== 'number' &&
      typeof v !== 'boolean'
    )
      return {
        ok: false,
        reason: `Field ${k} is not a string, number or boolean`,
        deviceIdentifier: id,
      };
    // Status packets send flags as JSON booleans; the raw packet keeps the original.
    fields[k] = typeof v === 'boolean' ? String(v) : v;
  }
  if (!Object.keys(fields).length)
    return {
      ok: false,
      reason: 'Packet has no data fields',
      deviceIdentifier: id,
    };
  return { ok: true, deviceIdentifier: id, fields };
}
