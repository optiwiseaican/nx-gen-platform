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
  /** Largest permitted difference between the meter's reading and the buffer, pH. Applies to guided calibrations. */
  deviationMaxPh: number;
}

export const DEFAULT_PH_LIMITS: PhLimits = {
  slopePassMin: 95,
  slopePassMax: 105,
  slopeWarnMin: 92,
  slopeWarnMax: 108,
  offsetPassMaxAbs: 30,
  offsetWarnMaxAbs: 45,
  deviationMaxPh: 0.05,
};

/** What the limits themselves may be set to (NxGen Sense AcceptanceProfileValidator). */
export const LIMIT_BOUNDS = { slopeMin: 50, slopeMax: 150, offsetMax: 200, deviationMin: 0.01, deviationMax: 2 };

const LIMIT_KEYS: (keyof PhLimits)[] = ['slopePassMin', 'slopePassMax', 'slopeWarnMin', 'slopeWarnMax', 'offsetPassMaxAbs', 'offsetWarnMaxAbs', 'deviationMaxPh'];

/** Limits from untrusted input; a value that is not a number becomes NaN and fails validateLimits. */
export function parseLimits(input: unknown): PhLimits {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const read = (k: keyof PhLimits) => {
    const v = o[k];
    return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  };
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, read(k)])) as unknown as PhLimits;
}

/** Problems with a set of limits, each a sentence the editor can act on, or []. */
export function validateLimits(l: PhLimits): string[] {
  if (LIMIT_KEYS.some((k) => !Number.isFinite(l[k]))) return ['Enter a number for every limit.'];
  const p: string[] = [];
  if (LIMIT_KEYS.some((k) => Math.abs(l[k] * 100 - Math.round(l[k] * 100)) > 1e-6)) p.push('Use at most two decimals.');
  const { slopeMin, slopeMax, offsetMax } = LIMIT_BOUNDS;
  if (l.slopeWarnMin < slopeMin || l.slopeWarnMax > slopeMax) p.push(`Slope limits must stay within ${slopeMin}–${slopeMax} %.`);
  if (l.slopePassMin >= l.slopePassMax) p.push('The slope pass minimum must be below the pass maximum.');
  if (l.slopeWarnMin > l.slopePassMin || l.slopeWarnMax < l.slopePassMax) p.push('The slope warning range must include the pass range.');
  if (l.offsetPassMaxAbs < 0 || l.offsetWarnMaxAbs > offsetMax) p.push(`Offset limits must stay within 0–${offsetMax} mV.`);
  if (l.offsetPassMaxAbs > l.offsetWarnMaxAbs) p.push('The offset warning limit cannot be below the pass limit.');
  if (l.deviationMaxPh < LIMIT_BOUNDS.deviationMin || l.deviationMaxPh > LIMIT_BOUNDS.deviationMax) p.push(`The deviation limit must be ${LIMIT_BOUNDS.deviationMin}–${LIMIT_BOUNDS.deviationMax} pH.`);
  return p;
}

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

export const worst = (...o: Outcome[]): Outcome => (o.includes('FAIL') ? 'FAIL' : o.includes('WARNING') ? 'WARNING' : 'PASS');

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
// Packets (the keys the current NxGen Sense app and meter use; same JSON over the USB dongle)
// ---------------------------------------------------------------------------

const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** Other spellings the app accepts for the same value (PHActivity2.parseTelemetry). */
const ALIASES: Record<string, string> = {
  PH: 'PH_VAL', ph: 'PH_VAL', pH: 'PH_VAL', CAL_PH: 'PH_VAL', CAL_VAL: 'PH_VAL',
  TEMP: 'TEMP_VAL', temp: 'TEMP_VAL', temperature: 'TEMP_VAL', CAL_TEMP: 'TEMP_VAL',
  MV: 'MV_VAL', mv: 'MV_VAL', CAL_MV: 'MV_VAL',
  BATTERY_PERCENT: 'BATTERY', BATTERY_LEVEL: 'BATTERY', BAT_PCT: 'BATTERY',
  IS_STABLE: 'STABLE', stability: 'STABLE',
};
const MEASUREMENT = ['PH_VAL', 'TEMP_VAL', 'EC_VAL', 'MV_VAL'];
const FLAGS = ['ATC', 'IS_CHARGING', 'PROBE_CONNECTED', 'TEMP_SENSOR_CONNECTED'];
const STATUS = ['BATTERY', 'ATC_AT', ...FLAGS];
const STATUS_TEXT = ['CHARGING_STATUS', 'DEVICE_STATUS', 'CURRENT_USER'];
const CALIBRATION = /^(CAL|B_[1-5]|MV_[1-5]|POST_VAL_[1-5]|SLOPE(_[1-4])?|OFFSET|DT_[1-5])$/;

export const isCalibrationKey = (key: string) => CALIBRATION.test(key);
/** Fields that describe the meter's state; a change in one is worth keeping. */
export const isStatusKey = (key: string) => STATUS.includes(key) || STATUS_TEXT.includes(key);

