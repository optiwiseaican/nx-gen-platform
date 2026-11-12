import { batteryCondition, calibrationBucket, dashboardSummary, DashboardFilter, DashboardRowLike, DEFAULT_DASHBOARD_FILTER, filterDashboardDevices, isChargingText, parseSampleListEntry, evaluateProbeHealth, PROBE_HEALTH_LIMITS, bufferExpired, parseBufferDetails, parseMeterSettings, ALARM_BREACH, dueAlertChanges, outsideAlarmRange, postCalibrationAlerts, sampleTrend, trendPoint, validateAlarmRange, assessStability, csvCell, isLogTrigger, logReadingProblem, parseLogDetails, computePh, DEFAULT_CALIBRATION_SETTINGS, DEFAULT_PH_LIMITS, parseCalibrationSettings, preCalibrationChecks, decodePacket, isStatusKey, parseLimits, phCommands, readCalCode, validateLimits, nernstSlope, readingsFromSlots, validateDetails, validateReadings } from './ph';

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

describe('current meter protocol', () => {
  it('treats a live frame as a measurement even though it carries BATTERY', () => {
    const r = decodePacket({ PH_VAL: '7.02', TEMP_VAL: '25.10', MV_VAL: '-1.20', STABLE: '1', BATTERY: '85' });
    expect(r).toMatchObject({ ok: true, packet: { kind: 'MEASUREMENT', values: { PH_VAL: 7.02, MV_VAL: -1.2, STABLE: 1, BATTERY: 85 } } });
  });

  it('reads the status frame, whose flags arrive as text', () => {
    const r = decodePacket({ BATTERY_PERCENT: '8', CHARGING_STATUS: 'NOT_CHARGING', IS_CHARGING: 'false', PROBE_CONNECTED: 'true', TEMP_SENSOR_CONNECTED: 'false', DEVICE_STATUS: 'ONLINE', ATC: 1 });
    expect(r).toEqual({
      ok: true,
      packet: {
        kind: 'STATUS',
        values: { BATTERY: 8, IS_CHARGING: 0, PROBE_CONNECTED: 1, TEMP_SENSOR_CONNECTED: 0, ATC: 1 },
        text: { CHARGING_STATUS: 'NOT_CHARGING', DEVICE_STATUS: 'ONLINE' },
        unknownKeys: [],
      },
    });
  });

  it('accepts the spellings the app accepts', () => {
    expect(decodePacket({ pH: '7', temp: '25', CAL_MV: '1', BAT_PCT: '50%', IS_STABLE: 'stable' })).toMatchObject({
      ok: true,
      packet: { values: { PH_VAL: 7, TEMP_VAL: 25, MV_VAL: 1, BATTERY: 50, STABLE: 1 } },
    });
  });

  it('classifies a calibration reply that also carries live values', () => {
    const r = decodePacket({ PH_VAL: '4.01', BATTERY: '85', CAL: 21, POST_VAL_2: '4.01', MV_2: '177.25', SLOPE: '98.5' });
    expect(r).toMatchObject({ ok: true, packet: { kind: 'CALIBRATION', values: { CAL: 21, POST_VAL_2: 4.01 } } });
  });

  it('treats HOLD and LOG of 1 as a log trigger, and 0 as status', () => {
    expect(decodePacket({ PH_VAL: '7', HOLD: '1' })).toMatchObject({ packet: { kind: 'LOG' } });
    expect(decodePacket({ LOG: '3' })).toMatchObject({ packet: { kind: 'STATUS' } });
    expect(decodePacket({ HOLD: '0' })).toMatchObject({ packet: { kind: 'STATUS' } });
  });

  it('rejects a flag it cannot read', () => {
    expect(decodePacket({ PROBE_CONNECTED: 'maybe' })).toEqual({ ok: false, reason: 'PROBE_CONNECTED is not on or off' });
  });

  it('does not count live values as status', () => {
    expect(isStatusKey('BATTERY')).toBe(true);
    expect(isStatusKey('DEVICE_STATUS')).toBe(true);
    expect(isStatusKey('PH_VAL')).toBe(false);
    expect(isStatusKey('STABLE')).toBe(false);
  });

  it('sends commands with the same keys and value types as the app', () => {
    expect(phCommands.calibrationStart(2)).toEqual({ CAL: 20 });
    expect(phCommands.calibrationBuffer(2, 4.01)).toEqual({ B_2: '4.01' });
    expect(phCommands.calibrationBuffer(3, 7)).toEqual({ B_3: '7.00' });
    expect(phCommands.calibrationTimestamp(2, '2026-11-09 10:00:00')).toEqual({ DT_2: '2026-11-09 10:00:00' });
    expect(phCommands.calibrationCapture(2)).toEqual({ CAL: 21 });
    expect(phCommands.calibrationReset()).toEqual({ CAL: '0' });
    expect(phCommands.calibrationSave()).toEqual({ CAL_SAVE: '1' });
    expect(phCommands.atc(true)).toEqual({ ATC: 1 });
    expect(phCommands.atc(false)).toEqual({ ATC: 0 });
    expect(phCommands.thermistor('PTC')).toEqual({ THERM_VAL: '1' });
    expect(phCommands.logOnStable()).toEqual({ LOG: '1' });
    expect(phCommands.logOnDeviceButton()).toEqual({ LOG: '3' });
    expect(phCommands.logEveryMinutes(0.5)).toEqual({ LOG_INTERVAL: '0.5000', LOG: '2' });
    expect(phCommands.logStop()).toEqual({ LOG: '0', HOLD: '0' });
    expect(() => phCommands.calibrationStart(6)).toThrow(RangeError);
  });

  it('reads the meter\'s calibration codes', () => {
    expect(readCalCode(20)).toEqual({ point: 2, phase: 'MEASURING' });
    expect(readCalCode(21)).toEqual({ point: 2, phase: 'CAPTURED' });
    expect(readCalCode(0)).toBeNull();
    expect(readCalCode(62)).toBeNull();
    expect(readCalCode(null)).toBeNull();
  });
});

