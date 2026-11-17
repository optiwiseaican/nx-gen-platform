/**
 * The TLC analysis chain on the server: original image → plate outline → straightened plate →
 * analytical image → layout → densitograms → spots → Rf evaluation. Everything stored is
 * computed here from the original image and the inputs, so an evaluation can be recomputed and
 * checked later (verify*). The browser runs the same engine only for live preview.
 */
import { createHash } from 'crypto';
import { ModuleError } from '@crescent/module-sdk';
import {
  Channel,
  DEFAULT_DENSITOMETRY,
  DEFAULT_DEVELOPMENT,
  DEFAULT_POST_PROCESSING,
  DEFAULT_SPOT_DETECTOR,
  Densitometry,
  DensitometrySettings,
  Development,
  GrayImage,
  ImageOps,
  LayoutDetector,
  LayoutResult,
  PeakWindow,
  PlateDetector,
  PlateGeometry,
  PlateRectifier,
  Point,
  PostProcessing,
  Quad,
  RgbImage,
  SpotDetector,
  SpotDetectorSettings,
  Track,
  matchPreset,
  polarityOf,
  quadArea,
  quadFrom,
  validatePostProcessing,
} from '../engine';
import { CaptureQc, CaptureVerdict, PlateDetection, QcItem, verdictOf } from '../engine';
import { Evaluation, Illumination, RfWindow, TrackRole, evaluateRf } from '../shared/tlc';
import { pixelBytes } from './images';

/** Bumped when a change to the engine or this chain could alter stored results. */
export const ENGINE_VERSION = 'tlc-engine/1.1.0';

/** The tablet keeps straightened plates at most this long and at least this dense. */
export const MAX_LONG_SIDE_PX = 2400;
export const MIN_PX_PER_MM = 5;

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** JSON with object keys sorted, so the same content always hashes the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r4 = (v: number): number => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------------------
// Plate outline and straightening
// ---------------------------------------------------------------------------

export interface PlateSpec {
  corners: Point[];
  widthMm: number;
  heightMm: number;
  channel: Channel;
  postProcessing: PostProcessing;
}

