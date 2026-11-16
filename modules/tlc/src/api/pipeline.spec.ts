import { readFileSync } from 'fs';
import { join } from 'path';
import { RgbImage, argb } from '../engine';
import { parseRfWindows } from '../shared/tlc';
import { decodeImage, encodePng, pixelBytes } from './images';
import { ENGINE_VERSION, autoLayout, analyticalGray, canonical, computeEvaluation, evaluationContent, imageQc, makePlate, parseEvaluationInput, parsePlateSpec, plateSize, sha256, suggestOutline, verifyPlate } from './pipeline';
import { PlateGeometry, PlateRectifier, quadFrom } from '../engine';

jest.setTimeout(120_000);

const FIX = join(__dirname, '../engine/__fixtures__');
const golden = JSON.parse(readFileSync(join(FIX, 'golden.json'), 'utf8'));
const load = (name: string): RgbImage => decodeImage(readFileSync(join(FIX, name)));
const corners = (q: number[][]) => q.map(([x, y]) => ({ x, y }));

describe('TLC pipeline: outline, straightening and verification', () => {
  const photo = load('plate_on_scale_uv254.png');

  it('suggests the plate outline on the photo and matches the 5 × 10 cm preset', () => {
    const s = suggestOutline(photo);
    expect(s).not.toBeNull();
    const g = golden.photo.detection.quad as number[][];
    s!.corners.forEach((c, i) => {
      expect(Math.abs(c.x - g[i][0])).toBeLessThan(12);
      expect(Math.abs(c.y - g[i][1])).toBeLessThan(12);
    });
    // The outline is 162 × 467 px (0.35): nearer the 2.5 × 7.5 cm proportions than 5 × 10 cm.
    expect(s!.preset?.label).toBe('2.5 × 7.5 cm');
  });

  it('straightens the plate exactly as the tablet (same pixels) and verifies it from the original', () => {
    const spec = parsePlateSpec({ corners: corners(golden.photo.detection.quad), widthMm: 50, heightMm: 100 }, photo);
    const quad = quadFrom(spec.corners);
    // At the photo's own resolution the plate is the tablet's 233 × 467 px, pixel for pixel.
    const native = PlateRectifier.outputSize(quad, 50, 100);
    expect([native.width, native.height]).toEqual([golden.photo.rectified.width, golden.photo.rectified.height]);
    expect(sha256(pixelBytes(PlateRectifier.rectify(photo, quad, native.width, native.height)))).toBe(golden.photo.rectified.pixelsSha256);
    // That is 4.66 px/mm, so the stored plate is brought up to the 5 px/mm floor.
    expect(plateSize(quad, 50, 100)).toEqual({ width: 250, height: 501 });
    const rect = makePlate(photo, spec);
    expect([rect.width, rect.height]).toEqual([250, 501]);
    const pixels = sha256(pixelBytes(rect));
    expect(verifyPlate(photo, spec, pixels)).toEqual({ ok: true, recomputed: pixels });
    const nudged = { ...spec, corners: spec.corners.map((c, i) => (i === 0 ? { x: c.x + 2, y: c.y } : c)) };
    expect(verifyPlate(photo, nudged, pixels).ok).toBe(false);
    // The PNG we store decodes back to the same pixels.
    expect(sha256(pixelBytes(decodeImage(encodePng(rect))))).toBe(pixels);
  });

  it('runs the capture quality gate on uploads: a photo is reviewed, a cropped plate is taken whole', () => {
    const photoQc = imageQc(photo, 'UV254');
    expect(photoQc.verdict).toBe(golden.photo.qcUpload.verdict);
    expect(photoQc.items.map((i) => `${i.check}:${i.status}`)).toEqual(golden.photo.qcUpload.items.map((i: { check: string; status: string }) => `${i.check}:${i.status}`));
    expect(photoQc.outline).not.toBeNull();
    const cropped = imageQc(load('five_lanes_5x10_uv254.png'), 'UV254');
    expect(cropped.verdict).not.toBe('RECAPTURE_REQUIRED');
    expect(cropped.items.find((i) => i.check === 'COMPLETENESS')?.status).toBe('NOT_ASSESSED');
    expect(cropped.outline).toEqual([
      { x: 0, y: 0 },
      { x: 625, y: 0 },
      { x: 625, y: 1250 },
      { x: 0, y: 1250 },
    ]);
    expect(suggestOutline(load('five_lanes_5x10_uv254.png'))?.corners).toEqual(cropped.outline);
    // A plate photographed far too dark fails the gate.
    const dark = new RgbImage(200, 400, new Int32Array(200 * 400).fill(argb(8, 9, 8)));
    expect(imageQc(dark, 'UV254').verdict).toBe('RECAPTURE_REQUIRED');
  });

  it('caps very large plates at 2400 px and floors small ones at 5 px/mm', () => {
    const big = plateSize(quadFrom(corners([[0, 0], [5999, 0], [5999, 2999], [0, 2999]])), 200, 100);
    expect(big).toEqual({ width: 2400, height: 1200 });
    const small = plateSize(quadFrom(corners([[0, 0], [99, 0], [99, 199], [0, 199]])), 50, 100);
    expect(small.width).toBeGreaterThanOrEqual(250);
    expect(small.height).toBeGreaterThanOrEqual(500);
  });

  it('rejects outlines that are not plates', () => {
    expect(() => parsePlateSpec({ corners: corners([[0, 0], [10, 0], [10, 10], [0, 10]]), widthMm: 50, heightMm: 100 }, photo)).toThrow(/too small/);
    expect(() => parsePlateSpec({ corners: corners([[0, 0], [300, 0], [550, 300], [0, 300]]), widthMm: 50, heightMm: 100 }, photo)).toThrow(/not a plate shape/);
    expect(() => parsePlateSpec({ corners: corners([[0, 0], [600, 0], [600, 600], [0, 600]]), widthMm: 5, heightMm: 100 }, photo)).toThrow(/10–300 mm/);
  });
});

