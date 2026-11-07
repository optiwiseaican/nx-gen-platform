/**
 * Live preview of the pH calibration result while readings are typed.
 * The server recomputes and stores the authoritative result
 * (apps/server/src/devices/calibration-math.ts); keep the two in step.
 */
import type { CalibrationOutcome, PhReading } from "./api";

export const PH_LIMITS = {
  slopePassMin: 95,
  slopePassMax: 105,
  slopeWarnMin: 92,
  slopeWarnMax: 108,
  offsetPassMaxAbs: 30,
  offsetWarnMaxAbs: 45,
};

export const nernstSlope = (celsius: number) => 0.1984126 * (celsius + 273.15);

export function previewPh(readings: PhReading[], celsius: number) {
  const n = readings.length;
  if (n < 2) return null;
  const mx = readings.reduce((s, r) => s + r.bufferPh, 0) / n;
  const my = readings.reduce((s, r) => s + r.mv, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const r of readings) {
    sxx += (r.bufferPh - mx) ** 2;
    sxy += (r.bufferPh - mx) * (r.mv - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const offsetMv = my - slope * mx + slope * 7;
  const slopePercent = (Math.abs(slope) / nernstSlope(celsius)) * 100;
  const L = PH_LIMITS;
  const slopeOutcome: CalibrationOutcome =
    slope >= 0
      ? "FAIL"
      : slopePercent >= L.slopePassMin && slopePercent <= L.slopePassMax
        ? "PASS"
        : slopePercent >= L.slopeWarnMin && slopePercent <= L.slopeWarnMax
          ? "WARNING"
          : "FAIL";
  const abs = Math.abs(offsetMv);
  const offsetOutcome: CalibrationOutcome = abs <= L.offsetPassMaxAbs ? "PASS" : abs <= L.offsetWarnMaxAbs ? "WARNING" : "FAIL";
  const outcome: CalibrationOutcome =
    slopeOutcome === "FAIL" || offsetOutcome === "FAIL" ? "FAIL" : slopeOutcome === "WARNING" || offsetOutcome === "WARNING" ? "WARNING" : "PASS";
  return { slopeMvPerPh: slope, slopePercent, offsetMv, slopeOutcome, offsetOutcome, outcome };
}