function flag(text: string): number | undefined {
  const v = text.toLowerCase();
  if (['1', '1.0', 'true', 'on', 'yes', 'enable', 'enabled'].includes(v)) return 1;
  if (['0', '0.0', 'false', 'off', 'no', 'disable', 'disabled'].includes(v)) return 0;
  return undefined;
}

export interface DecodedPacket {
  kind: PacketKind;
  /** Numeric fields, under their canonical names; flags are 1 or 0; "nan" and a disconnected temperature sensor (≤ -127) become null. */
  values: Record<string, number | null>;
  /** DT_n timestamps and status text, as sent. */
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
  for (const [sent, raw] of Object.entries(fields)) {
    const key = ALIASES[sent] ?? sent;
    let v = String(raw).trim();
    if (/^DT_[1-5]$/.test(key)) {
      if (!DATE_TIME.test(v)) return { ok: false, reason: `${key} is not "yyyy-MM-dd HH:mm:ss"` };
      text[key] = v;
      calibration = true;
      continue;
    }
    if (STATUS_TEXT.includes(key)) {
      text[key] = v;
      status = true;
      continue;
    }
    const control = key === 'LOG' || key === 'HOLD';
    const known = MEASUREMENT.includes(key) || STATUS.includes(key) || CALIBRATION.test(key) || control || key === 'STABLE';
    if (!known) {
      unknownKeys.push(sent);
      continue;
    }
    if (key === 'BATTERY') v = v.replace(/%$/, '').trim();
    let n: number | null;
    if (v.toLowerCase() === 'nan') n = null;
    else if (key === 'STABLE') n = ['1', 'true', 'stable'].includes(v.toLowerCase()) ? 1 : 0;
    else if (FLAGS.includes(key)) {
      const f = flag(v);
      if (f === undefined) return { ok: false, reason: `${key} is not on or off` };
      n = f;
    } else if (NUMBER.test(v)) n = Number(v);
    else return { ok: false, reason: `${key} is not a number` };
    if (key === 'TEMP_VAL' && n !== null && n <= -127) n = null;
    if (key === 'PH_VAL' && n !== null && (n < 0 || n > 14)) return { ok: false, reason: 'PH_VAL outside 0–14' };
    if (key === 'BATTERY' && n !== null && (n < 0 || n > 100)) return { ok: false, reason: 'BATTERY outside 0–100' };
    values[key] = n;
    if (MEASUREMENT.includes(key)) measurement = true;
    else if (STATUS.includes(key)) status = true;
    else if (control) {
      if (n === 1) log = true;
      else status = true;
    } else if (key !== 'STABLE') calibration = true;
  }
  // Live frames also carry BATTERY, so a reading outranks status.
  const kind: PacketKind = calibration ? 'CALIBRATION' : log ? 'LOG' : measurement ? 'MEASUREMENT' : status ? 'STATUS' : 'UNKNOWN';
  if (kind === 'UNKNOWN') return { ok: false, reason: 'No pH fields in the packet' };
  return { ok: true, packet: { kind, values, text, unknownKeys } };
}

// ---------------------------------------------------------------------------
// Commands to the meter (value types as the app sends them: some numbers, some text)
// ---------------------------------------------------------------------------

export type PhCommand = Record<string, string | number>;

function calibrationPoint(point: number): number {
  if (!Number.isInteger(point) || point < 1 || point > 5) throw new RangeError('Calibration point must be 1 to 5.');
  return point;
}

export const phCommands = {
  /** Start measuring buffer `point` (send calibrationBuffer straight after, and repeat it while measuring). */
  calibrationStart: (point: number): PhCommand => ({ CAL: calibrationPoint(point) * 10 }),
  calibrationBuffer: (point: number, bufferPh: number): PhCommand => ({ [`B_${calibrationPoint(point)}`]: bufferPh.toFixed(2) }),
  /** Send before calibrationCapture; `at` is "yyyy-MM-dd HH:mm:ss". */
  calibrationTimestamp: (point: number, at: string): PhCommand => ({ [`DT_${calibrationPoint(point)}`]: at }),
  calibrationCapture: (point: number): PhCommand => ({ CAL: calibrationPoint(point) * 10 + 1 }),
  calibrationReset: (): PhCommand => ({ CAL: '0' }),
  calibrationSave: (): PhCommand => ({ CAL_SAVE: '1' }),
  atc: (enabled: boolean): PhCommand => ({ ATC: enabled ? 1 : 0 }),
  /** ATC reference temperature, °C. */
  atcReference: (celsius: number): PhCommand => ({ R_C: celsius }),
  thermistor: (type: 'NTC' | 'PTC'): PhCommand => ({ THERM_VAL: type === 'NTC' ? '0' : '1' }),
  logOnStable: (): PhCommand => ({ LOG: '1' }),
  logOnDeviceButton: (): PhCommand => ({ LOG: '3' }),
  logEveryMinutes: (minutes: number): PhCommand => ({ LOG_INTERVAL: minutes.toFixed(4), LOG: '2' }),
  logStop: (): PhCommand => ({ LOG: '0', HOLD: '0' }),
  /** Re-arm "log on stable" after a HOLD was logged. */
  holdReset: (): PhCommand => ({ HOLD: '0' }),
};

