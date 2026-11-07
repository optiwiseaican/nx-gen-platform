/**
 * Calibration calculations. The server result is authoritative and is stored
 * with the limits that were applied, so a record can always be re-checked.
 */

export type CalibrationOutcome = 'PASS' | 'WARNING' | 'FAIL';

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
  /** Fitted electrode response, mV per pH unit (negative for a healthy electrode). */
  slopeMvPerPh: number;
  /** Theoretical Nernst slope at the calibration temperature, mV per pH. */
  nernstMvPerPh: number;
  /** |fitted| / theoretical × 100. */
  slopePercent: number;
  /** Potential at pH 7.00 (asymmetry / zero-point offset), mV. */
  offsetMv: number;
  /** Coefficient of determination of the fit. */
  rSquared: number;
  slopeOutcome: CalibrationOutcome;
  offsetOutcome: CalibrationOutcome;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** RT·ln(10)/F in mV per pH at `celsius`: 59.16 mV at 25 °C. */
export function nernstSlope(celsius: number): number {
  return 0.1984126 * (celsius + 273.15);
}

const worst = (...o: CalibrationOutcome[]): CalibrationOutcome =>
  o.includes('FAIL') ? 'FAIL' : o.includes('WARNING') ? 'WARNING' : 'PASS';

export function computePh(
  readings: PhReading[],
  celsius: number,
  limits: PhLimits = DEFAULT_PH_LIMITS,
): PhResult & { outcome: CalibrationOutcome } {
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
  const intercept = my - slope * mx;
  const nernst = nernstSlope(celsius);
  const slopePercent = (Math.abs(slope) / nernst) * 100;
  const offsetMv = intercept + slope * 7;
  const rSquared = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);

  // A positive slope means the electrode response is inverted: always a failure.
  const slopeOutcome: CalibrationOutcome =
    slope >= 0
      ? 'FAIL'
      : slopePercent >= limits.slopePassMin &&
          slopePercent <= limits.slopePassMax
        ? 'PASS'
        : slopePercent >= limits.slopeWarnMin &&
            slopePercent <= limits.slopeWarnMax
          ? 'WARNING'
          : 'FAIL';
  const absOffset = Math.abs(offsetMv);
  const offsetOutcome: CalibrationOutcome =
    absOffset <= limits.offsetPassMaxAbs
      ? 'PASS'
      : absOffset <= limits.offsetWarnMaxAbs
        ? 'WARNING'
        : 'FAIL';

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

/** Other instruments: a list of checks, each with an expected and observed value. */
export interface CheckReading {
  check: string;
  expected: string;
  observed: string;
  pass: boolean;
}

export function computeChecks(readings: CheckReading[]): {
  outcome: CalibrationOutcome;
  passed: number;
  failed: number;
} {
  const failed = readings.filter((r) => !r.pass).length;
  return {
    outcome: failed ? 'FAIL' : 'PASS',
    passed: readings.length - failed,
    failed,
  };
}
