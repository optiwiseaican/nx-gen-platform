import { computePh, decodePacket, nernstSlope, readingsFromSlots, validateReadings } from './ph';

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