/** Output size for the straightened plate: real proportions, capped and floored like the tablet. */
export function plateSize(quad: Quad, widthMm: number, heightMm: number): { width: number; height: number } {
  let { width, height } = PlateRectifier.outputSize(quad, widthMm, heightMm);
  const long = Math.max(width, height);
  if (long > MAX_LONG_SIDE_PX) {
    const s = MAX_LONG_SIDE_PX / long;
    width = Math.max(1, Math.round(width * s));
    height = Math.max(1, Math.round(height * s));
  }
  const pxPerMm = Math.min(width / widthMm, height / heightMm);
  if (pxPerMm < MIN_PX_PER_MM) {
    const s = MIN_PX_PER_MM / pxPerMm;
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  return { width, height };
}

export function parsePlateSpec(body: Record<string, unknown>, image: { width: number; height: number }): PlateSpec {
  const corners = body.corners;
  if (!Array.isArray(corners) || corners.length !== 4) throw new ModuleError(400, 'Give the four plate corners (top-left, top-right, bottom-right, bottom-left).', 'corners');
  const pts: Point[] = corners.map((c: { x?: unknown; y?: unknown }, i) => {
    const x = Number(c?.x);
    const y = Number(c?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1)
      throw new ModuleError(400, `Corner ${i + 1} lies outside the image.`, 'corners');
    return { x, y };
  });
  const quad = quadFrom(pts);
  if (quadArea(quad) < 400) throw new ModuleError(400, 'The outline is too small to be a plate.', 'corners');
  if (!CaptureQc.isPlausiblePlate(quad)) throw new ModuleError(400, 'The outline is not a plate shape: corners must be roughly square and no side collapsed.', 'corners');
  const widthMm = Number(body.widthMm);
  const heightMm = Number(body.heightMm);
  for (const [v, field] of [
    [widthMm, 'widthMm'],
    [heightMm, 'heightMm'],
  ] as [number, string][]) {
    if (!Number.isFinite(v) || v < 10 || v > 300) throw new ModuleError(400, 'Plate size must be 10–300 mm on each side.', field);
  }
  const channel = body.channel ?? 'INTENSITY';
  if (!['INTENSITY', 'RED', 'GREEN', 'BLUE'].includes(channel as string)) throw new ModuleError(400, 'Choose the channel: intensity, red, green or blue.', 'channel');
  const pp = (body.postProcessing ?? DEFAULT_POST_PROCESSING) as Partial<PostProcessing>;
  const postProcessing: PostProcessing = {
    blackPoint: Number(pp.blackPoint ?? 0),
    whitePoint: Number(pp.whitePoint ?? 255),
    denoise: pp.denoise === true,
  };
  const problems = validatePostProcessing(postProcessing);
  if (problems.length) throw new ModuleError(400, problems.join(' '), 'postProcessing');
  return { corners: pts, widthMm, heightMm, channel: channel as Channel, postProcessing };
}

/** Straightens the plate from the original image. */
export function makePlate(original: RgbImage, spec: PlateSpec): RgbImage {
  const quad = quadFrom(spec.corners);
  const { width, height } = plateSize(quad, spec.widthMm, spec.heightMm);
  return PlateRectifier.rectify(original, quad, width, height);
}

/**
 * The plate found on a reduced copy of the photo (colour distance first, brightness as a
 * fallback). An image that is already just the plate (the found blob runs to the image edges)
 * is taken whole, as the tablet's detector does for uploads of cropped plates.
 */
function findPlate(original: RgbImage, maxSide: number): { small: RgbImage; step: number; detection: PlateDetection | null; cropped: boolean } {
  const step = Math.max(1, Math.ceil(Math.max(original.width, original.height) / maxSide));
  const small = step === 1 ? original : subsample(original, step);
  const byColor = PlateDetector.detect(PlateDetector.colorDistanceFromBorder(small));
  let found = byColor && byColor.fill >= 0.85 ? byColor : null;
  if (!found) {
    const byBrightness = PlateDetector.detect(small.channel('INTENSITY'));
    const candidates = [byColor, byBrightness].filter((d): d is NonNullable<typeof d> => d !== null);
    found = candidates.sort((a, b) => b.fill - a.fill)[0] ?? null;
  }
  if (found) {
    const w = small.width;
    const h = small.height;
    const tol = Math.max(2, 0.02 * Math.max(w, h));
    const c = [found.quad.topLeft, found.quad.topRight, found.quad.bottomRight, found.quad.bottomLeft];
    const edges = [c.some((p) => p.x < tol), c.some((p) => p.x > w - 1 - tol), c.some((p) => p.y < tol), c.some((p) => p.y > h - 1 - tol)].filter(Boolean).length;
    const share = quadArea(found.quad) / (w * h);
    if (edges >= 3 && share >= 0.8) {
      const whole: Quad = { topLeft: { x: 0, y: 0 }, topRight: { x: w - 1, y: 0 }, bottomRight: { x: w - 1, y: h - 1 }, bottomLeft: { x: 0, y: h - 1 } };
      return { small, step, detection: { quad: whole, threshold: found.threshold, fill: 1, solid: 1, edges: 1 }, cropped: true };
    }
  }
  return { small, step, detection: found, cropped: false };
}

/**
 * Suggests a plate outline on the original image, on a reduced copy as the tablet does; the
 * outline is scaled back. Null when no clean rectangle is found; the analyst then outlines the
 * plate by hand.
 */
export function suggestOutline(original: RgbImage): { corners: Point[]; fill: number; preset: { label: string; widthMm: number; heightMm: number } | null } | null {
  const { step, detection: found, cropped } = findPlate(original, 1000);
  if (!found || found.fill < 0.6 || !CaptureQc.isPlausiblePlate(found.quad)) return null;
  const corners = cropped
    ? [{ x: 0, y: 0 }, { x: original.width - 1, y: 0 }, { x: original.width - 1, y: original.height - 1 }, { x: 0, y: original.height - 1 }]
    : [found.quad.topLeft, found.quad.topRight, found.quad.bottomRight, found.quad.bottomLeft].map((p) => ({
        x: Math.min(original.width - 1, p.x * step),
        y: Math.min(original.height - 1, p.y * step),
      }));
  return { corners, fill: found.fill, preset: matchPreset(quadFrom(corners)) };
}

/** Stored with every plate image: the tablet's capture quality gate, run on a ~1200 px copy. */
export interface ImageQc {
  verdict: CaptureVerdict;
  exposureEv: number | null;
  items: QcItem[];
  /** The outline the gate judged, in original-image pixels, if one was found. */
  outline: Point[] | null;
}

/** The capture quality gate on a whole image; `fromCamera` applies the stricter rules for live captures. */
export function imageQc(original: RgbImage, illumination: Illumination, fromCamera = false): ImageQc {
  const { small, step, detection, cropped } = findPlate(original, 1200);
  const report = CaptureQc.evaluate({ image: small, detection, illumination, fromCamera });
  const outline = cropped
    ? [{ x: 0, y: 0 }, { x: original.width - 1, y: 0 }, { x: original.width - 1, y: original.height - 1 }, { x: 0, y: original.height - 1 }]
    : detection
      ? [detection.quad.topLeft, detection.quad.topRight, detection.quad.bottomRight, detection.quad.bottomLeft].map((p) => ({ x: Math.min(original.width - 1, p.x * step), y: Math.min(original.height - 1, p.y * step) }))
      : null;
  return {
    verdict: verdictOf(report),
    exposureEv: report.exposureEv === null ? null : r3(report.exposureEv),
    items: report.items.map((i) => ({ ...i, value: i.value === null ? null : r3(i.value) })),
    outline,
  };
}

function subsample(img: RgbImage, step: number): RgbImage {
  const w = Math.floor((img.width + step - 1) / step);
  const h = Math.floor((img.height + step - 1) / step);
  const px = new Int32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = img.get(Math.min(img.width - 1, x * step), Math.min(img.height - 1, y * step));
  return new RgbImage(w, h, px);
}

/** The analytical image: post-processing (never destructive) then one channel, spots positive. */
export function analyticalGray(rectified: RgbImage, spec: Pick<PlateSpec, 'channel' | 'postProcessing'>): GrayImage {
  return ImageOps.apply(rectified, spec.postProcessing).channel(spec.channel);
}

// ---------------------------------------------------------------------------
// Layout and evaluation
// ---------------------------------------------------------------------------

export interface EvalTrack {
  id: number;
  name: string;
  role: TrackRole;
  centerMm: number;
  sampleVolumeUl: number | null;
  concentration: number | null;
  dilutionFactor: number | null;
  sampleId: string;
  /** Where the position came from: the detector, the method's template, or the analyst. */
  source: 'DETECTED' | 'METHOD' | 'MANUAL';
}

export interface EvaluationInput {
  layout: Development & { baselineSource: 'DETECTED' | 'MANUAL'; frontSource: 'DETECTED' | 'MANUAL' };
  tracks: EvalTrack[];
  /** How the straightened plate becomes the analytical image (the tablet's Plate-stage processing). */
  image: { channel: Channel; postProcessing: PostProcessing };
  settings: { densitometry: DensitometrySettings; spotDetector: SpotDetectorSettings };
  /** Per track id: windows the analyst set or adjusted instead of the automatic spots. */
  manualSpots: Record<string, PeakWindow[]>;
}

export interface EvaluatedSpot {
  number: number;
  window: PeakWindow;
  peak: { startHrf: number; maxHrf: number; endHrf: number; height: number; area: number; widthPx: number };
  prominence: number;
  rf: number;
  compound: string;
  source: 'AUTO' | 'MANUAL';
}

export interface EvaluatedTrack {
  id: number;
  name: string;
  role: TrackRole;
  centerMm: number;
  profile: { hRf: number[]; raw: number[]; processed: number[]; pxPerSample: number };
  noise: number;
  spots: EvaluatedSpot[];
}

export interface EvaluationResults {
  tracks: EvaluatedTrack[];
  rf: Evaluation;
  conclusion: Evaluation['conclusion'];
  analyticalSaturation: number;
  plate: { pixelsSha256: string; widthPx: number; heightPx: number; widthMm: number; heightMm: number; illumination: Illumination; channel: Channel; postProcessing: PostProcessing };
}

const num = (v: unknown, field: string, label: string, min: number, max: number, optional = false): number | null => {
  if (optional && (v === null || v === undefined || v === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ModuleError(400, `${label} must be between ${min} and ${max}.`, field);
  return n;
};

export function parseEvaluationInput(body: Record<string, unknown>, plate: { widthMm: number; heightMm: number; channel: Channel; postProcessing: PostProcessing }): EvaluationInput {
  const im = (body.image ?? {}) as Record<string, unknown>;
  const channel = (im.channel ?? plate.channel) as Channel;
  if (!['INTENSITY', 'RED', 'GREEN', 'BLUE'].includes(channel)) throw new ModuleError(400, 'Choose the channel: intensity, red, green or blue.', 'image');
  const pp = (im.postProcessing ?? plate.postProcessing) as Partial<PostProcessing>;
  const postProcessing: PostProcessing = { blackPoint: Number(pp.blackPoint ?? 0), whitePoint: Number(pp.whitePoint ?? 255), denoise: pp.denoise === true };
  const ppProblems = validatePostProcessing(postProcessing);
  if (ppProblems.length) throw new ModuleError(400, ppProblems.join(' '), 'image');
  const l = (body.layout ?? {}) as Record<string, unknown>;
  const baselineMm = num(l.baselineMm, 'layout', 'Baseline', 0, plate.heightMm) as number;
  const solventFrontMm = num(l.solventFrontMm, 'layout', 'Solvent front', 0, plate.heightMm) as number;
  if (solventFrontMm - baselineMm < 5) throw new ModuleError(400, 'The solvent front must be at least 5 mm above the baseline.', 'layout');
  const trackWidthMm = num(l.trackWidthMm, 'layout', 'Track width', 1, Math.min(60, plate.widthMm)) as number;
  const src = (v: unknown): 'DETECTED' | 'MANUAL' => (v === 'DETECTED' ? 'DETECTED' : 'MANUAL');

  if (!Array.isArray(body.tracks) || body.tracks.length === 0) throw new ModuleError(400, 'Add at least one track.', 'tracks');
  if (body.tracks.length > 40) throw new ModuleError(400, 'At most 40 tracks.', 'tracks');
  const names = new Set<string>();
  const tracks: EvalTrack[] = (body.tracks as Record<string, unknown>[]).map((t, i) => {
    const name = typeof t.name === 'string' ? t.name.trim().slice(0, 40) : '';
    if (!name) throw new ModuleError(400, `Track ${i + 1}: enter a name.`, 'tracks');
    if (names.has(name.toLowerCase()) && t.role === 'STANDARD') throw new ModuleError(400, `${name}: standard names must be unique.`, 'tracks');
    names.add(name.toLowerCase());
    if (t.role !== 'STANDARD' && t.role !== 'SAMPLE') throw new ModuleError(400, `${name}: choose standard or sample.`, 'tracks');
    const centerMm = num(t.centerMm, 'tracks', `${name}: position`, 0, plate.widthMm) as number;
    return {
      id: i + 1,
      name,
      role: t.role,
      centerMm,
      sampleVolumeUl: num(t.sampleVolumeUl, 'tracks', `${name}: volume`, 0.001, 1000, true),
      concentration: num(t.concentration, 'tracks', `${name}: concentration`, 0, 1e9, true),
      dilutionFactor: num(t.dilutionFactor, 'tracks', `${name}: dilution`, 0.000001, 1e9, true),
      sampleId: typeof t.sampleId === 'string' ? t.sampleId.trim().slice(0, 80) : '',
      source: t.source === 'DETECTED' ? 'DETECTED' : t.source === 'METHOD' ? 'METHOD' : 'MANUAL',
    };
  });
  const sorted = [...tracks].sort((a, b) => a.centerMm - b.centerMm);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].centerMm - sorted[i - 1].centerMm < trackWidthMm) throw new ModuleError(400, `${sorted[i - 1].name} and ${sorted[i].name} overlap: tracks must be at least the track width apart.`, 'tracks');
  }

  const s = (body.settings ?? {}) as Record<string, unknown>;
  const d = { ...DEFAULT_DENSITOMETRY, ...((s.densitometry ?? {}) as Partial<DensitometrySettings>) };
  if (d.aggregation !== 'AVERAGE' && d.aggregation !== 'MEDIAN') throw new ModuleError(400, 'Aggregation must be AVERAGE or MEDIAN.', 'settings');
  num(d.smoothingMm, 'settings', 'Smoothing window', 0.5, 10);
  num(d.backgroundWindowMm, 'settings', 'Background window', 3, 60);
  if (!['LINEAR_THROUGH_ORIGIN', 'LINEAR', 'POLYNOMIAL'].includes(d.regression)) throw new ModuleError(400, 'Unknown regression model.', 'settings');
  const sd = { ...DEFAULT_SPOT_DETECTOR, ...((s.spotDetector ?? {}) as Partial<SpotDetectorSettings>) };
  num(sd.sensitivity, 'settings', 'Spot sensitivity', 0.2, 5);
  num(sd.minSeparationMm, 'settings', 'Minimum spot separation', 0.5, 20);
  const densitometry: DensitometrySettings = {
    aggregation: d.aggregation,
    smoothing: d.smoothing !== false,
    smoothingMm: Number(d.smoothingMm),
    subtractBackground: d.subtractBackground === true,
    backgroundWindowMm: Number(d.backgroundWindowMm),
    subtractPeakBaseline: d.subtractPeakBaseline !== false,
    regression: d.regression,
  };
  const spotDetector: SpotDetectorSettings = { ...DEFAULT_SPOT_DETECTOR, sensitivity: Number(sd.sensitivity), minSeparationMm: Number(sd.minSeparationMm) };

  const manualSpots: Record<string, PeakWindow[]> = {};
  const ms = (body.manualSpots ?? {}) as Record<string, unknown>;
  for (const [key, windows] of Object.entries(ms)) {
    const track = tracks.find((t) => String(t.id) === key);
    if (!track) throw new ModuleError(400, `Manual spots refer to an unknown track (${key}).`, 'manualSpots');
    if (!Array.isArray(windows) || windows.length > 20) throw new ModuleError(400, `${track.name}: at most 20 spots.`, 'manualSpots');
    const list: PeakWindow[] = windows.map((w: { startHrf?: unknown; endHrf?: unknown }, i) => {
      const startHrf = num(w?.startHrf, 'manualSpots', `${track.name}, spot ${i + 1}: start`, 0, 100) as number;
      const endHrf = num(w?.endHrf, 'manualSpots', `${track.name}, spot ${i + 1}: end`, 0, 100) as number;
      if (endHrf - startHrf < 0.5) throw new ModuleError(400, `${track.name}, spot ${i + 1}: the window must be at least 0.5 hRf wide.`, 'manualSpots');
      return { startHrf, endHrf };
    });
    manualSpots[String(track.id)] = list;
  }

  return {
    layout: { baselineMm, solventFrontMm, trackWidthMm, baselineSource: src(l.baselineSource), frontSource: src(l.frontSource) },
    tracks,
    image: { channel, postProcessing },
    settings: { densitometry, spotDetector },
    manualSpots,
  };
}

