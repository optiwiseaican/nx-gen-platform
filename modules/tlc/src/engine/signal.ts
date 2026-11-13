/**
 * Densitograms, smoothing, background correction, peaks and automatic spot detection, ported
 * from the tablet engine (engine/signal).
 */
import { GrayImage, clamp, roundToInt, toInt } from './image';
import { LinearAlgebra } from './linear-algebra';
import { Development, PlateGeometry, Rf, Track, trackBaselineMm, trackFrontMm } from './plate';

/** Whether substances appear darker than the plate (UV 254 quenching, white light) or brighter (UV 366 fluorescence). */
export type SpotPolarity = 'DARK' | 'BRIGHT';
export type WidthAggregation = 'AVERAGE' | 'MEDIAN';
export type Illumination = 'WHITE' | 'UV254' | 'UV366';

export const polarityOf = (illumination: Illumination): SpotPolarity => (illumination === 'UV366' ? 'BRIGHT' : 'DARK');

/** Intensity profile of one track from baseline (hRF 0) to solvent front (hRF 100); substances form positive peaks. */
export class Profile {
  constructor(
    readonly hRf: number[],
    readonly signal: number[],
    /** Image pixels between consecutive samples. */
    readonly pxPerSample: number,
  ) {
    if (hRf.length !== signal.length || hRf.length === 0) throw new Error('Profile needs matching, non-empty hRf and signal');
  }

  get size(): number {
    return this.hRf.length;
  }

  withSignal(signal: number[]): Profile {
    return new Profile(this.hRf, signal, this.pxPerSample);
  }

  /** Index of the sample closest to h. */
  indexOf(h: number): number {
    if (this.size === 1) return 0;
    const step = (this.hRf[this.size - 1] - this.hRf[0]) / (this.size - 1);
    return clamp(roundToInt((h - this.hRf[0]) / step), 0, this.size - 1);
  }

  valueAt(h: number): number {
    const n = this.size;
    if (h <= this.hRf[0]) return this.signal[0];
    if (h >= this.hRf[n - 1]) return this.signal[n - 1];
    const step = (this.hRf[n - 1] - this.hRf[0]) / (n - 1);
    const pos = (h - this.hRf[0]) / step;
    const i = Math.min(toInt(pos), n - 2);
    const fr = pos - i;
    return this.signal[i] * (1 - fr) + this.signal[i + 1] * fr;
  }
}

export const Densitogram = {
  /** Samples a track one pixel row at a time from its baseline to its solvent front. */
  extract(
    image: GrayImage,
    geometry: PlateGeometry,
    track: Track,
    development: Development,
    polarity: SpotPolarity,
    aggregation: WidthAggregation = 'AVERAGE',
    trackWidthMm: number = development.trackWidthMm,
  ): Profile {
    if (image.width !== geometry.widthPx || image.height !== geometry.heightPx) throw new Error('Image does not match plate geometry');
    const baseline = trackBaselineMm(track, development);
    const front = trackFrontMm(track, development);
    const yStart = geometry.yMmToPx(baseline);
    const yEnd = geometry.yMmToPx(front);
    const samples = Math.max(2, roundToInt(yStart - yEnd) + 1);
    const pxPerSample = (yStart - yEnd) / (samples - 1);

    const cx = geometry.xMmToPx(track.centerMm);
    const halfW = geometry.xMmToPx(trackWidthMm) / 2;
    const x0 = Math.max(0, roundToInt(cx - halfW));
    const x1 = Math.min(image.width - 1, roundToInt(cx + halfW));
    if (x1 < x0) throw new Error(`Track ${track.id} lies outside the plate`);
    const buffer = new Array<number>(x1 - x0 + 1);

    const hRf = new Array<number>(samples);
    const signal = new Array<number>(samples);
    for (let s = 0; s < samples; s++) {
      const y = yStart - s * pxPerSample;
      for (let x = x0; x <= x1; x++) buffer[x - x0] = image.sample(x, y);
      let v: number;
      if (aggregation === 'AVERAGE') {
        let sum = 0;
        for (const b of buffer) sum += b;
        v = sum / buffer.length;
      } else {
        const sorted = [...buffer].sort((a, b) => a - b);
        v = sorted[toInt(sorted.length / 2)];
      }
      signal[s] = polarity === 'DARK' ? 255.0 - v : v;
      hRf[s] = Rf.hRf(geometry.yPxToMm(y), baseline, front);
    }
    return new Profile(hRf, signal, pxPerSample);
  },
};

