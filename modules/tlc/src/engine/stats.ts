/** Descriptive statistics and the calibration residual review, ported from the tablet engine (engine/stats). */
import { toInt } from './image';

/** Five-number summary with Tukey whiskers (1.5 × IQR) and the points beyond them. */
export interface BoxStats {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number[];
  mean: number;
}

export const Statistics = {
  /** Quantile with linear interpolation between order statistics (R type 7 / Excel QUARTILE.INC). */
  quantile(sorted: number[], p: number): number {
    if (sorted.length === 0) throw new Error('No values');
    const h = (sorted.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  },

  box(values: number[]): BoxStats | null {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const q1 = Statistics.quantile(v, 0.25);
    const q3 = Statistics.quantile(v, 0.75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    let mean = 0;
    for (const x of v) mean += x;
    mean /= v.length;
    return {
      n: v.length,
      min: v[0],
      q1,
      median: Statistics.quantile(v, 0.5),
      q3,
      max: v[v.length - 1],
      lowerWhisker: v.find((x) => x >= lowFence) as number,
      upperWhisker: [...v].reverse().find((x) => x <= highFence) as number,
      outliers: v.filter((x) => x < lowFence || x > highFence),
      mean,
    };
  },

  pearson(x: number[], y: number[]): number | null {
    const n = Math.min(x.length, y.length);
    if (n < 3) return null;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += x[i];
      my += y[i];
    }
    mx /= n;
    my /= n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx;
      const dy = y[i] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    if (sxx <= 1e-300 || syy <= 1e-300) return null;
    return sxy / Math.sqrt(sxx * syy);
  },
};

export type ResidualPattern = 'TOO_FEW' | 'NONE' | 'CURVATURE' | 'TREND' | 'FUNNEL';

export interface ResidualReview {
  pattern: ResidualPattern;
  message: string;
  systematic: boolean;
}

const review = (pattern: ResidualPattern, message: string): ResidualReview => ({
  pattern,
  message,
  systematic: pattern === 'CURVATURE' || pattern === 'TREND' || pattern === 'FUNNEL',
});

/**
 * Systematic-bias review of calibration residuals (measured − fitted) ordered by amount:
 * curvature, a trend with amount, or a spread that grows with amount. Needs at least four
 * included standards.
 */
export const CalibrationReview = {
  MIN_POINTS: 4,

  review(points: { amount: number; residual: number }[]): ResidualReview {
    if (points.length < CalibrationReview.MIN_POINTS) {
      return review('TOO_FEW', `Too few standards (${points.length}) to judge a residual pattern; at least ${CalibrationReview.MIN_POINTS} are needed.`);
    }
    const sorted = [...points].sort((a, b) => a.amount - b.amount);
    const scale = Math.max(...sorted.map((p) => Math.abs(p.residual)));
    if (!(scale > 0)) return review('NONE', 'Residuals are all zero.');
    const thirds = [0, 1, 2].map((t) => {
      const part = sorted.filter((_, i) => toInt((i * 3) / sorted.length) === t).map((p) => p.residual);
      let s = 0;
      for (const v of part) s += v;
      return s / part.length;
    });
    const curved =
      thirds[0] * thirds[1] < 0 && thirds[2] * thirds[1] < 0 && Math.min(Math.abs(thirds[0]), Math.abs(thirds[1]), Math.abs(thirds[2])) > 0.15 * scale;
    if (curved) {
      const shape = thirds[1] > 0 ? '∩ (middle above, ends below)' : 'U (middle below, ends above)';
      return review('CURVATURE', `Curvature: residuals form a ${shape} pattern, so the response is not linear over this range. Consider a polynomial model or a narrower range.`);
    }
    const amounts = sorted.map((p) => p.amount);
    const trend = Statistics.pearson(
      amounts,
      sorted.map((p) => p.residual),
    );
    if (trend !== null && Math.abs(trend) > 0.8) {
      return review('TREND', `Trend: residuals ${trend > 0 ? 'rise' : 'fall'} with amount (r = ${trend.toFixed(2)}); the model (e.g. through origin) may not suit the data.`);
    }
    const spread = Statistics.pearson(
      amounts,
      sorted.map((p) => Math.abs(p.residual)),
    );
    if (sorted.length >= 5 && spread !== null && spread > 0.85) {
      return review('FUNNEL', `Spread grows with amount (r = ${spread.toFixed(2)}): higher standards scatter more. Check the upper standards or use a narrower range.`);
    }
    return review('NONE', 'No systematic pattern in the residuals.');
  },
};
