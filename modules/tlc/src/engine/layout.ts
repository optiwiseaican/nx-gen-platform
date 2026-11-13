/**
 * Automatic plate layout: pencil baseline, solvent front, track positions and a common track
 * width. Ported from the tablet engine (LayoutDetector.kt, TrackDetector.kt).
 */
import { GrayImage, clamp, roundToInt, toInt } from './image';
import { Development, PlateGeometry } from './plate';
import { PeakLocator } from './signal';

const f = Math.fround;

export interface TrackDetectorSettings {
  /** Light smoothing of the column score; must stay below the narrowest gap between lanes. */
  smoothingMm: number;
  /** Bands that run into this edge zone are plate-edge shading, not samples. */
  edgeMarginMm: number;
  /** A track must reach this fraction of the strongest track's score above the gap level. */
  relativeThreshold: number;
  /** Absolute minimum above the gap level, in pixel-noise σ. */
  noiseSigmas: number;
}

export const DEFAULT_TRACK_DETECTOR: TrackDetectorSettings = { smoothingMm: 1.5, edgeMarginMm: 2.0, relativeThreshold: 0.15, noiseSigmas: 3.0 };

/** |pixel − background| for the rows between baseline (−3 mm) and front. */
export interface Residuals {
  width: number;
  rows: number;
  data: Float32Array;
  /** Robust pixel noise σ. */
  sigma: number;
}

export interface LaneExtent {
  leftMm: number;
  rightMm: number;
}

const laneCenter = (e: LaneExtent): number => (e.leftMm + e.rightMm) / 2;
const laneWidth = (e: LaneExtent): number => e.rightMm - e.leftMm;

/** Median of a float32 array; sorts it in place (as the tablet does). */
function medianF(values: Float32Array): number {
  values.sort();
  return values[toInt(values.length / 2)];
}