describe('editable acceptance limits', () => {
  const ok = { ...DEFAULT_PH_LIMITS };

  it('accepts the defaults and limits that match them at the edges', () => {
    expect(validateLimits(ok)).toEqual([]);
    expect(validateLimits({ ...ok, slopeWarnMin: 95, slopeWarnMax: 105, offsetWarnMaxAbs: 30 })).toEqual([]);
    expect(validateLimits({ ...ok, slopePassMin: 90.25 , slopeWarnMin: 50, slopeWarnMax: 150, offsetWarnMaxAbs: 200 })).toEqual([]);
  });

  it('explains each problem', () => {
    expect(validateLimits({ ...ok, slopeWarnMin: 49 })).toEqual(['Slope limits must stay within 50–150 %.']);
    expect(validateLimits({ ...ok, slopeWarnMax: 151 })).toEqual(['Slope limits must stay within 50–150 %.']);
    expect(validateLimits({ ...ok, slopePassMin: 96, slopeWarnMin: 97 })).toEqual(['The slope warning range must include the pass range.']);
    expect(validateLimits({ ...ok, slopePassMin: 105, slopePassMax: 105 })).toEqual(['The slope pass minimum must be below the pass maximum.']);
    expect(validateLimits({ ...ok, offsetPassMaxAbs: 50 })).toEqual(['The offset warning limit cannot be below the pass limit.']);
    expect(validateLimits({ ...ok, offsetWarnMaxAbs: 201 })).toEqual(['Offset limits must stay within 0–200 mV.']);
    expect(validateLimits({ ...ok, slopePassMin: 95.123 })).toEqual(['Use at most two decimals.']);
  });

  it('refuses anything that is not a number', () => {
    expect(validateLimits(parseLimits({ ...ok, slopePassMin: 'abc' }))).toEqual(['Enter a number for every limit.']);
    expect(validateLimits(parseLimits({ ...ok, slopePassMin: '' }))).toEqual(['Enter a number for every limit.']);
    expect(validateLimits(parseLimits(null))).toEqual(['Enter a number for every limit.']);
  });

  it('reads numbers typed as text', () => {
    expect(parseLimits({ ...ok, slopePassMin: '94.5' }).slopePassMin).toBe(94.5);
  });

  it('grades a calibration against the limits it is given', () => {
    const readings = [{ bufferPh: 4.01, mv: 165.3 }, { bufferPh: 7, mv: 0 }, { bufferPh: 10.01, mv: -165.3 }];
    const strict = computePh(readings, 25);
    expect(strict.slopePercent).toBeLessThan(95);
    expect(strict.slopeOutcome).not.toBe('PASS');
    expect(computePh(readings, 25, { ...ok, slopePassMin: 90, slopeWarnMin: 85 }).slopeOutcome).toBe('PASS');
  });
});

