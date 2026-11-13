/**
 * Capture quality gate, ported from the tablet engine (engine/capture/CaptureQc.kt). Works on
 * the whole photo (ideally ~1200 px on the long side), the plate outline and, for live
 * captures, how much the plate moved before the shutter. Problems that lose information are
 * never repaired afterwards; they lead to a retake.
 */
import { RgbImage, clamp, maxChannel, roundToInt, toInt } from './image';
import { Development, PlateDetection, PlateGeometry, PlateRectifier, PlateDetector, Point, Quad, Track, quadArea, quadAspect, quadCorners, trackBaselineMm, trackFrontMm } from './plate';
import { Illumination, SpotPolarity, polarityOf } from './signal';

export type QcCheck =
  | 'FOCUS'
  | 'EXPOSURE'
  | 'HIGHLIGHT_CLIPPING'
  | 'UNDEREXPOSURE'
  | 'COMPLETENESS'
  | 'POSITIONING'
  | 'PERSPECTIVE'
  | 'UNIFORMITY'
  | 'GLARE'
  | 'OBSTRUCTION'
  | 'STABILITY';

export const QC_CHECKS: QcCheck[] = ['FOCUS', 'EXPOSURE', 'HIGHLIGHT_CLIPPING', 'UNDEREXPOSURE', 'COMPLETENESS', 'POSITIONING', 'PERSPECTIVE', 'UNIFORMITY', 'GLARE', 'OBSTRUCTION', 'STABILITY'];

export const QC_CHECK_LABELS: Record<QcCheck, string> = {
  FOCUS: 'Focus',
  EXPOSURE: 'Exposure',
  HIGHLIGHT_CLIPPING: 'Highlight clipping',
  UNDEREXPOSURE: 'Underexposure',
  COMPLETENESS: 'Plate completeness',
  POSITIONING: 'Plate positioning',
  PERSPECTIVE: 'Perspective',
  UNIFORMITY: 'Illumination uniformity',
  GLARE: 'Glare',
  OBSTRUCTION: 'Obstruction',
  STABILITY: 'Image stability',
};

export type QcStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT_ASSESSED';
export type QcAction = 'NONE' | 'REVIEW' | 'ADJUST_AND_RETAKE' | 'RECAPTURE' | 'REPOSITION';
export type CaptureVerdict = 'READY' | 'REVIEW' | 'RECAPTURE_REQUIRED';

export const CAPTURE_VERDICT_LABELS: Record<CaptureVerdict, string> = { READY: 'READY', REVIEW: 'REVIEW', RECAPTURE_REQUIRED: 'RECAPTURE REQUIRED' };

export interface QcItem {
  check: QcCheck;
  status: QcStatus;
  /** The measured quantity, in `unit`; null when not measured. */
  value: number | null;
  unit: string;
  message: string;
  action: QcAction;
}

/** Brightness figures of the plate area, on the brightest colour channel (0..255). */
export interface ExposureStats {
  /** Share of plate pixels with a saturated channel. */
  clippedFraction: number;
  /** Share of plate pixels whose overall brightness (luma) is saturated. */
  lumaClippedFraction: number;
  /** Share of plate pixels that are practically black. */
  darkFraction: number;
  /** Typical plate background level. */
  background: number;
  /** Brightest 0.5 % (bright spots under UV 366). */
  highlight: number;
}

export interface QcReport {
  items: QcItem[];
  stats: ExposureStats | null;
  /** Exposure change (EV, + = brighter) that would bring the plate to the target level. */
  exposureEv: number | null;
}

export interface QcInput {
  /** Whole photo, ideally ~1000–1600 px on the long side. */
  image: RgbImage;
  /** Plate outline in image coordinates; null if none was found. */
  detection: PlateDetection | null;
  illumination: Illumination;
  /** True for camera captures (the camera can retake), false for uploaded files. */
  fromCamera: boolean;
  /** Largest movement of the plate corners over the last second, ‰ of the image's long side. */
  motion?: number | null;
  /** Low-resolution preview frame: focus is not judged. */
  live?: boolean;
}

