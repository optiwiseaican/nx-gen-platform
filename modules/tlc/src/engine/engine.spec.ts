/**
 * Golden tests: the TypeScript engine must reproduce the TLC Tablet's Kotlin engine on the
 * tablet's own fixture plates. __fixtures__/golden.json was written by running the Kotlin engine
 * (GoldenDump.kt, kept out of the tablet repo) over the PNGs in the same folder.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PNG } from 'pngjs';
import {
  CalibrationCurve,
  CalibrationReview,
  CaptureQc,
  DEFAULT_DENSITOMETRY,
  DEFAULT_DEVELOPMENT,
  Densitogram,
  Densitometry,
  GrayImage,
  Homography,
  ImageOps,
  LayoutDetector,
  MethodLayout,
  PeakIntegrator,
  PeakLocator,
  PlateDetection,
  PlateDetector,
  PlateGeometry,
  PlateRectifier,
  Point,
  Quad,
  QcReport,
  Quantifier,
  RegressionMode,
  Rf,
  RgbImage,
  SavitzkyGolay,
  SpotDetector,
  Statistics,
  Track,
  TrackDetector,
  TrackPeak,
  argb,
  autoRetakeEv,
  BackgroundCorrection,
  quadFrom,
  verdictOf,
} from './index';

jest.setTimeout(180_000);

const FIX = join(__dirname, '__fixtures__');
const golden = JSON.parse(readFileSync(join(FIX, 'golden.json'), 'utf8'));

function loadPng(name: string): RgbImage {
  const png = PNG.sync.read(readFileSync(join(FIX, name)));
  const px = new Int32Array(png.width * png.height);
  for (let i = 0; i < px.length; i++) px[i] = argb(png.data[4 * i], png.data[4 * i + 1], png.data[4 * i + 2]);
  return new RgbImage(png.width, png.height, px);
}

function pixelsSha(rgb: RgbImage): string {
  const bytes = Buffer.alloc(rgb.pixels.length * 3);
  for (let i = 0; i < rgb.pixels.length; i++) {
    const p = rgb.pixels[i];
    bytes[3 * i] = (p >> 16) & 0xff;
    bytes[3 * i + 1] = (p >> 8) & 0xff;
    bytes[3 * i + 2] = p & 0xff;
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 of the float32 data as Java's big-endian FloatBuffer writes it. */
function graySha(gray: GrayImage): string {
  const bytes = Buffer.alloc(gray.data.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < gray.data.length; i++) view.setFloat32(4 * i, gray.data[i], false);
  return createHash('sha256').update(bytes).digest('hex');
}

const near = (actual: number | null, expected: number | null, tol = 1e-9): void => {
  if (expected === null || actual === null) {
    expect(actual).toBe(expected);
    return;
  }
  const limit = tol * Math.max(1, Math.abs(expected));
  if (Math.abs(actual - expected) > limit) throw new Error(`expected ${expected}, got ${actual} (diff ${actual - expected})`);
};
const nearArr = (actual: number[], expected: number[], tol = 1e-9): void => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    try {
      near(actual[i], expected[i], tol);
    } catch (e) {
      throw new Error(`index ${i}: ${(e as Error).message}`);
    }
  }
};

type GoldenDet = { quad: number[][]; threshold: number; fill: number; solid: number; edges: number } | null;
const toQuad = (q: number[][]): Quad => quadFrom(q.map(([x, y]) => ({ x, y })));
const toDet = (d: GoldenDet): PlateDetection | null => (d ? { quad: toQuad(d.quad), threshold: d.threshold, fill: d.fill, solid: d.solid, edges: d.edges } : null);
function expectDet(actual: PlateDetection | null, expected: GoldenDet): void {
  if (!expected) {
    expect(actual).toBeNull();
    return;
  }
  if (!actual) throw new Error('expected a detection');
  expect(actual.threshold).toBe(expected.threshold);
  near(actual.fill, expected.fill);
  const corners = [actual.quad.topLeft, actual.quad.topRight, actual.quad.bottomRight, actual.quad.bottomLeft];
  corners.forEach((c, i) => {
    near(c.x, expected.quad[i][0]);
    near(c.y, expected.quad[i][1]);
  });
}