export const TrackDetector = {
  residuals(image: GrayImage, geometry: PlateGeometry, development: Development): Residuals | null {
    const yTop = Math.max(0, roundToInt(geometry.yMmToPx(development.solventFrontMm)) + 2);
    const yBottom = Math.min(image.height - 1, roundToInt(geometry.yMmToPx(development.baselineMm - 3.0)));
    if (yBottom - yTop < 3) return null;
    const w = image.width;
    const rows = yBottom - yTop + 1;

    const rowMedian = new Float32Array(rows);
    const rowBuf = new Float32Array(w);
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < w; x++) rowBuf[x] = image.get(x, yTop + r);
      rowMedian[r] = medianF(rowBuf);
    }
    const colMedian = new Float32Array(w);
    const colBuf = new Float32Array(rows);
    for (let x = 0; x < w; x++) {
      for (let r = 0; r < rows; r++) colBuf[r] = image.get(x, yTop + r);
      colMedian[x] = medianF(colBuf);
    }
    const overall = medianF(rowMedian.slice());

    const data = new Float32Array(rows * w);
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < w; x++) {
        data[r * w + x] = Math.abs(f(image.get(x, yTop + r) - f(f(colMedian[x] + rowMedian[r]) - overall)));
      }
    }
    const mad = medianF(data.slice());
    return { width: w, rows, data, sigma: Math.max(f(0.5), f(f(1.4826) * mad)) };
  },

  detect(image: GrayImage, geometry: PlateGeometry, development: Development, settings: TrackDetectorSettings = DEFAULT_TRACK_DETECTOR): number[] {
    const res = TrackDetector.residuals(image, geometry, development);
    if (!res) return [];
    const smooth = boxSmooth(TrackDetector.columnScore(res, geometry), Math.max(1, roundToInt(geometry.xMmToPx(settings.smoothingMm))));
    const w = smooth.length;
    const margin = clamp(roundToInt(geometry.xMmToPx(settings.edgeMarginMm)), 0, toInt(w / 4));

    const inner = smooth.slice(margin, w - margin).sort((a, b) => a - b);
    if (inner.length === 0) return [];
    const floor = inner[toInt(inner.length / 10)];
    const top = inner[inner.length - 1];
    const minProminence = Math.max((top - floor) * settings.relativeThreshold, settings.noiseSigmas * res.sigma);

    const candidates = PeakLocator.findPeaks(smooth, minProminence, 1)
      .filter((i) => smooth[i] - floor >= minProminence)
      .sort((a, b) => smooth[b] - smooth[a]);

    const accepted: number[] = [];
    for (const p of candidates) {
      const half = floor + (smooth[p] - floor) / 2;
      let l = p;
      while (l > 0 && smooth[l] > half) l--;
      let r = p;
      while (r < w - 1 && smooth[r] > half) r++;
      if (l <= margin || r >= w - 1 - margin) continue;
      const sameLane = accepted.some((q) => {
        const lo = Math.min(p, q);
        const hi = Math.max(p, q);
        let dip = Infinity;
        for (let i = lo; i <= hi; i++) dip = Math.min(dip, smooth[i]);
        return dip > floor + (Math.min(smooth[p], smooth[q]) - floor) / 2;
      });
      if (!sameLane) accepted.push(p);
    }
    return accepted.sort((a, b) => a - b).map((i) => geometry.xPxToMm(i));
  },

  /** How strongly each column carries a spot: the mean of its strongest 2 mm of residual. */
  columnScore(res: Residuals, geometry: PlateGeometry): number[] {
    const strongest = Math.min(Math.max(3, roundToInt(2.0 * geometry.pxPerMmY)), res.rows);
    const col = new Float32Array(res.rows);
    const out = new Array<number>(res.width);
    for (let x = 0; x < res.width; x++) {
      for (let r = 0; r < res.rows; r++) col[r] = res.data[r * res.width + x];
      col.sort();
      let s = 0;
      for (let i = res.rows - strongest; i < res.rows; i++) s += col[i];
      out[x] = s / strongest;
    }
    return out;
  },

  /** Horizontal extent of each lane's spots (null for lanes without a clear spot). */
  measureLanes(image: GrayImage, geometry: PlateGeometry, development: Development, centersMm: number[]): (LaneExtent | null)[] {
    if (centersMm.length === 0) return [];
    const res = TrackDetector.residuals(image, geometry, development);
    if (!res) return centersMm.map(() => null);
    const w = res.width;

    const sorted = res.data.slice().sort();
    const p999 = sorted[Math.min(toInt(sorted.length * 0.999), sorted.length - 1)];
    const threshold = Math.max(f(f(0.2) * p999), f(f(4) * res.sigma));

    const minRows = Math.max(1, roundToInt(geometry.pxPerMmY));
    const spotCount = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let r = 0; r < res.rows; r++) if (res.data[r * w + x] > threshold) n++;
      spotCount[x] = n;
    }

    const ordered = [...centersMm].sort((a, b) => a - b);
    return centersMm.map((c) => {
      const i = ordered.indexOf(c);
      const leftLimit = i > 0 ? (ordered[i - 1] + c) / 2 : 0;
      const rightLimit = i < ordered.length - 1 ? (ordered[i + 1] + c) / 2 : geometry.widthMm;
      const lo = clamp(roundToInt(geometry.xMmToPx(leftLimit)), 0, w - 1);
      const hi = clamp(roundToInt(geometry.xMmToPx(rightLimit)), 0, w - 1);
      const center = clamp(roundToInt(geometry.xMmToPx(c)), lo, hi);
      let maxCount = 0;
      for (let x = lo; x <= hi; x++) maxCount = Math.max(maxCount, spotCount[x]);
      const need = Math.max(minRows, roundToInt(0.1 * maxCount));
      const isSpot = (x: number): boolean => spotCount[x] >= need;
      let seed = -1;
      for (let x = lo; x <= hi; x++) {
        if (!isSpot(x)) continue;
        if (seed < 0 || Math.abs(x - center) < Math.abs(seed - center)) seed = x;
      }
      if (seed < 0) return null;
      let l = seed;
      while (l > lo && isSpot(l - 1)) l--;
      let r = seed;
      while (r < hi && isSpot(r + 1)) r++;
      return { leftMm: geometry.xPxToMm(l), rightMm: geometry.xPxToMm(r + 1) };
    });
  },

  /** One scan width for all tracks: the widest lane + 1 mm, never so wide that tracks overlap. */
  commonTrackWidthMm(extents: (LaneExtent | null)[], centersMm: number[]): number | null {
    const present = extents.filter((e): e is LaneExtent => e !== null);
    if (present.length === 0) return null;
    const widest = Math.max(...present.map(laneWidth));
    const sorted = [...centersMm].sort((a, b) => a - b);
    let minSpacing = Number.MAX_VALUE;
    for (let i = 1; i < sorted.length; i++) minSpacing = Math.min(minSpacing, sorted[i] - sorted[i - 1]);
    const width = Math.min(widest + 1.0, 0.9 * minSpacing, 40.0);
    return Math.max(Math.ceil(width * 2) / 2, 2.0);
  },
};

function boxSmooth(values: number[], width: number): number[] {
  const half = toInt(width / 2);
  const prefix = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    return (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  });
}

export interface LayoutResult {
  development: Development;
  trackCentersMm: number[];
  baselineFound: boolean;
  frontFound: boolean;
  widthEstimated: boolean;
}

export interface Lines {
  baselineMm: number | null;
  frontMm: number | null;
}