export const CLIP_LEVEL = 252;
const TARGET_LEVEL = 200.0;
const RADIANS_TO_DEGREES = 57.29577951308232;

const item = (check: QcCheck, status: QcStatus, message: string, action: QcAction = 'NONE', value: number | null = null, unit = ''): QcItem => ({
  check,
  status,
  value,
  unit,
  message,
  action,
});

/** Java's "%.1f" for the non-negative values formatted here. */
const f1 = (v: number): string => v.toFixed(1);

export function verdictOf(report: QcReport): CaptureVerdict {
  if (report.items.some((i) => i.status === 'FAIL')) return 'RECAPTURE_REQUIRED';
  if (report.items.some((i) => i.status === 'WARN')) return 'REVIEW';
  return 'READY';
}

export const problemsOf = (report: QcReport): QcItem[] => report.items.filter((i) => i.status === 'WARN' || i.status === 'FAIL');
export const qcItem = (report: QcReport, check: QcCheck): QcItem | null => report.items.find((i) => i.check === check) ?? null;

/** EV correction for an automatic retake: only when exposure is the reason and nothing needs the user. */
export function autoRetakeEv(report: QcReport): number | null {
  const p = problemsOf(report);
  if (!p.some((i) => i.action === 'ADJUST_AND_RETAKE')) return null;
  if (p.some((i) => i.status === 'FAIL' && i.action !== 'ADJUST_AND_RETAKE')) return null;
  return report.exposureEv !== null && Math.abs(report.exposureEv) >= 0.3 ? report.exposureEv : null;
}