type GoldenQc = {
  verdict: string;
  exposureEv: number | null;
  autoRetakeEv: number | null;
  stats?: { clippedFraction: number; lumaClippedFraction: number; darkFraction: number; background: number; highlight: number };
  items: { check: string; status: string; value: number | null; unit: string; message: string; action: string }[];
};
function expectQc(actual: QcReport, expected: GoldenQc): void {
  expect(verdictOf(actual)).toBe(expected.verdict);
  near(actual.exposureEv, expected.exposureEv);
  near(autoRetakeEv(actual), expected.autoRetakeEv);
  if (expected.stats) {
    const s = actual.stats as NonNullable<QcReport['stats']>;
    near(s.clippedFraction, expected.stats.clippedFraction);
    near(s.lumaClippedFraction, expected.stats.lumaClippedFraction);
    near(s.darkFraction, expected.stats.darkFraction);
    near(s.background, expected.stats.background);
    near(s.highlight, expected.stats.highlight);
  }
  expect(actual.items.map((i) => `${i.check} ${i.status} ${i.action} ${i.unit} | ${i.message}`)).toEqual(
    expected.items.map((i) => `${i.check} ${i.status} ${i.action} ${i.unit} | ${i.message}`),
  );
  actual.items.forEach((i, k) => near(i.value, expected.items[k].value, 1e-9));
}