export const BackgroundCorrection = {
  /**
   * Removes a slowly varying background by subtracting a smoothed morphological opening
   * (rolling minimum, then rolling maximum) over windowSamples. The window should be wider
   * than the widest peak.
   */
  subtractRollingBaseline(signal: number[], windowSamples: number): number[] {
    const half = Math.max(toInt(windowSamples / 2), 1);
    const opened = rolling(rolling(signal, half, Math.min), half, Math.max);
    const n = signal.length;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      let s = 0;
      for (let k = lo; k <= hi; k++) s += opened[k];
      out[i] = signal[i] - s / (hi - lo + 1);
    }
    return out;
  },
};

function rolling(values: number[], half: number, pick: (a: number, b: number) => number): number[] {
  return values.map((v, i) => {
    let m = v;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) m = pick(m, values[k]);
    return m;
  });
}

/** Savitzky–Golay smoothing: preserves peak height and width, unlike a moving average. */
export class SavitzkyGolay {
  readonly coefficients: number[];

  constructor(
    readonly windowSize: number,
    readonly polyOrder: number = 2,
  ) {
    if (!(windowSize >= 3 && windowSize % 2 === 1)) throw new Error('windowSize must be odd and >= 3');
    if (!(polyOrder >= 0 && polyOrder < windowSize)) throw new Error('polyOrder must be < windowSize');
    this.coefficients = this.solveFor(0, 1);
  }

  private solveFor(order: number, factorial: number): number[] {
    const half = toInt(this.windowSize / 2);
    const p = this.polyOrder + 1;
    const ata: number[][] = [];
    for (let j = 0; j < p; j++) {
      const row: number[] = [];
      for (let k = 0; k < p; k++) {
        let s = 0;
        for (let t = -half; t <= half; t++) s += Math.pow(t, j + k);
        row.push(s);
      }
      ata.push(row);
    }
    const e = new Array<number>(p).fill(0);
    e[order] = 1.0;
    const z = LinearAlgebra.solve(ata, e);
    const out: number[] = [];
    for (let i = 0; i < this.windowSize; i++) {
      const t = i - half;
      let s = 0;
      for (let j = 0; j < p; j++) s += Math.pow(t, j) * z[j];
      out.push(factorial * s);
    }
    return out;
  }

  /** Coefficients for the order-th derivative at the window centre, per sample. */
  derivativeCoefficients(order: number): number[] {
    if (!(order >= 1 && order <= this.polyOrder)) throw new Error('derivative order must be 1..polyOrder');
    let factorial = 1;
    for (let k = 1; k <= order; k++) factorial *= k;
    return this.solveFor(order, factorial);
  }

  /** order-th derivative of y sampled every step x-units (ends mirrored like smooth). */
  derivative(y: number[], order: number, step: number): number[] {
    const c = this.derivativeCoefficients(order);
    const half = toInt(this.windowSize / 2);
    const n = y.length;
    const scale = Math.pow(step, order);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -half; k <= half; k++) s += c[k + half] * y[SavitzkyGolay.mirror(i + k, n)];
      out[i] = s / scale;
    }
    return out;
  }

  /** Smooths y; the ends are handled by mirroring the signal. */
  smooth(y: number[]): number[] {
    if (y.length < 2) return [...y];
    const half = toInt(this.windowSize / 2);
    const n = y.length;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -half; k <= half; k++) s += this.coefficients[k + half] * y[SavitzkyGolay.mirror(i + k, n)];
      out[i] = s;
    }
    return out;
  }

  static mirror(i: number, n: number): number {
    if (n === 1) return 0;
    const period = 2 * (n - 1);
    const j = ((i % period) + period) % period;
    return j < n ? j : period - j;
  }

  /** Window covering regionMm at the profile's sampling, forced odd and large enough for polyOrder. */
  static forRegion(regionMm: number, samplesPerMm: number, polyOrder = 2): SavitzkyGolay {
    let window = Math.max(roundToInt(regionMm * samplesPerMm), polyOrder + 2, 3);
    if (window % 2 === 0) window++;
    return new SavitzkyGolay(window, polyOrder);
  }
}

/** Integration window on a track, in hRF. */
export interface PeakWindow {
  startHrf: number;
  endHrf: number;
}

export function peakWindow(startHrf: number, endHrf: number): PeakWindow {
  if (!(endHrf > startHrf)) throw new Error('Peak end must be above peak start');
  return { startHrf, endHrf };
}

export interface PeakResult {
  startHrf: number;
  maxHrf: number;
  endHrf: number;
  height: number;
  /** Area in signal × image pixels, independent of the profile sampling. */
  area: number;
  widthPx: number;
}