export const CaptureQc = {
  evaluate(input: QcInput): QcReport {
    const img = input.image;
    const w = img.width;
    const h = img.height;
    const det = input.detection && input.detection.fill >= 0.6 && CaptureQc.isPlausiblePlate(input.detection.quad) ? input.detection : null;
    const fullFrame = det !== null && isFullFrame(det.quad, w, h);
    const quad: Quad = det?.quad ?? { topLeft: { x: 0, y: 0 }, topRight: { x: w - 1, y: 0 }, bottomRight: { x: w - 1, y: h - 1 }, bottomLeft: { x: 0, y: h - 1 } };
    const items: QcItem[] = [];

    items.push(completeness(input, det, fullFrame));
    items.push(positioning(det, fullFrame, w, h));
    items.push(perspective(det, fullFrame));

    const small = rectifySmall(img, quad);
    const polarity = polarityOf(input.illumination);
    const stats = CaptureQc.exposureStats(small, polarity);
    const ev = CaptureQc.exposureEv(stats, polarity);
    items.push(exposure(stats, ev));
    const glareItem = glare(small, stats, polarity);
    items.push(clipping(stats, polarity, input.fromCamera, glareItem.status !== 'PASS'));
    items.push(underexposure(stats, polarity, input.fromCamera));
    items.push(uniformity(small, polarity));
    items.push(glareItem);
    items.push(obstruction(det, fullFrame));
    items.push(focus(input, det, fullFrame));
    items.push(stability(input));

    items.sort((a, b) => QC_CHECKS.indexOf(a.check) - QC_CHECKS.indexOf(b.check));
    return { items, stats, exposureEv: ev };
  },

  /** Roughly rectangular: corners within 35° of square and no side collapsed (shortest ≥ 15 % of longest). */
  isPlausiblePlate(q: Quad): boolean {
    const c = quadCorners(q);
    const sides = [0, 1, 2, 3].map((i) => Math.hypot(c[(i + 1) % 4].x - c[i].x, c[(i + 1) % 4].y - c[i].y));
    return Math.min(...sides) >= 0.15 * Math.max(...sides) && CaptureQc.cornerAngleDeviation(q) < 35;
  },

  /** Turn of the plate's top edge from the nearest frame axis, degrees (+ = clockwise on screen). */
  rotationDegrees(q: Quad): number {
    const a = Math.atan2(q.topRight.y - q.topLeft.y, q.topRight.x - q.topLeft.x) * RADIANS_TO_DEGREES;
    return ((((a + 45) % 90) + 90) % 90) - 45;
  },

  /** Largest deviation of a corner angle from 90°, in degrees. */
  cornerAngleDeviation(q: Quad): number {
    const c = quadCorners(q);
    let worst = 0;
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      const a = c[(i + 3) % 4];
      const b = c[(i + 1) % 4];
      const ux = a.x - p.x;
      const uy = a.y - p.y;
      const vx = b.x - p.x;
      const vy = b.y - p.y;
      const cos = clamp((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)), -1, 1);
      worst = Math.max(worst, Math.abs(Math.acos(cos) * RADIANS_TO_DEGREES - 90));
    }
    return worst;
  },

  exposureStats(plate: RgbImage, polarity: SpotPolarity): ExposureStats {
    const n = plate.pixels.length;
    const m = new Int32Array(n);
    let clipped = 0;
    let lumaClipped = 0;
    let dark = 0;
    for (let i = 0; i < n; i++) {
      const p = plate.pixels[i];
      const v = maxChannel(p);
      m[i] = v;
      if (v >= CLIP_LEVEL) clipped++;
      if (0.299 * ((p >> 16) & 0xff) + 0.587 * ((p >> 8) & 0xff) + 0.114 * (p & 0xff) >= CLIP_LEVEL - 2) lumaClipped++;
      if (v <= 6) dark++;
    }
    return {
      clippedFraction: clipped / n,
      lumaClippedFraction: lumaClipped / n,
      darkFraction: dark / n,
      background: percentile(m, polarity === 'DARK' ? 0.7 : 0.3),
      highlight: percentile(m, 0.995),
    };
  },

  /** EV that brings the plate background (dark spots) or the spots (bright spots) to the target. */
  exposureEv(s: ExposureStats, polarity: SpotPolarity): number {
    const level = polarity === 'DARK' ? s.background : s.highlight;
    const clippedTooMuch = polarity === 'DARK' ? s.clippedFraction > 0.25 : s.clippedFraction > 0.01;
    if (clippedTooMuch) return -1.0;
    return clamp(Math.log(TARGET_LEVEL / Math.max(level, 1.0)) / Math.log(2.0), -2.0, 3.0);
  },

  /**
   * Sharpness from the plate's own edges: the 10–90 % rise distance of intensity profiles across
   * the four sides, as ‰ of the plate's long side (median of all usable profiles).
   */
  edgeBlur(image: RgbImage, quad: Quad): number | null {
    const dist = PlateDetector.colorDistanceFromBorder(image);
    const c = quadCorners(quad);
    const sides: [Point, Point][] = [0, 1, 2, 3].map((i) => [c[i], c[(i + 1) % 4]]);
    const longSide = Math.max(...sides.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y)));
    const reach = Math.max(8.0, 0.03 * longSide);
    const step = 0.5;
    const n = toInt((2 * reach) / step) + 1;
    const widths: number[] = [];
    for (const [a, b] of sides) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 20) continue;
      const dx = (b.x - a.x) / len;
      const dy = (b.y - a.y) / len;
      const nx = dy;
      const ny = -dx;
      let t = 0.15;
      while (t <= 0.851) {
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        const profile = new Array<number>(n);
        for (let i = 0; i < n; i++) {
          const s = -reach + i * step;
          profile[i] = dist.sample(px + nx * s, py + ny * s);
        }
        const k = Math.max(2, toInt(n / 5));
        const inner = profile.slice(0, k).sort((p, q) => p - q)[toInt(k / 2)];
        const outer = profile.slice(n - k, n).sort((p, q) => p - q)[toInt(k / 2)];
        const contrast = inner - outer;
        if (Math.abs(contrast) >= 25) {
          let between = 0;
          for (const v of profile) {
            const r = (v - outer) / contrast;
            if (r > 0.1 && r < 0.9) between++;
          }
          widths.push(between * step);
        }
        t += 0.05;
      }
    }
    if (widths.length < 12) return null;
    const median = widths.sort((p, q) => p - q)[toInt(widths.length / 2)];
    return (median / longSide) * 1000;
  },

  /** Picks the analytical source among candidate exposures: best verdict, then no clipping, then nearest the target. */
  selectExposure(reports: QcReport[], labels: string[]): { index: number; reason: string } {
    if (reports.length === 0 || reports.length !== labels.length) throw new Error('reports and labels must match');
    const verdictRank: Record<CaptureVerdict, number> = { READY: 0, REVIEW: 1, RECAPTURE_REQUIRED: 2 };
    const key = (i: number): [number, number, number] => [
      verdictRank[verdictOf(reports[i])],
      (qcItem(reports[i], 'HIGHLIGHT_CLIPPING')?.status ?? 'PASS') === 'PASS' ? 0 : 1,
      Math.abs(reports[i].exposureEv ?? 0),
    ];
    let best = 0;
    for (let i = 1; i < reports.length; i++) {
      const a = key(i);
      const b = key(best);
      if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) best = i;
    }
    const r = reports[best];
    const clipping = qcItem(r, 'HIGHLIGHT_CLIPPING')?.status === 'PASS';
    const ev = r.exposureEv !== null ? `${r.exposureEv >= 0 ? '+' : '-'}${f1(Math.abs(r.exposureEv))} EV from target` : 'exposure unknown';
    const reason = `${labels[best]} selected: ${CAPTURE_VERDICT_LABELS[verdictOf(r)].toLowerCase()}, ${clipping ? 'no highlight clipping' : 'least clipping'}, ${ev}.`;
    return { index: best, reason };
  },

  /** Share of saturated pixels inside the lanes between baseline and solvent front. */
  analyticalSaturation(plate: RgbImage, geometry: PlateGeometry, development: Development, tracks: Track[]): number {
    if (tracks.length === 0) return 0;
    let total = 0;
    let clipped = 0;
    const half = development.trackWidthMm / 2;
    for (const t of tracks) {
      const x0 = clamp(roundToInt(geometry.xMmToPx(t.centerMm - half)), 0, plate.width - 1);
      const x1 = clamp(roundToInt(geometry.xMmToPx(t.centerMm + half)), 0, plate.width - 1);
      const yTop = clamp(roundToInt(geometry.yMmToPx(trackFrontMm(t, development))), 0, plate.height - 1);
      const yBottom = clamp(roundToInt(geometry.yMmToPx(trackBaselineMm(t, development))), 0, plate.height - 1);
      for (let y = Math.min(yTop, yBottom); y <= Math.max(yTop, yBottom); y++) {
        for (let x = x0; x <= x1; x++) {
          total++;
          if (maxChannel(plate.get(x, y)) >= CLIP_LEVEL + 2) clipped++;
        }
      }
    }
    return total === 0 ? 0 : clipped / total;
  },

  /** Mean absolute difference of two equally sized frames' intensities, 0..255. */
  frameDifference(a: RgbImage, b: RgbImage): number {
    if (a.width !== b.width || a.height !== b.height) throw new Error('Frames must have the same size');
    let sum = 0;
    for (let i = 0; i < a.pixels.length; i++) sum += Math.abs(maxChannel(a.pixels[i]) - maxChannel(b.pixels[i]));
    return sum / a.pixels.length;
  },
};