export const LayoutDetector = {
  detect(image: GrayImage, geometry: PlateGeometry, fallback: Development): LayoutResult {
    const lines = LayoutDetector.findLines(image, geometry);
    let baseline = lines.baselineMm ?? fallback.baselineMm;
    let front = lines.frontMm ?? fallback.solventFrontMm;
    if (front - baseline < 5.0) {
      baseline = fallback.baselineMm;
      front = fallback.solventFrontMm;
    }
    const search: Development = { baselineMm: baseline, solventFrontMm: front, trackWidthMm: fallback.trackWidthMm };
    const peaks = TrackDetector.detect(image, geometry, search);
    const extents = TrackDetector.measureLanes(image, geometry, search, peaks);
    const centers = peaks.map((p, i) => (extents[i] ? laneCenter(extents[i] as LaneExtent) : p));
    const width = TrackDetector.commonTrackWidthMm(extents, centers);
    return {
      development: { ...search, trackWidthMm: width ?? fallback.trackWidthMm },
      trackCentersMm: centers,
      baselineFound: lines.baselineMm !== null,
      frontFound: lines.frontMm !== null,
      widthEstimated: width !== null,
    };
  },

  /** Pencil baseline and solvent front: thin lines across the whole plate in the per-row median. */
  findLines(image: GrayImage, geometry: PlateGeometry): Lines {
    const rows = rowMedians(image);
    const window = Math.max(5, roundToInt(geometry.pxPerMmY * 6)) | 1;
    const trend = rollingMedian(rows, toInt(window / 2));
    const deviation = rows.map((v, i) => Math.abs(trend[i] - v));
    const sortedDev = [...deviation].sort((a, b) => a - b);
    const mad = sortedDev[toInt(sortedDev.length / 2)];
    const threshold = Math.max(4.0, 8 * mad);

    const edge = geometry.pxPerMmY * 1.5;
    const maxHalfWidth = Math.max(2.0, geometry.pxPerMmY * 1.2);
    const thin = (y: number): boolean => {
      let a = y;
      let b = y;
      while (a > 0 && deviation[a - 1] >= deviation[y] / 2) a--;
      while (b < deviation.length - 1 && deviation[b + 1] >= deviation[y] / 2) b++;
      return (b - a + 1) / 2.0 <= maxHalfWidth;
    };
    const reach = Math.max(2, roundToInt(geometry.pxPerMmY * 2));
    const acrossPlate = (y: number): boolean => {
      if (y - reach < 0 || y + reach >= image.height) return false;
      const sign = rows[y] < trend[y] ? -1 : 1;
      const x0 = roundToInt(image.width * 0.05);
      const x1 = roundToInt(image.width * 0.95);
      let hit = 0;
      let n = 0;
      for (let x = x0; x < x1; x++) {
        const around = f(image.get(x, y - reach) + image.get(x, y + reach)) / 2.0;
        if (sign * (image.get(x, y) - around) > threshold / 2) hit++;
        n++;
      }
      return n > 0 && hit >= 0.8 * n;
    };
    const strongestIn = (fromMm: number, toMm: number): number | null => {
      const yTop = clamp(roundToInt(geometry.yMmToPx(toMm)), 0, rows.length - 1);
      const yBottom = clamp(roundToInt(geometry.yMmToPx(fromMm)), 0, rows.length - 1);
      let best = -1;
      for (let y = yTop; y <= yBottom; y++) {
        if (y < edge || y > rows.length - 1 - edge) continue;
        if (deviation[y] < threshold || (best >= 0 && deviation[y] <= deviation[best])) continue;
        if (thin(y) && acrossPlate(y)) best = y;
      }
      return best < 0 ? null : geometry.yPxToMm(centroid(deviation, best));
    };
    const h = geometry.heightMm;
    return { baselineMm: strongestIn(0.0, 0.3 * h), frontMm: strongestIn(0.3 * h, h) };
  },
};

/** Sub-pixel line position: deviation-weighted mean over the line's few rows. */
function centroid(dev: number[], peak: number): number {
  let s = 0;
  let w = 0;
  for (let y = Math.max(0, peak - 3); y <= Math.min(dev.length - 1, peak + 3); y++) {
    if (dev[y] < dev[peak] / 2) continue;
    s += y * dev[y];
    w += dev[y];
  }
  return s / w + 0.5;
}

function rowMedians(image: GrayImage): number[] {
  const x0 = roundToInt(image.width * 0.05);
  const x1 = Math.max(roundToInt(image.width * 0.95), x0 + 1);
  const step = Math.max(1, toInt((x1 - x0) / 400));
  const size = toInt((x1 - x0 + step - 1) / step);
  const out = new Array<number>(image.height);
  for (let y = 0; y < image.height; y++) {
    const buf = new Float32Array(size);
    let k = 0;
    let x = x0;
    while (x < x1 && k < size) {
      buf[k++] = image.get(x, y);
      x += step;
    }
    const slice = buf.slice(0, k).sort();
    out[y] = slice[toInt(k / 2)];
  }
  return out;
}

function rollingMedian(values: number[], half: number): number[] {
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    const slice = values.slice(lo, hi + 1).sort((a, b) => a - b);
    return slice[toInt((hi - lo) / 2)];
  });
}