describe('guided calibration settings and checks', () => {
  const buffers = DEFAULT_CALIBRATION_SETTINGS.buffers;
  const good = { assignmentProblem: null as string | null, hasIdentifier: true, online: true, battery: 80, probe: 1, sensor: 1, temperature: 25 };
  const result = (m: Partial<typeof good> & Record<string, unknown>, label: string) => preCalibrationChecks({ ...good, ...m }).find((c) => c.label === label)?.result;

  it('passes a healthy meter', () => {
    expect(preCalibrationChecks(good).every((c) => c.result === 'PASS')).toBe(true);
  });

  it('blocks on what would make the result meaningless', () => {
    expect(result({ hasIdentifier: false }, 'Instrument ID')).toBe('FAIL');
    expect(result({ online: false }, 'Connection')).toBe('FAIL');
    expect(result({ probe: 0 }, 'pH probe')).toBe('FAIL');
    expect(result({ sensor: 0 }, 'Temperature sensor')).toBe('FAIL');
    expect(result({ temperature: null as unknown as number }, 'Temperature reading')).toBe('FAIL');
  });

  it('warns about a low or unknown battery, without blocking', () => {
    expect(result({ battery: 19 }, 'Battery')).toBe('WARN');
    expect(result({ battery: 20 }, 'Battery')).toBe('PASS');
    expect(result({ battery: null as unknown as number }, 'Battery')).toBe('WARN');
  });

  it('accepts a meter that does not report its probe', () => {
    expect(result({ probe: undefined as unknown as number }, 'pH probe')).toBe('PASS');
  });

  it('validates the settings', () => {
    const ok = { pointCount: 5, timerSeconds: 60, requireStable: false, buffers };
    expect(parseCalibrationSettings(ok).problems).toEqual([]);
    expect(parseCalibrationSettings({ ...ok, pointCount: 4 }).problems).toEqual(['Choose 3 or 5 points.']);
    expect(parseCalibrationSettings({ ...ok, timerSeconds: 4 }).problems).toEqual(['The timer must be 5 to 600 whole seconds.']);
    expect(parseCalibrationSettings({ ...ok, requireStable: 'yes' }).problems).toEqual(['Say whether a stable reading is required.']);
    expect(parseCalibrationSettings({ ...ok, buffers: { ...buffers, 3: 15 } }).problems).toEqual(['Buffer 3 must be a pH from 0 to 14.']);
    expect(parseCalibrationSettings({ ...ok, buffers: { ...buffers, 3: 4.01 } }).problems).toEqual(['Each buffer must have a different pH.']);
  });

  it('checks the deviation limit', () => {
    expect(validateLimits({ ...DEFAULT_PH_LIMITS, deviationMaxPh: 3 })).toEqual(['The deviation limit must be 0.01–2 pH.']);
  });
});