function isFullFrame(q: Quad, w: number, h: number): boolean {
  const tol = 1.5;
  return (
    Math.abs(q.topLeft.x) < tol &&
    Math.abs(q.topLeft.y) < tol &&
    Math.abs(q.bottomRight.x - (w - 1)) < tol &&
    Math.abs(q.bottomRight.y - (h - 1)) < tol &&
    Math.abs(q.topRight.x - (w - 1)) < tol &&
    Math.abs(q.bottomLeft.y - (h - 1)) < tol
  );
}

function completeness(input: QcInput, det: PlateDetection | null, fullFrame: boolean): QcItem {
  const c: QcCheck = 'COMPLETENESS';
  if (det === null) {
    return input.fromCamera
      ? item(c, 'FAIL', 'Plate not found in the frame. Place it on a contrasting background, fully in view.', 'REPOSITION')
      : item(c, 'WARN', 'Plate edges not found; outline the plate by hand in the Crop step.', 'REVIEW');
  }
  if (fullFrame) {
    return input.fromCamera
      ? item(c, 'FAIL', 'Plate edges are not visible. Move back so all four edges are in the frame.', 'REPOSITION')
      : item(c, 'NOT_ASSESSED', 'Image is already cropped to the plate.');
  }
  const w = input.image.width;
  const h = input.image.height;
  const margin = Math.max(2.0, 0.006 * Math.max(w, h));
  const corners = quadCorners(det.quad);
  const touching = corners.filter((p) => p.x < margin || p.y < margin || p.x > w - 1 - margin || p.y > h - 1 - margin).length;
  if (touching > 0) {
    const moves: string[] = [];
    if (corners.some((p) => p.x < margin)) moves.push('right');
    if (corners.some((p) => p.x > w - 1 - margin)) moves.push('left');
    if (corners.some((p) => p.y < margin)) moves.push('down');
    if (corners.some((p) => p.y > h - 1 - margin)) moves.push('up');
    const hint =
      moves.length >= 3 || (moves.includes('left') && moves.includes('right')) || (moves.includes('up') && moves.includes('down'))
        ? 'Move the tablet further away.'
        : `Move the plate ${moves.join(' and ')}.`;
    return item(c, 'FAIL', `Plate is cut off at the image edge. ${hint}`, 'REPOSITION', touching, 'corners');
  }
  return item(c, 'PASS', 'Whole plate is in the image.');
}

