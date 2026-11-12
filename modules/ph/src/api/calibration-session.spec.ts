import { CalibrationSession, REPLY_TIMEOUT_MS, SessionError } from './calibration-session';
import type { Telemetry } from './calibration-session';
import { calibrationSlots, DEFAULT_CALIBRATION_SETTINGS, DEFAULT_PH_LIMITS } from '../shared/ph';
import type { PhCommand } from '../shared/ph';

function setup(over: { requireStable?: boolean; timerSeconds?: number } = {}) {
  let now = 1_000_000;
  const sent: PhCommand[] = [];
  let fail: string | null = null;
  let onSend: ((fields: PhCommand) => void) | null = null;
  let telemetry: Telemetry<string> = { ph: 7, mv: 0, temperatureC: 25, stable: true, source: 'packet', simulated: false };
  const settings = { ...DEFAULT_CALIBRATION_SETTINGS, pointCount: 3 as const, timerSeconds: 5, ...over };
  const session = new CalibrationSession<string>(
    { startedById: 'u1', startedByName: 'A', startedAt: now, limits: DEFAULT_PH_LIMITS, limitsVersion: null, settings, slots: calibrationSlots(3), preChecks: [] },
    {
      send: async (fields) => {
        sent.push(fields);
        onSend?.(fields);
        return fail ? { sent: false, reason: fail } : { sent: true, messageId: 1 };
      },
      telemetry: () => telemetry,
      now: () => now,
    },
  );
  const advance = async (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      now += 1000;
      await session.tick();
    }
  };
  /** The meter's reply to a capture. */
  const reply = (slot: number, mv: number, post: number, id = slot * 100) =>
    session.onPacket({ values: { CAL: slot * 10 + 1, [`MV_${slot}`]: mv, [`POST_VAL_${slot}`]: post } }, id, false);
  const status = (slot: number) => session.view().points.find((p) => p.slot === slot)!.status;
  const runAll = async () => {
    for (const [slot, mv, post] of [[2, 177.3, 4.01], [3, 0, 7], [4, -177.8, 10.01]]) {
      await session.measure(slot);
      await advance(5);
      reply(slot, mv, post);
    }
  };
  return {
    session, sent, advance, reply, status, runAll,
    setFail: (r: string | null) => (fail = r),
    setOnSend: (f: (fields: PhCommand) => void) => (onSend = f),
    setTelemetry: (t: Partial<Telemetry<string>>) => (telemetry = { ...telemetry, ...t }),
  };
}

