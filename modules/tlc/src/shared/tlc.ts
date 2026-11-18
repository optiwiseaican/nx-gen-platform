/**
 * TLC module logic shared by its API (authoritative, stored) and its screens
 * (live preview): Rf calculation, Rf windows from the approved method, and
 * the evaluation of a plate.
 *
 * Method convention: every method parameter whose unit is "Rf" defines an
 * acceptance window for the compound named in it, e.g.
 *   { name: "Paracetamol", value: "0.40–0.50", unit: "Rf" }   (range)
 *   { name: "Caffeine",    value: "0.62 ± 0.05", unit: "Rf" } (centre ± tolerance)
 */

export type Conclusion = 'INCOMPLETE' | 'CONFORMS' | 'DOES_NOT_CONFORM' | 'SST_FAILED';
export type TrackRole = 'STANDARD' | 'SAMPLE';
export const ILLUMINATIONS = ['WHITE', 'UV254', 'UV366'] as const;
export type Illumination = (typeof ILLUMINATIONS)[number];

export interface RfWindow {
  compound: string;
  min: number;
  max: number;
}

export interface SpotInput {
  distanceMm: number;
  compound: string;
}

export interface TrackInput {
  label: string;
  role: TrackRole;
  spots: SpotInput[];
}

/** A spot whose Rf is already known (from a densitogram peak), for evaluateRf. */
export interface RfSpotInput {
  rf: number;
  compound: string;
  distanceMm: number | null;
}

export interface RfTrackInput {
  label: string;
  role: TrackRole;
  spots: RfSpotInput[];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Rf = distance travelled by the spot ÷ distance travelled by the solvent front. */
export function rf(distanceMm: number, frontMm: number): number {
  return round3(distanceMm / frontMm);
}

export function parseRfWindows(parameters: { name: string; value: string; unit: string }[]): { windows: RfWindow[]; problems: string[] } {
  const windows: RfWindow[] = [];
  const problems: string[] = [];
  for (const p of parameters) {
    if (p.unit.trim().toLowerCase() !== 'rf') continue;
    const v = p.value.replace(/\s+/g, '');
    const range = /^(\d*\.?\d+)[-–—](\d*\.?\d+)$/.exec(v);
    const tol = /^(\d*\.?\d+)(?:±|\+\/?-)(\d*\.?\d+)$/.exec(v);
    let min: number;
    let max: number;
    if (range) [min, max] = [Number(range[1]), Number(range[2])];
    else if (tol) [min, max] = [Number(tol[1]) - Number(tol[2]), Number(tol[1]) + Number(tol[2])];
    else {
      problems.push(`Rf window for ${p.name} is not "min–max" or "value ± tolerance": ${p.value}`);
      continue;
    }
    if (!(min >= 0 && max <= 1 && min < max)) {
      problems.push(`Rf window for ${p.name} must lie between 0 and 1: ${p.value}`);
      continue;
    }
    windows.push({ compound: p.name.trim(), min: round3(min), max: round3(max) });
  }
  return { windows, problems };
}

/**
 * Camera settings for a capture. `fixed` = the exposure is set (by the method or the analyst), so the
 * capture does not correct it automatically. `fromMethod` = which settings the method sets: those are
 * used as approved and cannot be changed on the Picture stage.
 */
export interface CameraSettingsInput {
  exposureUs: number;
  gain: number;
  whiteBalance: [number, number, number];
  fixed: boolean;
  fromMethod?: { exposure: boolean; gain: boolean; whiteBalance: boolean };
}

export const DEFAULT_CAMERA: CameraSettingsInput = { exposureUs: 20000, gain: 1, whiteBalance: [1, 1, 1], fixed: false };

/** Limits of the lamp box camera settings (exposure µs, gain factor, white balance factors). */
export const CAMERA_LIMITS = { exposureUs: [31, 2_000_000], gain: [1, 16], whiteBalance: [0.1, 8] } as const;

export interface CameraAdjustment {
  exposureUs?: number;
  gain?: number;
  whiteBalance?: [number, number, number];
}

/**
 * The settings a capture uses: the method's where it sets them, otherwise what the analyst chose on
 * the Picture stage. An exposure chosen by the analyst is used as is (no automatic correction).
 */
export function applyCameraAdjustment(base: CameraSettingsInput, adjustment: unknown): { settings: CameraSettingsInput; problems: string[]; adjusted: string[] } {
  const from = base.fromMethod ?? { exposure: base.fixed, gain: false, whiteBalance: false };
  const s: CameraSettingsInput = { ...base, whiteBalance: [...base.whiteBalance] as [number, number, number], fromMethod: from };
  const problems: string[] = [];
  const adjusted: string[] = [];
  if (!adjustment || typeof adjustment !== 'object') return { settings: s, problems, adjusted };
  const a = adjustment as Record<string, unknown>;
  const [eMin, eMax] = CAMERA_LIMITS.exposureUs;
  const [gMin, gMax] = CAMERA_LIMITS.gain;
  const [wMin, wMax] = CAMERA_LIMITS.whiteBalance;
  if (a.exposureUs !== undefined && !from.exposure) {
    const n = Number(a.exposureUs);
    if (!(n >= eMin && n <= eMax)) problems.push('Exposure must be 31 µs to 2 s.');
    else if (Math.round(n) !== s.exposureUs || !s.fixed) {
      s.exposureUs = Math.round(n);
      s.fixed = true;
      adjusted.push('exposure');
    }
  }
  if (a.gain !== undefined && !from.gain) {
    const n = Number(a.gain);
    if (!(n >= gMin && n <= gMax)) problems.push('Gain must be 1 to 16.');
    else if (n !== s.gain) {
      s.gain = Math.round(n * 100) / 100;
      adjusted.push('gain');
    }
  }
  if (a.whiteBalance !== undefined && !from.whiteBalance) {
    const w = a.whiteBalance;
    if (!Array.isArray(w) || w.length !== 3 || !w.every((x) => Number(x) >= wMin && Number(x) <= wMax)) problems.push('White balance must be three factors from 0.1 to 8.');
    else {
      const wb = w.map((x) => Math.round(Number(x) * 1000) / 1000) as [number, number, number];
      if (wb.some((x, i) => x !== s.whiteBalance[i])) {
        s.whiteBalance = wb;
        adjusted.push('whiteBalance');
      }
    }
  }
  return { settings: s, problems, adjusted };
}

/** Channel means of a preview frame, 0–255, over its unsaturated pixels; `saturated` is a fraction. */
export interface FrameStats {
  r: number;
  g: number;
  b: number;
  luma: number;
  saturated: number;
}

/**
 * Auto exposure (once): the exposure that brings the frame's mean brightness to about 45 %, at most
 * 8× brighter or darker per press; with more than 2 % of pixels saturated it halves the exposure.
 */
export function autoExposureUs(stats: FrameStats, currentUs: number): number {
  const [min, max] = CAMERA_LIMITS.exposureUs;
  let factor = stats.saturated > 0.02 ? 0.5 : (0.45 * 255) / Math.max(1, stats.luma);
  factor = Math.min(8, Math.max(0.125, factor));
  return Math.round(Math.min(max, Math.max(min, currentUs * factor)));
}

/** Auto white balance (once, grey world): red and blue scaled so their means match green. */
export function autoWhiteBalance(stats: FrameStats, current: [number, number, number]): [number, number, number] {
  const [min, max] = CAMERA_LIMITS.whiteBalance;
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 1000) / 1000;
  return [clamp(current[0] * (stats.g / Math.max(1, stats.r))), current[1], clamp(current[2] * (stats.g / Math.max(1, stats.b)))];
}

