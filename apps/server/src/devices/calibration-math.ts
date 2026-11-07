/**
 * Core calibration for instruments without a module (type OTHER): a list of
 * checks, each with an expected and observed value. Instrument-specific
 * calculations (e.g. pH slope and offset) live in the module for that type.
 */
export type CalibrationOutcome = 'PASS' | 'WARNING' | 'FAIL';

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