describe('guided calibration', () => {
  it('uses buffers 2, 3 and 4 for a 3-point calibration and all five otherwise', () => {
    expect(calibrationSlots(3)).toEqual([2, 3, 4]);
    expect(calibrationSlots(5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sends the same command sequence as the app', async () => {
    const t = setup();
    await t.session.measure(2);
    expect(t.sent).toEqual([{ CAL: 20 }, { B_2: '4.01' }]);
    await t.advance(4);
    expect(t.sent.slice(2)).toEqual([{ B_2: '4.01' }, { B_2: '4.01' }, { B_2: '4.01' }, { B_2: '4.01' }]);
    await t.advance(1);
    expect(t.status(2)).toBe('WAITING');
    expect(Object.keys(t.sent[6])).toEqual(['DT_2']);
    expect(t.sent[7]).toEqual({ CAL: 21 });
  });

  it('accepts a point on the meter\'s reply and keeps its values', async () => {
    const t = setup();
    await t.session.measure(2);
    await t.advance(5);
    t.reply(2, 177.25, 4.02);
    expect(t.session.view().points[0]).toMatchObject({ status: 'ACCEPTED', mv: 177.25, postPh: 4.02, measuredPh: 7, temperatureC: 25, stable: true });
  });

  it('offers a retry when the meter does not answer, and still accepts a late reply', async () => {
    const t = setup();
    await t.session.measure(2);
    await t.advance(5 + REPLY_TIMEOUT_MS / 1000);
    expect(t.status(2)).toBe('NO_REPLY');
    t.reply(2, 177, 4.01);
    expect(t.status(2)).toBe('ACCEPTED');
  });

  it('accepts a reply that arrives before the capture has finished sending', async () => {
    const t = setup();
    t.setOnSend((c) => {
      if (c.CAL === 21) t.reply(2, 177.3, 4.01);
    });
    await t.session.measure(2);
    await t.advance(5);
    expect(t.status(2)).toBe('ACCEPTED');
  });

  it('clears a point when it is repeated', async () => {
    const t = setup();
    await t.session.measure(2);
    await t.advance(5);
    t.reply(2, 177, 4.01);
    await t.session.measure(2);
    expect(t.session.view().points[0]).toMatchObject({ status: 'MEASURING', mv: null, postPh: null });
  });

  it('takes buffers in order, one at a time', async () => {
    const t = setup();
    await expect(t.session.measure(3)).rejects.toThrow('Finish the earlier buffers first.');
    await t.session.measure(2);
    await expect(t.session.measure(2)).rejects.toThrow(SessionError);
    await expect(t.session.measure(9)).rejects.toThrow('not part of this calibration');
  });

  it('records an unstable reading by default', async () => {
    const t = setup();
    t.setTelemetry({ stable: false });
    await t.session.measure(2);
    await t.advance(5);
    expect(t.status(2)).toBe('WAITING');
    expect(t.session.view().points[0].stable).toBe(false);
  });

  it('refuses an unstable reading when the setting requires stability', async () => {
    const t = setup({ requireStable: true });
    t.setTelemetry({ stable: false });
    await t.session.measure(2);
    await t.advance(5);
    expect(t.status(2)).toBe('UNSTABLE');
    expect(t.sent.some((c) => c.CAL === 21)).toBe(false);
  });

  it('stops a point when the meter can no longer be reached', async () => {
    const t = setup();
    await t.session.measure(2);
    t.setFail('The instrument is not connected.');
    await t.advance(1);
    expect(t.session.view().points[0]).toMatchObject({ status: 'FAILED', message: 'The instrument is not connected.' });
  });

  it('reports a command that could not be sent at the start', async () => {
    const t = setup();
    t.setFail('The USB dongle is not connected.');
    await expect(t.session.measure(2)).rejects.toThrow('The USB dongle is not connected.');
    expect(t.status(2)).toBe('PENDING');
  });

  it('cannot be saved until every buffer is accepted', async () => {
    const t = setup();
    expect(t.session.saveProblem()).toMatch(/Every buffer/);
    await t.runAll();
    expect(t.session.saveProblem()).toBeNull();
  });

  it('passes a good electrode and gathers the stored packets', async () => {
    const t = setup();
    await t.runAll();
    const e = t.session.evaluate();
    expect(e.outcome).toBe('PASS');
    expect(e.temperatureC).toBe(25);
    expect(e.readings.map((r) => r.bufferPh)).toEqual([4.01, 7, 10.01]);
    expect(t.session.messageIds().sort()).toEqual([200, 300, 400]);
  });

  it('fails a point whose reading is too far from the buffer, even with a good slope', async () => {
    const t = setup();
    await t.session.measure(2);
    await t.advance(5);
    t.reply(2, 177.3, 4.2);
    for (const [slot, mv, post] of [[3, 0, 7], [4, -177.8, 10.01]]) {
      await t.session.measure(slot);
      await t.advance(5);
      t.reply(slot, mv, post);
    }
    const e = t.session.evaluate();
    expect(e.result.outcome).toBe('PASS');
    expect(e.points[0]).toMatchObject({ deviation: 0.19, deviationOutcome: 'FAIL' });
    expect(e.outcome).toBe('FAIL');
  });

  it('refuses to evaluate without a temperature', async () => {
    const t = setup();
    t.setTelemetry({ temperatureC: null });
    await t.runAll();
    expect(t.session.saveProblem()).toBe('No temperature was received during this calibration.');
  });
});