/** Automatic layout with the detector's spots per lane, as a starting point for the analyst. */
export function autoLayout(gray: GrayImage, geometry: PlateGeometry, illumination: Illumination): LayoutResult & { lanes: { centerMm: number; spots: EvaluatedSpot[] }[] } {
  const layout = LayoutDetector.detect(gray, geometry, DEFAULT_DEVELOPMENT);
  const polarity = polarityOf(illumination);
  const lanes = layout.trackCentersMm.map((centerMm, i) => {
    const track: Track = { id: i + 1, name: `T${i + 1}`, centerMm };
    const spots = SpotDetector.detect(gray, geometry, track, layout.development, polarity).map((s) => spotView(s, 'AUTO', []));
    return { centerMm, spots };
  });
  return { ...layout, lanes };
}

function spotView(
  s: { number: number; window: PeakWindow; peak: EvaluatedSpot['peak']; prominence: number },
  source: 'AUTO' | 'MANUAL',
  windows: RfWindow[],
): EvaluatedSpot {
  const rf = r3(s.peak.maxHrf / 100);
  const w = windows.find((x) => rf >= x.min && rf <= x.max);
  return {
    number: s.number,
    window: { startHrf: r4(s.window.startHrf), endHrf: r4(s.window.endHrf) },
    peak: { startHrf: r4(s.peak.startHrf), maxHrf: r4(s.peak.maxHrf), endHrf: r4(s.peak.endHrf), height: r4(s.peak.height), area: r4(s.peak.area), widthPx: r4(s.peak.widthPx) },
    prominence: r4(s.prominence),
    rf,
    compound: w?.compound ?? '',
    source,
  };
}