export const PeakIntegrator = {
  /** Integrates the profile over the window, removing the chord between start and end first when asked. */
  integrate(profile: Profile, window: PeakWindow, subtractPeakBaseline = true): PeakResult {
    const i0 = profile.indexOf(window.startHrf);
    const i1 = Math.min(Math.max(i0 + 1, profile.indexOf(window.endHrf)), profile.size - 1);
    if (!(i1 > i0)) throw new Error('Peak window is narrower than one sample');
    const y0 = profile.signal[i0];
    const y1 = profile.signal[i1];
    const corrected = (i: number): number => {
      if (!subtractPeakBaseline) return profile.signal[i];
      const t = (i - i0) / (i1 - i0);
      return profile.signal[i] - (y0 + (y1 - y0) * t);
    };
    let height = -Infinity;
    let maxIndex = i0;
    let area = 0;
    for (let i = i0; i <= i1; i++) {
      const c = corrected(i);
      if (c > height) {
        height = c;
        maxIndex = i;
      }
      if (i < i1) area += ((c + corrected(i + 1)) / 2) * profile.pxPerSample;
    }
    return {
      startHrf: profile.hRf[i0],
      maxHrf: profile.hRf[maxIndex],
      endHrf: profile.hRf[i1],
      height,
      area,
      widthPx: (i1 - i0) * profile.pxPerSample,
    };
  },
};

export const PeakLocator = {
  /** Turns a tap at clickHrf into an integration window around the nearest maximum. */
  windowAround(profile: Profile, clickHrf: number, searchHrf = 5.0, maxHalfWidthHrf = 15.0): PeakWindow {
    const s = profile.signal;
    const n = profile.size;
    const step = n > 1 ? (profile.hRf[n - 1] - profile.hRf[0]) / (n - 1) : 1.0;
    const searchSamples = Math.max(1, toInt(searchHrf / step));
    const maxHalf = Math.max(2, toInt(maxHalfWidthHrf / step));

    const c = profile.indexOf(clickHrf);
    let top = c;
    for (let i = Math.max(0, c - searchSamples); i <= Math.min(n - 1, c + searchSamples); i++) if (s[i] > s[top]) top = i;

    const lo = Math.max(0, top - maxHalf);
    const hi = Math.min(n - 1, top + maxHalf);
    let floor = Infinity;
    for (let i = lo; i <= hi; i++) floor = Math.min(floor, s[i]);
    const tolerance = Math.max(1e-9, (s[top] - floor) * 0.02);

    let left = top;
    while (left > lo && s[left - 1] <= s[left] + tolerance && s[left] - floor > tolerance) left--;
    let right = top;
    while (right < hi && s[right + 1] <= s[right] + tolerance && s[right] - floor > tolerance) right++;
    if (left === right) {
      left = Math.max(0, top - 1);
      right = Math.min(n - 1, top + 1);
    }
    return { startHrf: profile.hRf[left], endHrf: profile.hRf[right] };
  },

  /** Local maxima with prominence above minProminence, at least minDistanceSamples apart. */
  findPeaks(signal: number[], minProminence: number, minDistanceSamples: number): number[] {
    const candidates: number[] = [];
    for (let i = 1; i < signal.length - 1; i++) {
      if (signal[i] >= signal[i - 1] && signal[i] > signal[i + 1] && PeakLocator.prominence(signal, i) >= minProminence) candidates.push(i);
    }
    candidates.sort((a, b) => signal[b] - signal[a]);
    const kept: number[] = [];
    for (const c of candidates) if (!kept.some((k) => Math.abs(k - c) < minDistanceSamples)) kept.push(c);
    return kept.sort((a, b) => a - b);
  },

  /** Height of a peak above the higher of the two minima separating it from taller terrain. */
  prominence(signal: number[], peak: number): number {
    const h = signal[peak];
    let leftMin = h;
    let i = peak - 1;
    while (i >= 0 && signal[i] <= h) {
      leftMin = Math.min(leftMin, signal[i]);
      i--;
    }
    let rightMin = h;
    i = peak + 1;
    while (i < signal.length && signal[i] <= h) {
      rightMin = Math.min(rightMin, signal[i]);
      i++;
    }
    return h - Math.max(leftMin, rightMin);
  },
};

export type RegressionMode = 'LINEAR_THROUGH_ORIGIN' | 'LINEAR' | 'POLYNOMIAL';