/**
 * Camera settings from a TLC method's parameters, as the tablet keeps them on the method so every
 * plate of a method is photographed the same way:
 *   "Camera exposure"       value in µs, ms or s (unit)        e.g. 25 ms
 *   "Camera gain"           factor (unit "x" or empty)         e.g. 1.5
 *   "Camera white balance"  "red/green/blue" factors           e.g. 1.6/1.0/1.9
 * Anything not set falls back to the defaults (20 ms, gain 1, white balance 1/1/1); without a
 * method exposure the capture adjusts the exposure automatically (the tablet's auto retake).
 */
export function parseCameraSettings(parameters: { name: string; value: string; unit: string }[]): { settings: CameraSettingsInput; problems: string[] } {
  const s: CameraSettingsInput = {
    ...DEFAULT_CAMERA,
    whiteBalance: [...DEFAULT_CAMERA.whiteBalance] as [number, number, number],
    fromMethod: { exposure: false, gain: false, whiteBalance: false },
  };
  const problems: string[] = [];
  for (const p of parameters) {
    const name = p.name.trim().toLowerCase();
    const unit = p.unit.trim().toLowerCase();
    const value = p.value.trim().replace(',', '.');
    if (name === 'camera exposure') {
      const n = Number(value);
      const k = unit === 'µs' || unit === 'us' ? 1 : unit === 'ms' ? 1000 : unit === 's' ? 1e6 : NaN;
      if (!(n > 0) || !Number.isFinite(k) || !(n * k >= 31 && n * k <= 2_000_000)) problems.push(`Camera exposure must be 31 µs – 2 s with unit µs, ms or s: ${p.value} ${p.unit}`);
      else {
        s.exposureUs = Math.round(n * k);
        s.fixed = true;
        s.fromMethod!.exposure = true;
      }
    } else if (name === 'camera gain') {
      const n = Number(value);
      if (!(n >= 1 && n <= 16) || !(unit === '' || unit === 'x' || unit === '×')) problems.push(`Camera gain must be a factor from 1 to 16: ${p.value} ${p.unit}`);
      else {
        s.gain = n;
        s.fromMethod!.gain = true;
      }
    } else if (name === 'camera white balance') {
      const parts = value.split('/').map(Number);
      if (parts.length !== 3 || !parts.every((x) => x >= 0.1 && x <= 8)) problems.push(`Camera white balance must be "red/green/blue" factors between 0.1 and 8: ${p.value}`);
      else {
        s.whiteBalance = parts as [number, number, number];
        s.fromMethod!.whiteBalance = true;
      }
    }
  }
  return { settings: s, problems };
}