describe('TLC engine golden tests (fixture plates)', () => {
  for (const g of golden.plates) {
    describe(g.file as string, () => {
      const rgb = loadPng(g.file);
      const gray = rgb.channel('INTENSITY');
      const geometry = new PlateGeometry(rgb.width, rgb.height, g.widthMm, g.heightMm);

      it('decodes the fixture and the intensity channel exactly as the tablet', () => {
        expect(pixelsSha(rgb)).toBe(g.pixelsSha256);
        expect(graySha(gray)).toBe(g.graySha256);
      });

      it('finds the baseline, front, tracks and width', () => {
        const lines = LayoutDetector.findLines(gray, geometry);
        near(lines.baselineMm, g.lines.baselineMm);
        near(lines.frontMm, g.lines.frontMm);
        const dev = { baselineMm: g.layout.baselineMm, solventFrontMm: g.layout.frontMm, trackWidthMm: 6 };
        nearArr(TrackDetector.detect(gray, geometry, dev), g.trackDetect);
        const layout = LayoutDetector.detect(gray, geometry, DEFAULT_DEVELOPMENT);
        near(layout.development.baselineMm, g.layout.baselineMm);
        near(layout.development.solventFrontMm, g.layout.frontMm);
        near(layout.development.trackWidthMm, g.layout.trackWidthMm);
        nearArr(layout.trackCentersMm, g.layout.centersMm);
        expect([layout.baselineFound, layout.frontFound, layout.widthEstimated]).toEqual([g.layout.baselineFound, g.layout.frontFound, g.layout.widthEstimated]);
      });

      it('thresholds and outlines the plate like the tablet', () => {
        expect(PlateDetector.otsuThreshold(gray)).toBe(g.otsu);
        expectDet(PlateDetector.detect(gray), g.detectGray);
        expectDet(PlateDetector.detect(PlateDetector.colorDistanceFromBorder(rgb)), g.detectColor);
      });

      it('extracts the same densitograms, smoothing and background correction', () => {
        const dev = { baselineMm: g.layout.baselineMm, solventFrontMm: g.layout.frontMm, trackWidthMm: g.layout.trackWidthMm };
        g.tracks.forEach((t: Record<string, unknown>, i: number) => {
          const track: Track = { id: i + 1, name: `T${i + 1}`, centerMm: t.centerMm as number };
          const raw = Densitogram.extract(gray, geometry, track, dev, 'DARK');
          nearArr(raw.hRf, t.rawHrf as number[]);
          nearArr(raw.signal, t.rawSignal as number[]);
          near(raw.pxPerSample, t.pxPerSample as number);
          nearArr(Densitometry.profile(gray, geometry, track, dev, 'DARK', DEFAULT_DENSITOMETRY).signal, t.smoothed as number[]);
          nearArr(Densitometry.profile(gray, geometry, track, dev, 'DARK', { ...DEFAULT_DENSITOMETRY, subtractBackground: true }).signal, t.backgroundCorrected as number[]);
        });
      });

      it('detects the same spots with the same windows, heights and areas', () => {
        const dev = { baselineMm: g.layout.baselineMm, solventFrontMm: g.layout.frontMm, trackWidthMm: g.layout.trackWidthMm };
        g.tracks.forEach((t: Record<string, unknown>, i: number) => {
          const track: Track = { id: i + 1, name: `T${i + 1}`, centerMm: t.centerMm as number };
          const dp = SpotDetector.detectionProfile(gray, geometry, track, dev, 'DARK');
          nearArr(dp.profile.signal, t.detection as number[]);
          near(dp.noise, t.noise as number);
          near(dp.samplesPerMm, t.samplesPerMm as number);
          const spots = SpotDetector.detectOn(dp, track.id);
          const expected = t.spots as Record<string, number | { startHrf: number; endHrf: number } | { maxHrf: number; height: number; area: number; widthPx: number }>[];
          expect(spots.length).toBe(expected.length);
          const smoothed = Densitometry.profile(gray, geometry, track, dev, 'DARK', DEFAULT_DENSITOMETRY);
          spots.forEach((s, k) => {
            const e = expected[k];
            expect(s.number).toBe(e.number);
            near(s.window.startHrf, e.startHrf as number);
            near(s.window.endHrf, e.endHrf as number);
            near(s.peak.startHrf, e.peakStart as number);
            near(s.peak.maxHrf, e.peakMax as number);
            near(s.peak.endHrf, e.peakEnd as number);
            near(s.peak.height, e.height as number);
            near(s.peak.area, e.area as number);
            near(s.peak.widthPx, e.widthPx as number);
            near(s.prominence, e.prominence as number);
            const tapWindow = e.tapWindow as { startHrf: number; endHrf: number };
            const tapPeak = e.tapPeak as { maxHrf: number; height: number; area: number; widthPx: number };
            const w = PeakLocator.windowAround(smoothed, s.peak.maxHrf);
            near(w.startHrf, tapWindow.startHrf);
            near(w.endHrf, tapWindow.endHrf);
            const p = PeakIntegrator.integrate(smoothed, w);
            near(p.maxHrf, tapPeak.maxHrf);
            near(p.height, tapPeak.height);
            near(p.area, tapPeak.area);
            near(p.widthPx, tapPeak.widthPx);
          });
        });
      });

      it('judges capture quality, analytical saturation and post-processing like the tablet', () => {
        const det = PlateDetector.detect(gray);
        expectQc(CaptureQc.evaluate({ image: rgb, detection: det, illumination: 'UV254', fromCamera: false }), g.qcCropped);
        expectQc(CaptureQc.evaluate({ image: rgb, detection: det, illumination: 'UV366', fromCamera: false }), g.qcUv366);
        const dev = { baselineMm: g.layout.baselineMm, solventFrontMm: g.layout.frontMm, trackWidthMm: g.layout.trackWidthMm };
        const tracks: Track[] = (g.layout.centersMm as number[]).map((c, i) => ({ id: i + 1, name: `T${i + 1}`, centerMm: c }));
        near(CaptureQc.analyticalSaturation(rgb, geometry, dev, tracks), g.analyticalSaturation);
        expect(pixelsSha(ImageOps.apply(rgb, { blackPoint: 30, whitePoint: 220, denoise: true }))).toBe(g.postProcessedSha256);
      });
    });
  }
});

describe('TLC engine golden tests (photo of a plate beside a scale)', () => {
  const g = golden.photo;
  const photo = loadPng(g.file);
  const det = toDet(g.detection) as PlateDetection;

  it('decodes the photo and outlines it by brightness and colour like the tablet', () => {
    expect(pixelsSha(photo)).toBe(g.pixelsSha256);
    expectDet(PlateDetector.detect(photo.channel('INTENSITY')), g.detectGray);
    expectDet(PlateDetector.detect(PlateDetector.colorDistanceFromBorder(photo)), g.detectColor);
  });

  it('straightens the plate pixel for pixel', () => {
    const { width, height } = PlateRectifier.outputSize(det.quad, 50, 100);
    expect([width, height]).toEqual([g.rectified.width, g.rectified.height]);
    const rect = PlateRectifier.rectify(photo, det.quad, width, height);
    expect(pixelsSha(rect)).toBe(g.rectified.pixelsSha256);
    expect(pixelsSha(loadPng('plate_on_scale_rectified.png'))).toBe(g.rectified.pixelsSha256);
  });

  it('measures rotation, perspective, sharpness and capture quality like the tablet', () => {
    near(CaptureQc.rotationDegrees(det.quad), g.rotationDeg);
    near(CaptureQc.cornerAngleDeviation(det.quad), g.cornerDeviationDeg);
    near(CaptureQc.edgeBlur(photo, det.quad), g.edgeBlur);
    expectQc(CaptureQc.evaluate({ image: photo, detection: det, illumination: 'UV254', fromCamera: true, motion: 1.0 }), g.qcCamera);
    expectQc(CaptureQc.evaluate({ image: photo, detection: det, illumination: 'UV254', fromCamera: false }), g.qcUpload);
    expectQc(CaptureQc.evaluate({ image: photo, detection: null, illumination: 'UV254', fromCamera: true, motion: 6.0 }), g.qcNoPlate);
  });
});

