/**
 * Plate geometry, outline, straightening and the simple (brightness / colour-distance) plate
 * finder, ported from the tablet engine (engine/plate). Plate coordinates follow TLC convention:
 * x from the left edge, y from the bottom edge (where samples are applied), both in mm.
 *
 * Not ported in this version: the tablet's full photo detector (edge lines, lighting surfaces,
 * framed plates — PlateDetector.kt lines 79–1500), which handles plates on trays under uneven
 * cabinet light. NxGen uses the brightness/colour route plus manual corners until phase 5.
 */
import { GrayImage, RgbImage, clamp, roundToInt, toInt } from './image';
import { LinearAlgebra } from './linear-algebra';

export interface Point {
  x: number;
  y: number;
}

/** Plate corners in source-image pixels, clockwise from the top left. */
export interface Quad {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export const quadCorners = (q: Quad): Point[] => [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft];

export function quadFrom(corners: Point[]): Quad {
  if (corners.length !== 4) throw new Error('A quad needs four corners');
  return { topLeft: corners[0], topRight: corners[1], bottomRight: corners[2], bottomLeft: corners[3] };
}

/** Shoelace area. */
export function quadArea(q: Quad): number {
  const c = quadCorners(q);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Mean width over mean height of the outline: the plate's proportions as photographed. */
export function quadAspect(q: Quad): number {
  const top = Math.hypot(q.topRight.x - q.topLeft.x, q.topRight.y - q.topLeft.y);
  const bottom = Math.hypot(q.bottomRight.x - q.bottomLeft.x, q.bottomRight.y - q.bottomLeft.y);
  const left = Math.hypot(q.bottomLeft.x - q.topLeft.x, q.bottomLeft.y - q.topLeft.y);
  const right = Math.hypot(q.bottomRight.x - q.topRight.x, q.bottomRight.y - q.topRight.y);
  return (top + bottom) / (left + right);
}

export function quadScaled(q: Quad, factor: number): Quad {
  const s = (p: Point): Point => ({ x: p.x * factor, y: p.y * factor });
  return { topLeft: s(q.topLeft), topRight: s(q.topRight), bottomRight: s(q.bottomRight), bottomLeft: s(q.bottomLeft) };
}

export interface PlateDetection {
  quad: Quad;
  threshold: number;
  /** blob area / quad area, ~1 for a clean rectangle. */
  fill: number;
  /** Share of the outline's inside that is plate; 1 for a solid rectangle. */
  solid: number;
  /** Lowest share, over the four sides, of the side that runs along plate. */
  edges: number;
}

/** Maps between pixels of a cropped, straightened plate image and plate millimetres. */
export class PlateGeometry {
  constructor(
    readonly widthPx: number,
    readonly heightPx: number,
    readonly widthMm: number,
    readonly heightMm: number,
  ) {
    if (!(widthPx > 0 && heightPx > 0 && widthMm > 0 && heightMm > 0)) throw new Error('Plate geometry must be positive');
  }
  get pxPerMmX(): number {
    return this.widthPx / this.widthMm;
  }
  get pxPerMmY(): number {
    return this.heightPx / this.heightMm;
  }
  xMmToPx(xMm: number): number {
    return xMm * this.pxPerMmX;
  }
  xPxToMm(xPx: number): number {
    return xPx / this.pxPerMmX;
  }
  yMmToPx(yMm: number): number {
    return this.heightPx - yMm * this.pxPerMmY;
  }
  yPxToMm(yPx: number): number {
    return (this.heightPx - yPx) / this.pxPerMmY;
  }
}

/** Development geometry shared by all tracks unless a track overrides it. */
export interface Development {
  baselineMm: number;
  solventFrontMm: number;
  trackWidthMm: number;
}

export const DEFAULT_DEVELOPMENT: Development = { baselineMm: 10, solventFrontMm: 70, trackWidthMm: 6 };

export function validateDevelopment(d: Development): string[] {
  const p: string[] = [];
  if (!(d.solventFrontMm > d.baselineMm)) p.push('Solvent front must be above the baseline');
  if (!(d.trackWidthMm > 0)) p.push('Track width must be positive');
  return p;
}

export interface Track {
  id: number;
  name: string;
  centerMm: number;
  sampleVolumeUl?: number | null;
  /** Known concentration for reference tracks, in the evaluation's concentration unit. */
  concentration?: number | null;
  isReference?: boolean;
  /** Samples only: the applied solution was diluted this many times. */
  dilutionFactor?: number | null;
  baselineOverrideMm?: number | null;
  solventFrontOverrideMm?: number | null;
  note?: string;
  /** Reaction monitoring: minutes from the start; null when not a time point. */
  timeMin?: number | null;
  sampleId?: string;
}

export const trackBaselineMm = (t: Track, dev: Development): number => t.baselineOverrideMm ?? dev.baselineMm;
export const trackFrontMm = (t: Track, dev: Development): number => t.solventFrontOverrideMm ?? dev.solventFrontMm;
/** Amount applied, e.g. mg/ml × µl = µg; null if volume or concentration is missing. */
export const appliedAmount = (t: Track): number | null =>
  t.sampleVolumeUl != null && t.concentration != null ? t.sampleVolumeUl * t.concentration : null;

export const Rf = {
  rf(positionMm: number, baselineMm: number, solventFrontMm: number): number {
    if (!(solventFrontMm > baselineMm)) throw new Error('Solvent front must be above the baseline');
    return (positionMm - baselineMm) / (solventFrontMm - baselineMm);
  },
  hRf(positionMm: number, baselineMm: number, solventFrontMm: number): number {
    return 100.0 * Rf.rf(positionMm, baselineMm, solventFrontMm);
  },
  positionMm(hRf: number, baselineMm: number, solventFrontMm: number): number {
    return baselineMm + (hRf / 100.0) * (solventFrontMm - baselineMm);
  },
};

/** Projective transform mapping (u, v) in the output rectangle to (x, y) in the source image. */
export class Homography {
  private constructor(private readonly h: number[]) {}

  map(u: number, v: number): Point {
    const h = this.h;
    const w = h[6] * u + h[7] * v + 1.0;
    return { x: (h[0] * u + h[1] * v + h[2]) / w, y: (h[3] * u + h[4] * v + h[5]) / w };
  }

  /** The transform taking the four `from` points onto the four `to` points. */
  static fromPoints(from: Point[], to: Point[]): Homography {
    if (from.length !== 4 || to.length !== 4) throw new Error('Four point pairs needed');
    const a: number[][] = [];
    const b: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { x: u, y: v } = from[i];
      const { x, y } = to[i];
      a.push([u, v, 1.0, 0.0, 0.0, 0.0, -u * x, -v * x]);
      b.push(x);
      a.push([0.0, 0.0, 0.0, u, v, 1.0, -u * y, -v * y]);
      b.push(y);
    }
    return new Homography(LinearAlgebra.solve(a, b));
  }
}

export const PlateRectifier = {
  /**
   * Output size with the plate's real proportions, at the better of the two resolutions the
   * photo offers, so neither direction is squashed below what the camera captured.
   */
  outputSize(quad: Quad, widthMm: number, heightMm: number): { width: number; height: number } {
    const top = Math.hypot(quad.topRight.x - quad.topLeft.x, quad.topRight.y - quad.topLeft.y);
    const bottom = Math.hypot(quad.bottomRight.x - quad.bottomLeft.x, quad.bottomRight.y - quad.bottomLeft.y);
    const left = Math.hypot(quad.bottomLeft.x - quad.topLeft.x, quad.bottomLeft.y - quad.topLeft.y);
    const right = Math.hypot(quad.bottomRight.x - quad.topRight.x, quad.bottomRight.y - quad.topRight.y);
    const pxPerMm = Math.max((top + bottom) / 2 / widthMm, (left + right) / 2 / heightMm);
    return { width: Math.max(1, roundToInt(widthMm * pxPerMm)), height: Math.max(1, roundToInt(heightMm * pxPerMm)) };
  },

  /** Crops and straightens the plate with bilinear sampling. */
  rectify(src: RgbImage, quad: Quad, outW: number, outH: number): RgbImage {
    const dst: Point[] = [
      { x: 0, y: 0 },
      { x: outW - 1, y: 0 },
      { x: outW - 1, y: outH - 1 },
      { x: 0, y: outH - 1 },
    ];
    const hm = Homography.fromPoints(dst, quadCorners(quad));
    const out = new Int32Array(outW * outH);
    for (let v = 0; v < outH; v++) {
      for (let u = 0; u < outW; u++) {
        const p = hm.map(u, v);
        out[v * outW + u] = bilinearArgb(src, p.x, p.y);
      }
    }
    return new RgbImage(outW, outH, out);
  },
};

function bilinearArgb(img: RgbImage, x: number, y: number): number {
  const cx = clamp(x, 0, img.width - 1);
  const cy = clamp(y, 0, img.height - 1);
  const x0 = toInt(cx);
  const y0 = toInt(cy);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const p00 = img.get(x0, y0);
  const p10 = img.get(x1, y0);
  const p01 = img.get(x0, y1);
  const p11 = img.get(x1, y1);
  let result = 0xff << 24;
  for (const shift of [16, 8, 0]) {
    const c00 = (p00 >> shift) & 0xff;
    const c10 = (p10 >> shift) & 0xff;
    const c01 = (p01 >> shift) & 0xff;
    const c11 = (p11 >> shift) & 0xff;
    const top = c00 + (c10 - c00) * fx;
    const bottom = c01 + (c11 - c01) * fx;
    const c = clamp(roundToInt(top + (bottom - top) * fy), 0, 255);
    result = result | (c << shift);
  }
  return result | 0;
}

export const PlateDetector = {
  /** Per-pixel colour distance from the median border colour, scaled to 0..255. */
  colorDistanceFromBorder(rgb: RgbImage, borderFraction = 0.03): GrayImage {
    const w = rgb.width;
    const h = rgb.height;
    const band = Math.max(1, roundToInt(Math.min(w, h) * borderFraction));
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const step = Math.max(1, toInt((w + h) / 2000));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        const p = rgb.get(x, y);
        rs.push((p >> 16) & 0xff);
        gs.push((p >> 8) & 0xff);
        bs.push(p & 0xff);
      }
    }
    const median = (v: number[]): number => v.sort((a, b) => a - b)[toInt(v.length / 2)];
    const br = median(rs);
    const bg = median(gs);
    const bb = median(bs);
    const out = new Float32Array(w * h);
    const three = Math.fround(3);
    for (let i = 0; i < out.length; i++) {
      const p = rgb.pixels[i];
      const d = Math.abs(((p >> 16) & 0xff) - br) + Math.abs(((p >> 8) & 0xff) - bg) + Math.abs((p & 0xff) - bb);
      out[i] = Math.min(Math.fround(Math.fround(d) / three), 255);
    }
    return new GrayImage(w, h, out);
  },

  /** Largest bright blob above the Otsu threshold, boxed by its diagonal extremes. */
  detect(gray: GrayImage, minAreaFraction = 0.05): PlateDetection | null {
    const w = gray.width;
    const h = gray.height;
    const n = w * h;
    const threshold = PlateDetector.otsuThreshold(gray);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = gray.data[i] > threshold ? 1 : 0;

    const label = new Int32Array(n);
    const stack = new Int32Array(n);
    let bestLabel = 0;
    let bestSize = 0;
    let next = 0;
    for (let start = 0; start < n; start++) {
      if (!mask[start] || label[start] !== 0) continue;
      next++;
      let size = 0;
      let sp = 0;
      const visit = (j: number): void => {
        if (mask[j] && label[j] === 0) {
          label[j] = next;
          stack[sp++] = j;
        }
      };
      visit(start);
      while (sp > 0) {
        const i = stack[--sp];
        size++;
        const x = i % w;
        const y = toInt(i / w);
        if (x > 0) visit(i - 1);
        if (x < w - 1) visit(i + 1);
        if (y > 0) visit(i - w);
        if (y < h - 1) visit(i + w);
      }
      if (size > bestSize) {
        bestSize = size;
        bestLabel = next;
      }
    }
    if (bestLabel === 0 || bestSize < minAreaFraction * n) return null;

    let tl = 0;
    let tr = 0;
    let br = 0;
    let bl = 0;
    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDiff = Infinity;
    let maxDiff = -Infinity;
    for (let i = 0; i < n; i++) {
      if (label[i] !== bestLabel) continue;
      const x = i % w;
      const y = toInt(i / w);
      const s = x + y;
      const d = x - y;
      if (s < minSum) {
        minSum = s;
        tl = i;
      }
      if (s > maxSum) {
        maxSum = s;
        br = i;
      }
      if (d > maxDiff) {
        maxDiff = d;
        tr = i;
      }
      if (d < minDiff) {
        minDiff = d;
        bl = i;
      }
    }
    const pt = (i: number): Point => ({ x: i % w, y: toInt(i / w) });
    const quad: Quad = { topLeft: pt(tl), topRight: pt(tr), bottomRight: pt(br), bottomLeft: pt(bl) };
    const area = quadArea(quad);
    return { quad, threshold, fill: area > 0 ? bestSize / area : 0, solid: 1, edges: 1 };
  },

  otsuThreshold(gray: GrayImage): number {
    const hist = new Int32Array(256);
    for (let i = 0; i < gray.data.length; i++) hist[clamp(roundToInt(gray.data[i]), 0, 255)]++;
    const total = gray.data.length;
    let sumAll = 0;
    for (let i = 0; i <= 255; i++) sumAll += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let threshold = 127;
    for (let t = 0; t <= 255; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        threshold = t;
      }
    }
    return threshold;
  },
};