function positioning(det: PlateDetection | null, fullFrame: boolean, w: number, h: number): QcItem {
  const c: QcCheck = 'POSITIONING';
  if (det === null || fullFrame) return item(c, 'NOT_ASSESSED', 'No plate outline to judge.');
  const q = det.quad;
  const share = quadArea(q) / (w * h);
  const corners = quadCorners(q);
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4 / w;
  const cy = corners.reduce((s, p) => s + p.y, 0) / 4 / h;
  const offCentre = Math.max(Math.abs(cx - 0.5), Math.abs(cy - 0.5));
  const pct = share * 100;
  const rotation = CaptureQc.rotationDegrees(q);
  if (share < 0.03) return item(c, 'FAIL', `Plate fills only ${roundToInt(pct)} % of the frame. Move closer (or zoom in).`, 'REPOSITION', pct, '% of frame');
  if (share < 0.06) return item(c, 'WARN', `Plate fills only ${roundToInt(pct)} % of the frame; move closer or zoom in for more detail.`, 'REPOSITION', pct, '% of frame');
  if (offCentre > 0.2) {
    const moves: string[] = [];
    if (cx < 0.3) moves.push('right');
    else if (cx > 0.7) moves.push('left');
    if (cy < 0.3) moves.push('down');
    else if (cy > 0.7) moves.push('up');
    return item(c, 'WARN', `Plate is off-centre: move it ${moves.join(' and ')}.`, 'REPOSITION', pct, '% of frame');
  }
  if (Math.abs(rotation) > 8) {
    return item(
      c,
      'WARN',
      `Plate is turned ${roundToInt(Math.abs(rotation))}° ${rotation > 0 ? 'clockwise' : 'anticlockwise'}; turn it back to line up with the frame.`,
      'REPOSITION',
      pct,
      '% of frame',
    );
  }
  return item(c, 'PASS', `Plate position OK (${roundToInt(pct)} % of the frame).`, 'NONE', pct, '% of frame');
}