describe('logging', () => {
  it('logs on the meter\'s HOLD in stable mode', () => {
    expect(isLogTrigger('STABLE', { HOLD: 1 })).toBe(true);
    expect(isLogTrigger('STABLE', { HOLD: 0, STABLE: 1 })).toBe(true);
    expect(isLogTrigger('STABLE', { HOLD: 0, STABLE: 0 })).toBe(false);
    expect(isLogTrigger('STABLE', { STABLE: 1 })).toBe(false);
  });

  it('logs on the button in button mode only', () => {
    expect(isLogTrigger('BUTTON', { LOG: 1 })).toBe(true);
    expect(isLogTrigger('BUTTON', { LOG: 0 })).toBe(false);
    expect(isLogTrigger('BUTTON', { HOLD: 1 })).toBe(false);
    expect(isLogTrigger('STABLE', { LOG: 1 })).toBe(false);
    expect(isLogTrigger('INTERVAL', { LOG: 1, HOLD: 1 })).toBe(false);
  });

  it('needs a complete reading', () => {
    expect(logReadingProblem({ ph: 7, mv: 0, temperatureC: 25 })).toBeNull();
    expect(logReadingProblem({ ph: null, mv: 0, temperatureC: 25 })).toMatch(/pH/);
    expect(logReadingProblem({ ph: 15, mv: 0, temperatureC: 25 })).toMatch(/pH/);
    expect(logReadingProblem({ ph: 7, mv: null, temperatureC: 25 })).toMatch(/millivolt/);
    expect(logReadingProblem({ ph: 7, mv: 0, temperatureC: undefined })).toMatch(/temperature/);
  });

  it('checks the details', () => {
    expect(parseLogDetails({ batch: ' B1 ' })).toEqual({ details: { batch: 'B1', arNumber: '', product: '' }, problems: [] });
    expect(parseLogDetails({ batch: 'x'.repeat(81) }).problems).toHaveLength(1);
    expect(parseLogDetails(null).problems).toEqual([]);
  });

  it('neutralises formulas in exported text but leaves negative numbers alone', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell(-177.3)).toBe('-177.3');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});

describe('alarms and alerts', () => {
  it('accepts only a real range within 0 to 14', () => {
    expect(validateAlarmRange(6.5, 7.5)).toBeNull();
    expect(validateAlarmRange(0, 14)).toBeNull();
    for (const [a, b] of [[7, 7], [8, 7], [-1, 7], [7, 15], [null, 7], ['6', 7], [Number.NaN, 7]])
      expect(validateAlarmRange(a, b)).toMatch(/valid range/);
  });

  it('treats the limits themselves as inside the range', () => {
    expect(outsideAlarmRange(6.5, 6.5, 7.5)).toBe(false);
    expect(outsideAlarmRange(7.5, 6.5, 7.5)).toBe(false);
    expect(outsideAlarmRange(6.49, 6.5, 7.5)).toBe(true);
    expect(outsideAlarmRange(7.51, 6.5, 7.5)).toBe(true);
    expect(ALARM_BREACH).toBe('PH-ALARM-LIMIT-BREACH');
  });

  const fit = computePh([{ bufferPh: 4.01, mv: 177 }, { bufferPh: 7, mv: 0 }, { bufferPh: 10.01, mv: -177 }], 25);
  const codes = (over: object, outcome: 'PASS' | 'WARNING' | 'FAIL' = 'PASS', unstablePoints = 0) =>
    postCalibrationAlerts({ result: { ...fit, ...over }, outcome, unstablePoints }).map((a) => `${a.code}:${a.severity}`);

  it('raises nothing for a clean calibration', () => {
    expect(codes({ slopeOutcome: 'PASS', offsetOutcome: 'PASS' })).toEqual([]);
  });

  it('raises the same codes as the app', () => {
    expect(codes({ slopeOutcome: 'FAIL', offsetOutcome: 'PASS' }, 'FAIL')).toEqual(['PH-POSTCAL-RESULT-FAILED:CRITICAL', 'PH-POSTCAL-SLOPE-OUT-OF-LIMIT:CRITICAL']);
    expect(codes({ slopeOutcome: 'WARNING', offsetOutcome: 'WARNING' }, 'WARNING')).toEqual(['PH-POSTCAL-SLOPE-WARNING:WARNING', 'PH-POSTCAL-OFFSET-WARNING:WARNING']);
    expect(codes({ slopeOutcome: 'PASS', offsetOutcome: 'FAIL' }, 'FAIL')).toContain('PH-POSTCAL-OFFSET-OUT-OF-LIMIT:CRITICAL');
    expect(codes({ slopeOutcome: 'PASS', offsetOutcome: 'PASS' }, 'PASS', 2)).toEqual(['PH-POSTCAL-UNSTABLE-READING:WARNING']);
  });

  it('follows the calibration due date', () => {
    expect(dueAlertChanges('DUE_SOON')).toMatchObject({ raise: { code: 'PH-CAL-DUE', severity: 'WARNING' }, resolve: ['PH-CAL-OVERDUE'] });
    expect(dueAlertChanges('OVERDUE')).toMatchObject({ raise: { code: 'PH-CAL-OVERDUE', severity: 'CRITICAL' }, resolve: ['PH-CAL-DUE'] });
    expect(dueAlertChanges('READY')).toEqual({ raise: null, resolve: ['PH-CAL-DUE', 'PH-CAL-OVERDUE'] });
    expect(dueAlertChanges('NOT_CALIBRATED')).toEqual({ raise: null, resolve: [] });
  });
});