export interface DensitometrySettings {
  aggregation: WidthAggregation;
  smoothing: boolean;
  /** Savitzky–Golay window in mm along the track. */
  smoothingMm: number;
  subtractBackground: boolean;
  /** Background window in mm; must be wider than the widest spot. */
  backgroundWindowMm: number;
  /** Remove the straight line between peak start and end before measuring height and area. */
  subtractPeakBaseline: boolean;
  regression: RegressionMode;
}

export const DEFAULT_DENSITOMETRY: DensitometrySettings = {
  aggregation: 'AVERAGE',
  smoothing: true,
  smoothingMm: 2.0,
  subtractBackground: false,
  backgroundWindowMm: 15.0,
  subtractPeakBaseline: true,
  regression: 'LINEAR',
};

export const Densitometry = {
  profile(image: GrayImage, geometry: PlateGeometry, track: Track, development: Development, polarity: SpotPolarity, settings: DensitometrySettings): Profile {
    const raw = Densitogram.extract(image, geometry, track, development, polarity, settings.aggregation);
    let signal = raw.signal;
    const samplesPerMm = geometry.pxPerMmY / raw.pxPerSample;
    if (settings.subtractBackground) {
      const window = Math.max(roundToInt(settings.backgroundWindowMm * samplesPerMm), 3);
      signal = BackgroundCorrection.subtractRollingBaseline(signal, window);
    }
    if (settings.smoothing && signal.length >= 5) {
      const sg = SavitzkyGolay.forRegion(settings.smoothingMm, samplesPerMm);
      if (sg.windowSize < signal.length) signal = sg.smooth(signal);
    }
    return raw.withSignal(signal);
  },
};

/** A spot found automatically in one track, with its integration window and measured peak. */
export interface DetectedSpot {
  trackId: number;
  /** 1-based, from the baseline upwards. */
  number: number;
  window: PeakWindow;
  peak: PeakResult;
  /** Height above the surrounding valleys, in the units of PeakResult.height. */
  prominence: number;
}

export interface SpotDetectorSettings {
  /** 1 = default; higher finds fainter spots (and more noise), lower only strong ones. */
  sensitivity: number;
  /** Spots closer than this along the track are treated as one. */
  minSeparationMm: number;
  backgroundWindowMm: number;
  smoothingMm: number;
  /** A spot must stand this many noise σ above its valleys (divided by sensitivity). */
  noiseSigmas: number;
  /** …and this fraction of the track's strongest signal (divided by sensitivity). */
  relativeThreshold: number;
  /** Peaks this close to hRF 0 or 100 are the pencil marks and the front line, not substances. */
  endExclusionHrf: number;
  /** A spot's window ends where the signal falls to this fraction of its height. */
  edgeFraction: number;
  /** Absolute minimum prominence in grey levels (divided by sensitivity). */
  minProminence: number;
  /** Wider than this at half height is a background undulation, not a spot. */
  maxHalfHeightWidthMm: number;
}

export const DEFAULT_SPOT_DETECTOR: SpotDetectorSettings = {
  sensitivity: 1.0,
  minSeparationMm: 1.5,
  backgroundWindowMm: 15.0,
  smoothingMm: 1.5,
  noiseSigmas: 5.0,
  relativeThreshold: 0.04,
  endExclusionHrf: 2.0,
  edgeFraction: 0.05,
  minProminence: 3.0,
  maxHalfHeightWidthMm: 10.0,
};

/** Background-corrected, smoothed profile the detector works on (also used for manual spots). */
export interface DetectionProfile {
  profile: Profile;
  samplesPerMm: number;
  /** Noise σ of the corrected signal. */
  noise: number;
}