/** Reads a CAL value from the meter: n×10 measuring buffer n, n×10+1 buffer n captured, 0 reset. */
export function readCalCode(code: number | null | undefined): { point: number; phase: 'MEASURING' | 'CAPTURED' } | null {
  if (typeof code !== 'number' || !Number.isInteger(code)) return null;
  const point = Math.floor(code / 10);
  const phase = code % 10;
  if (point < 1 || point > 5 || (phase !== 0 && phase !== 1)) return null;
  return { point, phase: phase === 0 ? 'MEASURING' : 'CAPTURED' };
}

// ---------------------------------------------------------------------------
// Guided calibration settings and checks
// ---------------------------------------------------------------------------

export interface CalibrationSettings {
  pointCount: 3 | 5;
  timerSeconds: number;
  /** Refuse a point whose reading the meter did not report as stable. Off, as in NxGen Sense. */
  requireStable: boolean;
  /** Meter slot (1–5) to buffer pH. */
  buffers: Record<number, number>;
}

export const DEFAULT_CALIBRATION_SETTINGS: CalibrationSettings = {
  pointCount: 5,
  timerSeconds: 60,
  requireStable: false,
  buffers: { 1: 1.68, 2: 4.01, 3: 7, 4: 10.01, 5: 12.45 },
};

/** The meter slots a calibration uses: a 3-point calibration uses the middle three. */
export const calibrationSlots = (pointCount: 3 | 5): number[] => (pointCount === 3 ? [2, 3, 4] : [1, 2, 3, 4, 5]);