/** Problems that make the plate data unusable, or []. */
export function validatePlate(frontMm: number | null, tracks: TrackInput[]): string[] {
  const p: string[] = [];
  if (frontMm === null || !Number.isFinite(frontMm) || frontMm <= 0 || frontMm > 300) p.push('Enter the solvent front distance (0–300 mm from the origin).');
  if (tracks.length > 40) p.push('At most 40 tracks.');
  const labels = new Set<string>();
  for (const [i, t] of tracks.entries()) {
    const name = t.label.trim() || `Track ${i + 1}`;
    if (!t.label.trim()) p.push(`Track ${i + 1}: enter a label.`);
    if (labels.has(t.label.trim())) p.push(`${name}: labels must be unique.`);
    labels.add(t.label.trim());
    if (t.role !== 'STANDARD' && t.role !== 'SAMPLE') p.push(`${name}: choose standard or sample.`);
    if (t.spots.length > 20) p.push(`${name}: at most 20 spots.`);
    for (const [j, s] of t.spots.entries()) {
      if (!Number.isFinite(s.distanceMm) || s.distanceMm <= 0) p.push(`${name}, spot ${j + 1}: enter the distance from the origin.`);
      else if (frontMm && s.distanceMm > frontMm) p.push(`${name}, spot ${j + 1}: a spot cannot travel further than the solvent front.`);
    }
  }
  return p;
}

export interface Evaluation {
  frontMm: number;
  tracks: { label: string; role: TrackRole; spots: { distanceMm: number | null; rf: number; compound: string; window: RfWindow | null; inWindow: boolean | null }[] }[];
  suitability: { compound: string; track: string; rf: number | null; window: RfWindow; pass: boolean }[];
  identification: { compound: string; track: string; rf: number | null; window: RfWindow; pass: boolean }[];
  conclusion: Conclusion;
  reasons: string[];
}

/** Evaluation of spots entered as distances from the origin (the manual path). */
export function evaluate(frontMm: number, tracks: TrackInput[], windows: RfWindow[]): Evaluation {
  return evaluateRf(
    frontMm,
    tracks.map((t) => ({ label: t.label, role: t.role, spots: t.spots.map((s) => ({ rf: rf(s.distanceMm, frontMm), compound: s.compound, distanceMm: s.distanceMm })) })),
    windows,
  );
}

/**
 * System suitability: every standard track's spot for each compound with a
 * window must fall inside that window. Identification: every sample track
 * must show a spot for each compound, inside its window.
 */
export function evaluateRf(frontMm: number, tracks: RfTrackInput[], windows: RfWindow[]): Evaluation {
  const byCompound = new Map(windows.map((w) => [w.compound.toLowerCase(), w]));
  const out: Evaluation['tracks'] = tracks.map((t) => ({
    label: t.label.trim(),
    role: t.role,
    spots: t.spots.map((s) => {
      const value = round3(s.rf);
      const window = s.compound ? (byCompound.get(s.compound.trim().toLowerCase()) ?? null) : null;
      return { distanceMm: s.distanceMm, rf: value, compound: s.compound.trim(), window, inWindow: window ? value >= window.min && value <= window.max : null };
    }),
  }));
  const reasons: string[] = [];
  const check = (role: TrackRole) =>
    out
      .filter((t) => t.role === role)
      .flatMap((t) =>
        windows.map((w) => {
          const spot = t.spots.find((s) => s.compound.toLowerCase() === w.compound.toLowerCase());
          return { compound: w.compound, track: t.label, rf: spot?.rf ?? null, window: w, pass: !!spot?.inWindow };
        }),
      );
  const suitability = check('STANDARD');
  const identification = check('SAMPLE');

  let conclusion: Conclusion;
  if (!windows.length) {
    conclusion = 'INCOMPLETE';
    reasons.push('The method defines no Rf windows (parameters with unit "Rf").');
  } else if (!out.some((t) => t.role === 'STANDARD') || !out.some((t) => t.role === 'SAMPLE')) {
    conclusion = 'INCOMPLETE';
    reasons.push('The plate needs at least one standard track and one sample track.');
  } else if (suitability.some((s) => !s.pass)) {
    conclusion = 'SST_FAILED';
    for (const s of suitability.filter((x) => !x.pass))
      reasons.push(`Standard ${s.track}: ${s.compound} ${s.rf === null ? 'not found' : `Rf ${s.rf.toFixed(3)}`} outside ${s.window.min}–${s.window.max}.`);
  } else if (identification.some((s) => !s.pass)) {
    conclusion = 'DOES_NOT_CONFORM';
    for (const s of identification.filter((x) => !x.pass))
      reasons.push(`Sample ${s.track}: ${s.compound} ${s.rf === null ? 'not found' : `Rf ${s.rf.toFixed(3)}`} outside ${s.window.min}–${s.window.max}.`);
  } else conclusion = 'CONFORMS';
  return { frontMm, tracks: out, suitability, identification, conclusion, reasons };
}

/** PNG or JPEG by content, not by name. */
export function imageType(data: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return null;
}