describe('TLC engine golden tests (staged scenes)', () => {
  const plate = loadPng('five_lanes_5x10_uv254.png');
  const bench = argb(0x26, 0x26, 0x26);
  function scene(c: Point[], w = 1400, h = 1000): RgbImage {
    const src: Point[] = [
      { x: 0, y: 0 },
      { x: plate.width - 1, y: 0 },
      { x: plate.width - 1, y: plate.height - 1 },
      { x: 0, y: plate.height - 1 },
    ];
    const toPlate = Homography.fromPoints(c, src);
    const px = new Int32Array(w * h).fill(bench);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = toPlate.map(x, y);
        const sx = Math.round(p.x);
        const sy = Math.round(p.y);
        if (sx >= 0 && sx < plate.width && sy >= 0 && sy < plate.height) px[y * w + x] = plate.get(sx, sy) | (0xff << 24);
      }
    }
    return new RgbImage(w, h, px);
  }

  for (const g of golden.scenes) {
    it(`${g.label}: outline, quality gate, sharpness and straightening`, () => {
      const img = scene((g.corners as number[][]).map(([x, y]) => ({ x, y })));
      expect(pixelsSha(img)).toBe(g.pixelsSha256);
      const gd = PlateDetector.detect(img.channel('INTENSITY'), 0.02);
      expectDet(gd, g.detectGray);
      expectDet(PlateDetector.detect(PlateDetector.colorDistanceFromBorder(img), 0.02), g.detectColor);
      const det = toDet(g.detection);
      expectQc(CaptureQc.evaluate({ image: img, detection: det, illumination: 'UV254', fromCamera: true, motion: 1.0 }), g.qc);
      expectQc(CaptureQc.evaluate({ image: img, detection: gd, illumination: 'UV254', fromCamera: true, motion: 1.0 }), g.qcGray);
      expectQc(CaptureQc.evaluate({ image: img, detection: det, illumination: 'UV366', fromCamera: true, motion: 5.0 }), g.qc366);
      if (det) {
        near(CaptureQc.edgeBlur(img, det.quad), g.edgeBlur);
        const { width, height } = PlateRectifier.outputSize(det.quad, 50, 100);
        expect([width, height]).toEqual([g.rectified.width, g.rectified.height]);
        expect(pixelsSha(PlateRectifier.rectify(img, det.quad, width, height))).toBe(g.rectified.pixelsSha256);
      }
    });
  }
});