function perspective(det: PlateDetection | null, fullFrame: boolean): QcItem {
  const c: QcCheck = 'PERSPECTIVE';
  if (det === null || fullFrame) return item(c, 'NOT_ASSESSED', 'No plate outline to judge.');
  const dev = CaptureQc.cornerAngleDeviation(det.quad);
  if (dev > 25) return item(c, 'FAIL', `Strong perspective (${roundToInt(dev)}°). Hold the tablet parallel to the plate.`, 'RECAPTURE', dev, '°');
  if (dev > 10) return item(c, 'WARN', `Plate photographed at an angle (${roundToInt(dev)}°); straightening corrects it, but parallel is better.`, 'REVIEW', dev, '°');
  return item(c, 'PASS', 'Camera is parallel to the plate.', 'NONE', dev, '°');
}

/** Plate straightened to ≤ 480 px with a 3 % inset so plate edges and background do not count. */
function rectifySmall(img: RgbImage, quad: Quad): RgbImage {
  const aspect = clamp(quadAspect(quad), 0.1, 10.0);
  const ow = aspect >= 1 ? 480 : Math.max(8, roundToInt(480 * aspect));
  const oh = aspect >= 1 ? Math.max(8, roundToInt(480 / aspect)) : 480;
  return PlateRectifier.rectify(img, insetQuad(quad, 0.03), ow, oh);
}

function insetQuad(q: Quad, fr: number): Quad {
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  return {
    topLeft: lerp(q.topLeft, q.bottomRight, fr),
    topRight: lerp(q.topRight, q.bottomLeft, fr),
    bottomRight: lerp(q.bottomRight, q.topLeft, fr),
    bottomLeft: lerp(q.bottomLeft, q.topRight, fr),
  };
}

function percentile(values: Int32Array, q: number): number {
  if (values.length === 0) return 0;
  const hist = new Int32Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i]]++;
  const target = q * (values.length - 1);
  let acc = 0;
  for (let i = 0; i <= 255; i++) {
    acc += hist[i];
    if (acc > target) return i;
  }
  return 255;
}

function exposure(s: ExposureStats, ev: number): QcItem {
  const c: QcCheck = 'EXPOSURE';
  const dir = ev > 0 ? 'under' : 'over';
  if (Math.abs(ev) <= 0.5) return item(c, 'PASS', `Exposure on target (level ${roundToInt(s.background)}).`, 'NONE', ev, 'EV');
  return item(c, 'WARN', `Plate is ${dir}exposed by ${f1(Math.abs(ev))} EV.`, 'ADJUST_AND_RETAKE', ev, 'EV');
}

function clipping(s: ExposureStats, polarity: SpotPolarity, fromCamera: boolean, glareSeen: boolean): QcItem {
  const c: QcCheck = 'HIGHLIGHT_CLIPPING';
  const pct = s.clippedFraction * 100;
  const lumaPct = s.lumaClippedFraction * 100;
  const action: QcAction = glareSeen ? 'RECAPTURE' : fromCamera ? 'ADJUST_AND_RETAKE' : 'RECAPTURE';
  const fmt = f1(pct);
  if (polarity === 'BRIGHT') {
    if (pct > 0.5) return item(c, 'FAIL', `${fmt} % of the plate is saturated; spot intensities there are lost.`, action, pct, '% of plate');
    if (pct > 0.05) return item(c, 'WARN', `${fmt} % of the plate is saturated.`, action, pct, '% of plate');
    return item(c, 'PASS', 'No significant clipping.', 'NONE', pct, '% of plate');
  }
  if (lumaPct > 2) return item(c, 'FAIL', `${f1(lumaPct)} % of the plate is pure white; faint spots there are lost.`, action, pct, '% of plate');
  if (pct > 0.2) {
    return item(
      c,
      'WARN',
      `A colour channel is saturated on ${fmt} % of the plate; lower exposure keeps faint spots.`,
      fromCamera && !glareSeen ? 'ADJUST_AND_RETAKE' : 'REVIEW',
      pct,
      '% of plate',
    );
  }
  return item(c, 'PASS', 'No significant clipping.', 'NONE', pct, '% of plate');
}