export function parseCalibrationSettings(input: unknown): { settings: CalibrationSettings; problems: string[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const pointCount = Number(o.pointCount);
  if (pointCount !== 3 && pointCount !== 5) problems.push('Choose 3 or 5 points.');
  const timerSeconds = Number(o.timerSeconds);
  if (!Number.isInteger(timerSeconds) || timerSeconds < 5 || timerSeconds > 600) problems.push('The timer must be 5 to 600 whole seconds.');
  if (typeof o.requireStable !== 'boolean') problems.push('Say whether a stable reading is required.');
  const raw = (o.buffers && typeof o.buffers === 'object' ? o.buffers : {}) as Record<string, unknown>;
  const buffers: Record<number, number> = {};
  for (const slot of [1, 2, 3, 4, 5]) {
    const v = raw[slot];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
    if (!Number.isFinite(n) || n < 0 || n > 14) problems.push(`Buffer ${slot} must be a pH from 0 to 14.`);
    buffers[slot] = n;
  }
  if (new Set(Object.values(buffers)).size !== 5) problems.push('Each buffer must have a different pH.');
  return { settings: { pointCount: pointCount as 3 | 5, timerSeconds, requireStable: o.requireStable === true, buffers }, problems };
}

export const MIN_CALIBRATION_BATTERY = 20;

export interface PreCheck {
  label: string;
  /** FAIL blocks the calibration; WARN must be acknowledged. */
  result: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  /** The alert raised when this check does not pass. */
  alertCode: string;
}

/** NxGen Sense PreCalibrationDiagnosticPolicy, from what the meter itself reports. */
export function preCalibrationChecks(m: { assignmentProblem: string | null; hasIdentifier: boolean; online: boolean; battery: number | null | undefined; probe: number | null | undefined; sensor: number | null | undefined; temperature: number | null | undefined }): PreCheck[] {
  const part = (label: string, connected: number | null | undefined, alertCode: string): PreCheck =>
    connected === 0 ? { label, result: 'FAIL', detail: 'The meter reports it is disconnected.', alertCode } : { label, result: 'PASS', detail: connected === 1 ? 'Connected' : 'Not reported by this meter', alertCode };
  const temperatureOk = m.online && m.sensor !== 0 && typeof m.temperature === 'number';
  return [
    { label: 'Instrument ID', result: m.hasIdentifier ? 'PASS' : 'FAIL', detail: m.hasIdentifier ? 'Set' : 'Set the DEVICE_ID on the instrument record.', alertCode: 'PH-PRECAL-DEVICE-ID-MISSING' },
    { label: 'Probe and sensor', result: m.assignmentProblem ? 'FAIL' : 'PASS', detail: m.assignmentProblem ?? 'Assigned', alertCode: 'PH-PRECAL-PROBE-ID-MISSING' },
    { label: 'Connection', result: m.online ? 'PASS' : 'FAIL', detail: m.online ? 'Receiving data' : 'No data from the meter.', alertCode: 'PH-PRECAL-DEVICE-NOT-CONNECTED' },
    part('pH probe', m.probe, 'PH-PRECAL-PROBE-NOT-CONNECTED'),
    part('Temperature sensor', m.sensor, 'PH-PRECAL-TEMP-SENSOR-NOT-CONNECTED'),
    { label: 'Temperature reading', result: temperatureOk ? 'PASS' : 'FAIL', detail: temperatureOk ? `${m.temperature} °C` : 'The meter is not sending a temperature.', alertCode: 'PH-PRECAL-TEMP-SENSOR-NOT-CONNECTED' },
    !m.online || typeof m.battery !== 'number'
      ? { label: 'Battery', result: 'WARN', detail: `Level unavailable (minimum ${MIN_CALIBRATION_BATTERY} %).`, alertCode: 'PH-PRECAL-BATTERY-LOW' }
      : m.battery >= MIN_CALIBRATION_BATTERY
        ? { label: 'Battery', result: 'PASS', detail: `${m.battery} %`, alertCode: 'PH-PRECAL-BATTERY-LOW' }
        : { label: 'Battery', result: 'WARN', detail: `${m.battery} %, below the recommended ${MIN_CALIBRATION_BATTERY} %.`, alertCode: 'PH-PRECAL-BATTERY-LOW' },
  ];
}

// ---------------------------------------------------------------------------
// Logging (NxGen Sense PH2 logs)
// ---------------------------------------------------------------------------

export type LogMode = 'STABLE' | 'BUTTON' | 'INTERVAL';
export type LogMethod = LogMode | 'MANUAL';

export const LOG_METHOD_LABEL: Record<LogMethod, string> = { MANUAL: 'Manual', STABLE: 'On stable', BUTTON: 'Device button', INTERVAL: 'At interval' };
export const MIN_LOG_INTERVAL_S = 1;
export const MAX_LOG_INTERVAL_S = 86_400;
/** The meter can resend the same frame; a repeat this soon is one trigger. */
export const LOG_DEBOUNCE_MS = 1_500;

/** Whether a packet from the meter should create a log entry in this mode. */
export function isLogTrigger(mode: LogMode, values: Record<string, number | null>): boolean {
  if (mode === 'STABLE') return values.HOLD === 1 || (values.STABLE === 1 && 'HOLD' in values);
  if (mode === 'BUTTON') return values.LOG === 1;
  return false;
}

export interface LogDetails {
  batch: string;
  arNumber: string;
  product: string;
}

export function parseLogDetails(input: unknown): { details: LogDetails; problems: string[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const text = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const details = { batch: text('batch'), arNumber: text('arNumber'), product: text('product') };
  const problems: string[] = [];
  if (details.batch.length > 80) problems.push('The batch can be at most 80 characters.');
  if (details.arNumber.length > 80) problems.push('The AR number can be at most 80 characters.');
  if (details.product.length > 120) problems.push('The product can be at most 120 characters.');
  return { details, problems };
}

/** Why this live reading cannot be logged, or null. */
export function logReadingProblem(r: { ph: number | null | undefined; mv: number | null | undefined; temperatureC: number | null | undefined }): string | null {
  if (typeof r.ph !== 'number' || r.ph < 0 || r.ph > 14) return 'A valid live pH reading is not available.';
  if (typeof r.mv !== 'number') return 'The meter is not sending a millivolt reading.';
  if (typeof r.temperatureC !== 'number') return 'The meter is not sending a temperature.';
  return null;
}

/** RFC 4180 field; neutralises spreadsheet formulas (=, +, -, @) in text, never in numbers. */
export function csvCell(value: string | number | boolean): string {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ---------------------------------------------------------------------------
// Alarms, alerts and trends (NxGen Sense PH2 alarms, PhAlertPolicy, trends)
// ---------------------------------------------------------------------------

export const ALARM_BREACH = 'PH-ALARM-LIMIT-BREACH';
export type AlertSeverity = 'WARNING' | 'CRITICAL';

export interface AlertRequest {
  code: string;
  severity: AlertSeverity;
  message: string;
}

/** The pH range for an alarm, or why it cannot be used. */
export function validateAlarmRange(min: unknown, max: unknown): string | null {
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 14 || min >= max)
    return 'Enter a valid range between 0 and 14 pH.';
  return null;
}

export const outsideAlarmRange = (ph: number, min: number, max: number) => ph < min || ph > max;

/** What a saved calibration should raise (PhAlertPolicy.postCalibration). */
export function postCalibrationAlerts(input: { result: PhResult; outcome: Outcome; unstablePoints: number }): AlertRequest[] {
  const { result, outcome, unstablePoints } = input;
  const alerts: AlertRequest[] = [];
  if (outcome === 'FAIL') alerts.push({ code: 'PH-POSTCAL-RESULT-FAILED', severity: 'CRITICAL', message: 'The calibration did not meet the acceptance limits.' });
  if (unstablePoints > 0) alerts.push({ code: 'PH-POSTCAL-UNSTABLE-READING', severity: 'WARNING', message: `${unstablePoints} calibration point(s) were captured while the reading was not stable.` });
  const limit = (o: Outcome, name: string, text: string) => {
    if (o === 'FAIL') alerts.push({ code: `PH-POSTCAL-${name}-OUT-OF-LIMIT`, severity: 'CRITICAL', message: `${text} is outside the allowed limit.` });
    if (o === 'WARNING') alerts.push({ code: `PH-POSTCAL-${name}-WARNING`, severity: 'WARNING', message: `${text} is outside the pass range.` });
  };
  limit(result.slopeOutcome, 'SLOPE', `Calibration slope ${result.slopePercent.toFixed(2)} %`);
  limit(result.offsetOutcome, 'OFFSET', `Calibration offset ${result.offsetMv.toFixed(2)} mV`);
  return alerts;
}

/** Which due-date alerts an instrument's readiness calls for. */
export function dueAlertChanges(state: string): { raise: AlertRequest | null; resolve: string[] } {
  const due: AlertRequest = { code: 'PH-CAL-DUE', severity: 'WARNING', message: 'Calibration is due soon.' };
  const overdue: AlertRequest = { code: 'PH-CAL-OVERDUE', severity: 'CRITICAL', message: 'Calibration is overdue.' };
  if (state === 'DUE_SOON') return { raise: due, resolve: [overdue.code] };
  if (state === 'OVERDUE') return { raise: overdue, resolve: [due.code] };
  return { raise: null, resolve: state === 'READY' ? [due.code, overdue.code] : [] };
}

export interface TrendPoint {
  at: number;
  ph: number | null;
  temperatureC: number | null;
  mv: number | null;
}

export const TREND_KEEP_MS = 60 * 60_000;
export const TREND_STEP_MS = 5_000;
export const TREND_WINDOWS = [10, 30, 60];
export const TREND_SAMPLES = [5, 10, 30, 60, 180, 300, 600];

/** A trend point, leaving out values outside what the sensors can report. */
export function trendPoint(at: number, v: Record<string, number | null | undefined>): TrendPoint {
  const within = (x: number | null | undefined, low: number, high: number) => (typeof x === 'number' && x >= low && x <= high ? x : null);
  return { at, ph: within(v.PH_VAL, 0, 14), temperatureC: within(v.TEMP_VAL, -50, 150), mv: within(v.MV_VAL, -2000, 2000) };
}

/** The latest point in each sample period of the window. */
export function sampleTrend(points: TrendPoint[], now: number, windowMinutes: number, sampleSeconds: number): TrendPoint[] {
  const since = now - windowMinutes * 60_000;
  const size = sampleSeconds * 1000;
  const buckets = new Map<number, TrendPoint>();
  for (const p of points) if (p.at >= since && p.at <= now) buckets.set(Math.floor(p.at / size), p);
  return [...buckets.values()].sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Buffer lot and meter settings
// ---------------------------------------------------------------------------

/** Buffer lot and expiry from a save request; expiry is optional, yyyy-MM-dd. */
export function parseBufferDetails(input: unknown): { lot: string; expiry: string | null; problems: string[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const lot = typeof o.bufferLot === 'string' ? o.bufferLot.trim() : '';
  const raw = typeof o.bufferExpiry === 'string' ? o.bufferExpiry.trim() : '';
  const problems: string[] = [];
  if (lot.length > 80) problems.push('The buffer lot can be at most 80 characters.');
  if (raw && (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`)))) problems.push('Enter the buffer expiry as a date.');
  return { lot, expiry: raw || null, problems };
}

/** A buffer is usable through its expiry date. */
export const bufferExpired = (expiry: string | null, now: Date) => !!expiry && expiry < now.toISOString().slice(0, 10);

/** What was asked to be set on the meter, or why it cannot be sent. */
export function parseMeterSettings(input: unknown): { thermistor: 'NTC' | 'PTC' | null; atcReferenceC: number | null; problems: string[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const thermistor = o.thermistor === 'NTC' || o.thermistor === 'PTC' ? o.thermistor : null;
  if (o.thermistor !== undefined && o.thermistor !== null && !thermistor) problems.push('Choose NTC or PTC.');
  let atcReferenceC: number | null = null;
  if (o.atcReferenceC !== undefined && o.atcReferenceC !== null) {
    if (typeof o.atcReferenceC === 'number' && Number.isFinite(o.atcReferenceC) && o.atcReferenceC >= -20 && o.atcReferenceC <= 150) atcReferenceC = o.atcReferenceC;
    else problems.push('The ATC reference must be −20 to 150 °C.');
  }
  if (!thermistor && atcReferenceC === null && !problems.length) problems.push('Choose a setting to send.');
  return { thermistor, atcReferenceC, problems };
}

// ---------------------------------------------------------------------------
// Probes (NxGen Sense probe master and ProbeHealthRepository)
// ---------------------------------------------------------------------------

export const PROBE_STATUSES = ['ACTIVE', 'BLOCKED', 'INACTIVE', 'RETIRED'] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];
export type ProbeHealthStatus = 'NOT_CONFIGURED' | 'NOT_CONNECTED' | 'UNAUTHORIZED' | 'CRITICAL' | 'REPLACEMENT_RECOMMENDED' | 'WARNING' | 'GOOD';

export const PROBE_HEALTH_LIMITS = {
  driftWarning: 3,
  driftCritical: 5,
  bufferDeviation: 0.1,
  responseWarningS: 60,
  responseCriticalS: 300,
  usageCountWarning: 500,
  usageHoursWarning: 2000,
  ageHoursWarning: 4000,
  ageHoursReplacement: 6000,
  failuresWarning: 2,
  failuresCritical: 3,
};

export interface ProbeCalibration {
  outcome: Outcome;
  slopePercent: number | null;
  offsetMv: number | null;
  largestDeviation: number | null;
}

export interface ProbeHealthInput {
  assigned: boolean;
  probeStatus: ProbeStatus | null;
  /** What the meter reports: 1, 0, or nothing. */
  connected: number | null | undefined;
  dueState: string;
  limits: PhLimits;
  /** This probe's calibrations, newest first. */
  calibrations: ProbeCalibration[];
  interruptions: number;
  responseAgeSeconds: number | null;
  ageHours: number;
}

export interface ProbeHealth {
  status: ProbeHealthStatus;
  reasons: string[];
  stability: string;
  drift: number | null;
  repeatedFailures: number;
  usageCount: number;
  replacement: string;
}

export function evaluateProbeHealth(i: ProbeHealthInput): ProbeHealth {
  const L = PROBE_HEALTH_LIMITS;
  const [latest, previous] = i.calibrations;
  const slope = latest?.slopePercent ?? null;
  const offset = latest?.offsetMv ?? null;
  const slopeOk = slope === null || (slope >= i.limits.slopeWarnMin && slope <= i.limits.slopeWarnMax);
  const offsetOk = offset === null || Math.abs(offset) <= i.limits.offsetWarnMaxAbs;
  const stability = !latest ? 'Not calibrated' : latest.outcome === 'FAIL' ? 'Calibration not accepted' : slopeOk && offsetOk ? 'Stable' : 'Unstable';
  const drift = slope !== null && previous?.slopePercent != null ? Math.round(Math.abs(slope - previous.slopePercent) * 100) / 100 : null;
  const repeatedFailures = i.calibrations.filter((c) => c.outcome === 'FAIL').length;
  const usageCount = i.calibrations.length;
  const overdue = i.dueState === 'OVERDUE' || i.dueState === 'CALIBRATION_FAILED';
  const replacement =
    stability === 'Unstable' || overdue
      ? 'Replacement review required'
      : i.ageHours >= L.usageHoursWarning || usageCount >= L.usageCountWarning
        ? 'Replacement review due'
        : drift !== null && drift >= L.driftCritical
          ? 'Drift review required'
          : 'No replacement due';
  const result = (status: ProbeHealthStatus, reasons: string[]): ProbeHealth => ({ status, reasons, stability, drift, repeatedFailures, usageCount, replacement });

  if (!i.assigned) return result('NOT_CONFIGURED', ['No probe is assigned to this instrument.']);
  if (i.connected === 0) return result('NOT_CONNECTED', ['The meter reports the probe is disconnected.']);
  if (i.probeStatus !== 'ACTIVE') return result('UNAUTHORIZED', [`This probe is ${String(i.probeStatus).toLowerCase()}.`]);

  const critical: string[] = [];
  if (stability === 'Unstable') critical.push('Slope or offset is outside the warning limits.');
  if (latest?.largestDeviation != null && latest.largestDeviation > L.bufferDeviation) critical.push(`Buffer deviation ${latest.largestDeviation} pH exceeds ${L.bufferDeviation} pH.`);
  if (i.responseAgeSeconds !== null && i.responseAgeSeconds >= L.responseCriticalS) critical.push(`No response from the probe for ${i.responseAgeSeconds} s.`);
  if (repeatedFailures >= L.failuresCritical) critical.push(`Repeated calibration failures: ${repeatedFailures}.`);
  if (drift !== null && drift >= L.driftCritical) critical.push(`Slope drift ${drift} % exceeds ${L.driftCritical} %.`);
  if (i.interruptions >= L.failuresCritical) critical.push(`Repeated interrupted calibrations: ${i.interruptions}.`);
  if (overdue) critical.push('The calibration is overdue or failed.');
  if (critical.length) return result('CRITICAL', critical);

  const replace: string[] = [];
  if (replacement.includes('required')) replace.push(replacement);
  if (i.ageHours >= L.ageHoursReplacement) replace.push(`Probe age ${i.ageHours} h exceeds ${L.ageHoursReplacement} h.`);
  if (repeatedFailures >= L.failuresWarning) replace.push(`Repeated calibration failures: ${repeatedFailures}.`);
  if (replace.length) return result('REPLACEMENT_RECOMMENDED', replace);

  const warnings: string[] = [];
  if (i.dueState === 'DUE_SOON') warnings.push('Calibration is due soon.');
  if (i.dueState === 'NOT_CALIBRATED') warnings.push('The instrument has no approved calibration.');
  if (replacement === 'Replacement review due') warnings.push(replacement);
  if (i.ageHours >= L.ageHoursWarning) warnings.push(`Probe age ${i.ageHours} h is approaching replacement.`);
  if (i.responseAgeSeconds !== null && i.responseAgeSeconds >= L.responseWarningS) warnings.push(`No response from the probe for ${i.responseAgeSeconds} s.`);
  if (drift !== null && drift >= L.driftWarning) warnings.push(`Slope drift ${drift} % exceeds ${L.driftWarning} %.`);
  if (i.interruptions >= L.failuresWarning) warnings.push(`Interrupted calibrations: ${i.interruptions}.`);
  return result(warnings.length ? 'WARNING' : 'GOOD', warnings);
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

// ---------------------------------------------------------------------------
// Dashboard (NxGen Sense dashboard and Devices screens): how each instrument
// is summarised, filtered and counted. Pure so the API and the screen agree.
// ---------------------------------------------------------------------------

/** The app's calibration statuses, derived from the core's readiness state. */
export type CalibrationBucket = 'VALID' | 'DUE_SOON' | 'DUE' | 'OVERDUE' | 'FAILED' | 'NOT_CALIBRATED' | 'OUT_OF_SERVICE';
export const CALIBRATION_BUCKET_LABEL: Record<CalibrationBucket, string> = {
  VALID: 'Valid',
  DUE_SOON: 'Due soon',
  DUE: 'Due',
  OVERDUE: 'Overdue',
  FAILED: 'Failed',
  NOT_CALIBRATED: 'Not calibrated',
  OUT_OF_SERVICE: 'Out of service',
};
/** "Due" is the app's last day: the calibration expires within 24 hours. */
export const CALIBRATION_DUE_WINDOW_MS = 24 * 60 * 60_000;

export function calibrationBucket(readinessState: string, dueAt: string | null, now: number): CalibrationBucket {
  switch (readinessState) {
    case 'READY':
      return 'VALID';
    case 'DUE_SOON': {
      const due = dueAt ? Date.parse(dueAt) : NaN;
      return !Number.isNaN(due) && due - now <= CALIBRATION_DUE_WINDOW_MS ? 'DUE' : 'DUE_SOON';
    }
    case 'OVERDUE':
      return 'OVERDUE';
    case 'CALIBRATION_FAILED':
      return 'FAILED';
    case 'OUT_OF_SERVICE':
    case 'RETIRED':
      return 'OUT_OF_SERVICE';
    default:
      return 'NOT_CALIBRATED';
  }
}

export type BatteryCondition = 'UNKNOWN' | 'NORMAL' | 'LOW' | 'CRITICAL' | 'CHARGING' | 'FULL';
export const BATTERY_CONDITION_LABEL: Record<BatteryCondition, string> = {
  UNKNOWN: 'Not reported',
  NORMAL: 'Normal',
  LOW: 'Low battery',
  CRITICAL: 'Critical',
  CHARGING: 'Charging',
  FULL: 'Charging complete',
};

/** The app's battery thresholds: above 20 % normal, 10–20 % low, below 10 % critical. */
export function batteryCondition(percent: number | null | undefined, charging: boolean): BatteryCondition {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'UNKNOWN';
  if (charging) return percent >= 100 ? 'FULL' : 'CHARGING';
  if (percent < 10) return 'CRITICAL';
  if (percent <= 20) return 'LOW';
  return 'NORMAL';
}

export const isChargingText = (status: string | null | undefined) => !!status && /charg/i.test(status) && !/not|dis|un/i.test(status);

/** What the dashboard needs to know about an instrument to filter and count it. */
export interface DashboardRowLike {
  name: string;
  code: string;
  deviceIdentifier: string | null;
  location: string;
  model: string;
  serialNumber: string;
  currentUser: string | null;
  probeCode: string | null;
  temperatureSensorId: string | null;
  online: boolean;
  battery: number | null;
  batteryCondition: BatteryCondition;
  calibrationBucket: CalibrationBucket;
  calibrationDueAt: string | null;
  openAlerts: number;
  criticalAlerts: number;
  lastActivityAt: string | null;
}

export interface DashboardFilter {
  search: string;
  connection: 'ALL' | 'ONLINE' | 'OFFLINE';
  calibration: 'ALL' | 'ATTENTION' | CalibrationBucket;
  battery: 'ALL' | 'NORMAL' | 'LOW' | 'CRITICAL' | 'CHARGING' | 'UNKNOWN';
  alerts: 'ALL' | 'CRITICAL' | 'WARNING' | 'NONE';
  activity: 'ALL' | 'TODAY' | 'WEEK' | 'INACTIVE';
  sort: 'NAME' | 'LAST_ACTIVITY' | 'CALIBRATION_DUE' | 'ALERTS' | 'BATTERY';
  location: string;
}
export const DEFAULT_DASHBOARD_FILTER: DashboardFilter = { search: '', connection: 'ALL', calibration: 'ALL', battery: 'ALL', alerts: 'ALL', activity: 'ALL', sort: 'NAME', location: '' };
export const ATTENTION_BUCKETS: CalibrationBucket[] = ['DUE_SOON', 'DUE', 'OVERDUE', 'FAILED', 'NOT_CALIBRATED'];

export function filterDashboardDevices<T extends DashboardRowLike>(rows: T[], f: DashboardFilter, now: number): T[] {
  const needle = f.search.trim().toLowerCase();
  const day = 24 * 60 * 60_000;
  const kept = rows.filter((r) => {
    if (f.connection !== 'ALL' && (f.connection === 'ONLINE') !== r.online) return false;
    if (f.calibration === 'ATTENTION' ? !ATTENTION_BUCKETS.includes(r.calibrationBucket) : f.calibration !== 'ALL' && r.calibrationBucket !== f.calibration) return false;
    if (f.battery !== 'ALL' && (f.battery === 'CHARGING' ? r.batteryCondition !== 'CHARGING' && r.batteryCondition !== 'FULL' : r.batteryCondition !== f.battery)) return false;
    if (f.alerts === 'CRITICAL' && r.criticalAlerts === 0) return false;
    if (f.alerts === 'WARNING' && r.openAlerts - r.criticalAlerts === 0) return false;
    if (f.alerts === 'NONE' && r.openAlerts > 0) return false;
    if (f.location && r.location.trim().toLowerCase() !== f.location.trim().toLowerCase()) return false;
    if (f.activity !== 'ALL') {
      const at = r.lastActivityAt ? Date.parse(r.lastActivityAt) : NaN;
      const age = Number.isNaN(at) ? Infinity : now - at;
      if (f.activity === 'TODAY' && age > day) return false;
      if (f.activity === 'WEEK' && age > 7 * day) return false;
      if (f.activity === 'INACTIVE' && age <= 7 * day) return false;
    }
    if (needle) {
      const hay = [r.name, r.code, r.deviceIdentifier, r.location, r.model, r.serialNumber, r.currentUser, r.probeCode, r.temperatureSensorId];
      if (!hay.some((v) => (v ?? '').toLowerCase().includes(needle))) return false;
    }
    return true;
  });
  const time = (v: string | null) => (v ? Date.parse(v) : -Infinity);
  const byName = (a: T, b: T) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code);
  return kept.sort((a, b) => {
    switch (f.sort) {
      case 'LAST_ACTIVITY':
        return time(b.lastActivityAt) - time(a.lastActivityAt) || byName(a, b);
      case 'CALIBRATION_DUE': {
        const soonest = (r: T) => (r.calibrationDueAt ? Date.parse(r.calibrationDueAt) : Infinity);
        return soonest(a) - soonest(b) || byName(a, b);
      }
      case 'ALERTS':
        return b.criticalAlerts - a.criticalAlerts || b.openAlerts - a.openAlerts || byName(a, b);
      case 'BATTERY':
        return (a.battery ?? Infinity) - (b.battery ?? Infinity) || byName(a, b);
      default:
        return byName(a, b);
    }
  });
}

export interface DashboardSummary {
  total: number;
  online: number;
  offline: number;
  lowBattery: number;
  criticalBattery: number;
  calibrationDue: number;
  criticalAlerts: number;
  calibration: Record<'valid' | 'dueSoon' | 'due' | 'overdue' | 'failed' | 'notCalibrated', number>;
}

/** The dashboard's summary cards. "Calibration due" is anything that needs attention. */
export function dashboardSummary(rows: DashboardRowLike[]): DashboardSummary {
  const count = (fn: (r: DashboardRowLike) => boolean) => rows.filter(fn).length;
  return {
    total: rows.length,
    online: count((r) => r.online),
    offline: count((r) => !r.online),
    lowBattery: count((r) => r.batteryCondition === 'LOW'),
    criticalBattery: count((r) => r.batteryCondition === 'CRITICAL'),
    calibrationDue: count((r) => ATTENTION_BUCKETS.includes(r.calibrationBucket)),
    criticalAlerts: rows.reduce((n, r) => n + r.criticalAlerts, 0),
    calibration: {
      valid: count((r) => r.calibrationBucket === 'VALID'),
      dueSoon: count((r) => r.calibrationBucket === 'DUE_SOON'),
      due: count((r) => r.calibrationBucket === 'DUE'),
      overdue: count((r) => r.calibrationBucket === 'OVERDUE'),
      failed: count((r) => r.calibrationBucket === 'FAILED'),
      notCalibrated: count((r) => r.calibrationBucket === 'NOT_CALIBRATED'),
    },
  };
}

// ---------------------------------------------------------------------------
// Saved product, batch and AR-number lists (the app's "Add List")
// ---------------------------------------------------------------------------

export const SAMPLE_LIST_KINDS = ['PRODUCT', 'BATCH', 'AR'] as const;
export type SampleListKind = (typeof SAMPLE_LIST_KINDS)[number];
export const SAMPLE_LIST_LABEL: Record<SampleListKind, string> = { PRODUCT: 'Product', BATCH: 'Batch', AR: 'AR number' };

/** The same rules as the sample details, so a saved value is always usable. */
export function parseSampleListEntry(input: unknown): { kind: SampleListKind; value: string } | { problem: string } {
  const b = (input ?? {}) as { kind?: unknown; value?: unknown };
  const kind = b.kind as SampleListKind;
  if (!SAMPLE_LIST_KINDS.includes(kind)) return { problem: 'Choose Product, Batch or AR number.' };
  const value = typeof b.value === 'string' ? b.value.trim() : '';
  const max = kind === 'PRODUCT' ? 120 : 80;
  if (!value || /^n\/?a$/i.test(value)) return { problem: `Enter the ${SAMPLE_LIST_LABEL[kind].toLowerCase()}.` };
  if (value.length > max) return { problem: `${SAMPLE_LIST_LABEL[kind]}: at most ${max} characters.` };
  if (!SAFE_TEXT.test(value)) return { problem: `${SAMPLE_LIST_LABEL[kind]}: use letters, numbers, spaces and . _ - / # ( ) , : + only.` };
  return { kind, value };
}