describe('trends', () => {
  it('leaves out values the sensors cannot report', () => {
    expect(trendPoint(1, { PH_VAL: 7, TEMP_VAL: 25, MV_VAL: 0 })).toEqual({ at: 1, ph: 7, temperatureC: 25, mv: 0 });
    expect(trendPoint(1, { PH_VAL: 15, TEMP_VAL: 200, MV_VAL: 3000 })).toEqual({ at: 1, ph: null, temperatureC: null, mv: null });
    expect(trendPoint(1, { PH_VAL: null })).toEqual({ at: 1, ph: null, temperatureC: null, mv: null });
  });

  it('keeps the window and the latest point of each period', () => {
    const now = 1_000_000;
    const point = (at: number) => ({ at, ph: 7, temperatureC: 25, mv: 0 });
    const points = [now - 700_000, now - 590_000, now - 585_000, now - 10_000].map(point);
    expect(sampleTrend(points, now, 10, 5).map((p) => p.at)).toEqual([now - 590_000, now - 585_000, now - 10_000]);
    expect(sampleTrend(points, now, 10, 60).map((p) => p.at)).toEqual([now - 585_000, now - 10_000]);
  });
});

describe('buffer details and meter settings', () => {
  it('accepts an optional lot and expiry date', () => {
    expect(parseBufferDetails({ bufferLot: ' B-1 ', bufferExpiry: '2027-01-31' })).toEqual({ lot: 'B-1', expiry: '2027-01-31', problems: [] });
    expect(parseBufferDetails({})).toEqual({ lot: '', expiry: null, problems: [] });
    expect(parseBufferDetails({ bufferExpiry: 'soon' }).problems).toEqual(['Enter the buffer expiry as a date.']);
    expect(parseBufferDetails({ bufferLot: 'x'.repeat(81) }).problems).toHaveLength(1);
  });

  it('counts a buffer as usable through its expiry date', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    expect(bufferExpired('2026-11-09', now)).toBe(false);
    expect(bufferExpired('2026-11-08', now)).toBe(true);
    expect(bufferExpired(null, now)).toBe(false);
  });

  it('sends the ATC reference as a number, as the app does', () => {
    expect(phCommands.atcReference(25)).toEqual({ R_C: 25 });
  });

  it('checks meter settings', () => {
    expect(parseMeterSettings({ thermistor: 'PTC' })).toEqual({ thermistor: 'PTC', atcReferenceC: null, problems: [] });
    expect(parseMeterSettings({ atcReferenceC: 25 })).toEqual({ thermistor: null, atcReferenceC: 25, problems: [] });
    expect(parseMeterSettings({}).problems).toEqual(['Choose a setting to send.']);
    expect(parseMeterSettings({ thermistor: 'X' }).problems).toEqual(['Choose NTC or PTC.']);
    expect(parseMeterSettings({ atcReferenceC: 900 }).problems).toHaveLength(1);
    expect(parseMeterSettings({ atcReferenceC: '25' }).problems).toHaveLength(1);
  });
});