function underexposure(s: ExposureStats, polarity: SpotPolarity, fromCamera: boolean): QcItem {
  const c: QcCheck = 'UNDEREXPOSURE';
  const action: QcAction = fromCamera ? 'ADJUST_AND_RETAKE' : 'RECAPTURE';
  if (polarity === 'DARK') {
    if (s.background < 60 || s.darkFraction > 0.2) return item(c, 'FAIL', `Plate is too dark (level ${roundToInt(s.background)}); faint spots are lost.`, action, s.background, 'level');
    if (s.background < 100) return item(c, 'WARN', `Plate is dark (level ${roundToInt(s.background)}).`, action, s.background, 'level');
    return item(c, 'PASS', 'Enough light on the plate.', 'NONE', s.background, 'level');
  }
  if (s.highlight < 40) return item(c, 'FAIL', `Fluorescence too dim (level ${roundToInt(s.highlight)}); spots are lost in noise.`, action, s.highlight, 'level');
  if (s.highlight < 90) return item(c, 'WARN', `Fluorescence is dim (level ${roundToInt(s.highlight)}).`, action, s.highlight, 'level');
  return item(c, 'PASS', 'Spots are bright enough.', 'NONE', s.highlight, 'level');
}

interface Grid {
  cols: number;
  rows: number;
  levels: number[];
  clipped: number[];
}

function grid(plate: RgbImage, target: number, q: number): Grid {
  const aspect = plate.width / plate.height;
  const cols = aspect >= 1 ? target : Math.max(2, roundToInt(target * aspect));
  const rows = aspect >= 1 ? Math.max(2, roundToInt(target / aspect)) : target;
  const levels = new Array<number>(cols * rows).fill(0);
  const clipped = new Array<number>(cols * rows).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = toInt((c * plate.width) / cols);
      const x1 = toInt(((c + 1) * plate.width) / cols);
      const y0 = toInt((r * plate.height) / rows);
      const y1 = toInt(((r + 1) * plate.height) / rows);
      const vals = new Int32Array((x1 - x0) * (y1 - y0));
      let k = 0;
      let clip = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = maxChannel(plate.get(x, y));
          vals[k++] = v;
          if (v >= CLIP_LEVEL) clip++;
        }
      }
      levels[r * cols + c] = percentile(vals, q);
      clipped[r * cols + c] = vals.length === 0 ? 0 : clip / vals.length;
    }
  }
  return { cols, rows, levels, clipped };
}

function uniformity(plate: RgbImage, polarity: SpotPolarity): QcItem {
  const c: QcCheck = 'UNIFORMITY';
  const g = grid(plate, 8, polarity === 'DARK' ? 0.7 : 0.3);
  const lo = Math.min(...g.levels);
  const hi = Math.max(...g.levels);
  if (polarity === 'DARK') {
    const ratio = hi <= 0 ? 1.0 : lo / hi;
    const pct = ratio * 100;
    if (ratio < 0.45) return item(c, 'FAIL', `Very uneven light: darkest area is ${roundToInt(pct)} % of the brightest.`, 'RECAPTURE', pct, '% min/max');
    if (ratio < 0.7) return item(c, 'WARN', `Uneven light (${roundToInt(pct)} % min/max); background correction will compensate.`, 'REVIEW', pct, '% min/max');
    return item(c, 'PASS', 'Light is even across the plate.', 'NONE', pct, '% min/max');
  }
  const spread = hi - lo;
  if (spread > 60) return item(c, 'WARN', `Background glow varies by ${roundToInt(spread)} levels across the plate.`, 'REVIEW', spread, 'levels');
  return item(c, 'PASS', 'Background is even across the plate.', 'NONE', spread, 'levels');
}

