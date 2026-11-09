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

// ---------------------------------------------------------------------------
// Stable readings (NxGen Sense PhReadingStabilityTracker)
// ---------------------------------------------------------------------------

export interface StabilityRule {
  /** How long readings must stay settled. */
  windowMs: number;
  /** Largest spread (max − min) across the window that still counts as settled, in pH. */
  tolerance: number;
  /** A longer silence between readings breaks the run. */
  maxGapMs: number;
  /** Fewest readings in the window that can show a spread. */
  minSamples: number;
}

export const DEFAULT_STABILITY: StabilityRule = { windowMs: 5_000, tolerance: 0.01, maxGapMs: 15_000, minSamples: 2 };

export interface TimedReading {
  /** null: the instrument sent "nan" (no reading). */
  value: number | null;
  /** Arrival time, ms. */
  at: number;
}

export interface Stability {
  state: 'NO_READING' | 'UNSTABLE' | 'STABLE';
  /** Readings inside the window. */
  samples: number;
  /** How long the current unbroken run of readings has lasted, ms. */
  coveredMs: number;
  min: number | null;
  max: number | null;
  spread: number | null;
  /** The newest reading. */
  latest: number | null;
  /** Arrival of the oldest and newest reading in the window, ms. */
  from: number | null;
  to: number | null;
  rule: StabilityRule;
}

/** How long the readings the decision used span, ms. */
export const windowSpanMs = (s: Stability) => (s.from !== null && s.to !== null ? s.to - s.from : 0);

/**
 * Whether the live pH has settled: readings arriving without a break across
 * the whole window, and spread within the tolerance across it (from the last
 * reading at or before the window start to the newest). Conservative,
 * like NxGen Sense: unstable until a full window is covered, and any break
 * (no reading, a long gap, a clock going backwards, or a stream that stopped)
 * starts again.
 */
export function assessStability(readings: TimedReading[], now: number, rule: StabilityRule = DEFAULT_STABILITY): Stability {
  const empty = (state: Stability['state'], latest: number | null = null, coveredMs = 0): Stability => ({
    state, samples: 0, coveredMs, min: null, max: null, spread: null, latest, from: null, to: null, rule,
  });
  let run: { value: number; at: number }[] = [];
  let last: number | null = null;
  for (const r of readings) {
    if (last !== null && r.at === last) continue; // the same reading twice
    if (r.value === null || !Number.isFinite(r.value) || (last !== null && (r.at < last || r.at - last > rule.maxGapMs))) run = [];
    if (r.value !== null && Number.isFinite(r.value)) run.push({ value: r.value, at: r.at });
    last = r.at;
  }
  if (!run.length) return empty('NO_READING');
  const newest = run[run.length - 1];
  if (now - newest.at > rule.maxGapMs) return empty('NO_READING');
  // The window starts at the last reading at or before (newest − windowMs), so the
  // readings kept as evidence always span the whole window.
  const cutoff = newest.at - rule.windowMs;
  let anchor = -1;
  for (let i = 0; i < run.length; i++) if (run[i].at <= cutoff) anchor = i;
  const window = anchor >= 0 ? run.slice(anchor) : run;
  const values = window.map((r) => r.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.round((max - min) * 1e6) / 1e6;
  const coveredMs = newest.at - run[0].at;
  const stable = anchor >= 0 && window.length >= rule.minSamples && max - min <= rule.tolerance + 1e-9;
  return {
    state: stable ? 'STABLE' : 'UNSTABLE',
    samples: window.length,
    coveredMs,
    min,
    max,
    spread,
    latest: newest.value,
    from: window[0].at,
    to: newest.at,
    rule,
  };
}

// ---------------------------------------------------------------------------
// Measurement details (NxGen Sense: mandatory, approved characters only)
// ---------------------------------------------------------------------------

export interface MeasurementDetails {
  sampleId: string;
  batch: string;
  arNumber: string;
  product: string;
  remarks: string;
}

const SAFE_TEXT = /^[A-Za-z0-9 ._\-/#(),:+]*$/;
const DETAIL_FIELDS: [keyof MeasurementDetails, string, number][] = [
  ['sampleId', 'Sample ID', 80],
  ['batch', 'Batch / lot number', 80],
  ['arNumber', 'AR number', 80],
  ['product', 'Product', 120],
];

/** Problems per field ({} when valid). "NA" is not a value. */
export function validateDetails(d: MeasurementDetails): Partial<Record<keyof MeasurementDetails, string>> {
  const p: Partial<Record<keyof MeasurementDetails, string>> = {};
  for (const [key, label, max] of DETAIL_FIELDS) {
    const v = d[key].trim();
    if (!v || /^n\/?a$/i.test(v)) p[key] = `${label} is required.`;
    else if (v.length > max) p[key] = `${label}: at most ${max} characters.`;
    else if (!SAFE_TEXT.test(v)) p[key] = `${label}: use letters, numbers, spaces and . _ - / # ( ) , : + only.`;
  }
  if (d.remarks.length > 2000) p.remarks = 'Remarks: at most 2000 characters.';
  return p;
}
