import type {
  CalibrationInput,
  DeviceInfo,
  InstrumentPacket,
  ModuleContext,
  ModuleRequest,
  NxGenModule,
} from '@crescent/module-sdk';
import { ModuleError } from '@crescent/module-sdk';
import {
  computePh,
  decodePacket,
  DEFAULT_PH_LIMITS,
  display,
  PhReading,
  readingsFromSlots,
  validateReadings,
} from '../shared/ph';

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
}

let ctx: ModuleContext;
const live = new Map<string, LiveState>();

const state = (device: DeviceInfo) => {
  let s = live.get(device.id);
  if (!s) {
    s = { values: {}, valueAt: {}, lastSeenAt: 0, transport: 'SERIAL', lastPacket: {}, calibration: { mv: {}, fields: {}, at: 0, messageIds: new Set() } };
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

function liveView(d: DeviceInfo) {
  const s = live.get(d.id);
  if (!s) return null;
  return {
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
        for (const [k, v] of Object.entries(p.values)) {
          s.values[k] = v;
          s.valueAt[k] = packet.receivedAt;
          s.lastPacket[k] = { packet, messageId, at: now };
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
            if (held && held.messageId === null) held.messageId = await ctx.gateway.persist(d, held.packet, 'MEASUREMENT');
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
        return { device: d, live: liveView(d), calibration: await instrumentCalibration(d), limits: DEFAULT_PH_LIMITS };
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
