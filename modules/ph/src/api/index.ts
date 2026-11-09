import type {
  CalibrationInput,
  DeviceInfo,
  InstrumentPacket,
  ModuleContext,
  ModuleRequest,
  ModuleTx,
  NxGenModule,
} from '@crescent/module-sdk';
import { ModuleError } from '@crescent/module-sdk';
import {
  assessStability,
  computePh,
  decodePacket,
  DEFAULT_PH_LIMITS,
  DEFAULT_STABILITY,
  display,
  PhReading,
  readingsFromSlots,
  validateDetails,
  validateReadings,
} from '../shared/ph';
import type { MeasurementDetails, Stability } from '../shared/ph';

const TABLE = 'ph_measurements';
const WORKFLOW = 'PH_MEASUREMENT_APPROVAL';
/** Recent pH readings kept in memory per instrument, for the stability window. */
const HISTORY_MS = 60_000;
const HISTORY_MAX = 600;

/** Calibration packets older than this are not offered for a new record. */
const CALIBRATION_FRESH_MS = 60 * 60_000;
/** Live readings older than this are shown as stale. */
const STALE_MS = 15_000;

interface Held {
  packet: InstrumentPacket;
  messageId: number | null;
  at: number;
}

interface LiveState {
  values: Record<string, number | null>;
  valueAt: Record<string, string>;
  lastSeenAt: number;
  transport: InstrumentPacket['transport'];
  /** Latest packet that carried each field (kept so a record can store the original). */
  lastPacket: Record<string, Held>;
  calibration: { mv: Record<number, Held & { value: number }>; fields: Record<string, number | string | null>; at: number; messageIds: Set<number> };
  /** Recent PH_VAL readings with their packets (oldest first). */
  history: { value: number | null; at: number; held: Held }[];
}

let ctx: ModuleContext;
const live = new Map<string, LiveState>();

const state = (device: DeviceInfo) => {
  let s = live.get(device.id);
  if (!s) {
    s = { values: {}, valueAt: {}, lastSeenAt: 0, transport: 'SERIAL', lastPacket: {}, calibration: { mv: {}, fields: {}, at: 0, messageIds: new Set() }, history: [] };
    live.set(device.id, s);
  }
  return s;
};

async function defaultBuffers(): Promise<{ code: string; buffers: Record<string, number> }> {
  const [row] = await ctx.db.query<{ code: string; buffers: Record<string, number> }>(
    'SELECT code, buffers FROM ph_buffer_sets WHERE is_default AND NOT is_deleted',
  );
  if (!row) throw new ModuleError(409, 'No default pH buffer set is configured.');
  return row;
}

async function device(req: ModuleRequest): Promise<DeviceInfo> {
  const d = await ctx.devices.get(req.params.id);
  if (!d) throw new ModuleError(404, 'pH instrument not found.');
  return d;
}

function stabilityOf(s: LiveState | undefined): Stability {
  return assessStability((s?.history ?? []).map((h) => ({ value: h.value, at: h.at })), Date.now());
}

function liveView(d: DeviceInfo) {
  const s = live.get(d.id);
  if (!s) return null;
  return {
    stability: stabilityOf(s),
    values: s.values,
    valueAt: s.valueAt,
    lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    online: Date.now() - s.lastSeenAt < STALE_MS,
    simulated: s.transport === 'SIMULATOR',
  };
}

async function instrumentCalibration(d: DeviceInfo) {
  const s = live.get(d.id);
  if (!s || Date.now() - s.calibration.at > CALIBRATION_FRESH_MS) return null;
  const { code, buffers } = await defaultBuffers();
  const mv = Object.fromEntries(Object.entries(s.calibration.mv).map(([k, v]) => [k, v.value]));
  const readings = readingsFromSlots(mv, buffers);
  if (readings.length < 2) return null;
  const temperatureC = typeof s.values.TEMP_VAL === 'number' ? s.values.TEMP_VAL : null;
  return {
    bufferSet: code,
    readings,
    temperatureC,
    deviceReported: { slope: s.calibration.fields.SLOPE ?? null, offset: s.calibration.fields.OFFSET ?? null },
    deviceTimes: Object.fromEntries(Object.entries(s.calibration.fields).filter(([k]) => k.startsWith('DT_'))),
    receivedAt: new Date(s.calibration.at).toISOString(),
    preview: temperatureC !== null && !validateReadings(readings, temperatureC).length ? computePh(readings, temperatureC) : null,
  };
}


