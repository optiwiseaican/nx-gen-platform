/**
 * Calibration and quantification, ported from the tablet engine (engine/quant). Standards
 * (reference tracks) give amount = concentration × volume against the measured peak; unknowns
 * are read off the curve: amount ÷ sample volume × dilution = concentration of the sample.
 */
import { LinearAlgebra } from './linear-algebra';
import { Track, appliedAmount } from './plate';
import { PeakResult, RegressionMode } from './signal';

export type Response = 'HEIGHT' | 'AREA';

/** One reference measurement: applied amount and the measured response. */
export interface CalibrationPoint {
  amount: number;
  response: number;
}

const PARAMS: Record<RegressionMode, number> = { LINEAR_THROUGH_ORIGIN: 1, LINEAR: 2, POLYNOMIAL: 3 };

/** Java's %.4e: mantissa with 4 decimals, exponent sign and at least two digits. */
function javaExp(v: number): string {
  const s = v.toExponential(4);
  const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
  if (!m) return s;
  return `${m[1]}e${m[2]}${m[3].padStart(2, '0')}`;
}

export class CalibrationCurve {
  constructor(
    readonly mode: RegressionMode,
    /** Polynomial coefficients, lowest power first: y = c0 + c1·x + c2·x². */
    readonly coefficients: number[],
    /** Correlation coefficient, √R². */
    readonly r: number,
    /** Relative residual standard deviation of the fit, in %. */
    readonly cvPercent: number,
    readonly points: CalibrationPoint[],
  ) {}

  response(amount: number): number {
    let s = 0;
    this.coefficients.forEach((c, j) => {
      s += c * Math.pow(amount, j);
    });
    return s;
  }

  /** Amount that produces the response; for a polynomial the root nearest the calibrated range. */
  amountFor(response: number): number | null {
    const c0 = this.coefficients[0] ?? 0;
    const c1 = this.coefficients[1] ?? 0;
    const c2 = this.coefficients[2] ?? 0;
    if (Math.abs(c2) < 1e-15) {
      if (Math.abs(c1) < 1e-15) return null;
      return (response - c0) / c1;
    }
    const disc = c1 * c1 - 4 * c2 * (c0 - response);
    if (disc < 0) return null;
    const roots = [(-c1 + Math.sqrt(disc)) / (2 * c2), (-c1 - Math.sqrt(disc)) / (2 * c2)];
    const amounts = this.points.map((p) => p.amount);
    const mid = (Math.min(...amounts) + Math.max(...amounts)) / 2;
    const nearest = (list: number[]): number | null => {
      let best: number | null = null;
      for (const x of list) if (best === null || Math.abs(x - mid) < Math.abs(best - mid)) best = x;
      return best;
    };
    return nearest(roots.filter((x) => x >= 0)) ?? nearest(roots);
  }

  /** Human-readable equation, e.g. "Y = 6.4252e+01·X". */
  equation(): string {
    const terms: string[] = [];
    for (let j = this.coefficients.length - 1; j >= 0; j--) {
      if (this.mode === 'LINEAR_THROUGH_ORIGIN' && j === 0) continue;
      const v = javaExp(this.coefficients[j]);
      terms.push(j === 0 ? v : j === 1 ? `${v}·X` : `${v}·X^${j}`);
    }
    return `Y = ${terms.join(' + ').replace(/\+ -/g, '- ')}`;
  }