describe('TLC pipeline: evaluation snapshots', () => {
  const plateImage = load('five_lanes_5x10_uv254.png');
  const g = golden.plates.find((p: { file: string }) => p.file === 'five_lanes_5x10_uv254.png');
  const plate = {
    widthMm: 50,
    heightMm: 100,
    illumination: 'UV254' as const,
    channel: 'INTENSITY' as const,
    postProcessing: { blackPoint: 0, whitePoint: 255, denoise: false },
    pixelsSha256: sha256(pixelBytes(plateImage)),
  };
  const { windows } = parseRfWindows([
    { name: 'Compound A', value: '0.40–0.46', unit: 'Rf' },
    { name: 'Compound B', value: '0.60–0.66', unit: 'Rf' },
  ]);

  it('auto layout finds the five lanes and their spots as the tablet does', () => {
    const gray = analyticalGray(plateImage, plate);
    const layout = autoLayout(gray, new PlateGeometry(gray.width, gray.height, 50, 100), 'UV254');
    expect(layout.trackCentersMm.map((c) => Math.round(c * 10) / 10)).toEqual((g.layout.centersMm as number[]).map((c) => Math.round(c * 10) / 10));
    expect(layout.lanes.map((l) => l.spots.map((s) => s.peak.maxHrf))).toEqual(
      g.tracks.map((t: { spots: { peakMax: number }[] }) => t.spots.map((s) => Math.round(s.peakMax * 10000) / 10000)),
    );
  });

  const input = parseEvaluationInput(
    {
      layout: { baselineMm: g.layout.baselineMm, solventFrontMm: g.layout.frontMm, trackWidthMm: g.layout.trackWidthMm, baselineSource: 'DETECTED', frontSource: 'DETECTED' },
      tracks: [
        { name: 'Std', role: 'STANDARD', centerMm: g.layout.centersMm[0], source: 'DETECTED', sampleVolumeUl: 2, concentration: 1 },
        { name: 'S2', role: 'SAMPLE', centerMm: g.layout.centersMm[1], source: 'DETECTED', sampleVolumeUl: 2 },
        { name: 'S5', role: 'SAMPLE', centerMm: g.layout.centersMm[4], source: 'DETECTED', sampleVolumeUl: 2 },
      ],
    },
    plate,
  );

  it('computes spots, Rf against the method windows and a conclusion, deterministically', () => {
    const results = computeEvaluation(plateImage, plate, input, windows);
    expect(results.tracks.map((t) => t.spots.map((s) => [s.rf, s.compound]))).toEqual([
      [
        [0.34, ''],
        [0.425, 'Compound A'],
        [0.62, 'Compound B'],
      ],
      [
        [0.34, ''],
        [0.528, ''],
      ],
      [
        [0.437, 'Compound A'],
        [0.635, 'Compound B'],
      ],
    ]);
    expect(results.rf.suitability.every((s) => s.pass)).toBe(true);
    expect(results.conclusion).toBe('DOES_NOT_CONFORM');
    expect(results.rf.reasons).toEqual(['Sample S2: Compound A not found outside 0.4–0.46.', 'Sample S2: Compound B not found outside 0.6–0.66.']);
    expect(results.analyticalSaturation).toBe(0);
    expect(results.tracks[0].profile.hRf.length).toBe(results.tracks[0].profile.processed.length);
    expect(results.tracks[0].profile.raw.length).toBe(results.tracks[0].profile.processed.length);
    const again = computeEvaluation(plateImage, plate, input, windows);
    expect(sha256(evaluationContent(input, again))).toBe(sha256(evaluationContent(input, results)));
    expect(evaluationContent(input, results)).toContain(ENGINE_VERSION);
    expect(canonical({ b: 1, a: [{ d: 2, c: NaN }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
  });

  it('conforms when only the matching sample is evaluated, and uses manual windows when given', () => {
    const two = { ...input, tracks: input.tracks.filter((t) => t.name !== 'S2') };
    expect(computeEvaluation(plateImage, plate, two, windows).conclusion).toBe('CONFORMS');
    const manual = {
      ...two,
      manualSpots: { '3': [{ startHrf: 40, endHrf: 48 }] },
    };
    const r = computeEvaluation(plateImage, plate, manual, windows);
    const s5 = r.tracks.find((t) => t.name === 'S5')!;
    expect(s5.spots.map((s) => s.source)).toEqual(['MANUAL']);
    expect(s5.spots[0].window).toEqual({ startHrf: 40, endHrf: 48 });
    expect(s5.spots[0].compound).toBe('Compound A');
    expect(r.conclusion).toBe('DOES_NOT_CONFORM');
    expect(r.rf.reasons).toEqual(['Sample S5: Compound B not found outside 0.6–0.66.']);
  });

  it('validates the evaluation input', () => {
    const base = { layout: { baselineMm: 10, solventFrontMm: 70, trackWidthMm: 6 }, tracks: [{ name: 'A', role: 'SAMPLE', centerMm: 10 }] };
    expect(() => parseEvaluationInput({ ...base, layout: { ...base.layout, solventFrontMm: 12 } }, plate)).toThrow(/at least 5 mm/);
    expect(() => parseEvaluationInput({ ...base, tracks: [] }, plate)).toThrow(/at least one track/);
    expect(() => parseEvaluationInput({ ...base, tracks: [{ name: 'A', role: 'SAMPLE', centerMm: 10 }, { name: 'B', role: 'SAMPLE', centerMm: 13 }] }, plate)).toThrow(/overlap/);
    expect(() => parseEvaluationInput({ ...base, tracks: [{ name: 'A', role: 'BLANK', centerMm: 10 }] }, plate)).toThrow(/standard or sample/);
    expect(() => parseEvaluationInput({ ...base, manualSpots: { '9': [] } }, plate)).toThrow(/unknown track/);
    expect(() => parseEvaluationInput({ ...base, manualSpots: { '1': [{ startHrf: 40, endHrf: 40.2 }] } }, plate)).toThrow(/0.5 hRf/);
    expect(() => parseEvaluationInput({ ...base, settings: { densitometry: { regression: 'CUBIC' } } }, plate)).toThrow(/regression/);
    expect(() => parseEvaluationInput({ ...base, image: { postProcessing: { blackPoint: 300 } } }, plate)).toThrow(/blackPoint/);
    expect(parseEvaluationInput({ ...base, image: { channel: 'GREEN', postProcessing: { blackPoint: 20, whitePoint: 240, denoise: true } } }, plate).image).toEqual({ channel: 'GREEN', postProcessing: { blackPoint: 20, whitePoint: 240, denoise: true } });
    expect(parseEvaluationInput(base, plate).image).toEqual({ channel: 'INTENSITY', postProcessing: plate.postProcessing });
    const ok = parseEvaluationInput({ ...base, settings: { densitometry: { subtractBackground: true, smoothingMm: 3 }, spotDetector: { sensitivity: 1.5 } } }, plate);
    expect(ok.settings.densitometry).toMatchObject({ subtractBackground: true, smoothingMm: 3, smoothing: true, regression: 'LINEAR' });
    expect(ok.settings.spotDetector.sensitivity).toBe(1.5);
  });
});