/** Store a packet held in memory (once), returning its device_messages id. */
async function persistHeld(d: DeviceInfo, held: Held): Promise<number> {
  if (held.messageId === null) held.messageId = await ctx.gateway.persist(d, held.packet, 'MEASUREMENT');
  return held.messageId;
}

interface MeasurementRow {
  id: string;
  code: string;
  device_id: string;
  sample_id: string;
  batch: string;
  ar_number: string;
  product: string;
  remarks: string;
  ph: string;
  temperature_c: string;
  atc: 'ON' | 'OFF' | 'UNKNOWN';
  stability: Stability;
  data_source: 'INSTRUMENT' | 'SIMULATED';
  source_messages: string[];
  calibration: Record<string, unknown>;
  measured_by: string;
  measured_by_name?: string;
  measured_at: Date;
  device_code?: string;
  device_name?: string;
}

async function loadMeasurement(tx: Pick<ModuleTx, 'query'>, id: string): Promise<MeasurementRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ModuleError(404, 'Measurement not found.');
  const [row] = await tx.query<MeasurementRow>(
    `SELECT m.*, u.full_name AS measured_by_name, d.code AS device_code, d.name AS device_name
       FROM ph_measurements m LEFT JOIN users u ON u.id = m.measured_by JOIN devices d ON d.id = m.device_id
      WHERE m.id = $1 AND NOT m.is_deleted`,
    [id],
  );
  if (!row) throw new ModuleError(404, 'Measurement not found.');
  return row;
}

async function sourcePackets(tx: Pick<ModuleTx, 'query'>, ids: string[]) {
  return tx.query<{ id: string; received_at: Date; raw: string; raw_sha256: string; transport: string }>(
    'SELECT id, received_at, raw, raw_sha256, transport FROM device_messages WHERE id = ANY($1::bigint[]) ORDER BY id',
    [ids],
  );
}

function measurementView(m: MeasurementRow) {
  return {
    id: m.id,
    code: m.code,
    device: { id: m.device_id, code: m.device_code, name: m.device_name },
    sampleId: m.sample_id,
    batch: m.batch,
    arNumber: m.ar_number,
    product: m.product,
    remarks: m.remarks,
    ph: Number(m.ph),
    temperatureC: Number(m.temperature_c),
    atc: m.atc,
    stability: m.stability,
    dataSource: m.data_source,
    sourceMessages: m.source_messages.map(Number),
    calibration: m.calibration,
    measuredBy: { id: m.measured_by, name: m.measured_by_name ?? m.measured_by },
    measuredAt: m.measured_at.toISOString(),
  };
}

function details(body: Record<string, unknown>): MeasurementDetails {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const d = { sampleId: str(body.sampleId), batch: str(body.batch), arNumber: str(body.arNumber), product: str(body.product), remarks: str(body.remarks) };
  const problems = validateDetails(d);
  const first = Object.entries(problems)[0];
  if (first) throw new ModuleError(400, first[1], first[0]);
  return d;
}

