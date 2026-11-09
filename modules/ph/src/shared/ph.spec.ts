import { assessStability, computePh, decodePacket, nernstSlope, readingsFromSlots, validateDetails, validateReadings } from './ph';

const ideal = (slopeFactor = 1, offset = 0) =>
  [4.01, 7.0, 10.01].map((bufferPh) => ({ bufferPh, mv: Math.round((offset - nernstSlope(25) * slopeFactor * (bufferPh - 7)) * 10) / 10 }));

describe('pH calibration', () => {
  it('uses 59.16 mV/pH at 25 °C and grades slope and offset against the LabApp limits', () => {
    expect(nernstSlope(25)).toBeCloseTo(59.16, 2);
    expect(computePh(ideal(), 25)).toMatchObject({ outcome: 'PASS', rSquared: 1 });
    expect(computePh(ideal(), 25).slopePercent).toBeCloseTo(100, 0);
    expect(computePh(ideal(0.97, 12), 25)).toMatchObject({ outcome: 'PASS' });
    expect(computePh(ideal(1, 38), 25)).toMatchObject({ outcome: 'WARNING', offsetOutcome: 'WARNING' });
    expect(computePh(ideal(0.93), 25)).toMatchObject({ outcome: 'WARNING', slopeOutcome: 'WARNING' });
    expect(computePh(ideal(0.88), 25)).toMatchObject({ outcome: 'FAIL', slopeOutcome: 'FAIL' });
    expect(computePh(ideal(1, 60), 25)).toMatchObject({ outcome: 'FAIL', offsetOutcome: 'FAIL' });
    expect(computePh(ideal(-1), 25)).toMatchObject({ outcome: 'FAIL', slopeOutcome: 'FAIL' });
  });

  it('corrects the theoretical slope for temperature', () => {
    // An electrode with exactly Nernstian response at 35 °C reads ~103 % if wrongly assumed at 25 °C.
    const at35 = [4.01, 7, 10.01].map((bufferPh) => ({ bufferPh, mv: -nernstSlope(35) * (bufferPh - 7) }));
    expect(computePh(at35, 35).slopePercent).toBeCloseTo(100, 1);
    expect(computePh(at35, 25).slopePercent).toBeCloseTo(103.35, 1);
  });

  it('rejects unusable readings', () => {
    expect(validateReadings(ideal(), 25)).toEqual([]);
    expect(validateReadings(ideal(), null)).toContain('Enter the buffer temperature (0–100 °C).');
    expect(validateReadings([{ bufferPh: 7, mv: 0 }], 25)).toContain('Use 2 to 5 buffers.');
    expect(validateReadings([{ bufferPh: 7, mv: 0 }, { bufferPh: 7.5, mv: -30 }], 25)).toContain('Buffers must span at least 2 pH units.');
    expect(validateReadings([{ bufferPh: 4, mv: 0 }, { bufferPh: 4, mv: 1 }], 25)).toContain('Each buffer must have a different pH.');
  });
});

describe('pH packets (LabApp protocol)', () => {
  it('classifies measurement, calibration, status and log packets', () => {
    expect(decodePacket({ PH_VAL: '7.25' })).toEqual({ ok: true, packet: { kind: 'MEASUREMENT', values: { PH_VAL: 7.25 }, text: {}, unknownKeys: [] } });
    const cal = decodePacket({ MV_1: '177.25', MV_2: '0.00', DT_1: '2026-11-07 10:00:00', SLOPE: '98.5' });
    expect(cal).toMatchObject({ ok: true, packet: { kind: 'CALIBRATION', values: { MV_1: 177.25, MV_2: 0, SLOPE: 98.5 }, text: { DT_1: '2026-11-07 10:00:00' } } });
    expect(decodePacket({ BATTERY: '85' })).toMatchObject({ ok: true, packet: { kind: 'STATUS' } });
    expect(decodePacket({ LOG: '1' })).toMatchObject({ ok: true, packet: { kind: 'LOG' } });
  });

  it('handles nan, a disconnected temperature sensor and unknown keys', () => {
    expect(decodePacket({ PH_VAL: 'nan' })).toMatchObject({ ok: true, packet: { values: { PH_VAL: null } } });
    expect(decodePacket({ TEMP_VAL: '-127' })).toMatchObject({ ok: true, packet: { values: { TEMP_VAL: null } } });
    expect(decodePacket({ PH_VAL: '7', FOO: 'x' })).toMatchObject({ ok: true, packet: { unknownKeys: ['FOO'] } });
  });

  it('rejects malformed values', () => {
    expect(decodePacket({ PH_VAL: 'seven' })).toEqual({ ok: false, reason: 'PH_VAL is not a number' });
    expect(decodePacket({ PH_VAL: '15' })).toEqual({ ok: false, reason: 'PH_VAL outside 0–14' });
    expect(decodePacket({ BATTERY: '140' })).toEqual({ ok: false, reason: 'BATTERY outside 0–100' });
    expect(decodePacket({ DT_1: 'yesterday' })).toMatchObject({ ok: false });
    expect(decodePacket({ FOO: '1' })).toEqual({ ok: false, reason: 'No pH fields in the packet' });
  });

  it('maps MV slots to buffer pH through the buffer set', () => {
    expect(readingsFromSlots({ 1: 177, 2: 0, 4: -177 }, { '1': 4.01, '2': 7, '3': 9.21, '4': 10.01 })).toEqual([
      { buffer: 1, bufferPh: 4.01, mv: 177 },
      { buffer: 2, bufferPh: 7, mv: 0 },
      { buffer: 4, bufferPh: 10.01, mv: -177 },
    ]);
  });
});

