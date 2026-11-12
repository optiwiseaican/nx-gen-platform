import type { CommandResult } from '@crescent/module-sdk';
import { computePh, phCommands, readCalCode, validateReadings, worst } from '../shared/ph';
import type { CalibrationSettings, Outcome, PhCommand, PhLimits, PhResult } from '../shared/ph';

export type PointStatus = 'PENDING' | 'MEASURING' | 'WAITING' | 'ACCEPTED' | 'NO_REPLY' | 'UNSTABLE' | 'FAILED';

/** How long the meter has to answer a capture before the point can be retried. */
export const REPLY_TIMEOUT_MS = 10_000;

export class SessionError extends Error {}

export interface Telemetry<H> {
  ph: number | null;
  mv: number | null;
  temperatureC: number | null;
  stable: boolean;
  /** The packet the reading came from, kept as the point's original data. */
  source: H | null;
  simulated: boolean;
}

export interface SessionDeps<H> {
  send(fields: PhCommand, options?: { persist?: boolean }): Promise<CommandResult>;
  telemetry(): Telemetry<H>;
  now(): number;
}

interface Point<H> {
  slot: number;
  bufferPh: number;
  status: PointStatus;
  message: string | null;
  endsAt: number | null;
  waitingSince: number | null;
  measuredPh: number | null;
  mv: number | null;
  temperatureC: number | null;
  stable: boolean | null;
  postPh: number | null;
  segmentSlope: number | null;
  capturedAt: string | null;
  messageIds: Set<number>;
  source: H | null;
}

export interface SessionPacket {
  values: Record<string, number | null>;
}

export interface SessionEvaluation {
  readings: { buffer: number; bufferPh: number; mv: number }[];
  temperatureC: number;
  result: PhResult;
  points: { slot: number; bufferPh: number; deviation: number | null; deviationOutcome: Outcome }[];
  outcome: Outcome;
}

/** Local time, as the meter expects it: yyyy-MM-dd HH:mm:ss. */
export function meterTimestamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * One guided calibration (NxGen Sense PH2): for each buffer, CAL n×10 and B_n,
 * B_n repeated each second while the timer runs, then DT_n and CAL n×10+1, and
 * the meter's reply accepts the point. The limits are fixed when the run starts,
 * so a change approved meanwhile cannot alter how this run is judged.
 */
export class CalibrationSession<H> {
  readonly points: Point<H>[];
  simulated = false;
  deviceSlope: number | null = null;
  deviceOffset: number | null = null;
  private readonly otherMessages = new Set<number>();
  private ticking = false;

  constructor(
    readonly config: { startedById: string; startedByName: string; startedAt: number; limits: PhLimits; limitsVersion: number | null; settings: CalibrationSettings; slots: number[]; preChecks: unknown; probe?: unknown },
    private readonly deps: SessionDeps<H>,
  ) {
    this.points = config.slots.map((slot) => ({
      slot,
      bufferPh: config.settings.buffers[slot],
      status: 'PENDING',
      message: null,
      endsAt: null,
      waitingSince: null,
      measuredPh: null,
      mv: null,
      temperatureC: null,
      stable: null,
      postPh: null,
      segmentSlope: null,
      capturedAt: null,
      messageIds: new Set(),
      source: null,
    }));
  }

  private get busy() {
    return this.points.find((p) => p.status === 'MEASURING' || p.status === 'WAITING') ?? null;
  }

  private point(slot: number): Point<H> {
    const p = this.points.find((x) => x.slot === slot);
    if (!p) throw new SessionError('That buffer is not part of this calibration.');
    return p;
  }

  /** Start, or repeat, one buffer. Buffers are taken in order. */
  async measure(slot: number): Promise<void> {
    const p = this.point(slot);
    const running = this.busy;
    if (running) throw new SessionError(`Buffer pH ${running.bufferPh.toFixed(2)} is still being measured.`);
    const before = this.points.slice(0, this.points.indexOf(p));
    if (before.some((x) => x.status !== 'ACCEPTED')) throw new SessionError('Finish the earlier buffers first.');

    const sent = await this.deps.send(phCommands.calibrationStart(slot));
    if (!sent.sent) throw new SessionError(sent.reason);
    const buffer = await this.deps.send(phCommands.calibrationBuffer(slot, p.bufferPh));
    if (!buffer.sent) throw new SessionError(buffer.reason);
    Object.assign(p, {
      status: 'MEASURING',
      message: null,
      endsAt: this.deps.now() + this.config.settings.timerSeconds * 1000,
      waitingSince: null,
      measuredPh: null,
      mv: null,
      temperatureC: null,
      stable: null,
      postPh: null,
      segmentSlope: null,
      capturedAt: null,
      source: null,
    } satisfies Partial<Point<H>>);
    p.messageIds.clear();
  }