  static fit(points: CalibrationPoint[], mode: RegressionMode): CalibrationCurve {
    const params = PARAMS[mode];
    if (points.length < params) throw new Error(`${mode} needs at least ${params} reference points, got ${points.length}`);
    if (new Set(points.map((p) => p.amount)).size < params) throw new Error(`${mode} needs at least ${params} distinct amounts`);

    const y = points.map((p) => p.response);
    let coefficients: number[];
    if (mode === 'LINEAR_THROUGH_ORIGIN') {
      const a = LinearAlgebra.leastSquares(
        points.map((p) => [p.amount]),
        y,
      );
      coefficients = [0, a[0]];
    } else if (mode === 'LINEAR') {
      coefficients = LinearAlgebra.leastSquares(
        points.map((p) => [1, p.amount]),
        y,
      );
    } else {
      coefficients = LinearAlgebra.leastSquares(
        points.map((p) => [1, p.amount, p.amount * p.amount]),
        y,
      );
    }
    const provisional = new CalibrationCurve(mode, coefficients, 0, 0, points);
    let mean = 0;
    for (const v of y) mean += v;
    mean /= y.length;
    let ssRes = 0;
    let ssTot = 0;
    for (const p of points) {
      const e = p.response - provisional.response(p.amount);
      ssRes += e * e;
      ssTot += (p.response - mean) * (p.response - mean);
    }
    const r2 = ssTot > 0 ? Math.min(1, Math.max(0, 1 - ssRes / ssTot)) : 1;
    const dof = points.length - params;
    const cv = dof > 0 && mean !== 0 ? (100 * Math.sqrt(ssRes / dof)) / Math.abs(mean) : 0;
    return new CalibrationCurve(mode, coefficients, Math.sqrt(r2), cv, points);
  }
}

export interface TrackPeak {
  track: Track;
  peak: PeakResult;
}

export type RangeStatus = 'IN_RANGE' | 'BELOW_RANGE' | 'ABOVE_RANGE' | 'NOT_DETERMINED';

export interface SampleResult {
  track: Track;
  peak: PeakResult;
  /** Concentration of the sample, in the reference unit, after dilution; null if not determinable. */
  concentrationByHeight: number | null;
  concentrationByArea: number | null;
  rangeByHeight: RangeStatus;
  rangeByArea: RangeStatus;
  dilutionFactor: number;
}

/** A standard run back through the curve; bias = (back-calculated − nominal) / nominal. */
export interface StandardResult {
  track: Track;
  peak: PeakResult;
  nominalAmount: number;
  included: boolean;
  exclusionReason: string | null;
  backCalculatedByHeight: number | null;
  backCalculatedByArea: number | null;
  residualByHeight: number;
  residualByArea: number;
  biasPercentByHeight: number | null;
  biasPercentByArea: number | null;
}

export interface ReplicateStats {
  n: number;
  mean: number;
  sd: number | null;
  cvPercent: number | null;
}

export interface ReplicateGroup {
  name: string;
  members: SampleResult[];
  byHeight: ReplicateStats | null;
  byArea: ReplicateStats | null;
  /** True if any replicate lies outside the calibrated range (the mean is then not valid either). */
  anyOutOfRange: boolean;
}

export interface QuantificationResult {
  byHeight: CalibrationCurve;
  byArea: CalibrationCurve;
  samples: SampleResult[];
  standards: StandardResult[];
  replicates: ReplicateGroup[];
}

const bias = (back: number | null, nominal: number): number | null => (back === null || nominal === 0 ? null : (100 * (back - nominal)) / nominal);