export const SpotDetector = {
  detectionProfile(
    image: GrayImage,
    geometry: PlateGeometry,
    track: Track,
    development: Development,
    polarity: SpotPolarity,
    aggregation: WidthAggregation = 'AVERAGE',
    settings: SpotDetectorSettings = DEFAULT_SPOT_DETECTOR,
  ): DetectionProfile {
    const raw = Densitogram.extract(image, geometry, track, development, polarity, aggregation);
    const samplesPerMm = geometry.pxPerMmY / raw.pxPerSample;
    const corrected = BackgroundCorrection.subtractRollingBaseline(raw.signal, Math.max(roundToInt(settings.backgroundWindowMm * samplesPerMm), 3));
    const sg = SavitzkyGolay.forRegion(settings.smoothingMm, samplesPerMm);
    const smooth = sg.windowSize < corrected.length ? sg.smooth(corrected) : corrected;
    const noise = robustSigma(corrected.map((v, i) => v - smooth[i]));
    return { profile: raw.withSignal(smooth), samplesPerMm, noise };
  },

  detect(
    image: GrayImage,
    geometry: PlateGeometry,
    track: Track,
    development: Development,
    polarity: SpotPolarity,
    aggregation: WidthAggregation = 'AVERAGE',
    settings: SpotDetectorSettings = DEFAULT_SPOT_DETECTOR,
  ): DetectedSpot[] {
    return SpotDetector.detectOn(SpotDetector.detectionProfile(image, geometry, track, development, polarity, aggregation, settings), track.id, settings);
  },

  /** Detection on an already computed profile (so callers can reuse its noise estimate). */
  detectOn(dp: DetectionProfile, trackId: number, settings: SpotDetectorSettings = DEFAULT_SPOT_DETECTOR): DetectedSpot[] {
    const profile = dp.profile;
    const smooth = profile.signal;
    if (smooth.length < 7) return [];

    let maxIn = -Infinity;
    let minIn = Infinity;
    let any = false;
    for (let i = 0; i < smooth.length; i++) {
      const h = profile.hRf[i];
      if (h >= settings.endExclusionHrf && h <= 100 - settings.endExclusionHrf) {
        any = true;
        maxIn = Math.max(maxIn, smooth[i]);
        minIn = Math.min(minIn, smooth[i]);
      }
    }
    if (!any) return [];
    const range = maxIn - minIn;
    const minProminence = Math.max(settings.noiseSigmas * dp.noise, settings.relativeThreshold * range, settings.minProminence) / settings.sensitivity;
    const minDistance = Math.max(1, roundToInt(settings.minSeparationMm * dp.samplesPerMm));
    const peaks = PeakLocator.findPeaks(smooth, minProminence, minDistance).filter(
      (i) => profile.hRf[i] >= settings.endExclusionHrf && profile.hRf[i] <= 100 - settings.endExclusionHrf,
    );
    if (peaks.length === 0) return [];

    const tolerance = 2 * dp.noise;
    const spots: DetectedSpot[] = [];
    peaks.forEach((p, i) => {
      const leftBound = i > 0 ? argMin(smooth, peaks[i - 1], p) : 0;
      const rightBound = i < peaks.length - 1 ? argMin(smooth, p, peaks[i + 1]) : smooth.length - 1;
      let base = Infinity;
      for (let k = leftBound; k <= rightBound; k++) base = Math.min(base, smooth[k]);
      const height = smooth[p] - base;
      const half = base + height / 2;
      const cutoff = base + settings.edgeFraction * height;

      let hl = p;
      while (hl > leftBound && smooth[hl - 1] > half) hl--;
      let hr = p;
      while (hr < rightBound && smooth[hr + 1] > half) hr++;
      if ((hr - hl) / dp.samplesPerMm > settings.maxHalfHeightWidthMm) return;
      const maxLeft = Math.max(leftBound, p - Math.ceil(2.5 * (p - hl + 1)));
      const maxRight = Math.min(rightBound, p + Math.ceil(2.5 * (hr - p + 1)));

      let l = p;
      while (l > maxLeft && smooth[l - 1] > cutoff && smooth[l - 1] <= smooth[l] + tolerance) l--;
      let r = p;
      while (r < maxRight && smooth[r + 1] > cutoff && smooth[r + 1] <= smooth[r] + tolerance) r++;
      if (r === l) {
        l = Math.max(leftBound, p - 1);
        r = Math.min(rightBound, p + 1);
      }
      const window: PeakWindow = { startHrf: profile.hRf[l], endHrf: profile.hRf[r] };
      spots.push({
        trackId,
        number: 0,
        window,
        peak: PeakIntegrator.integrate(profile, window, true),
        prominence: PeakLocator.prominence(smooth, p),
      });
    });
    return spots.map((s, i) => ({ ...s, number: i + 1 }));
  },

  /** Measures spots whose windows the user set or adjusted, numbered from the baseline up. */
  measure(dp: DetectionProfile, trackId: number, windows: PeakWindow[]): DetectedSpot[] {
    return [...windows]
      .sort((a, b) => a.startHrf - b.startHrf)
      .map((w, i) => {
        const peak = PeakIntegrator.integrate(dp.profile, w, true);
        return { trackId, number: i + 1, window: w, peak, prominence: peak.height };
      });
  },
};

function argMin(values: number[], from: number, to: number): number {
  let best = from;
  for (let i = from; i <= to; i++) if (values[i] < values[best]) best = i;
  return best;
}

/** σ from the median absolute deviation, robust to the spots themselves. */
function robustSigma(values: number[]): number {
  const absDev = values.map(Math.abs).sort((a, b) => a - b);
  return 1.4826 * absDev[toInt(absDev.length / 2)];
}