/** The latest approved calibration in force, kept with the measurement. */
async function calibrationInForce(d: DeviceInfo) {
  const [c] = await ctx.db.query<{ id: string; code: string; outcome: string; performed_at: Date }>(
    `SELECT c.id, c.code, c.outcome, c.performed_at FROM calibration_records c
       JOIN workflow_instances w ON w.table_name = 'calibration_records' AND w.record_id = c.id::text AND w.state = 'APPROVED'
      WHERE c.device_id = $1 AND NOT c.is_deleted ORDER BY c.performed_at DESC LIMIT 1`,
    [d.id],
  );
  return {
    id: c?.id ?? null,
    code: c?.code ?? null,
    outcome: c?.outcome ?? null,
    performedAt: c?.performed_at.toISOString() ?? null,
    dueAt: d.readiness.dueAt,
    readiness: d.readiness.state,
  };
}

const PhModule: NxGenModule = {
  register(c) {
    ctx = c;

    ctx.gateway.registerHandler({
      instrumentType: 'PH',
      decide(packet, d) {
        const r = decodePacket(packet.fields);
        if (!r.ok) return { kind: 'UNKNOWN', persist: false, reject: r.reason };
        const p = r.packet;
        const s = live.get(d.id);
        // Keep calibration and log packets; status only when it changes; the
        // continuous measurement stream is held in memory (stored when used).
        const statusChanged = p.kind === 'STATUS' && Object.entries(p.values).some(([k, v]) => s?.values[k] !== v);
        return {
          kind: p.kind,
          persist: p.kind === 'CALIBRATION' || p.kind === 'LOG' || statusChanged,
          payload: { values: p.values, text: p.text, unknownKeys: p.unknownKeys },
        };
      },
      async accepted(packet, d, messageId) {
        const r = decodePacket(packet.fields);
        if (!r.ok) return;
        const p = r.packet;
        const s = state(d);
        const now = Date.now();
        s.lastSeenAt = now;
        s.transport = packet.transport;
        // One holder per packet, so a packet stored for one field is stored once.
        const held: Held = { packet, messageId, at: now };
        for (const [k, v] of Object.entries(p.values)) {
          s.values[k] = v;
          s.valueAt[k] = packet.receivedAt;
          s.lastPacket[k] = held;
        }
        if ('PH_VAL' in p.values) {
          const at = Date.parse(packet.receivedAt) || now;
          s.history.push({ value: p.values.PH_VAL, at, held });
          while (s.history.length > HISTORY_MAX || (s.history.length && at - s.history[0].at > HISTORY_MS)) s.history.shift();
        }
        if (p.kind === 'CALIBRATION') {
          if (now - s.calibration.at > CALIBRATION_FRESH_MS) s.calibration = { mv: {}, fields: {}, at: 0, messageIds: new Set() };
          for (const [k, v] of Object.entries(p.values)) {
            const slot = /^MV_([1-5])$/.exec(k);
            if (slot && typeof v === 'number') s.calibration.mv[Number(slot[1])] = { packet, messageId, at: now, value: v };
            else s.calibration.fields[k] = v;
          }
          for (const [k, v] of Object.entries(p.text)) s.calibration.fields[k] = v;
          if (messageId !== null) s.calibration.messageIds.add(messageId);
          s.calibration.at = now;
        }
        if (p.kind === 'LOG') {
          // A logged reading: keep the original measurement packets it refers to.
          for (const k of ['PH_VAL', 'TEMP_VAL']) {
            const held = s.lastPacket[k];
            if (held && held.messageId === null) held.messageId = await persistHeld(d, held);
          }
        }
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments',
      permission: 'ph.view',
      async handler() {
        const devices = await ctx.devices.list('PH');
        return devices.map((d) => ({ ...d, live: liveView(d) }));
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments/:id/live',
      permission: 'ph.view',
      passive: true,
      async handler(req) {
        const d = await device(req);
        return { device: d, live: liveView(d), calibration: await instrumentCalibration(d), limits: DEFAULT_PH_LIMITS, stabilityRule: DEFAULT_STABILITY };
      },
    });

    ctx.workflow.registerRecordType({
      tableName: TABLE,
      link: (seriesId) => `?measurement=${seriesId}`,
      authorOf: async (tx, id) => (await loadMeasurement(tx, id)).measured_by,
      // What reviewers and approvers sign: the measurement and the hashes of the packets it came from.
      async load(tx, id) {
        const m = await loadMeasurement(tx, id);
        const packets = await sourcePackets(tx, m.source_messages);
        return {
          title: `${m.code} · pH ${Number(m.ph).toFixed(2)} · ${m.sample_id}`,
          content: {
            ...measurementView(m),
            packets: packets.map((x) => ({ id: Number(x.id), receivedAt: x.received_at.toISOString(), sha256: x.raw_sha256 })),
          },
        };
      },
      async beforeSubmit(tx, id) {
        const m = await loadMeasurement(tx, id);
        if (m.data_source === 'SIMULATED' && ctx.production) return 'Simulated measurements cannot be submitted.';
        return null;
      },
    });

    /** Record the current stable reading as a measurement (draft). Values come only from the stored packets. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/measurements',
      permission: 'ph.measure',
      async handler(req) {
        const d = await device(req);
        const f = details((req.body ?? {}) as Record<string, unknown>);
        const blocked = async (reason: string, status: 400 | 409 = 409): Promise<never> => {
          await ctx.audit.record({ action: 'PH_MEASUREMENT_BLOCKED', result: 'FAILURE', principal: req.principal, recordId: d.id, reason, details: { device: d.code, sampleId: f.sampleId } });
          throw new ModuleError(status, reason);
        };
        if (!d.readiness.usable) return blocked(`${d.code} cannot be used: ${d.readiness.message}`);
        const s = live.get(d.id);
        const stability = stabilityOf(s);
        if (!s || stability.state === 'NO_READING') return blocked('No pH reading is arriving from this instrument.');
        if (stability.state !== 'STABLE')
          return blocked(`The reading is not stable yet (spread ${stability.spread?.toFixed(3) ?? '—'} pH over ${((stability.to! - stability.from!) / 1000).toFixed(1)} s; needs ≤ ${stability.rule.tolerance} pH for ${stability.rule.windowMs / 1000} s). Wait for a stable reading.`);
        const temp = s.lastPacket.TEMP_VAL;
        const tempValue = s.values.TEMP_VAL;
        if (typeof tempValue !== 'number' || !temp || Date.now() - temp.at > stability.rule.maxGapMs)
          return blocked('The temperature sensor is not sending a temperature. Reconnect it before measuring.');
        if (tempValue < -20 || tempValue > 150) return blocked(`Temperature ${tempValue} °C is outside −20 to 150 °C.`);

        // The packets the result rests on: every reading in the stability window, and the temperature.
        const used = s.history.filter((h) => h.at >= stability.from! && h.at <= stability.to!).map((h) => h.held);
        used.push(temp);
        const dataSource = used.some((h) => h.packet.transport === 'SIMULATOR') ? 'SIMULATED' : 'INSTRUMENT';
        if (dataSource === 'SIMULATED' && ctx.production) return blocked('Simulated data cannot be used.');
        const sourceMessages = [...new Set(await Promise.all(used.map((h) => persistHeld(d, h))))].sort((a, b) => a - b);
        const atc = s.values.ATC === 1 ? 'ON' : s.values.ATC === 0 ? 'OFF' : 'UNKNOWN';
        const calibration = await calibrationInForce(d);
        const ph = stability.latest!;

        const id = await ctx.db.transaction(req.principal, 'pH measurement recorded', req.origin, async (tx) => {
          const [seq] = await tx.query<{ n: string }>("SELECT nextval('ph_measurement_code_seq') AS n");
          const code = `PHM-${String(seq.n).padStart(4, '0')}`;
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO ph_measurements (code, device_id, sample_id, batch, ar_number, product, remarks, ph, temperature_c, atc,
                                          stability, data_source, source_messages, calibration, measured_by, measured_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now()) RETURNING id`,
            [code, d.id, f.sampleId, f.batch, f.arNumber, f.product, f.remarks, ph, tempValue, atc,
             JSON.stringify(stability), dataSource, sourceMessages, JSON.stringify(calibration), req.principal.userId],
          );
          await ctx.workflow.start(tx, req.principal, { definitionCode: WORKFLOW, tableName: TABLE, recordId: row.id, seriesId: row.id, seriesVersion: 1 });
          return row.id;
        });
        await ctx.audit.record({
          action: 'PH_MEASUREMENT_RECORDED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: id,
          details: { device: d.code, ph, temperatureC: tempValue, sampleId: f.sampleId, dataSource, sourceMessages: sourceMessages.join(',') },
        });
        return measurementView(await loadMeasurement(ctx.db, id));
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/measurements',
      permission: 'ph.view',
      async handler(req) {
        const deviceId = typeof req.query.device === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.device) ? req.query.device : null;
        const rows = await ctx.db.query<MeasurementRow>(
          `SELECT m.*, u.full_name AS measured_by_name, d.code AS device_code, d.name AS device_name
             FROM ph_measurements m LEFT JOIN users u ON u.id = m.measured_by JOIN devices d ON d.id = m.device_id
            WHERE NOT m.is_deleted AND ($1::uuid IS NULL OR m.device_id = $1) ORDER BY m.measured_at DESC LIMIT 200`,
          [deviceId],
        );
        return Promise.all(rows.map(async (r) => ({ ...measurementView(r), workflow: await ctx.workflow.forRecord(TABLE, r.id) })));
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/measurements/:id',
      permission: 'ph.view',
      async handler(req) {
        const m = await loadMeasurement(ctx.db, req.params.id);
        const packets = await sourcePackets(ctx.db, m.source_messages);
        return {
          ...measurementView(m),
          packets: packets.map((x) => ({ id: Number(x.id), receivedAt: x.received_at.toISOString(), raw: x.raw, sha256: x.raw_sha256, transport: x.transport })),
          workflow: await ctx.workflow.forRecord(TABLE, m.id),
        };
      },
    });

    /** Correct the sample details of a draft (the measured values can never change). Reason required. */
    ctx.http.route({
      method: 'PUT',
      path: '/measurements/:id/details',
      permission: 'ph.measure',
      async handler(req) {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 5) throw new ModuleError(400, 'Enter a reason for the correction (at least 5 characters).', 'reason');
        const f = details(body);
        await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          const m = await loadMeasurement(tx, req.params.id);
          if (m.measured_by !== req.principal.userId) throw new ModuleError(403, 'Only the person who took the measurement can correct it.');
          await ctx.workflow.assertEditable(tx, TABLE, m.id);
          if (m.sample_id === f.sampleId && m.batch === f.batch && m.ar_number === f.arNumber && m.product === f.product && m.remarks === f.remarks)
            throw new ModuleError(400, 'Nothing changed.');
          await tx.query('UPDATE ph_measurements SET sample_id = $2, batch = $3, ar_number = $4, product = $5, remarks = $6 WHERE id = $1', [
            m.id, f.sampleId, f.batch, f.arNumber, f.product, f.remarks,
          ]);
        });
        return measurementView(await loadMeasurement(ctx.db, req.params.id));
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/buffer-sets',
      permission: 'ph.view',
      async handler() {
        return ctx.db.query('SELECT code, name, buffers, is_default AS "isDefault" FROM ph_buffer_sets WHERE NOT is_deleted ORDER BY code');
      },
    });

    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/calibrations',
      permission: 'calibration.perform',
      async handler(req) {
        const d = await device(req);
        const body = (req.body ?? {}) as { source?: string; temperatureC?: unknown; readings?: unknown; remarks?: unknown };
        const remarks = typeof body.remarks === 'string' ? body.remarks.trim().slice(0, 2000) : '';
        let readings: PhReading[];
        let temperatureC: number | null;
        let dataSource: CalibrationInput['dataSource'] = 'MANUAL';
        let sourceMessages: number[] = [];
        const extra: Record<string, unknown> = {};

        if (body.source === 'INSTRUMENT') {
          const s = live.get(d.id);
          const cal = await instrumentCalibration(d);
          if (!s || !cal)
            throw new ModuleError(409, 'No calibration has been received from this instrument in the last 60 minutes. Calibrate on the instrument first.');
          readings = cal.readings.map(({ bufferPh, mv }) => ({ bufferPh, mv }));
          if (cal.temperatureC !== null) {
            temperatureC = cal.temperatureC;
            const t = s.lastPacket.TEMP_VAL;
            if (t && t.messageId === null) t.messageId = await ctx.gateway.persist(d, t.packet, 'MEASUREMENT');
            if (t?.messageId) sourceMessages.push(t.messageId);
            extra.temperatureSource = 'INSTRUMENT';
          } else {
            temperatureC = typeof body.temperatureC === 'number' ? body.temperatureC : null;
            extra.temperatureSource = 'MANUAL';
          }
          sourceMessages = [...new Set([...s.calibration.messageIds, ...sourceMessages])].sort((a, b) => a - b);
          // Simulated if ANY packet used came from the simulator (never judge by the latest packet alone).
          const used = [...Object.values(s.calibration.mv), ...(extra.temperatureSource === 'INSTRUMENT' && s.lastPacket.TEMP_VAL ? [s.lastPacket.TEMP_VAL] : [])];
          dataSource = used.some((h) => h.packet.transport === 'SIMULATOR') ? 'SIMULATED' : 'INSTRUMENT';
          if (dataSource === 'SIMULATED' && ctx.production) throw new ModuleError(409, 'Simulated data cannot be used.');
          extra.bufferSet = cal.bufferSet;
          extra.deviceReported = cal.deviceReported;
          extra.deviceTimes = cal.deviceTimes;
        } else if (body.source === 'MANUAL') {
          if (!Array.isArray(body.readings)) throw new ModuleError(400, 'Enter the buffer readings.', 'readings');
          readings = (body.readings as { bufferPh?: unknown; mv?: unknown }[]).map((r) => ({ bufferPh: Number(r?.bufferPh), mv: Number(r?.mv) }));
          temperatureC = typeof body.temperatureC === 'number' ? body.temperatureC : null;
        } else throw new ModuleError(400, 'Choose where the readings come from.', 'source');

        const problems = validateReadings(readings, temperatureC);
        if (problems.length) throw new ModuleError(400, problems.join(' '), 'readings');
        const result = computePh(readings, temperatureC!);
        const { outcome, ...results } = result;
        const created = await ctx.calibrations.record(
          req.principal,
          d.id,
          {
            temperatureC,
            readings,
            limits: { ...DEFAULT_PH_LIMITS },
            results: { ...results, ...extra },
            display: display(result, temperatureC!),
            outcome,
            remarks,
            dataSource,
            sourceMessages,
          },
          req.origin,
        );
        if (body.source === 'INSTRUMENT') {
          const s = live.get(d.id);
          if (s) s.calibration = { mv: {}, fields: {}, at: 0, messageIds: new Set() };
        }
        await ctx.audit.record({
          action: 'PH_CALIBRATION_CAPTURED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: created.calibrationId,
          details: { code: created.code, device: d.code, dataSource, outcome, sourceMessages: sourceMessages.join(',') },
        });
        return { ...created, outcome, dataSource };
      },
    });
  },

  async healthCheck() {
    const sets = await ctx.db.query('SELECT 1 FROM ph_buffer_sets WHERE is_default AND NOT is_deleted');
    return sets.length ? { ok: true } : { ok: false, message: 'Default buffer set missing' };
  },

  unload() {
    live.clear();
  },
};

export default PhModule;
export const register = PhModule.register;
export const healthCheck = PhModule.healthCheck;
export const unload = PhModule.unload;