describe('stable readings (NxGen Sense rule: 5 s window, ±0.01 pH spread, 15 s gap)', () => {
  const T = 1_000_000;
  const stream = (values: (number | null)[], everyMs = 1000, start = T) => values.map((value, i) => ({ value, at: start + i * everyMs }));

  it('is stable only once a full window of settled readings has arrived', () => {
    const settled = stream([7.01, 7.01, 7.02, 7.02, 7.01, 7.02]); // 5 s covered
    expect(assessStability(settled, T + 5_200)).toMatchObject({ state: 'STABLE', samples: 6, spread: 0.01, latest: 7.02 });
    expect(assessStability(settled.slice(0, 5), T + 4_200).state).toBe('UNSTABLE'); // only 4 s so far
  });

  it('is unstable when the spread exceeds 0.01 pH', () => {
    expect(assessStability(stream([7.0, 7.01, 7.02, 7.0, 7.01, 7.02]), T + 5_100)).toMatchObject({ state: 'UNSTABLE', spread: 0.02 });
  });

  it('a drift that has settled becomes stable once the moving readings leave the window', () => {
    const r = stream([6.5, 6.8, 6.95, 7.0, 7.0, 7.0, 7.01, 7.0, 7.01, 7.0]);
    expect(assessStability(r, T + 9_100).state).toBe('STABLE');
    expect(assessStability(r.slice(0, 7), T + 6_100).state).toBe('UNSTABLE');
  });

  it('starts again after "nan", a long gap or a clock going backwards, and needs a live stream', () => {
    expect(assessStability(stream([7.0, 7.0, 7.0, null, 7.0, 7.0, 7.0]), T + 6_100).state).toBe('UNSTABLE');
    const gap = [...stream([7.0, 7.0, 7.0]), ...stream([7.0, 7.0, 7.0], 1000, T + 20_000)];
    expect(assessStability(gap, T + 22_100)).toMatchObject({ state: 'UNSTABLE', coveredMs: 2000 });
    const back = [...stream([7.0, 7.0, 7.0, 7.0]), { value: 7.0, at: T + 500 }, { value: 7.0, at: T + 1500 }];
    expect(assessStability(back, T + 2_000).state).toBe('UNSTABLE');
    // A stream that stopped 20 s ago is no reading at all.
    expect(assessStability(stream([7.0, 7.0, 7.0, 7.0, 7.0, 7.0]), T + 25_000).state).toBe('NO_READING');
    expect(assessStability([], T).state).toBe('NO_READING');
  });

  it('ignores the same reading delivered twice', () => {
    const r = stream([7.0, 7.0]);
    expect(assessStability([...r, r[1], r[1]], T + 1_100)).toMatchObject({ samples: 2, state: 'UNSTABLE' });
  });
});

describe('measurement details', () => {
  const ok = { sampleId: 'SMP-1', batch: 'B-24/0311', arNumber: 'AR-2026-118', product: 'Paracetamol tablets (500 mg)', remarks: '' };
  it('requires sample, batch, AR number and product, with approved characters only', () => {
    expect(validateDetails(ok)).toEqual({});
    expect(validateDetails({ ...ok, batch: ' ', arNumber: 'NA', product: 'n/a' })).toEqual({
      batch: 'Batch / lot number is required.',
      arNumber: 'AR number is required.',
      product: 'Product is required.',
    });
    expect(validateDetails({ ...ok, sampleId: 'SMP<script>' }).sampleId).toMatch(/letters, numbers/);
  });
});
