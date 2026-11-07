/**
 * pH module logic shared by its API and its screens: packet decoding (LabApp
 * protocol) and the calibration calculation. The API result is the one that
 * is stored; the screen uses the same code for its live preview.
 */

export type Outcome = 'PASS' | 'WARNING' | 'FAIL';
export type PacketKind = 'MEASUREMENT' | 'CALIBRATION' | 'STATUS' | 'LOG' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface PhReading {
  bufferPh: number;
  mv: number;
}

/** LabApp default acceptance profile (CalibrationLimitProfileStore). */
export interface PhLimits {
  slopePassMin: number;
  slopePassMax: number;
  slopeWarnMin: number;
  slopeWarnMax: number;
  offsetPassMaxAbs: number;
  offsetWarnMaxAbs: number;
}

export const DEFAULT_PH_LIMITS: PhLimits = {
  slopePassMin: 95,
  slopePassMax: 105,
  slopeWarnMin: 92,
  slopeWarnMax: 108,
  offsetPassMaxAbs: 30,
  offsetWarnMaxAbs: 45,
};

export interface PhResult {
  slopeMvPerPh: number;
  nernstMvPerPh: number;
  slopePercent: number;
  offsetMv: number;
  rSquared: number;
  slopeOutcome: Outcome;
  offsetOutcome: Outcome;
  outcome: Outcome;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** RT·ln(10)/F in mV per pH at `celsius`: 59.16 mV at 25 °C. */
export const nernstSlope = (celsius: number) => 0.1984126 * (celsius + 273.15);

const worst = (...o: Outcome[]): Outcome => (o.includes('FAIL') ? 'FAIL' : o.includes('WARNING') ? 'WARNING' : 'PASS');

export function computePh(readings: PhReading[], celsius: number, limits: PhLimits = DEFAULT_PH_LIMITS): PhResult {
  const n = readings.length;
  const mx = readings.reduce((s, r) => s + r.bufferPh, 0) / n;
  const my = readings.reduce((s, r) => s + r.mv, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const r of readings) {
    sxx += (r.bufferPh - mx) ** 2;
    sxy += (r.bufferPh - mx) * (r.mv - my);
    syy += (r.mv - my) ** 2;
  }
  const slope = sxy / sxx;
  const nernst = nernstSlope(celsius);
  const slopePercent = (Math.abs(slope) / nernst) * 100;
  const offsetMv = my - slope * mx + slope * 7;
  const rSquared = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  // A positive slope means the electrode response is inverted: always a failure.
  const slopeOutcome: Outcome =
    slope >= 0
      ? 'FAIL'
      : slopePercent >= limits.slopePassMin && slopePercent <= limits.slopePassMax
        ? 'PASS'
        : slopePercent >= limits.slopeWarnMin && slopePercent <= limits.slopeWarnMax
          ? 'WARNING'
          : 'FAIL';
  const absOffset = Math.abs(offsetMv);
  const offsetOutcome: Outcome =
    absOffset <= limits.offsetPassMaxAbs ? 'PASS' : absOffset <= limits.offsetWarnMaxAbs ? 'WARNING' : 'FAIL';
  return {
    slopeMvPerPh: round(slope, 3),
    nernstMvPerPh: round(nernst, 3),
    slopePercent: round(slopePercent, 2),
    offsetMv: round(offsetMv, 2),
    rSquared: round(rSquared, 5),
    slopeOutcome,
    offsetOutcome,
    outcome: worst(slopeOutcome, offsetOutcome),
  };
}

/** Problems that make a set of readings unusable for a calibration, or []. */
export function validateReadings(readings: PhReading[], celsius: number | null): string[] {
  const p: string[] = [];
  if (celsius === null || !Number.isFinite(celsius) || celsius < 0 || celsius > 100) p.push('Enter the buffer temperature (0–100 °C).');
  if (readings.length < 2 || readings.length > 5) p.push('Use 2 to 5 buffers.');
  for (const [i, r] of readings.entries())
    if (!Number.isFinite(r.bufferPh) || r.bufferPh < 0 || r.bufferPh > 14 || !Number.isFinite(r.mv) || Math.abs(r.mv) > 1000)
      p.push(`Buffer ${i + 1}: pH 0–14 and potential within ±1000 mV.`);
  if (new Set(readings.map((r) => r.bufferPh)).size !== readings.length) p.push('Each buffer must have a different pH.');
  if (readings.length >= 2) {
    const ph = readings.map((r) => r.bufferPh);
    if (Math.max(...ph) - Math.min(...ph) < 2) p.push('Buffers must span at least 2 pH units.');
  }
  return p;
}

// ---------------------------------------------------------------------------
// Packets (LabApp WEBSOCKET_PROTOCOL_DOCUMENTATION.md; same JSON over the USB dongle)
// ---------------------------------------------------------------------------

const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MEASUREMENT = ['PH_VAL', 'TEMP_VAL', 'EC_VAL'];
const STATUS = ['BATTERY', 'ATC', 'ATC_AT'];
const CALIBRATION = /^(MV_[1-5]|POST_VAL_[1-5]|SLOPE(_[1-4])?|OFFSET|DT_[1-5])$/;

export interface DecodedPacket {
  kind: PacketKind;
  /** Numeric fields; "nan" and a disconnected temperature sensor (≤ -127) become null. */
  values: Record<string, number | null>;
  /** DT_n timestamps as sent. */
  text: Record<string, string>;
  unknownKeys: string[];
}

export type DecodeResult = { ok: true; packet: DecodedPacket } | { ok: false; reason: string };

export function decodePacket(fields: Record<string, string | number>): DecodeResult {
  const values: Record<string, number | null> = {};
  const text: Record<string, string> = {};
  const unknownKeys: string[] = [];
  let calibration = false;
  let status = false;
  let measurement = false;
  let log = false;
  for (const [key, raw] of Object.entries(fields)) {
    const v = String(raw).trim();
    if (/^DT_[1-5]$/.test(key)) {
      if (!DATE_TIME.test(v)) return { ok: false, reason: `${key} is not "yyyy-MM-dd HH:mm:ss"` };
      text[key] = v;
      calibration = true;
      continue;
    }
    const known = MEASUREMENT.includes(key) || STATUS.includes(key) || CALIBRATION.test(key) || key === 'LOG';
    if (!known) {
      unknownKeys.push(key);
      continue;
    }
    let n: number | null;
    if (v.toLowerCase() === 'nan') n = null;
    else if (NUMBER.test(v)) n = Number(v);
    else return { ok: false, reason: `${key} is not a number` };
    if (key === 'TEMP_VAL' && n !== null && n <= -127) n = null;
    if (key === 'PH_VAL' && n !== null && (n < 0 || n > 14)) return { ok: false, reason: 'PH_VAL outside 0–14' };
    if (key === 'BATTERY' && n !== null && (n < 0 || n > 100)) return { ok: false, reason: 'BATTERY outside 0–100' };
    values[key] = n;
    if (MEASUREMENT.includes(key)) measurement = true;
    else if (STATUS.includes(key)) status = true;
    else if (key === 'LOG') log = true;
    else calibration = true;
  }
  const kind: PacketKind = calibration ? 'CALIBRATION' : log ? 'LOG' : status ? 'STATUS' : measurement ? 'MEASUREMENT' : 'UNKNOWN';
  if (kind === 'UNKNOWN') return { ok: false, reason: 'No pH fields in the packet' };
  return { ok: true, packet: { kind, values, text, unknownKeys } };
}

/** Readings for a calibration from MV_n slots and a buffer set (slot → pH). */
export function readingsFromSlots(mv: Record<number, number>, buffers: Record<string, number>): (PhReading & { buffer: number })[] {
  return Object.entries(mv)
    .map(([slot, value]) => ({ buffer: Number(slot), bufferPh: buffers[slot], mv: value }))
    .filter((r) => typeof r.bufferPh === 'number')
    .sort((a, b) => a.buffer - b.buffer);
}

export function display(r: PhResult, temperatureC: number) {
  return [
    { label: 'Slope', value: `${r.slopePercent.toFixed(2)} % (${r.slopeMvPerPh.toFixed(2)} of ${r.nernstMvPerPh.toFixed(2)} mV/pH)` },
    { label: 'Offset at pH 7', value: `${r.offsetMv.toFixed(2)} mV` },
    { label: 'Fit r²', value: r.rSquared.toFixed(5) },
    { label: 'Temperature', value: `${temperatureC} °C` },
  ];
}