describe('probe health', () => {
  const healthy = { outcome: 'PASS' as const, slopePercent: 99, offsetMv: 1, largestDeviation: 0.01 };
  const base = { assigned: true, probeStatus: 'ACTIVE' as const, connected: 1, dueState: 'READY', limits: DEFAULT_PH_LIMITS, calibrations: [healthy, healthy], interruptions: 0, responseAgeSeconds: 1, ageHours: 10 };
  const check = (over: Partial<Parameters<typeof evaluateProbeHealth>[0]>) => evaluateProbeHealth({ ...base, ...over });

  it('is good when nothing is wrong', () => {
    expect(check({})).toMatchObject({ status: 'GOOD', reasons: [], stability: 'Stable', drift: 0, usageCount: 2, replacement: 'No replacement due' });
  });

  it('checks the assignment before anything else', () => {
    expect(check({ assigned: false }).status).toBe('NOT_CONFIGURED');
    expect(check({ connected: 0, probeStatus: 'BLOCKED' }).status).toBe('NOT_CONNECTED');
    expect(check({ probeStatus: 'BLOCKED' }).status).toBe('UNAUTHORIZED');
  });

  it('computes drift from the stored slopes, which the app could not', () => {
    const c = (slopePercent: number) => ({ ...healthy, slopePercent });
    expect(check({ calibrations: [c(100), c(96.5)] })).toMatchObject({ status: 'WARNING', drift: 3.5 });
    expect(check({ calibrations: [c(100), c(94.5)] })).toMatchObject({ status: 'CRITICAL', drift: 5.5 });
    expect(check({ calibrations: [c(100)] }).drift).toBeNull();
  });

  it('reads the buffer deviation, not the lot number', () => {
    expect(check({ calibrations: [{ ...healthy, largestDeviation: PROBE_HEALTH_LIMITS.bufferDeviation + 0.01 }] }).status).toBe('CRITICAL');
    expect(check({ calibrations: [{ ...healthy, largestDeviation: PROBE_HEALTH_LIMITS.bufferDeviation }] }).status).toBe('GOOD');
  });

  it('applies the failure, interruption and response thresholds', () => {
    const fail = { ...healthy, outcome: 'FAIL' as const };
    expect(check({ calibrations: [healthy, fail, fail] }).status).toBe('REPLACEMENT_RECOMMENDED');
    expect(check({ calibrations: [fail, fail, fail] }).status).toBe('CRITICAL');
    expect(check({ interruptions: 2 }).status).toBe('WARNING');
    expect(check({ interruptions: 3 }).status).toBe('CRITICAL');
    expect(check({ responseAgeSeconds: 60 }).status).toBe('WARNING');
    expect(check({ responseAgeSeconds: 300 }).status).toBe('CRITICAL');
  });

  it('applies the age and usage thresholds', () => {
    expect(check({ ageHours: 2000 })).toMatchObject({ status: 'WARNING', replacement: 'Replacement review due' });
    expect(check({ ageHours: 6000 }).status).toBe('REPLACEMENT_RECOMMENDED');
  });

  it('follows the instrument calibration status', () => {
    expect(check({ dueState: 'OVERDUE' }).status).toBe('CRITICAL');
    expect(check({ dueState: 'DUE_SOON' }).status).toBe('WARNING');
  });

  it('treats out-of-warning results as critical', () => {
    expect(check({ calibrations: [{ ...healthy, slopePercent: 80 }] })).toMatchObject({ status: 'CRITICAL', stability: 'Unstable' });
    expect(check({ calibrations: [] })).toMatchObject({ status: 'GOOD', stability: 'Not calibrated' });
  });

  it('blocks calibration until a probe is assigned', () => {
    const r = preCalibrationChecks({ assignmentProblem: 'Assign a probe', hasIdentifier: true, online: true, battery: 80, probe: 1, sensor: 1, temperature: 25 });
    expect(r.find((c) => c.label === 'Probe and sensor')).toMatchObject({ result: 'FAIL', alertCode: 'PH-PRECAL-PROBE-ID-MISSING' });
  });
});