describe('TLC engine golden tests (synthetic plate through quantification)', () => {
  const g = golden.synthetic;
  const widthMm = g.widthMm as number;
  const heightMm = g.heightMm as number;
  const pxPerMm = 5;
  const geometry = new PlateGeometry(Math.trunc(widthMm * pxPerMm), Math.trunc(heightMm * pxPerMm), widthMm, heightMm);
  const development = { baselineMm: 10, solventFrontMm: 70, trackWidthMm: 6 };
  const spots = g.spots as { xMm: number; hRf: number; depth: number; sigmaXmm: number; sigmaYmm: number }[];

  function render(): GrayImage {
    const w = geometry.widthPx;
    const h = geometry.heightPx;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const yMm = geometry.yPxToMm(y + 0.5);
      for (let x = 0; x < w; x++) {
        const xMm = geometry.xPxToMm(x + 0.5);
        let v = 200.0;
        for (const s of spots) {
          const cy = Rf.positionMm(s.hRf, development.baselineMm, development.solventFrontMm);
          const dx = (xMm - s.xMm) / s.sigmaXmm;
          const dy = (yMm - cy) / s.sigmaYmm;
          v -= s.depth * Math.exp(-0.5 * (dx * dx + dy * dy));
        }
        data[y * w + x] = Math.fround(Math.min(255, Math.max(0, v)));
      }
    }
    return new GrayImage(w, h, data);
  }
  const synth = render();
  const tracks: Track[] = [
    { id: 1, name: 'Ref 1µl', centerMm: 30, sampleVolumeUl: 1, concentration: 1, isReference: true },
    { id: 2, name: 'Ref 2µl', centerMm: 60, sampleVolumeUl: 2, concentration: 1, isReference: true },
    { id: 3, name: 'Ref 3µl', centerMm: 90, sampleVolumeUl: 3, concentration: 1, isReference: true },
    { id: 4, name: 'Ref 4µl', centerMm: 120, sampleVolumeUl: 4, concentration: 1, isReference: true },
    { id: 5, name: 'Sample', centerMm: 150, sampleVolumeUl: 0.3 },
    { id: 6, name: 'sample ', centerMm: 180, sampleVolumeUl: 0.3, dilutionFactor: 2 },
  ];

  it('renders the same plate and finds its tracks', () => {
    expect(graySha(synth)).toBe(g.graySha256);
    expect(pixelsSha(new RgbImage(synth.width, synth.height, synth.toArgb()))).toBe(pixelsSha(loadPng('synthetic_quant.png')));
    nearArr(TrackDetector.detect(synth, geometry, development), g.trackDetect);
  });

  const sg = SavitzkyGolay.forRegion(2.0, pxPerMm);
  const peaks: TrackPeak[] = tracks.map((t) => {
    const raw = Densitogram.extract(synth, geometry, t, development, 'DARK');
    const profile = raw.withSignal(sg.smooth(raw.signal));
    return { track: t, peak: PeakIntegrator.integrate(profile, PeakLocator.windowAround(profile, 57.0)) };
  });

  it('smooths and integrates the reference and sample peaks identically', () => {
    expect(sg.windowSize).toBe(g.sgWindow);
    nearArr(sg.coefficients, g.sgCoefficients);
    nearArr(sg.derivativeCoefficients(1), g.sgDerivative1);
    nearArr(sg.derivativeCoefficients(2), g.sgDerivative2);
    peaks.forEach((p, i) => {
      const e = g.peaks[i];
      expect(p.track.id).toBe(e.track);
      near(p.peak.startHrf, e.startHrf);
      near(p.peak.maxHrf, e.maxHrf);
      near(p.peak.endHrf, e.endHrf);
      near(p.peak.height, e.height);
      near(p.peak.area, e.area);
      near(p.peak.widthPx, e.widthPx);
    });
  });

  type GoldenCurve = { mode: string; coefficients: number[]; r: number; cvPercent: number; equation: string };
  const expectCurve = (c: CalibrationCurve, e: GoldenCurve): void => {
    expect(c.mode).toBe(e.mode);
    nearArr(c.coefficients, e.coefficients, 1e-8);
    near(c.r, e.r, 1e-8);
    near(c.cvPercent, e.cvPercent, 1e-6);
    expect(c.equation()).toBe(e.equation);
  };

  const cases: [string, RegressionMode, Map<number, string>][] = [
    ['linear', 'LINEAR', new Map()],
    ['throughOrigin', 'LINEAR_THROUGH_ORIGIN', new Map()],
    ['polynomial', 'POLYNOMIAL', new Map()],
    ['linearExcluded', 'LINEAR', new Map([[3, 'Spot smeared']])],
  ];
  for (const [key, mode, excluded] of cases) {
    it(`quantifies with ${mode}${excluded.size ? ' and an excluded standard' : ''} like the tablet`, () => {
      const e = g[key];
      const q = Quantifier.quantify(peaks, mode, excluded);
      expectCurve(q.byHeight, e.byHeight);
      expectCurve(q.byArea, e.byArea);
      expect(q.samples.length).toBe(e.samples.length);
      q.samples.forEach((s, i) => {
        expect(s.track.id).toBe(e.samples[i].track);
        near(s.concentrationByHeight, e.samples[i].concentrationByHeight, 1e-7);
        near(s.concentrationByArea, e.samples[i].concentrationByArea, 1e-7);
        expect([s.rangeByHeight, s.rangeByArea, s.dilutionFactor]).toEqual([e.samples[i].rangeByHeight, e.samples[i].rangeByArea, e.samples[i].dilutionFactor]);
      });
      q.standards.forEach((s, i) => {
        const x = e.standards[i];
        expect([s.track.id, s.nominalAmount, s.included, s.exclusionReason ?? '']).toEqual([x.track, x.nominalAmount, x.included, x.exclusionReason]);
        near(s.backCalculatedByHeight, x.backCalculatedByHeight, 1e-7);
        near(s.backCalculatedByArea, x.backCalculatedByArea, 1e-7);
        near(s.residualByHeight, x.residualByHeight, 1e-6);
        near(s.residualByArea, x.residualByArea, 1e-6);
        near(s.biasPercentByHeight, x.biasPercentByHeight, 1e-6);
        near(s.biasPercentByArea, x.biasPercentByArea, 1e-6);
      });
      expect(q.replicates.map((r) => [r.name, r.members.map((m) => m.track.id), r.anyOutOfRange])).toEqual(
        e.replicates.map((r: { name: string; members: number[]; anyOutOfRange: boolean }) => [r.name, r.members, r.anyOutOfRange]),
      );
      q.replicates.forEach((r, i) => {
        for (const side of ['byHeight', 'byArea'] as const) {
          const a = r[side];
          const x = e.replicates[i][side];
          if (!x) {
            expect(a).toBeNull();
            continue;
          }
          expect(a?.n).toBe(x.n);
          near(a?.mean ?? null, x.mean, 1e-7);
          near(a?.sd ?? null, x.sd, 1e-6);
          near(a?.cvPercent ?? null, x.cvPercent, 1e-6);
        }
      });
      const review = CalibrationReview.review(q.standards.filter((s) => s.included).map((s) => ({ amount: s.nominalAmount, residual: s.residualByArea })));
      expect([review.pattern, review.message]).toEqual([e.reviewByArea.pattern, e.reviewByArea.message]);
    });
  }

  it('applies a method layout to the detected lanes', () => {
    const detected = TrackDetector.detect(synth, geometry, development);
    const templates = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, i) => ({ name, centerMm: [31, 62, 91, 119, 151, 179][i], isReference: i === 0, sampleVolumeUl: i === 0 ? 1 : null, concentration: i === 0 ? 1 : null }));
    const a = MethodLayout.apply(templates, detected, widthMm);
    expect(a.match).toBe(g.methodLayout.match);
    nearArr(
      a.tracks.map((t) => t.centerMm),
      g.methodLayout.centers,
    );
    const b = MethodLayout.apply(
      [
        { name: 'A', centerMm: 31 },
        { name: 'B', centerMm: 250 },
      ],
      detected,
      widthMm,
    );
    expect(b.match).toBe(g.methodLayoutMismatch.match);
    nearArr(
      b.tracks.map((t) => t.centerMm),
      g.methodLayoutMismatch.centers,
    );
  });
});