/** Computes an evaluation from the analytical image and the analyst's inputs. Deterministic. */
export function computeEvaluation(
  rectified: RgbImage,
  plate: { widthMm: number; heightMm: number; illumination: Illumination; pixelsSha256: string },
  input: EvaluationInput,
  windows: RfWindow[],
): EvaluationResults {
  const gray = analyticalGray(rectified, input.image);
  const geometry = new PlateGeometry(gray.width, gray.height, plate.widthMm, plate.heightMm);
  const polarity = polarityOf(plate.illumination);
  const dev: Development = { baselineMm: input.layout.baselineMm, solventFrontMm: input.layout.solventFrontMm, trackWidthMm: input.layout.trackWidthMm };
  const tracks: EvaluatedTrack[] = input.tracks.map((t) => {
    const track: Track = { id: t.id, name: t.name, centerMm: t.centerMm };
    const dp = SpotDetector.detectionProfile(gray, geometry, track, dev, polarity, input.settings.densitometry.aggregation, input.settings.spotDetector);
    const manual = input.manualSpots[String(t.id)];
    const found = manual ? SpotDetector.measure(dp, t.id, manual) : SpotDetector.detectOn(dp, t.id, input.settings.spotDetector);
    const processed = Densitometry.profile(gray, geometry, track, dev, polarity, input.settings.densitometry);
    return {
      id: t.id,
      name: t.name,
      role: t.role,
      centerMm: t.centerMm,
      profile: {
        hRf: dp.profile.hRf.map(r4),
        raw: rawSignal(gray, geometry, track, dev, polarity, input.settings.densitometry),
        processed: processed.signal.map(r3),
        pxPerSample: r4(processed.pxPerSample),
      },
      noise: r4(dp.noise),
      spots: found.map((s) => spotView(s, manual ? 'MANUAL' : 'AUTO', windows)),
    };
  });
  const rf = evaluateRf(
    input.layout.solventFrontMm,
    tracks.map((t) => ({ label: t.name, role: t.role, spots: t.spots.map((s) => ({ rf: s.rf, compound: s.compound, distanceMm: null })) })),
    windows,
  );
  const saturation = CaptureQc.analyticalSaturation(
    rectified,
    geometry,
    dev,
    input.tracks.map((t) => ({ id: t.id, name: t.name, centerMm: t.centerMm })),
  );
  return {
    tracks,
    rf,
    conclusion: saturation > 0.01 ? 'INCOMPLETE' : rf.conclusion,
    analyticalSaturation: r4(saturation),
    plate: {
      pixelsSha256: plate.pixelsSha256,
      widthPx: gray.width,
      heightPx: gray.height,
      widthMm: plate.widthMm,
      heightMm: plate.heightMm,
      illumination: plate.illumination,
      channel: input.image.channel,
      postProcessing: input.image.postProcessing,
    },
  };
}

function rawSignal(gray: GrayImage, geometry: PlateGeometry, track: Track, dev: Development, polarity: 'DARK' | 'BRIGHT', settings: DensitometrySettings): number[] {
  return Densitometry.profile(gray, geometry, track, dev, polarity, { ...settings, smoothing: false, subtractBackground: false }).signal.map(r3);
}

/** What the snapshot hash covers: the inputs, the results and the engine that produced them. */
export function evaluationContent(input: EvaluationInput, results: EvaluationResults): string {
  return canonical({ engine: ENGINE_VERSION, input, results });
}

/** The straightened plate recomputed from the original image must match what was stored. */
export function verifyPlate(original: RgbImage, spec: PlateSpec, storedPixelsSha256: string): { ok: boolean; recomputed: string } {
  const recomputed = sha256(pixelBytes(makePlate(original, spec)));
  return { ok: recomputed === storedPixelsSha256, recomputed };
}