export const Quantifier = {
  /** excluded maps reference track ids left out of the fit to the reason given. */
  quantify(peaks: TrackPeak[], mode: RegressionMode, excluded: Map<number, string> = new Map()): QuantificationResult {
    const references = peaks.filter((p) => p.track.isReference);
    const missing = references.filter((p) => appliedAmount(p.track) === null).map((p) => p.track.name);
    if (missing.length) throw new Error(`Reference tracks need concentration and sample volume: ${missing.join(', ')}`);
    const used = references.filter((p) => !excluded.has(p.track.id));

    const byHeight = CalibrationCurve.fit(
      used.map((p) => ({ amount: appliedAmount(p.track) as number, response: p.peak.height })),
      mode,
    );
    const byArea = CalibrationCurve.fit(
      used.map((p) => ({ amount: appliedAmount(p.track) as number, response: p.peak.area })),
      mode,
    );

    const standards: StandardResult[] = references.map((r) => {
      const amount = appliedAmount(r.track) as number;
      const backH = byHeight.amountFor(r.peak.height);
      const backA = byArea.amountFor(r.peak.area);
      return {
        track: r.track,
        peak: r.peak,
        nominalAmount: amount,
        included: !excluded.has(r.track.id),
        exclusionReason: excluded.get(r.track.id) ?? null,
        backCalculatedByHeight: backH,
        backCalculatedByArea: backA,
        residualByHeight: r.peak.height - byHeight.response(amount),
        residualByArea: r.peak.area - byArea.response(amount),
        biasPercentByHeight: bias(backH, amount),
        biasPercentByArea: bias(backA, amount),
      };
    });

    const samples: SampleResult[] = peaks
      .filter((p) => !p.track.isReference)
      .map((tp) => {
        const volume = tp.track.sampleVolumeUl != null && tp.track.sampleVolumeUl > 0 ? tp.track.sampleVolumeUl : null;
        const dilution = tp.track.dilutionFactor != null && tp.track.dilutionFactor > 0 ? tp.track.dilutionFactor : 1.0;
        const amountH = byHeight.amountFor(tp.peak.height);
        const amountA = byArea.amountFor(tp.peak.area);
        return {
          track: tp.track,
          peak: tp.peak,
          concentrationByHeight: volume !== null && amountH !== null ? (amountH / volume) * dilution : null,
          concentrationByArea: volume !== null && amountA !== null ? (amountA / volume) * dilution : null,
          rangeByHeight: Quantifier.rangeOf(amountH, byHeight),
          rangeByArea: Quantifier.rangeOf(amountA, byArea),
          dilutionFactor: dilution,
        };
      });
    return { byHeight, byArea, samples, standards, replicates: Quantifier.replicates(samples) };
  },

  /** Groups sample tracks by name (trimmed, case-insensitive) and averages the individual results. */
  replicates(samples: SampleResult[]): ReplicateGroup[] {
    const groups = new Map<string, SampleResult[]>();
    for (const s of samples) {
      const key = s.track.name.trim().toLowerCase();
      const list = groups.get(key);
      if (list) list.push(s);
      else groups.set(key, [s]);
    }
    return [...groups.values()].map((members) => ({
      name: members[0].track.name.trim(),
      members,
      byHeight: Quantifier.stats(members.map((m) => m.concentrationByHeight).filter((v): v is number => v !== null)),
      byArea: Quantifier.stats(members.map((m) => m.concentrationByArea).filter((v): v is number => v !== null)),
      anyOutOfRange: members.some((m) => isOut(m.rangeByHeight) || isOut(m.rangeByArea)),
    }));
  },

  stats(values: number[]): ReplicateStats | null {
    if (values.length === 0) return null;
    let mean = 0;
    for (const v of values) mean += v;
    mean /= values.length;
    if (values.length < 2) return { n: 1, mean, sd: null, cvPercent: null };
    let ss = 0;
    for (const v of values) ss += (v - mean) * (v - mean);
    const sd = Math.sqrt(ss / (values.length - 1));
    const cv = Math.abs(mean) < 1e-12 ? null : (100 * sd) / Math.abs(mean);
    return { n: values.length, mean, sd, cvPercent: cv };
  },

  /** Calibrated range = lowest to highest included standard amount (a small tolerance absorbs rounding). */
  rangeOf(amount: number | null, curve: CalibrationCurve): RangeStatus {
    if (amount === null || Number.isNaN(amount)) return 'NOT_DETERMINED';
    const amounts = curve.points.map((p) => p.amount);
    const lo = Math.min(...amounts);
    const hi = Math.max(...amounts);
    const tol = (hi - lo) * 1e-6;
    if (amount < lo - tol) return 'BELOW_RANGE';
    if (amount > hi + tol) return 'ABOVE_RANGE';
    return 'IN_RANGE';
  },
};

const isOut = (r: RangeStatus): boolean => r === 'ABOVE_RANGE' || r === 'BELOW_RANGE';