describe('TLC engine golden tests (pure numbers)', () => {
  const n = golden.numbers;

  it('Savitzky–Golay coefficients, smoothing and derivatives', () => {
    nearArr(new SavitzkyGolay(5, 2).coefficients, n.sg5_2);
    nearArr(new SavitzkyGolay(7, 3).derivativeCoefficients(1), n.sg7_3d1);
    nearArr(new SavitzkyGolay(9, 4).derivativeCoefficients(2), n.sg9_4d2);
    const ramp = Array.from({ length: 20 }, (_, i) => i * i * 0.3 + 2.0);
    nearArr(new SavitzkyGolay(7, 2).smooth(ramp), n.smoothRamp);
    nearArr(new SavitzkyGolay(7, 2).derivative(ramp, 1, 0.5), n.derivRamp);
    const drift = Array.from({ length: 60 }, (_, i) => 0.2 * i + 40 * Math.exp(-0.5 * ((i - 30) / 4.0) * ((i - 30) / 4.0)));
    nearArr(BackgroundCorrection.subtractRollingBaseline(drift, 15), n.rollingBaseline);
  });

  it('calibration fits, back-calculation and the residual review', () => {
    const scatter = [
      { amount: 1, response: 10.5 },
      { amount: 2, response: 19.0 },
      { amount: 3, response: 31.0 },
      { amount: 4, response: 39.5 },
      { amount: 5, response: 52.0 },
    ];
    for (const [key, mode] of [
      ['fitLinear', 'LINEAR'],
      ['fitOrigin', 'LINEAR_THROUGH_ORIGIN'],
      ['fitPoly', 'POLYNOMIAL'],
    ] as [string, RegressionMode][]) {
      const c = CalibrationCurve.fit(scatter, mode);
      nearArr(c.coefficients, n[key].coefficients, 1e-8);
      near(c.r, n[key].r, 1e-8);
      near(c.cvPercent, n[key].cvPercent, 1e-6);
      expect(c.equation()).toBe(n[key].equation);
    }
    const poly = CalibrationCurve.fit(
      [1.0, 1.5, 2.0, 2.5, 3.0].map((x) => ({ amount: x, response: -3.2867 * x * x + 26.438 * x + 12.472 })),
      'POLYNOMIAL',
    );
    near(poly.amountFor(40.0), n.polyAmountFor[0], 1e-7);
    near(poly.amountFor(poly.response(2.2)), n.polyAmountFor[1], 1e-7);
    near(poly.amountFor(60.0), n.polyAmountFor[2], 1e-7);
    expect(poly.amountFor(80.0)).toBeNull();
    near(poly.response(2.2), n.polyResponse, 1e-8);
    const rv = (pts: number[][]): string => CalibrationReview.review(pts.map(([amount, residual]) => ({ amount, residual }))).pattern;
    expect(rv([[1, -2], [2, -1.5], [3, 2], [4, 2.5], [5, -1.8], [6, -2.2]])).toBe(n.reviewCurved);
    expect(rv([[1, -2], [2, -1], [3, 0.2], [4, 1.1], [5, 2.3]])).toBe(n.reviewTrend);
    expect(rv([[1, 0.1], [2, -0.3], [3, 0.9], [4, -1.6], [5, 2.4], [6, -3.1]])).toBe(n.reviewFunnel);
    expect(rv([[1, 0.5], [2, -0.4], [3, 0.3], [4, -0.5], [5, 0.2]])).toBe(n.reviewNone);
    expect(rv([[1, 0.5], [2, -0.4], [3, 0.3]])).toBe(n.reviewFew);
  });

  it('box statistics, Pearson, replicate statistics, contrast stretch', () => {
    const box = Statistics.box([5, 1, 9, 3, 7, 30, 2, 4]);
    expect(box).not.toBeNull();
    const b = box as NonNullable<typeof box>;
    for (const k of ['n', 'min', 'q1', 'median', 'q3', 'max', 'lowerWhisker', 'upperWhisker', 'mean'] as const) near(b[k], n.box[k]);
    nearArr(b.outliers, n.box.outliers);
    near(Statistics.pearson([1, 2, 3, 4], [2, 4.1, 5.9, 8.2]), n.pearson);
    const st = Quantifier.stats([4.9, 5.1, 5.3]) as NonNullable<ReturnType<typeof Quantifier.stats>>;
    expect(st.n).toBe(n.stats.n);
    near(st.mean, n.stats.mean);
    near(st.sd, n.stats.sd);
    near(st.cvPercent, n.stats.cvPercent);
    expect([ImageOps.contrastStretch(50, 63, 255), ImageOps.contrastStretch(159, 63, 255), ImageOps.contrastStretch(255, 63, 255)]).toEqual(n.contrastStretch);
  });

  it('plate outline geometry and homography', () => {
    const quad = quadFrom([
      { x: 800, y: 240 },
      { x: 1180, y: 240 },
      { x: 1180, y: 965 },
      { x: 800, y: 965 },
    ]);
    const a = PlateRectifier.outputSize(quad, 50, 100);
    expect([a.width, a.height]).toEqual(n.outputSize5x10);
    const b = PlateRectifier.outputSize(quad, 200, 100);
    expect([b.width, b.height]).toEqual(n.outputSize20x10);
    const hm = Homography.fromPoints(
      [
        { x: 0, y: 0 },
        { x: 99, y: 0 },
        { x: 99, y: 49 },
        { x: 0, y: 49 },
      ],
      [
        { x: 10, y: 12 },
        { x: 210, y: 20 },
        { x: 200, y: 130 },
        { x: 5, y: 120 },
      ],
    );
    const p = hm.map(50, 25);
    const q = hm.map(0, 49);
    nearArr([p.x, p.y, q.x, q.y], n.homographyMap);
  });
});