/** Glare: saturation (or, under UV 366, background glow) concentrated in a few places. */
function glare(plate: RgbImage, s: ExposureStats, polarity: SpotPolarity): QcItem {
  const c: QcCheck = 'GLARE';
  const g = grid(plate, 16, polarity === 'DARK' ? 0.7 : 0.3);
  const n = g.levels.length;
  if (polarity === 'DARK') {
    if (s.clippedFraction < 0.001) return item(c, 'PASS', 'No glare.', 'NONE', 0, '% of plate');
    const hot = g.clipped.filter((v) => v > 0.1).length;
    if (hot > n * 0.35) return item(c, 'PASS', 'Saturation is spread evenly (overexposure, not glare).', 'NONE', 0, '% of plate');
    const area = (hot * 100.0) / n;
    if (area >= 3) return item(c, 'FAIL', `Glare covers ${roundToInt(area)} % of the plate. Change the light or tablet angle.`, 'RECAPTURE', area, '% of plate');
    if (hot > 0) return item(c, 'WARN', 'Small glare spot on the plate.', 'REVIEW', area, '% of plate');
    return item(c, 'PASS', 'No glare.', 'NONE', 0, '% of plate');
  }
  const sorted = [...g.levels].sort((a, b) => a - b);
  const median = sorted[toInt(n / 2)];
  const hot = g.levels.filter((v) => v > median + 40).length;
  const area = (hot * 100.0) / n;
  if (area >= 3) return item(c, 'FAIL', `Bright reflection covers ${roundToInt(area)} % of the plate.`, 'RECAPTURE', area, '% of plate');
  if (hot > 0) return item(c, 'WARN', 'Small bright reflection on the plate.', 'REVIEW', area, '% of plate');
  return item(c, 'PASS', 'No glare.', 'NONE', 0, '% of plate');
}

function obstruction(det: PlateDetection | null, fullFrame: boolean): QcItem {
  const c: QcCheck = 'OBSTRUCTION';
  if (det === null || fullFrame) return item(c, 'NOT_ASSESSED', 'No plate outline to judge.');
  const pct = det.fill * 100;
  if (det.fill < 0.85) return item(c, 'FAIL', 'Part of the plate is hidden or its outline is broken. Remove anything covering it.', 'RECAPTURE', pct, '% outline filled');
  if (det.fill < 0.93) return item(c, 'WARN', 'Plate outline is irregular; check nothing covers the plate.', 'REVIEW', pct, '% outline filled');
  return item(c, 'PASS', 'Nothing covers the plate.', 'NONE', pct, '% outline filled');
}

function focus(input: QcInput, det: PlateDetection | null, fullFrame: boolean): QcItem {
  const c: QcCheck = 'FOCUS';
  if (input.live) return item(c, 'NOT_ASSESSED', 'Checked on the captured photo.');
  if (det === null || fullFrame) return item(c, 'NOT_ASSESSED', 'Needs the plate edges to measure sharpness.');
  const blur = CaptureQc.edgeBlur(input.image, det.quad);
  if (blur === null) return item(c, 'NOT_ASSESSED', 'Plate edges too faint to measure sharpness.');
  if (blur > 12) return item(c, 'FAIL', 'Image is blurred. Tap the plate to focus and hold still.', 'RECAPTURE', blur, '‰ edge width');
  if (blur > 6) return item(c, 'WARN', 'Image is slightly soft.', 'REVIEW', blur, '‰ edge width');
  return item(c, 'PASS', 'Plate is sharp.', 'NONE', blur, '‰ edge width');
}

function stability(input: QcInput): QcItem {
  const c: QcCheck = 'STABILITY';
  const m = input.motion ?? null;
  if (m === null) return item(c, 'NOT_ASSESSED', input.fromCamera ? 'Movement not measured.' : 'Uploaded image: movement cannot be measured.');
  if (m > 12) return item(c, 'FAIL', 'Camera or plate was moving. Hold the tablet still.', 'RECAPTURE', m, '‰ movement');
  if (m > 4) return item(c, 'WARN', 'Slight movement during capture.', 'REVIEW', m, '‰ movement');
  return item(c, 'PASS', 'Camera was steady.', 'NONE', m, '‰ movement');
}