describe('dashboard', () => {
  const now = Date.parse('2026-11-12T09:00:00Z');
  const hours = (h: number) => new Date(now + h * 3_600_000).toISOString();
  const row = (over: Partial<DashboardRowLike>): DashboardRowLike => ({
    name: 'pH meter',
    code: 'PH-001',
    deviceIdentifier: 'CSPL001',
    location: 'QC Lab 1',
    model: 'PH-05',
    serialNumber: 'SN-1',
    currentUser: null,
    probeCode: 'PRB-1',
    temperatureSensorId: 'TS-1',
    online: true,
    battery: 80,
    batteryCondition: 'NORMAL',
    calibrationBucket: 'VALID',
    calibrationDueAt: hours(24 * 20),
    openAlerts: 0,
    criticalAlerts: 0,
    lastActivityAt: hours(-1),
    ...over,
  });

  it('maps the core readiness states onto the app calibration statuses', () => {
    expect(calibrationBucket('READY', hours(100), now)).toBe('VALID');
    expect(calibrationBucket('DUE_SOON', hours(100), now)).toBe('DUE_SOON');
    expect(calibrationBucket('DUE_SOON', hours(12), now)).toBe('DUE');
    expect(calibrationBucket('DUE_SOON', null, now)).toBe('DUE_SOON');
    expect(calibrationBucket('OVERDUE', hours(-1), now)).toBe('OVERDUE');
    expect(calibrationBucket('CALIBRATION_FAILED', null, now)).toBe('FAILED');
    expect(calibrationBucket('OUT_OF_SERVICE', null, now)).toBe('OUT_OF_SERVICE');
    expect(calibrationBucket('RETIRED', null, now)).toBe('OUT_OF_SERVICE');
    expect(calibrationBucket('NOT_CALIBRATED', null, now)).toBe('NOT_CALIBRATED');
    expect(calibrationBucket('MODULE_UNAVAILABLE', null, now)).toBe('NOT_CALIBRATED');
  });

  it('grades the battery like the app: above 20 % normal, 10–20 % low, below 10 % critical', () => {
    expect(batteryCondition(null, false)).toBe('UNKNOWN');
    expect(batteryCondition(21, false)).toBe('NORMAL');
    expect(batteryCondition(20, false)).toBe('LOW');
    expect(batteryCondition(10, false)).toBe('LOW');
    expect(batteryCondition(9, false)).toBe('CRITICAL');
    expect(batteryCondition(50, true)).toBe('CHARGING');
    expect(batteryCondition(100, true)).toBe('FULL');
    expect(isChargingText('CHARGING')).toBe(true);
    expect(isChargingText('NOT_CHARGING')).toBe(false);
    expect(isChargingText('DISCHARGING')).toBe(false);
    expect(isChargingText(null)).toBe(false);
  });

  it('filters by search, connection, calibration, battery, alerts, location and activity', () => {
    const rows = [
      row({ code: 'PH-001', name: 'Alpha' }),
      row({ code: 'PH-002', name: 'Beta', online: false, battery: 15, batteryCondition: 'LOW', calibrationBucket: 'OVERDUE', calibrationDueAt: hours(-30), openAlerts: 2, criticalAlerts: 1, lastActivityAt: hours(-24 * 10), location: 'QC Lab 2' }),
      row({ code: 'PH-003', name: 'Gamma', battery: null, batteryCondition: 'UNKNOWN', calibrationBucket: 'DUE_SOON', openAlerts: 1, criticalAlerts: 0, lastActivityAt: null, currentUser: 'Priya' }),
    ];
    const f = (over: Partial<DashboardFilter>) => filterDashboardDevices(rows, { ...DEFAULT_DASHBOARD_FILTER, ...over }, now).map((r) => r.code);
    expect(f({})).toEqual(['PH-001', 'PH-002', 'PH-003']);
    expect(f({ search: 'priya' })).toEqual(['PH-003']);
    expect(f({ search: 'lab 2' })).toEqual(['PH-002']);
    expect(f({ connection: 'OFFLINE' })).toEqual(['PH-002']);
    expect(f({ calibration: 'ATTENTION' })).toEqual(['PH-002', 'PH-003']);
    expect(f({ calibration: 'OVERDUE' })).toEqual(['PH-002']);
    expect(f({ battery: 'LOW' })).toEqual(['PH-002']);
    expect(f({ battery: 'UNKNOWN' })).toEqual(['PH-003']);
    expect(f({ alerts: 'CRITICAL' })).toEqual(['PH-002']);
    expect(f({ alerts: 'WARNING' })).toEqual(['PH-002', 'PH-003']);
    expect(f({ alerts: 'NONE' })).toEqual(['PH-001']);
    expect(f({ location: 'qc lab 2' })).toEqual(['PH-002']);
    expect(f({ activity: 'TODAY' })).toEqual(['PH-001']);
    expect(f({ activity: 'INACTIVE' })).toEqual(['PH-002', 'PH-003']);
    expect(f({ sort: 'ALERTS' })).toEqual(['PH-002', 'PH-003', 'PH-001']);
    expect(f({ sort: 'CALIBRATION_DUE' })).toEqual(['PH-002', 'PH-001', 'PH-003']);
    expect(f({ sort: 'BATTERY' })).toEqual(['PH-002', 'PH-001', 'PH-003']);
    expect(f({ sort: 'LAST_ACTIVITY' })).toEqual(['PH-001', 'PH-002', 'PH-003']);
  });

  it('counts the summary cards and the calibration summary', () => {
    const s = dashboardSummary([
      row({}),
      row({ online: false, batteryCondition: 'LOW', calibrationBucket: 'DUE', criticalAlerts: 2, openAlerts: 3 }),
      row({ batteryCondition: 'CRITICAL', calibrationBucket: 'FAILED', criticalAlerts: 1, openAlerts: 1 }),
      row({ calibrationBucket: 'NOT_CALIBRATED' }),
    ]);
    expect(s).toMatchObject({ total: 4, online: 3, offline: 1, lowBattery: 1, criticalBattery: 1, calibrationDue: 3, criticalAlerts: 3 });
    expect(s.calibration).toEqual({ valid: 1, dueSoon: 0, due: 1, overdue: 0, failed: 1, notCalibrated: 1 });
  });

  it('validates saved list entries like the sample details', () => {
    expect(parseSampleListEntry({ kind: 'PRODUCT', value: ' Paracetamol 500 mg ' })).toEqual({ kind: 'PRODUCT', value: 'Paracetamol 500 mg' });
    expect(parseSampleListEntry({ kind: 'BATCH', value: 'NA' })).toEqual({ problem: 'Enter the batch.' });
    expect(parseSampleListEntry({ kind: 'AR', value: 'AR<1>' })).toMatchObject({ problem: expect.stringContaining('AR number: use letters') });
    expect(parseSampleListEntry({ kind: 'LOT', value: 'x' })).toEqual({ problem: 'Choose Product, Batch or AR number.' });
    expect(parseSampleListEntry({ kind: 'BATCH', value: 'x'.repeat(81) })).toEqual({ problem: 'Batch: at most 80 characters.' });
  });
});