  /** Called once a second by the module. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const p = this.busy;
      if (!p) return;
      const now = this.deps.now();
      if (p.status === 'WAITING') {
        if (now - p.waitingSince! >= REPLY_TIMEOUT_MS) {
          p.status = 'NO_REPLY';
          p.message = 'The meter did not answer. Repeat this buffer.';
        }
        return;
      }
      if (now >= p.endsAt!) return await this.capture(p, now);
      // The meter expects the selected buffer to stay active for the whole measurement.
      const kept = await this.deps.send(phCommands.calibrationBuffer(p.slot, p.bufferPh), { persist: false });
      if (!kept.sent) this.fail(p, kept.reason);
    } finally {
      this.ticking = false;
    }
  }

  private fail(p: Point<H>, reason: string) {
    p.status = 'FAILED';
    p.message = reason;
    p.endsAt = null;
  }

  private async capture(p: Point<H>, now: number) {
    const t = this.deps.telemetry();
    if (this.config.settings.requireStable && !t.stable) {
      p.status = 'UNSTABLE';
      p.message = 'The reading was not stable when the timer ended. Repeat this buffer.';
      p.endsAt = null;
      return;
    }
    p.measuredPh = t.ph;
    p.mv = t.mv;
    p.temperatureC = t.temperatureC;
    p.stable = t.stable;
    p.source = t.source;
    p.capturedAt = meterTimestamp(now);
    p.endsAt = null;
    this.simulated ||= t.simulated;
    const stamped = await this.deps.send(phCommands.calibrationTimestamp(p.slot, p.capturedAt));
    if (!stamped.sent) return this.fail(p, stamped.reason);
    // Waiting starts first: a fast meter can answer before the send has finished.
    p.status = 'WAITING';
    p.waitingSince = now;
    const captured = await this.deps.send(phCommands.calibrationCapture(p.slot));
    if (!captured.sent) this.fail(p, captured.reason);
  }

  /** A calibration packet from the meter. A late reply still counts. */
  onPacket(packet: SessionPacket, messageId: number | null, simulated: boolean): void {
    const { values } = packet;
    const number = (k: string) => (typeof values[k] === 'number' ? (values[k] as number) : null);
    for (const p of this.points) {
      if (p.status !== 'WAITING' && p.status !== 'NO_REPLY' && p.status !== 'ACCEPTED') continue;
      const mv = number(`MV_${p.slot}`);
      const post = number(`POST_VAL_${p.slot}`);
      const slope = number(`SLOPE_${p.slot - 1}`);
      if (mv !== null) p.mv = mv;
      if (post !== null) p.postPh = post;
      if (slope !== null) p.segmentSlope = slope;
      if ((mv !== null || post !== null || slope !== null) && messageId !== null) p.messageIds.add(messageId);
    }
    if (number('SLOPE') !== null) this.deviceSlope = number('SLOPE');
    if (number('OFFSET') !== null) this.deviceOffset = number('OFFSET');
    const code = readCalCode(number('CAL'));
    if (code?.phase === 'CAPTURED') {
      const p = this.points.find((x) => x.slot === code.point);
      if (p && (p.status === 'WAITING' || p.status === 'NO_REPLY')) {
        p.status = 'ACCEPTED';
        p.message = null;
        if (messageId !== null) p.messageIds.add(messageId);
      }
    }
    if (messageId !== null) this.otherMessages.add(messageId);
    this.simulated ||= simulated;
  }

  /** Why the run cannot be saved yet, or null. */
  saveProblem(): string | null {
    if (this.points.some((p) => p.status !== 'ACCEPTED')) return 'Every buffer must be accepted by the meter before saving.';
    const e = this.evaluateOrProblem();
    return typeof e === 'string' ? e : null;
  }

  private evaluateOrProblem(): SessionEvaluation | string {
    const usable = this.points.filter((p) => typeof p.mv === 'number');
    if (usable.length !== this.points.length) return 'A buffer has no millivolt reading. Repeat it.';
    const temperatures = this.points.map((p) => p.temperatureC).filter((t): t is number => typeof t === 'number');
    if (!temperatures.length) return 'No temperature was received during this calibration.';
    const temperatureC = Math.round((temperatures.reduce((a, b) => a + b, 0) / temperatures.length) * 100) / 100;
    const readings = usable.map((p) => ({ buffer: p.slot, bufferPh: p.bufferPh, mv: p.mv! }));
    const problems = validateReadings(readings, temperatureC);
    if (problems.length) return problems.join(' ');
    const result = computePh(readings, temperatureC, this.config.limits);
    const points = this.points.map((p) => {
      const read = p.postPh ?? p.measuredPh;
      const deviation = read === null ? null : Math.round(Math.abs(read - p.bufferPh) * 1000) / 1000;
      const deviationOutcome: Outcome = deviation !== null && deviation <= this.config.limits.deviationMaxPh ? 'PASS' : 'FAIL';
      return { slot: p.slot, bufferPh: p.bufferPh, deviation, deviationOutcome };
    });
    return { readings, temperatureC, result, points, outcome: worst(result.outcome, ...points.map((p) => p.deviationOutcome)) };
  }

  evaluate(): SessionEvaluation {
    const e = this.evaluateOrProblem();
    if (typeof e === 'string') throw new SessionError(e);
    return e;
  }

  /** The stored packets the run rests on; the module adds each point's source packet. */
  messageIds(): number[] {
    return [...new Set([...this.otherMessages, ...this.points.flatMap((p) => [...p.messageIds])])];
  }

  view() {
    const now = this.deps.now();
    const e = this.points.every((p) => p.status === 'ACCEPTED') ? this.evaluateOrProblem() : null;
    return {
      startedById: this.config.startedById,
      startedByName: this.config.startedByName,
      startedAt: new Date(this.config.startedAt).toISOString(),
      limits: this.config.limits,
      limitsVersion: this.config.limitsVersion,
      requireStable: this.config.settings.requireStable,
      timerSeconds: this.config.settings.timerSeconds,
      deviceSlope: this.deviceSlope,
      deviceOffset: this.deviceOffset,
      points: this.points.map((p) => ({
        slot: p.slot,
        bufferPh: p.bufferPh,
        status: p.status,
        message: p.message,
        secondsLeft: p.status === 'MEASURING' ? Math.max(0, Math.ceil((p.endsAt! - now) / 1000)) : null,
        measuredPh: p.measuredPh,
        mv: p.mv,
        temperatureC: p.temperatureC,
        stable: p.stable,
        postPh: p.postPh,
        segmentSlope: p.segmentSlope,
        capturedAt: p.capturedAt,
      })),
      evaluation: e && typeof e !== 'string' ? e : null,
      saveProblem: this.saveProblem(),
    };
  }
}
