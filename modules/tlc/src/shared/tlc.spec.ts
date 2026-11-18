import { evaluate, imageType, parseRfWindows, rf, validatePlate } from './tlc';

const windows = parseRfWindows([
  { name: 'Paracetamol', value: '0.40–0.50', unit: 'Rf' },
  { name: 'Caffeine', value: '0.62 ± 0.05', unit: 'rf' },
  { name: 'Chamber saturation', value: '30', unit: 'min' },
]).windows;

const plate = (sampleCaffeineMm = 49.6, standardParacetamolMm = 36) => [
  { label: 'S1', role: 'STANDARD' as const, spots: [{ distanceMm: standardParacetamolMm, compound: 'Paracetamol' }, { distanceMm: 49.6, compound: 'Caffeine' }] },
  { label: 'T1', role: 'SAMPLE' as const, spots: [{ distanceMm: 36.8, compound: 'paracetamol' }, { distanceMm: sampleCaffeineMm, compound: 'Caffeine' }, { distanceMm: 12, compound: '' }] },
];

describe('TLC', () => {
  it('calculates Rf as spot distance over solvent front distance', () => {
    expect(rf(36, 80)).toBe(0.45);
    expect(rf(49.6, 80)).toBe(0.62);
  });

  it('reads Rf windows from method parameters with unit Rf', () => {
    expect(windows).toEqual([
      { compound: 'Paracetamol', min: 0.4, max: 0.5 },
      { compound: 'Caffeine', min: 0.57, max: 0.67 },
    ]);
    expect(parseRfWindows([{ name: 'X', value: 'about half', unit: 'Rf' }]).problems[0]).toMatch(/not "min–max"/);
    expect(parseRfWindows([{ name: 'X', value: '0.9-1.2', unit: 'Rf' }]).problems[0]).toMatch(/between 0 and 1/);
  });

  it('conforms when standards pass suitability and samples match every compound', () => {
    const e = evaluate(80, plate(), windows);
    expect(e.conclusion).toBe('CONFORMS');
    expect(e.suitability.every((s) => s.pass)).toBe(true);
    expect(e.tracks[1].spots[2]).toMatchObject({ rf: 0.15, window: null, inWindow: null });
  });

  it('fails suitability before judging samples', () => {
    const e = evaluate(80, plate(49.6, 44), windows); // standard paracetamol Rf 0.55
    expect(e.conclusion).toBe('SST_FAILED');
    expect(e.reasons[0]).toMatch(/Standard S1: Paracetamol Rf 0.550 outside 0.4–0.5/);
  });

  it('does not conform when a sample spot is outside or missing', () => {
    expect(evaluate(80, plate(60), windows).conclusion).toBe('DOES_NOT_CONFORM'); // Rf 0.75
    const missing = evaluate(80, [plate()[0], { label: 'T1', role: 'SAMPLE', spots: [{ distanceMm: 36.8, compound: 'Paracetamol' }] }], windows);
    expect(missing.conclusion).toBe('DOES_NOT_CONFORM');
    expect(missing.reasons[0]).toMatch(/Caffeine not found/);
  });

  it('is incomplete without windows, standards or samples', () => {
    expect(evaluate(80, plate(), []).conclusion).toBe('INCOMPLETE');
    expect(evaluate(80, [plate()[1]], windows).conclusion).toBe('INCOMPLETE');
  });

  it('validates plate data', () => {
    expect(validatePlate(80, plate())).toEqual([]);
    expect(validatePlate(null, [])).toContain('Enter the solvent front distance (0–300 mm from the origin).');
    expect(validatePlate(40, plate())[0]).toMatch(/cannot travel further than the solvent front/);
    expect(validatePlate(80, [plate()[0], { ...plate()[0] }])).toContain('S1: labels must be unique.');
  });

  it('recognises images by content', () => {
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });
});

import { applyCameraAdjustment, autoExposureUs, autoWhiteBalance, DEFAULT_CAMERA, parseCameraSettings } from './tlc';

describe('camera settings on the Picture stage', () => {
  const method = (params: { name: string; value: string; unit: string }[]) => parseCameraSettings(params).settings;

  it('the analyst sets exposure, gain and white balance when the method does not', () => {
    const { settings, problems, adjusted } = applyCameraAdjustment(method([]), { exposureUs: 110_000, gain: 4.38, whiteBalance: [1.9, 1, 1.6] });
    expect(problems).toEqual([]);
    expect(adjusted).toEqual(['exposure', 'gain', 'whiteBalance']);
    expect(settings).toMatchObject({ exposureUs: 110_000, gain: 4.38, whiteBalance: [1.9, 1, 1.6], fixed: true });
  });

  it('settings from the method win and cannot be changed', () => {
    const base = method([
      { name: 'Camera exposure', value: '25', unit: 'ms' },
      { name: 'Camera white balance', value: '1.6/1.0/1.9', unit: '' },
    ]);
    const { settings, adjusted } = applyCameraAdjustment(base, { exposureUs: 500_000, gain: 2, whiteBalance: [1, 1, 1] });
    expect(adjusted).toEqual(['gain']);
    expect(settings).toMatchObject({ exposureUs: 25_000, gain: 2, whiteBalance: [1.6, 1, 1.9], fixed: true });
  });

  it('out-of-range values are refused; nothing given keeps automatic exposure', () => {
    expect(applyCameraAdjustment(DEFAULT_CAMERA, { exposureUs: 5, gain: 40, whiteBalance: [9, 1, 1] }).problems).toHaveLength(3);
    expect(applyCameraAdjustment(DEFAULT_CAMERA, undefined).settings.fixed).toBe(false);
  });

  it('auto exposure brings a dark frame up, a saturated one down, in bounded steps', () => {
    expect(autoExposureUs({ r: 8, g: 12, b: 8, luma: 10, saturated: 0 }, 20_000)).toBe(160_000); // 11.5× wanted, capped at 8×
    expect(autoExposureUs({ r: 60, g: 60, b: 60, luma: 57.375, saturated: 0 }, 20_000)).toBe(40_000); // 45 % of 255 = 114.75 = 2 × 57.375
    expect(autoExposureUs({ r: 200, g: 200, b: 200, luma: 200, saturated: 0.1 }, 100_000)).toBe(50_000);
  });

  it('auto white balance (grey world) removes a green cast', () => {
    expect(autoWhiteBalance({ r: 40, g: 80, b: 50, luma: 65, saturated: 0 }, [1, 1, 1])).toEqual([2, 1, 1.6]);
  });
});