/** Plate size presets offered in the crop step, in mm (width × height as laid on the bench). */
export const PLATE_PRESETS: { label: string; widthMm: number; heightMm: number }[] = [
  { label: '20 × 10 cm', widthMm: 200, heightMm: 100 },
  { label: '10 × 10 cm', widthMm: 100, heightMm: 100 },
  { label: '5 × 10 cm', widthMm: 50, heightMm: 100 },
  { label: '10 × 5 cm', widthMm: 100, heightMm: 50 },
  { label: '20 × 20 cm', widthMm: 200, heightMm: 200 },
  { label: '10 × 20 cm', widthMm: 100, heightMm: 200 },
  { label: '2.5 × 7.5 cm', widthMm: 25, heightMm: 75 },
];

/** The preset whose proportions match the outline within ±12 %, if any. */
export function matchPreset(quad: Quad): (typeof PLATE_PRESETS)[number] | null {
  const aspect = quadAspect(quad);
  let best: (typeof PLATE_PRESETS)[number] | null = null;
  let bestErr = Infinity;
  for (const p of PLATE_PRESETS) {
    const err = Math.abs(aspect / (p.widthMm / p.heightMm) - 1);
    if (err <= 0.12 && err < bestErr) {
      best = p;
      bestErr = err;
    }
  }
  return best;
}
