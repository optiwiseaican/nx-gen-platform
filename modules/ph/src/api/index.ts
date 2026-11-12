import { createHash } from 'crypto';
import type {
  CalibrationInput,
  CalibrationRecord,
  DeviceInfo,
  InstrumentPacket,
  ModuleContext,
  ModulePrincipal,
  ModuleRequest,
  ModuleTx,
  NxGenModule,
  ReportInput,
  RequestOrigin,
} from '@crescent/module-sdk';
import { ModuleError } from '@crescent/module-sdk';
import { CalibrationSession, SessionError } from './calibration-session';
import {
  assessStability,
  ALARM_BREACH,
  batteryCondition,
  calibrationBucket,
  dashboardSummary,
  isChargingText,
  parseSampleListEntry,
  evaluateProbeHealth,
  PROBE_STATUSES,
  bufferExpired,
  parseBufferDetails,
  parseMeterSettings,
  calibrationSlots,
  csvCell,
  dueAlertChanges,
  outsideAlarmRange,
  postCalibrationAlerts,
  sampleTrend,
  TREND_KEEP_MS,
  TREND_SAMPLES,
  TREND_STEP_MS,
  TREND_WINDOWS,
  trendPoint,
  validateAlarmRange,
  isLogTrigger,
  LOG_DEBOUNCE_MS,
  LOG_METHOD_LABEL,
  logReadingProblem,
  MAX_LOG_INTERVAL_S,
  MIN_LOG_INTERVAL_S,
  parseLogDetails,
  DEFAULT_CALIBRATION_SETTINGS,
  parseCalibrationSettings,
  preCalibrationChecks,
  computePh,
  decodePacket,
  DEFAULT_PH_LIMITS,
  DEFAULT_STABILITY,
  display,
  PhReading,
  readingsFromSlots,
  isCalibrationKey,
  isStatusKey,
  parseLimits,
  phCommands,
  validateDetails,
  validateLimits,
  validateReadings,
} from '../shared/ph';
import type { ProbeCalibration, ProbeStatus, AlertRequest, TrendPoint, CalibrationSettings, DashboardRowLike, LogDetails, LogMethod, LogMode, MeasurementDetails, PhLimits, SampleListKind, Stability } from '../shared/ph';

const TABLE = 'ph_measurements';
const WORKFLOW = 'PH_MEASUREMENT_APPROVAL';
const LIMITS_TABLE = 'ph_acceptance_profiles';
const LIMITS_WORKFLOW = 'PH_ACCEPTANCE_LIMITS_APPROVAL';
/** All versions of the limits form one series: approving one retires the one before. */
const LIMITS_SERIES = 'ph-acceptance-limits';
const IN_PROGRESS = ['DRAFT', 'IN_REVIEW', 'REVIEWED'];
/** Recent pH readings kept in memory per instrument, for the stability window. */
const HISTORY_MS = 60_000;
const HISTORY_MAX = 600;

/** Calibration packets older than this are not offered for a new record. */
const CALIBRATION_FRESH_MS = 60 * 60_000;
/** A meter silent this long is shown as offline (as in NxGen Sense). */
const STALE_MS = 10_000;

interface Held {
  packet: InstrumentPacket;
  messageId: number | null;
  at: number;
}

interface LiveState {
  values: Record<string, number | null>;
  /** Latest status text (DEVICE_STATUS, CHARGING_STATUS, CURRENT_USER). */
  text: Record<string, string>;
  valueAt: Record<string, string>;
  lastSeenAt: number;
  transport: InstrumentPacket['transport'];
  /** Latest packet that carried each field (kept so a record can store the original). */
  lastPacket: Record<string, Held>;
  calibration: { mv: Record<number, Held & { value: number }>; fields: Record<string, number | string | null>; at: number; messageIds: Set<number> };
  /** Recent PH_VAL readings with their packets (oldest first). */
  history: { value: number | null; at: number; held: Held }[];
  /** Readings at most every few seconds, for the last hour. */
  trend: TrendPoint[];
  lastDueCheck: number;
}

let ctx: ModuleContext;
const live = new Map<string, LiveState>();

const state = (device: DeviceInfo) => {
  let s = live.get(device.id);
  if (!s) {
    s = { values: {}, text: {}, valueAt: {}, lastSeenAt: 0, transport: 'SERIAL', lastPacket: {}, calibration: { mv: {}, fields: {}, at: 0, messageIds: new Set() }, history: [], trend: [], lastDueCheck: 0 };
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
    text: s.text,
    valueAt: s.valueAt,
    lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    online: Date.now() - s.lastSeenAt < STALE_MS,
    simulated: s.transport === 'SIMULATOR',
  };
}

async function instrumentCalibration(d: DeviceInfo, limits: PhLimits) {
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
    preview: temperatureC !== null && !validateReadings(readings, temperatureC).length ? computePh(readings, temperatureC, limits) : null,
  };
}


/** Store a packet held in memory (once), returning its device_messages id. */
async function persistHeld(d: DeviceInfo, held: Held): Promise<number> {
  if (held.messageId === null) held.messageId = await ctx.gateway.persist(d, held.packet, 'MEASUREMENT');
  return held.messageId;
}

interface LimitsRow {
  id: string;
  profile_version: number;
  slope_pass_min: string;
  slope_pass_max: string;
  slope_warn_min: string;
  slope_warn_max: string;
  offset_pass_max_abs: string;
  offset_warn_max_abs: string;
  deviation_max_ph: string;
  change_reason: string;
  prepared_by: string;
  created_at: Date;
}

const limitsOf = (r: LimitsRow): PhLimits => ({
  slopePassMin: Number(r.slope_pass_min),
  slopePassMax: Number(r.slope_pass_max),
  slopeWarnMin: Number(r.slope_warn_min),
  slopeWarnMax: Number(r.slope_warn_max),
  offsetPassMaxAbs: Number(r.offset_pass_max_abs),
  offsetWarnMaxAbs: Number(r.offset_warn_max_abs),
  deviationMaxPh: Number(r.deviation_max_ph),
});

const limitsRows = () => ctx.db.query<LimitsRow>(`SELECT * FROM ${LIMITS_TABLE} ORDER BY profile_version DESC`);

/** The approved limits in force; version null means the built-in defaults (nothing approved yet). */
async function limitsInForce(): Promise<{ version: number | null; limits: PhLimits }> {
  for (const r of await limitsRows()) {
    const w = await ctx.workflow.forRecord(LIMITS_TABLE, r.id);
    if (w?.state === 'APPROVED') return { version: r.profile_version, limits: limitsOf(r) };
  }
  return { version: null, limits: DEFAULT_PH_LIMITS };
}

function parseLimitsBody(body: unknown): { limits: PhLimits; reason: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 10 || reason.length > 1000) throw new ModuleError(400, 'Enter the reason for this change (10 to 1000 characters).', 'reason');
  const limits = parseLimits(b.limits);
  const problems = validateLimits(limits);
  if (problems.length) throw new ModuleError(400, problems.join(' '), 'limits');
  return { limits, reason };
}

const limitsParams = (l: PhLimits) => [l.slopePassMin, l.slopePassMax, l.slopeWarnMin, l.slopeWarnMax, l.offsetPassMaxAbs, l.offsetWarnMaxAbs, l.deviationMaxPh];

interface GuidedRun {
  session: CalibrationSession<Held>;
  timer: NodeJS.Timeout;
}
/** Guided calibrations in progress, by instrument. They run here so a closed browser cannot break one. */
const runs = new Map<string, GuidedRun>();

function endRun(deviceId: string) {
  const run = runs.get(deviceId);
  if (run) clearInterval(run.timer);
  runs.delete(deviceId);
}

async function calibrationSettings(deviceId: string): Promise<CalibrationSettings> {
  const [r] = await ctx.db.query<{ point_count: 3 | 5; timer_seconds: number; require_stable: boolean; buffers: Record<number, number> }>(
    'SELECT point_count, timer_seconds, require_stable, buffers FROM ph_calibration_settings WHERE device_id = $1',
    [deviceId],
  );
  return r ? { pointCount: r.point_count, timerSeconds: r.timer_seconds, requireStable: r.require_stable, buffers: r.buffers } : DEFAULT_CALIBRATION_SETTINGS;
}

interface InstrumentProbe {
  probe_id: string;
  probe_code: string;
  probe_type: string;
  display_name: string;
  status: ProbeStatus;
  created_at: Date;
  temperature_sensor_id: string;
  interrupted_runs: number;
}

const instrumentProbe = async (deviceId: string): Promise<InstrumentProbe | null> =>
  (
    await ctx.db.query<InstrumentProbe>(
      `SELECT a.probe_id, p.probe_code, p.probe_type, p.display_name, p.status, p.created_at, a.temperature_sensor_id, a.interrupted_runs
         FROM ph_instrument_probes a JOIN ph_probes p ON p.id = a.probe_id WHERE a.device_id = $1`,
      [deviceId],
    )
  )[0] ?? null;

async function checksFor(d: DeviceInfo) {
  const fitted = await instrumentProbe(d.id);
  const s = live.get(d.id);
  const online = !!s && Date.now() - s.lastSeenAt < STALE_MS;
  return preCalibrationChecks({
    assignmentProblem: !fitted ? 'Assign a probe and temperature sensor to this instrument.' : fitted.status === 'ACTIVE' ? null : `Probe ${fitted.probe_code} is ${fitted.status.toLowerCase()}.`,
    hasIdentifier: !!d.deviceIdentifier,
    online,
    battery: s?.values.BATTERY,
    probe: s?.values.PROBE_CONNECTED,
    sensor: s?.values.TEMP_SENSOR_CONNECTED,
    temperature: s?.values.TEMP_VAL,
  });
}

/** A SessionError is the user's to read; anything else is a fault. */
async function sessionStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SessionError) throw new ModuleError(409, e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** Automatic logging ends after this long, so entries are never attributed to someone long gone. */
const LOG_RUN_MAX_MS = 12 * 60 * 60_000;
const LOG_EXPORT_MAX_ROWS = 100_000;

// ---------------------------------------------------------------------------
// Alerts and alarms
// ---------------------------------------------------------------------------

/** Raise an alert unless the same one is already unresolved. Never disturbs the work that raised it. */
async function raiseAlert(d: DeviceInfo, a: AlertRequest, details?: Record<string, string | number | boolean | null>) {
  try {
    const rows = await ctx.db.query(
      `INSERT INTO ph_alerts (device_id, device_code, code, severity, message, details) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (device_id, code) WHERE status <> 'RESOLVED' DO NOTHING RETURNING id`,
      [d.id, d.code, a.code, a.severity, a.message, details ? JSON.stringify(details) : null],
    );
    if (rows.length)
      await ctx.audit.record({ action: 'PH_ALERT_RAISED', result: a.severity === 'CRITICAL' ? 'FAILURE' : 'INFO', recordId: d.id, reason: a.message, details: { device: d.code, code: a.code, severity: a.severity } });
  } catch (e) {
    ctx.logger.error(`Could not raise ${a.code} on ${d.code}: ${(e as Error).message}`);
  }
}

async function resolveAlert(d: DeviceInfo, code: string, resolution: string, by: ModulePrincipal | null = null) {
  try {
    const rows = await ctx.db.query(
      `UPDATE ph_alerts SET status = 'RESOLVED', resolved_by = $3, resolved_at = now(), resolution = $4 WHERE device_id = $1 AND code = $2 AND status <> 'RESOLVED' RETURNING id`,
      [d.id, code, by?.fullName ?? 'System', resolution],
    );
    if (rows.length) await ctx.audit.record({ action: 'PH_ALERT_RESOLVED', result: 'INFO', principal: by, recordId: d.id, reason: resolution, details: { device: d.code, code } });
  } catch (e) {
    ctx.logger.error(`Could not resolve ${code} on ${d.code}: ${(e as Error).message}`);
  }
}

interface AlarmState {
  minPh: number;
  maxPh: number;
  monitoring: boolean;
  /** The reading is outside the range and the breach has been raised. */
  active: boolean;
}
const alarms = new Map<string, AlarmState | null>();

async function alarmFor(deviceId: string): Promise<AlarmState | null> {
  if (alarms.has(deviceId)) return alarms.get(deviceId)!;
  const [r] = await ctx.db.query<{ min_ph: string; max_ph: string; monitoring: boolean }>('SELECT min_ph, max_ph, monitoring FROM ph_alarm_settings WHERE device_id = $1', [deviceId]);
  // An alarm raised before a restart is still in force.
  const open = await ctx.db.query("SELECT 1 FROM ph_alerts WHERE device_id = $1 AND code = $2 AND status <> 'RESOLVED'", [deviceId, ALARM_BREACH]);
  const state = r ? { minPh: Number(r.min_ph), maxPh: Number(r.max_ph), monitoring: r.monitoring, active: open.length > 0 } : null;
  alarms.set(deviceId, state);
  return state;
}

async function evaluateAlarm(d: DeviceInfo, ph: number | null) {
  const a = await alarmFor(d.id);
  if (!a?.monitoring || ph === null) return;
  if (outsideAlarmRange(ph, a.minPh, a.maxPh)) {
    if (a.active) return;
    a.active = true;
    await raiseAlert(
      d,
      { code: ALARM_BREACH, severity: 'CRITICAL', message: `pH ${ph.toFixed(2)} is outside the alarm range ${a.minPh.toFixed(2)}–${a.maxPh.toFixed(2)}.` },
      { ph, minPh: a.minPh, maxPh: a.maxPh },
    );
  } else if (a.active) {
    a.active = false;
    await resolveAlert(d, ALARM_BREACH, `The reading returned to the range at pH ${ph.toFixed(2)}.`);
  }
}

interface LogRun {
  mode: LogMode;
  intervalSeconds: number | null;
  details: LogDetails;
  principal: ModulePrincipal;
  origin: RequestOrigin;
  startedAt: number;
  count: number;
  skipped: number;
  lastProblem: string | null;
  lastRaw: string | null;
  lastTriggerAt: number;
  writing: boolean;
  timer: NodeJS.Timeout | null;
}
/** Automatic logging in progress, by instrument. */
const logRuns = new Map<string, LogRun>();

/** Store one logged reading, or say why it could not be. */
async function writeLog(d: DeviceInfo, method: LogMethod, details: LogDetails, principal: ModulePrincipal, origin: RequestOrigin, held?: Held): Promise<string | null> {
  const current = await ctx.devices.get(d.id);
  if (!current?.readiness.usable) return `${d.code} cannot be used: ${current?.readiness.message ?? 'not found'}`;
  const s = live.get(d.id);
  if (!s || Date.now() - s.lastSeenAt >= STALE_MS) return 'A valid live pH reading is not available.';
  const reading = { ph: s.values.PH_VAL, mv: s.values.MV_VAL, temperatureC: s.values.TEMP_VAL };
  const problem = logReadingProblem(reading);
  if (problem) return problem;
  const source = held && 'PH_VAL' in held.packet.fields ? held : s.lastPacket.PH_VAL;
  if (source.packet.transport === 'SIMULATOR' && ctx.production) return 'Simulated data cannot be used.';
  const messageId = await persistHeld(d, source);
  const dataSource = source.packet.transport === 'SIMULATOR' ? 'SIMULATED' : 'INSTRUMENT';
  await ctx.db.transaction(principal, null, origin, (tx) =>
    tx.query(
      `INSERT INTO ph_log_entries (device_id, device_code, method, ph, mv, temperature_c, stable, batch, ar_number, product, data_source, source_message, logged_by, logged_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [d.id, d.code, method, reading.ph, reading.mv, reading.temperatureC, s.values.STABLE === 1, details.batch, details.arNumber, details.product, dataSource, messageId, principal.userId, principal.fullName],
    ),
  );
  return null;
}

async function logFromRun(d: DeviceInfo, run: LogRun, method: LogMethod, held?: Held) {
  if (run.writing) return;
  run.writing = true;
  try {
    if (Date.now() - run.startedAt > LOG_RUN_MAX_MS) {
      await stopLogRun(d, 'It reached the 12-hour limit.');
      return;
    }
    const problem = await writeLog(d, method, run.details, run.principal, run.origin, held);
    if (problem) {
      run.skipped++;
      run.lastProblem = problem;
    } else {
      run.count++;
      run.lastProblem = null;
    }
  } catch (e) {
    run.skipped++;
    run.lastProblem = 'The reading could not be saved.';
    ctx.logger.error(`Logging on ${d.code}: ${(e as Error).message}`);
  } finally {
    run.writing = false;
  }
}

async function stopLogRun(d: DeviceInfo, reason: string | null, by?: ModulePrincipal) {
  const run = logRuns.get(d.id);
  if (!run) return;
  if (run.timer) clearInterval(run.timer);
  logRuns.delete(d.id);
  const sent = await ctx.gateway.send(d, phCommands.logStop());
  await ctx.audit.record({
    action: 'PH_LOGGING_STOPPED',
    result: 'SUCCESS',
    principal: by ?? run.principal,
    recordId: d.id,
    reason,
    details: { device: d.code, mode: run.mode, entries: run.count, skipped: run.skipped, meterStopped: sent.sent },
  });
}

/** A meter packet during automatic logging. */
async function onLogPacket(d: DeviceInfo, packet: InstrumentPacket, values: Record<string, number | null>, held: Held) {
  const run = logRuns.get(d.id);
  if (!run || !isLogTrigger(run.mode, values)) return;
  const now = Date.now();
  const repeat = packet.raw === run.lastRaw && now - run.lastTriggerAt < LOG_DEBOUNCE_MS;
  run.lastRaw = packet.raw;
  run.lastTriggerAt = now;
  if (repeat) return;
  await logFromRun(d, run, run.mode, held);
  // Tells the meter this reading was taken, so it can offer the next stable one.
  if (run.mode === 'STABLE') await ctx.gateway.send(d, phCommands.holdReset());
}

const logRunView = (run: LogRun | undefined) =>
  run
    ? { mode: run.mode, intervalSeconds: run.intervalSeconds, details: run.details, startedByName: run.principal.fullName, startedAt: new Date(run.startedAt).toISOString(), count: run.count, skipped: run.skipped, lastProblem: run.lastProblem }
    : null;

interface LogRow {
  id: string;
  device_id: string;
  device_code: string;
  method: LogMethod;
  ph: string;
  mv: string;
  temperature_c: string;
  stable: boolean;
  batch: string;
  ar_number: string;
  product: string;
  data_source: string;
  source_message: string;
  logged_by_name: string;
  logged_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The WHERE clause shared by the list and the export. */
function logFilter(q: Record<string, string | undefined>): { where: string; params: unknown[] } {
  const date = (v: string | undefined, name: string) => {
    if (!v) return null;
    const t = new Date(v);
    if (Number.isNaN(t.getTime())) throw new ModuleError(400, `Invalid ${name} date.`, name);
    return t.toISOString();
  };
  if (q.device && !UUID.test(q.device)) throw new ModuleError(400, 'Invalid instrument.', 'device');
  if (q.method && !(q.method in LOG_METHOD_LABEL)) throw new ModuleError(400, 'Invalid logging method.', 'method');
  const search = q.search?.trim().slice(0, 80) || null;
  return {
    where: `($1::uuid IS NULL OR device_id = $1)
        AND ($2::text IS NULL OR method = $2)
        AND ($3::timestamptz IS NULL OR logged_at >= $3)
        AND ($4::timestamptz IS NULL OR logged_at < $4)
        AND ($5::text IS NULL OR concat_ws(' ', device_code, batch, ar_number, product, logged_by_name) ILIKE '%' || replace(replace(replace($5, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')`,
    params: [q.device || null, q.method || null, date(q.from, 'from'), date(q.to, 'to'), search],
  };
}

const logView = (r: LogRow) => ({
  id: Number(r.id),
  deviceId: r.device_id,
  deviceCode: r.device_code,
  method: r.method,
  ph: Number(r.ph),
  mv: Number(r.mv),
  temperatureC: Number(r.temperature_c),
  stable: r.stable,
  batch: r.batch,
  arNumber: r.ar_number,
  product: r.product,
  dataSource: r.data_source,
  sourceMessage: Number(r.source_message),
  loggedBy: r.logged_by_name,
  loggedAt: r.logged_at.toISOString(),
});

// ---------------------------------------------------------------------------
// Calibration history and reports
// ---------------------------------------------------------------------------

const REPORT_LOG_MAX_ROWS = 10_000;
const utcText = (iso: string) => `${iso.replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`;
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const STATE_TEXT: Record<string, string> = { DRAFT: 'Draft', IN_REVIEW: 'In review', REVIEWED: 'Reviewed', APPROVED: 'Approved', INVALIDATED: 'Invalidated', SUPERSEDED: 'Superseded' };

function calibrationSummary(c: CalibrationRecord, d: DeviceInfo) {
  const limits = c.limits as { version?: number | null } & Record<string, unknown>;
  const results = c.results as {
    slopePercent?: number;
    offsetMv?: number;
    rSquared?: number;
    slopeOutcome?: string;
    offsetOutcome?: string;
    guided?: boolean;
    points?: unknown;
    deviations?: unknown;
  };
  const { version: _version, ...limitValues } = limits;
  return {
    id: c.id,
    code: c.code,
    deviceId: d.id,
    deviceCode: d.code,
    performedAt: c.performedAt,
    performedBy: c.performedBy.name,
    outcome: c.outcome,
    state: c.workflow.state,
    slopePercent: results.slopePercent ?? null,
    offsetMv: results.offsetMv ?? null,
    temperatureC: c.temperatureC,
    readings: Array.isArray(c.readings) ? (c.readings as { bufferPh: number; mv: number }[]).map(({ bufferPh, mv }) => ({ bufferPh, mv })) : [],
    dataSource: c.dataSource,
    guided: results.guided === true,
    limitsVersion: limits.version ?? null,
    limits: Object.keys(limitValues).length ? limitValues : null,
    rSquared: typeof results.rSquared === 'number' ? results.rSquared : null,
    slopeOutcome: results.slopeOutcome ?? null,
    offsetOutcome: results.offsetOutcome ?? null,
    // Guided runs keep every buffer as it was captured, and its deviation verdict.
    points: Array.isArray(results.points) ? results.points : [],
    deviations: Array.isArray(results.deviations) ? results.deviations : [],
  };
}

async function calibrationHistory(req: ModuleRequest) {
  const q = req.query;
  if (q.device && !UUID.test(q.device)) throw new ModuleError(400, 'Invalid instrument.', 'device');
  if (q.outcome && !['PASS', 'WARNING', 'FAIL'].includes(q.outcome)) throw new ModuleError(400, 'Invalid outcome.', 'outcome');
  const when = (v: string | undefined, name: string) => {
    if (!v) return null;
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new ModuleError(400, `Invalid ${name} date.`, name);
    return t;
  };
  const from = when(q.from, 'from');
  const to = when(q.to, 'to');
  const devices = (await ctx.devices.list('PH')).filter((d) => !q.device || d.id === q.device);
  const rows = [];
  for (const d of devices)
    for (const c of await ctx.calibrations.forDevice(req.principal, d.id)) {
      const at = Date.parse(c.performedAt);
      if ((q.outcome && c.outcome !== q.outcome) || (from !== null && at < from) || (to !== null && at >= to)) continue;
      rows.push(calibrationSummary(c, d));
    }
  return rows.sort((a, b) => b.performedAt.localeCompare(a.performedAt));
}

/** The report is built from what was stored; nothing is recalculated. */
function calibrationReport(c: CalibrationRecord, d: DeviceInfo, generatedBy: string): ReportInput {
  const r = c.results as Record<string, unknown>;
  const limits = c.limits as Record<string, unknown>;
  const banner = c.dataSource === 'SIMULATED' ? 'SIMULATED DATA: NOT FOR REGULATED USE' : c.workflow.state === 'APPROVED' ? null : `NOT APPROVED: ${(STATE_TEXT[c.workflow.state] ?? c.workflow.state).toUpperCase()}`;
  const limitsVersion = limits.version as number | null | undefined;
  type Point = { slot: number; bufferPh: number; postPh: number | null; measuredPh: number | null; mv: number | null; temperatureC: number | null; segmentSlope: number | null; stable: boolean | null; capturedAt: string | null };
  const points = (r.points ?? []) as Point[];
  const deviations = (r.deviations ?? []) as { slot: number; deviation: number | null; deviationOutcome: string }[];
  const readings = (Array.isArray(c.readings) ? c.readings : []) as { bufferPh: number; mv: number }[];
  const checks = (r.preChecks ?? []) as { label: string; result: string; detail: string }[];
  const sections: ReportInput['sections'] = [
    r.guided
      ? {
          heading: 'Calibration points',
          columns: [
            { title: 'Buffer (pH)', weight: 70 },
            { title: 'Meter pH', weight: 70 },
            { title: 'mV', weight: 70 },
            { title: '°C', weight: 60 },
            { title: 'Slope %', weight: 70 },
            { title: 'Deviation', weight: 70 },
            { title: 'Result', weight: 60 },
            { title: 'Stable', weight: 60 },
            { title: 'Captured (meter time)', weight: 130 },
          ],
          rows: points.map((p) => {
            const dev = deviations.find((x) => x.slot === p.slot);
            return {
              cells: [p.bufferPh.toFixed(2), num(p.postPh ?? p.measuredPh, 2), num(p.mv, 2), num(p.temperatureC, 1), num(p.segmentSlope, 2), num(dev?.deviation, 3), dev?.deviationOutcome ?? '—', p.stable === null ? '—' : p.stable ? 'Yes' : 'No', p.capturedAt ?? '—'],
              alertCell: dev?.deviationOutcome === 'FAIL' ? 6 : undefined,
            };
          }),
        }
      : {
          heading: 'Calibration points',
          columns: [
            { title: 'Buffer (pH)', weight: 1 },
            { title: 'Potential (mV)', weight: 1 },
          ],
          rows: readings.map((x) => ({ cells: [num(x.bufferPh, 2), num(x.mv, 2)] })),
        },
    {
      heading: 'Results',
      columns: [
        { title: 'Measure', weight: 1 },
        { title: 'Value', weight: 2 },
      ],
      rows: [
        ...c.display.map((x) => ({ cells: [x.label, x.value] })),
        { cells: ['Slope limits', `Pass ${String(limits.slopePassMin)}–${String(limits.slopePassMax)} %, warning ${String(limits.slopeWarnMin)}–${String(limits.slopeWarnMax)} %`] },
        { cells: ['Offset limits', `Pass within ±${String(limits.offsetPassMaxAbs)} mV, warning within ±${String(limits.offsetWarnMaxAbs)} mV`] },
        ...(limits.deviationMaxPh === undefined ? [] : [{ cells: ['Deviation limit', `At most ${String(limits.deviationMaxPh)} pH`] }]),
      ],
    },
  ];
  if (checks.length)
    sections.push({
      heading: 'Pre-calibration checks',
      columns: [
        { title: 'Check', weight: 1 },
        { title: 'Result', weight: 1 },
        { title: 'Detail', weight: 3 },
      ],
      rows: checks.map((x) => ({ cells: [x.label, x.result, x.detail], alertCell: x.result === 'PASS' ? undefined : 1 })),
    });
  sections.push({
    heading: 'Approval history and signatures',
    columns: [
      { title: 'Step', weight: 1 },
      { title: 'By', weight: 2 },
      { title: 'Signature meaning', weight: 1.4 },
      { title: 'When (UTC)', weight: 1.6 },
      { title: 'Signature check', weight: 1 },
    ],
    rows: c.history.map((e) => ({
      cells: [e.step, e.signature ? `${e.signature.signerFullName} (${e.signature.signerUsername})` : (e.actorName ?? '—'), e.signature?.meaningLabel ?? '—', utcText(e.occurredAt).replace(' UTC', ''), e.signature ? (e.signature.intact ? 'Intact' : 'NOT INTACT') : '—'],
      alertCell: e.signature && !e.signature.intact ? 4 : undefined,
      below: [e.comment ? `Comment: ${e.comment}` : '', e.contentHash ? `Content SHA-256: ${e.contentHash}` : ''].filter(Boolean),
    })),
    empty: 'No approval steps yet.',
  });
  const results = c.outcome === 'FAIL';
  const probe = r.probe as { code?: string; type?: string; temperatureSensorId?: string } | null | undefined;
  const probeText = probe?.code ? [probe.code, probe.type].filter(Boolean).join(' · ') : '—';
  return {
    title: `pH Calibration Report ${c.code}`,
    banner,
    summary: [
      { label: 'Report ID', value: c.code },
      { label: 'Record status', value: STATE_TEXT[c.workflow.state] ?? c.workflow.state },
      { label: 'Result', value: c.outcome, alert: results },
      { label: 'Instrument', value: `${d.code} · ${d.name}` },
      { label: 'Make and model', value: `${d.manufacturer} ${d.model}` },
      { label: 'Serial number', value: d.serialNumber },
      { label: 'Location', value: d.location || '—' },
      { label: 'Performed by', value: c.performedBy.name },
      { label: 'Performed (UTC)', value: utcText(c.performedAt).replace(' UTC', '') },
      { label: 'Data source', value: c.dataSource },
      { label: 'Acceptance limits', value: limitsVersion === null || limitsVersion === undefined ? 'Built-in defaults' : `Version ${limitsVersion}` },
      { label: 'Probe', value: probeText },
      { label: 'Temperature sensor', value: typeof probe?.temperatureSensorId === 'string' ? probe.temperatureSensorId : '—' },
      { label: 'Buffer lot', value: typeof r.bufferLot === 'string' && r.bufferLot ? r.bufferLot : '—' },
      { label: 'Buffer expiry', value: typeof r.bufferExpiry === 'string' ? r.bufferExpiry : '—' },
      { label: 'Remarks', value: c.remarks || '—' },
      { label: 'Generated by', value: `${generatedBy}, ${utcText(new Date().toISOString())}` },
    ],
    note: 'Printed from the stored record; nothing was recalculated. The SHA-256 of this file is recorded in the audit trail.',
    sections,
  };
}

async function pdfFile(req: ModuleRequest, input: ReportInput, action: string, fileBase: string, details: Record<string, string | number | boolean | null>, recordId?: string) {
  const data = await ctx.reports.pdf(input);
  await ctx.audit.record({ action, result: 'SUCCESS', principal: req.principal, recordId: recordId ?? null, details: { ...details, format: 'PDF', sha256: createHash('sha256').update(data).digest('hex') } });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return { kind: 'file', contentType: 'application/pdf', data, fileName: `${fileBase}-${stamp}.pdf` };
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
        // Keep calibration and log packets; status fields only when they change; the
        // continuous measurement stream is held in memory (stored when used).
        const statusChanged =
          Object.entries(p.values).some(([k, v]) => isStatusKey(k) && s?.values[k] !== v) ||
          Object.entries(p.text).some(([k, v]) => isStatusKey(k) && s?.text[k] !== v);
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
        for (const [k, v] of Object.entries(p.text)) if (isStatusKey(k)) s.text[k] = v;
        if ('PH_VAL' in p.values) {
          const at = Date.parse(packet.receivedAt) || now;
          s.history.push({ value: p.values.PH_VAL, at, held });
          while (s.history.length > HISTORY_MAX || (s.history.length && at - s.history[0].at > HISTORY_MS)) s.history.shift();
          if (!s.trend.length || at - s.trend[s.trend.length - 1].at >= TREND_STEP_MS) {
            s.trend.push(trendPoint(at, s.values));
            while (s.trend.length && at - s.trend[0].at > TREND_KEEP_MS) s.trend.shift();
          }
        }
        if (p.kind === 'CALIBRATION') {
          if (now - s.calibration.at > CALIBRATION_FRESH_MS) s.calibration = { mv: {}, fields: {}, at: 0, messageIds: new Set() };
          for (const [k, v] of Object.entries(p.values)) {
            const slot = /^MV_([1-5])$/.exec(k);
            if (slot && typeof v === 'number') s.calibration.mv[Number(slot[1])] = { packet, messageId, at: now, value: v };
            else if (isCalibrationKey(k)) s.calibration.fields[k] = v;
          }
          for (const [k, v] of Object.entries(p.text)) if (isCalibrationKey(k)) s.calibration.fields[k] = v;
          if (messageId !== null) s.calibration.messageIds.add(messageId);
          s.calibration.at = now;
          runs.get(d.id)?.session.onPacket(p, messageId, packet.transport === 'SIMULATOR');
        }
        try {
          if ('PH_VAL' in p.values) await evaluateAlarm(d, p.values.PH_VAL);
          if (now - s.lastDueCheck >= 60_000) {
            s.lastDueCheck = now;
            const change = dueAlertChanges(d.readiness.state);
            if (change.raise) await raiseAlert(d, change.raise, { dueAt: d.readiness.dueAt });
            for (const code of change.resolve) await resolveAlert(d, code, 'The calibration is up to date.');
          }
        } catch (e) {
          ctx.logger.error(`Alarm check on ${d.code}: ${(e as Error).message}`);
        }
        try {
          await onLogPacket(d, packet, p.values, held);
        } catch (e) {
          ctx.logger.error(`Log trigger on ${d.code}: ${(e as Error).message}`);
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
        const inForce = await limitsInForce();
        return { device: d, live: liveView(d), calibration: await instrumentCalibration(d, inForce.limits), limits: inForce.limits, limitsVersion: inForce.version, stabilityRule: DEFAULT_STABILITY };
      },
    });

    /**
     * Everything the Dashboard and Devices screens show (NxGen Sense dashboard),
     * in one call: each instrument with its link, battery, probe, latest
     * calibration, open alerts and last activity, plus the summary counts.
     */
    const dashboard = async () => {
      const now = Date.now();
      const devices = await ctx.devices.list('PH');
      const ids = devices.map((d) => d.id);
      const [probes, calibrations, alerts, activity] = await Promise.all([
        ctx.db.query<{ device_id: string; probe_code: string; probe_type: string; status: ProbeStatus; temperature_sensor_id: string }>(
          'SELECT a.device_id, p.probe_code, p.probe_type, p.status, a.temperature_sensor_id FROM ph_instrument_probes a JOIN ph_probes p ON p.id = a.probe_id WHERE a.device_id = ANY($1::uuid[])',
          [ids],
        ),
        ctx.db.query<{ device_id: string; id: string; code: string; performed_at: Date; performed_by: string; outcome: string; state: string | null; results: Record<string, unknown>; point_count: number }>(
          `SELECT DISTINCT ON (c.device_id) c.device_id, c.id, c.code, c.performed_at, u.full_name AS performed_by, c.outcome, w.state, c.results,
                  jsonb_array_length(c.readings) AS point_count
             FROM calibration_records c
             JOIN users u ON u.id = c.performed_by
             LEFT JOIN workflow_instances w ON w.table_name = 'calibration_records' AND w.record_id = c.id::text
            WHERE c.device_id = ANY($1::uuid[]) AND NOT c.is_deleted AND (w.state IS NULL OR w.state <> 'INVALIDATED')
            ORDER BY c.device_id, c.performed_at DESC`,
          [ids],
        ),
        ctx.db.query<{ device_id: string; severity: string; n: number }>(
          "SELECT device_id, severity, COUNT(*)::int AS n FROM ph_alerts WHERE status <> 'RESOLVED' AND device_id = ANY($1::uuid[]) GROUP BY device_id, severity",
          [ids],
        ),
        ctx.db.query<{ device_id: string; at: Date }>('SELECT device_id, MAX(received_at) AS at FROM device_messages WHERE device_id = ANY($1::uuid[]) GROUP BY device_id', [ids]),
      ]);
      const flag = (v: number | null | undefined) => (typeof v === 'number' ? v === 1 : null);
      const rows = devices.map((d) => {
        const s = live.get(d.id);
        const online = !!s && now - s.lastSeenAt < STALE_MS;
        const battery = typeof s?.values.BATTERY === 'number' ? s.values.BATTERY : null;
        const charging = s?.values.IS_CHARGING === 1 || isChargingText(s?.text.CHARGING_STATUS);
        const probe = probes.find((p) => p.device_id === d.id) ?? null;
        const cal = calibrations.find((c) => c.device_id === d.id) ?? null;
        const results = (cal?.results ?? {}) as { slopePercent?: number; offsetMv?: number; guided?: boolean };
        const forDevice = alerts.filter((a) => a.device_id === d.id);
        const openAlerts = forDevice.reduce((n, a) => n + a.n, 0);
        const criticalAlerts = forDevice.filter((a) => a.severity === 'CRITICAL').reduce((n, a) => n + a.n, 0);
        const lastMessage = activity.find((a) => a.device_id === d.id)?.at.getTime() ?? 0;
        const lastActivity = Math.max(lastMessage, s?.lastSeenAt ?? 0);
        const row: DashboardRowLike & Record<string, unknown> = {
          id: d.id,
          code: d.code,
          name: d.name,
          model: d.model,
          manufacturer: d.manufacturer,
          serialNumber: d.serialNumber,
          location: d.location,
          status: d.status,
          deviceIdentifier: d.deviceIdentifier,
          readiness: d.readiness,
          online,
          simulated: s?.transport === 'SIMULATOR',
          lastSeenAt: s?.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : null,
          battery,
          charging,
          batteryCondition: batteryCondition(battery, charging),
          currentUser: s?.text.CURRENT_USER?.trim() || null,
          meterStatus: s?.text.DEVICE_STATUS ?? null,
          probeConnected: flag(s?.values.PROBE_CONNECTED),
          sensorConnected: flag(s?.values.TEMP_SENSOR_CONNECTED),
          probeCode: probe?.probe_code ?? null,
          probeType: probe?.probe_type ?? null,
          probeStatus: probe?.status ?? null,
          temperatureSensorId: probe?.temperature_sensor_id ?? null,
          calibrationBucket: calibrationBucket(d.readiness.state, d.readiness.dueAt, now),
          calibrationDueAt: d.readiness.dueAt,
          calibration: cal
            ? {
                id: cal.id,
                code: cal.code,
                performedAt: cal.performed_at.toISOString(),
                performedBy: cal.performed_by,
                outcome: cal.outcome,
                state: cal.state ?? 'DRAFT',
                slopePercent: typeof results.slopePercent === 'number' ? results.slopePercent : null,
                offsetMv: typeof results.offsetMv === 'number' ? results.offsetMv : null,
                pointCount: cal.point_count,
                guided: results.guided === true,
              }
            : null,
          openAlerts,
          criticalAlerts,
          lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
        };
        return row;
      });
      return {
        generatedAt: new Date(now).toISOString(),
        devices: rows,
        summary: dashboardSummary(rows),
        locations: [...new Set(rows.map((r) => r.location.trim()).filter(Boolean))].sort(),
      };
    };

    ctx.http.route({ method: 'GET', path: '/dashboard', permission: 'ph.view', passive: true, handler: () => dashboard() });

    /** The Refresh button: the same data, and the manual refresh goes on the audit trail. */
    ctx.http.route({
      method: 'POST',
      path: '/dashboard/refresh',
      permission: 'ph.view',
      async handler(req) {
        const data = await dashboard();
        await ctx.audit.record({ action: 'PH_DASHBOARD_REFRESHED', result: 'INFO', principal: req.principal, details: { devices: data.devices.length, online: data.summary.online } });
        return data;
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

    ctx.workflow.registerRecordType({
      tableName: LIMITS_TABLE,
      link: () => '?limits=1',
      authorOf: async (tx, id) => {
        const [r] = await tx.query<{ prepared_by: string }>(`SELECT prepared_by FROM ${LIMITS_TABLE} WHERE id = $1`, [id]);
        return r?.prepared_by ?? null;
      },
      // What the approver signs: the limits themselves and why they changed.
      async load(tx, id) {
        const [r] = await tx.query<LimitsRow>(`SELECT * FROM ${LIMITS_TABLE} WHERE id = $1`, [id]);
        if (!r) throw new ModuleError(404, 'Acceptance limits version not found.');
        return { title: `pH acceptance limits, version ${r.profile_version}`, content: { version: r.profile_version, limits: limitsOf(r), reason: r.change_reason } };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/acceptance-limits',
      permission: 'ph.view',
      async handler() {
        const inForce = await limitsInForce();
        const versions = await Promise.all(
          (await limitsRows()).map(async (r) => ({
            id: r.id,
            version: r.profile_version,
            limits: limitsOf(r),
            reason: r.change_reason,
            preparedById: r.prepared_by,
            createdAt: r.created_at.toISOString(),
            workflow: await ctx.workflow.forRecord(LIMITS_TABLE, r.id),
          })),
        );
        return { inForce, defaults: DEFAULT_PH_LIMITS, versions };
      },
    });

    /** Prepare a new version of the limits. It applies only once approved. */
    ctx.http.route({
      method: 'POST',
      path: '/acceptance-limits',
      permission: 'ph.limits',
      async handler(req) {
        const { limits, reason } = parseLimitsBody(req.body);
        const rows = await limitsRows();
        for (const r of rows) {
          const w = await ctx.workflow.forRecord(LIMITS_TABLE, r.id);
          if (w && IN_PROGRESS.includes(w.state)) throw new ModuleError(409, `Version ${r.profile_version} is still in progress. Finish it before starting another.`);
        }
        const inForce = await limitsInForce();
        if (limitsParams(limits).join() === limitsParams(inForce.limits).join()) throw new ModuleError(400, 'These are already the limits in force.');
        const version = (rows[0]?.profile_version ?? 0) + 1;
        const id = await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO ${LIMITS_TABLE} (profile_version, slope_pass_min, slope_pass_max, slope_warn_min, slope_warn_max, offset_pass_max_abs, offset_warn_max_abs, deviation_max_ph, change_reason, prepared_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [version, ...limitsParams(limits), reason, req.principal.userId],
          );
          await ctx.workflow.start(tx, req.principal, { definitionCode: LIMITS_WORKFLOW, tableName: LIMITS_TABLE, recordId: row.id, seriesId: LIMITS_SERIES, seriesVersion: version });
          return row.id;
        });
        return { id, version };
      },
    });

    /** Correct a draft version (for example after a rejection). Only its author can. */
    ctx.http.route({
      method: 'PUT',
      path: '/acceptance-limits/:id',
      permission: 'ph.limits',
      async handler(req) {
        const { limits, reason } = parseLimitsBody(req.body);
        await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          const [r] = await tx.query<LimitsRow>(`SELECT * FROM ${LIMITS_TABLE} WHERE id = $1`, [req.params.id]);
          if (!r) throw new ModuleError(404, 'Acceptance limits version not found.');
          if (r.prepared_by !== req.principal.userId) throw new ModuleError(403, 'Only the person who prepared this version can correct it.');
          await ctx.workflow.assertEditable(tx, LIMITS_TABLE, r.id);
          await tx.query(
            `UPDATE ${LIMITS_TABLE} SET slope_pass_min = $2, slope_pass_max = $3, slope_warn_min = $4, slope_warn_max = $5, offset_pass_max_abs = $6, offset_warn_max_abs = $7, deviation_max_ph = $8, change_reason = $9 WHERE id = $1`,
            [r.id, ...limitsParams(limits), reason],
          );
        });
        return { id: req.params.id };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments/:id/guided-calibration',
      permission: 'ph.view',
      passive: true,
      async handler(req) {
        const d = await device(req);
        return {
          settings: await calibrationSettings(d.id),
          checks: await checksFor(d),
          run: runs.get(d.id)?.session.view() ?? null,
          inForce: await limitsInForce(),
        };
      },
    });

    ctx.http.route({
      method: 'PUT',
      path: '/instruments/:id/calibration-settings',
      permission: 'ph.limits',
      async handler(req) {
        const d = await device(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (reason.length < 10 || reason.length > 1000) throw new ModuleError(400, 'Enter the reason for this change (10 to 1000 characters).', 'reason');
        if (runs.has(d.id)) throw new ModuleError(409, 'A calibration is in progress on this instrument.');
        const { settings, problems } = parseCalibrationSettings(body.settings);
        if (problems.length) throw new ModuleError(400, problems.join(' '), 'settings');
        const params = [d.id, settings.pointCount, settings.timerSeconds, settings.requireStable, JSON.stringify(settings.buffers)];
        await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          const [existing] = await tx.query('SELECT 1 FROM ph_calibration_settings WHERE device_id = $1', [d.id]);
          await tx.query(
            existing
              ? 'UPDATE ph_calibration_settings SET point_count = $2, timer_seconds = $3, require_stable = $4, buffers = $5 WHERE device_id = $1'
              : 'INSERT INTO ph_calibration_settings (device_id, point_count, timer_seconds, require_stable, buffers) VALUES ($1, $2, $3, $4, $5)',
            params,
          );
        });
        return settings;
      },
    });

    /** Begin a guided calibration. The limits in force now judge the whole run. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/guided-calibration',
      permission: 'calibration.perform',
      async handler(req) {
        const d = await device(req);
        if (d.status !== 'ACTIVE') throw new ModuleError(409, `${d.code} is not in service.`);
        if (runs.has(d.id)) throw new ModuleError(409, 'A calibration is already in progress on this instrument.');
        if (logRuns.has(d.id)) throw new ModuleError(409, 'Automatic logging is running on this instrument. Stop it first.');
        const checks = await checksFor(d);
        for (const c of checks.filter((x) => x.result !== 'PASS'))
          await raiseAlert(d, { code: c.alertCode, severity: c.result === 'FAIL' ? 'CRITICAL' : 'WARNING', message: `${c.label}: ${c.detail}` });
        const failed = checks.filter((c) => c.result === 'FAIL');
        const warnings = checks.filter((c) => c.result === 'WARN');
        const acknowledged = (req.body as { acknowledgeWarnings?: unknown } | undefined)?.acknowledgeWarnings === true;
        if (failed.length || (warnings.length && !acknowledged)) {
          await ctx.audit.record({
            action: 'PH_CALIBRATION_BLOCKED',
            result: 'FAILURE',
            principal: req.principal,
            recordId: d.id,
            reason: [...failed, ...warnings].map((c) => `${c.label}: ${c.detail}`).join(' '),
            details: { device: d.code },
          });
          if (failed.length) throw new ModuleError(409, failed.map((c) => `${c.label}: ${c.detail}`).join(' '));
          throw new ModuleError(409, 'Acknowledge the warnings to continue.');
        }
        const settings = await calibrationSettings(d.id);
        const inForce = await limitsInForce();
        const session = new CalibrationSession<Held>(
          {
            startedById: req.principal.userId,
            startedByName: req.principal.fullName,
            startedAt: Date.now(),
            limits: inForce.limits,
            limitsVersion: inForce.version,
            settings,
            slots: calibrationSlots(settings.pointCount),
            preChecks: checks,
            probe: await instrumentProbe(d.id).then((p) => p && { id: p.probe_id, code: p.probe_code, type: p.probe_type, temperatureSensorId: p.temperature_sensor_id }),
          },
          {
            send: async (fields, options) => {
              const result = await ctx.gateway.send(d, fields, options);
              if (!result.sent && 'CAL' in fields) await raiseAlert(d, { code: 'PH-CAL-START-COMMAND-FAILED', severity: 'CRITICAL', message: `A calibration command could not be sent: ${result.reason}` });
              return result;
            },
            telemetry: () => {
              const s = state(d);
              return {
                ph: s.values.PH_VAL ?? null,
                mv: s.values.MV_VAL ?? null,
                temperatureC: s.values.TEMP_VAL ?? null,
                stable: s.values.STABLE === 1,
                source: s.lastPacket.PH_VAL ?? null,
                simulated: s.transport === 'SIMULATOR',
              };
            },
            now: () => Date.now(),
          },
        );
        const timer = setInterval(() => {
          session.tick().catch((e: Error) => ctx.logger.error(`Guided calibration of ${d.code}: ${e.message}`));
        }, 1000);
        timer.unref();
        runs.set(d.id, { session, timer });
        await ctx.audit.record({
          action: 'PH_CALIBRATION_STARTED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: d.id,
          details: { device: d.code, points: settings.pointCount, limitsVersion: inForce.version, requireStable: settings.requireStable, warningsAcknowledged: warnings.length },
        });
        return session.view();
      },
    });

    const ownRun = (req: ModuleRequest, deviceId: string) => {
      const run = runs.get(deviceId);
      if (!run) throw new ModuleError(409, 'No calibration is in progress on this instrument.');
      if (run.session.config.startedById !== req.principal.userId) throw new ModuleError(403, `This calibration was started by ${run.session.config.startedByName}.`);
      return run;
    };

    /** Measure one buffer, or repeat it. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/guided-calibration/measure',
      permission: 'calibration.perform',
      async handler(req) {
        const d = await device(req);
        const run = ownRun(req, d.id);
        const slot = Number((req.body as { slot?: unknown } | undefined)?.slot);
        await sessionStep(() => run.session.measure(slot));
        return run.session.view();
      },
    });

    /** Abandon a run. Anyone who may calibrate can, so a forgotten run cannot block the instrument. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/guided-calibration/reset',
      permission: 'calibration.perform',
      async handler(req) {
        const d = await device(req);
        const run = runs.get(d.id);
        if (!run) throw new ModuleError(409, 'No calibration is in progress on this instrument.');
        const sent = await ctx.gateway.send(d, phCommands.calibrationReset());
        endRun(d.id);
        await ctx.db.transaction(req.principal, 'Calibration abandoned', req.origin, (tx) => tx.query('UPDATE ph_instrument_probes SET interrupted_runs = interrupted_runs + 1 WHERE device_id = $1', [d.id]));
        await ctx.audit.record({
          action: 'PH_CALIBRATION_RESET',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: d.id,
          reason: sent.sent ? null : `The meter was not told: ${sent.reason}`,
          details: { device: d.code, startedBy: run.session.config.startedByName, meterReset: sent.sent },
        });
        return { reset: true, meterReset: sent.sent };
      },
    });

    /** Save a finished run as a draft calibration, then the core workflow takes over. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/guided-calibration/save',
      permission: 'calibration.perform',
      async handler(req) {
        const d = await device(req);
        const { session } = ownRun(req, d.id);
        const problem = session.saveProblem();
        if (problem) throw new ModuleError(409, problem);
        const body = (req.body ?? {}) as { remarks?: unknown };
        const remarks = typeof body.remarks === 'string' ? body.remarks.trim().slice(0, 2000) : '';
        const buffer = parseBufferDetails(body);
        if (buffer.problems.length) throw new ModuleError(400, buffer.problems.join(' '), 'buffer');
        const dataSource: CalibrationInput['dataSource'] = session.simulated ? 'SIMULATED' : 'INSTRUMENT';
        if (dataSource === 'SIMULATED' && ctx.production) throw new ModuleError(409, 'Simulated data cannot be used.');
        const saved = await ctx.gateway.send(d, phCommands.calibrationSave());
        if (!saved.sent) {
          await raiseAlert(d, { code: 'PH-CAL-DEVICE-SAVE-NOT-SENT', severity: 'WARNING', message: `The meter could not be told to keep the calibration: ${saved.reason}` });
          throw new ModuleError(409, `The meter could not be told to keep this calibration: ${saved.reason}`);
        }

        // One at a time, in arrival order: a packet used twice must be stored once.
        const stored = new Set(session.messageIds());
        const sources = session.points.flatMap((p) => (p.source ? [p.source] : [])).sort((a, b) => a.at - b.at);
        for (const h of sources) stored.add(await persistHeld(d, h));
        const sourceMessages = [...stored].sort((a, b) => a - b);

        const e = session.evaluate();
        const { limits, limitsVersion, preChecks, settings } = session.config;
        const { outcome: fitOutcome, ...results } = e.result;
        const created = await ctx.calibrations
          .record(
          req.principal,
          d.id,
          {
            temperatureC: e.temperatureC,
            readings: e.readings,
            limits: { ...limits, version: limitsVersion },
            results: {
              ...results,
              fitOutcome,
              guided: true,
              probe: session.config.probe,
              bufferLot: buffer.lot,
              bufferExpiry: buffer.expiry,
              points: session.view().points,
              deviations: e.points,
              preChecks,
              requireStable: settings.requireStable,
              deviceReported: { slope: session.deviceSlope, offset: session.deviceOffset },
            },
            display: [
              ...display(e.result, e.temperatureC),
              { label: 'Largest deviation', value: `${Math.max(...e.points.map((p) => p.deviation ?? 0)).toFixed(3)} pH` },
              { label: 'Acceptance limits', value: limitsVersion === null ? 'Built-in defaults' : `Version ${limitsVersion}` },
            ],
            outcome: e.outcome,
            remarks,
            dataSource,
            sourceMessages,
          },
          req.origin,
          )
          .catch(async (err: Error) => {
            await raiseAlert(d, { code: 'PH-CAL-SAVE-FAILED', severity: 'CRITICAL', message: `The calibration could not be saved: ${err.message}` });
            throw err;
          });
        const unstablePoints = session.points.filter((p) => p.stable === false).length;
        for (const a of postCalibrationAlerts({ result: e.result, outcome: e.outcome, unstablePoints })) await raiseAlert(d, a, { calibration: created.code });
        if (bufferExpired(buffer.expiry, new Date()))
          await raiseAlert(d, { code: 'PH-CAL-BUFFER-EXPIRED', severity: 'WARNING', message: `Calibration ${created.code} used a buffer that expired on ${buffer.expiry}.` }, { calibration: created.code });
        endRun(d.id);
        const s = live.get(d.id);
        if (s) s.calibration = { mv: {}, fields: {}, at: 0, messageIds: new Set() };
        await ctx.audit.record({
          action: 'PH_CALIBRATION_CAPTURED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: created.calibrationId,
          details: { code: created.code, device: d.code, dataSource, outcome: e.outcome, limitsVersion, guided: true, sourceMessages: sourceMessages.join(',') },
        });
        return { ...created, outcome: e.outcome, dataSource };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments/:id/logging',
      permission: 'ph.view',
      passive: true,
      async handler(req) {
        const d = await device(req);
        return { run: logRunView(logRuns.get(d.id)), calibrating: runs.has(d.id) };
      },
    });

    /** Log the current reading by hand. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/logs',
      permission: 'ph.measure',
      async handler(req) {
        const d = await device(req);
        if (logRuns.has(d.id)) throw new ModuleError(409, 'Automatic logging is running on this instrument.');
        const { details, problems } = parseLogDetails(req.body);
        if (problems.length) throw new ModuleError(400, problems.join(' '), 'details');
        const problem = await writeLog(d, 'MANUAL', details, req.principal, req.origin);
        if (problem) throw new ModuleError(409, problem);
        return { logged: true };
      },
    });

    /** Start automatic logging; it runs here until stopped, so a closed browser does not end it. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/logging/start',
      permission: 'ph.measure',
      async handler(req) {
        const d = await device(req);
        const body = (req.body ?? {}) as { mode?: unknown; intervalSeconds?: unknown };
        const mode = body.mode as LogMode;
        if (mode !== 'STABLE' && mode !== 'BUTTON' && mode !== 'INTERVAL') throw new ModuleError(400, 'Choose how to log.', 'mode');
        const intervalSeconds = mode === 'INTERVAL' ? Number(body.intervalSeconds) : null;
        if (intervalSeconds !== null && (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_LOG_INTERVAL_S || intervalSeconds > MAX_LOG_INTERVAL_S))
          throw new ModuleError(400, `The interval must be ${MIN_LOG_INTERVAL_S} to ${MAX_LOG_INTERVAL_S} whole seconds.`, 'intervalSeconds');
        const { details, problems } = parseLogDetails(body);
        if (problems.length) throw new ModuleError(400, problems.join(' '), 'details');
        if (!d.readiness.usable) throw new ModuleError(409, `${d.code} cannot be used: ${d.readiness.message}`);
        if (logRuns.has(d.id)) throw new ModuleError(409, 'Automatic logging is already running on this instrument.');
        if (runs.has(d.id)) throw new ModuleError(409, 'A calibration is in progress on this instrument.');

        const command = mode === 'STABLE' ? phCommands.logOnStable() : mode === 'BUTTON' ? phCommands.logOnDeviceButton() : phCommands.logEveryMinutes(intervalSeconds! / 60);
        const sent = await ctx.gateway.send(d, command);
        if (!sent.sent) throw new ModuleError(409, sent.reason);
        const run: LogRun = { mode, intervalSeconds, details, principal: req.principal, origin: req.origin, startedAt: Date.now(), count: 0, skipped: 0, lastProblem: null, lastRaw: null, lastTriggerAt: 0, writing: false, timer: null };
        if (intervalSeconds !== null) {
          run.timer = setInterval(() => void logFromRun(d, run, 'INTERVAL'), intervalSeconds * 1000);
          run.timer.unref();
        }
        logRuns.set(d.id, run);
        await ctx.audit.record({ action: 'PH_LOGGING_STARTED', result: 'SUCCESS', principal: req.principal, recordId: d.id, details: { device: d.code, mode, intervalSeconds } });
        return logRunView(run);
      },
    });

    /** Anyone who may log can stop it, so a forgotten run cannot be left going. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/logging/stop',
      permission: 'ph.measure',
      async handler(req) {
        const d = await device(req);
        if (!logRuns.has(d.id)) throw new ModuleError(409, 'Automatic logging is not running on this instrument.');
        await stopLogRun(d, null, req.principal);
        return { stopped: true };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/logs',
      permission: 'ph.view',
      async handler(req) {
        const { where, params } = logFilter(req.query);
        const pageSize = [10, 25, 50, 100].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 25;
        const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
        const [rows, [count]] = await Promise.all([
          ctx.db.query<LogRow>(`SELECT * FROM ph_log_entries WHERE ${where} ORDER BY id DESC LIMIT $6 OFFSET $7`, [...params, pageSize, (page - 1) * pageSize]),
          ctx.db.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM ph_log_entries WHERE ${where}`, params),
        ]);
        return { rows: rows.map(logView), total: count.total, page, pageSize };
      },
    });

    /** The selected entries as CSV, oldest first. The export is recorded with the file's SHA-256. */
    ctx.http.route({
      method: 'GET',
      path: '/logs/export',
      permission: 'ph.view',
      async handler(req) {
        const { where, params } = logFilter(req.query);
        const pdf = req.query.format === 'pdf';
        const limit = pdf ? REPORT_LOG_MAX_ROWS : LOG_EXPORT_MAX_ROWS;
        const rows = await ctx.db.query<LogRow>(`SELECT * FROM ph_log_entries WHERE ${where} ORDER BY id LIMIT $6`, [...params, limit + 1]);
        if (rows.length > limit) throw new ModuleError(409, `This selection has more than ${limit} entries. Narrow the filters${pdf ? ' or export CSV' : ''}.`);
        if (pdf)
          return pdfFile(
            req,
            {
              title: 'pH Log Report',
              banner: rows.some((r) => r.data_source === 'SIMULATED') ? 'CONTAINS SIMULATED DATA: NOT FOR REGULATED USE' : null,
              summary: [
                { label: 'Generated by', value: `${req.principal.fullName}, ${utcText(new Date().toISOString())}` },
                { label: 'Entries', value: String(rows.length) },
                { label: 'Filters', value: [req.query.search && `Search: ${req.query.search}`, req.query.method && `Method: ${LOG_METHOD_LABEL[req.query.method as LogMethod]}`, req.query.from && `From: ${req.query.from}`, req.query.to && `Before: ${req.query.to}`].filter(Boolean).join('; ') || 'None' },
              ],
              note: 'Times are UTC, oldest entry first. The SHA-256 of this file is recorded in the audit trail.',
              sections: [
                {
                  columns: [
                    { title: 'Entry', weight: 40 }, { title: 'Instrument', weight: 75 }, { title: 'Time (UTC)', weight: 105 }, { title: 'Method', weight: 70 },
                    { title: 'pH', weight: 45 }, { title: 'mV', weight: 55 }, { title: '°C', weight: 45 }, { title: 'Stable', weight: 40 },
                    { title: 'Product', weight: 100 }, { title: 'Batch', weight: 70 }, { title: 'AR number', weight: 70 }, { title: 'Operator', weight: 95 },
                  ],
                  rows: rows.map((r) => ({
                    cells: [r.id, r.device_code, utcText(r.logged_at.toISOString()).replace(' UTC', ''), LOG_METHOD_LABEL[r.method], Number(r.ph).toFixed(2), Number(r.mv).toFixed(2), Number(r.temperature_c).toFixed(1), r.stable ? 'Yes' : 'No', r.product || '—', r.batch || '—', r.ar_number || '—', r.logged_by_name],
                  })),
                  empty: 'No log entries match.',
                },
              ],
            },
            'PH_LOGS_EXPORTED',
            'nxgen-ph-logs',
            { rows: rows.length },
          );
        const header = ['Entry', 'Instrument', 'Time (UTC)', 'Method', 'pH', 'mV', 'Temperature (C)', 'Stable', 'Product', 'Batch', 'AR number', 'Operator', 'Data source', 'Original packet'];
        const lines = [header.join(',')];
        for (const r of rows)
          lines.push(
            [Number(r.id), r.device_code, r.logged_at.toISOString(), LOG_METHOD_LABEL[r.method], Number(r.ph), Number(r.mv), Number(r.temperature_c), r.stable ? 'Yes' : 'No', r.product, r.batch, r.ar_number, r.logged_by_name, r.data_source, Number(r.source_message)]
              .map(csvCell)
              .join(','),
          );
        const data = Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
        await ctx.audit.record({
          action: 'PH_LOGS_EXPORTED',
          result: 'SUCCESS',
          principal: req.principal,
          details: { format: 'CSV', rows: rows.length, sha256: createHash('sha256').update(data).digest('hex') },
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return { kind: 'file', contentType: 'text/csv; charset=utf-8', data, fileName: `nxgen-ph-logs-${stamp}.csv` };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments/:id/alarm',
      permission: 'ph.view',
      passive: true,
      async handler(req) {
        const d = await device(req);
        const alarm = await alarmFor(d.id);
        return { alarm: alarm && { minPh: alarm.minPh, maxPh: alarm.maxPh, monitoring: alarm.monitoring, active: alarm.active } };
      },
    });

    const saveAlarm = async (req: ModuleRequest, d: DeviceInfo, minPh: number, maxPh: number, monitoring: boolean, reason: string) => {
      await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
        const [existing] = await tx.query('SELECT 1 FROM ph_alarm_settings WHERE device_id = $1', [d.id]);
        await tx.query(
          existing
            ? 'UPDATE ph_alarm_settings SET min_ph = $2, max_ph = $3, monitoring = $4 WHERE device_id = $1'
            : 'INSERT INTO ph_alarm_settings (device_id, min_ph, max_ph, monitoring) VALUES ($1, $2, $3, $4)',
          [d.id, minPh, maxPh, monitoring],
        );
      });
    };

    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/alarm/start',
      permission: 'ph.measure',
      async handler(req) {
        const d = await device(req);
        const { minPh, maxPh } = (req.body ?? {}) as { minPh?: unknown; maxPh?: unknown };
        const problem = validateAlarmRange(minPh, maxPh);
        if (problem) throw new ModuleError(400, problem, 'range');
        if ((await alarmFor(d.id))?.monitoring) throw new ModuleError(409, 'Monitoring is already on. Stop it to change the range.');
        await saveAlarm(req, d, minPh as number, maxPh as number, true, 'pH alarm monitoring started');
        alarms.set(d.id, { minPh: minPh as number, maxPh: maxPh as number, monitoring: true, active: false });
        const s = live.get(d.id);
        if (s && Date.now() - s.lastSeenAt < STALE_MS && 'PH_VAL' in s.values) await evaluateAlarm(d, s.values.PH_VAL);
        return { monitoring: true };
      },
    });

    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/alarm/stop',
      permission: 'ph.measure',
      async handler(req) {
        const d = await device(req);
        const a = await alarmFor(d.id);
        if (!a?.monitoring) throw new ModuleError(409, 'Monitoring is not on.');
        await saveAlarm(req, d, a.minPh, a.maxPh, false, 'pH alarm monitoring stopped');
        a.monitoring = false;
        a.active = false;
        await resolveAlert(d, ALARM_BREACH, 'Monitoring was stopped.', req.principal);
        return { monitoring: false };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments/:id/trend',
      permission: 'ph.view',
      passive: true,
      async handler(req) {
        const d = await device(req);
        const windowMinutes = Number(req.query.windowMinutes ?? 10);
        const sampleSeconds = Number(req.query.sampleSeconds ?? 5);
        if (!TREND_WINDOWS.includes(windowMinutes)) throw new ModuleError(400, 'Choose 10, 30 or 60 minutes.', 'windowMinutes');
        if (!TREND_SAMPLES.includes(sampleSeconds)) throw new ModuleError(400, 'Choose a listed sample interval.', 'sampleSeconds');
        const s = live.get(d.id);
        const now = Date.now();
        const alarm = await alarmFor(d.id);
        return {
          now,
          points: sampleTrend(s?.trend ?? [], now, windowMinutes, sampleSeconds),
          simulated: s?.transport === 'SIMULATOR',
          alarm: alarm?.monitoring ? { minPh: alarm.minPh, maxPh: alarm.maxPh } : null,
        };
      },
    });

    const alertView = (r: Record<string, unknown>) => ({
      id: Number(r.id),
      deviceId: r.device_id,
      deviceCode: r.device_code,
      code: r.code,
      severity: r.severity,
      message: r.message,
      status: r.status,
      raisedAt: (r.raised_at as Date).toISOString(),
      acknowledgedBy: r.acknowledged_by,
      acknowledgedAt: r.acknowledged_at ? (r.acknowledged_at as Date).toISOString() : null,
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : null,
      resolution: r.resolution,
    });

    ctx.http.route({
      method: 'GET',
      path: '/alerts',
      permission: 'ph.view',
      async handler(req) {
        const status = req.query.status === 'OPEN' || req.query.status === 'ACKNOWLEDGED' || req.query.status === 'RESOLVED' ? req.query.status : null;
        if (req.query.device && !UUID.test(req.query.device)) throw new ModuleError(400, 'Invalid instrument.', 'device');
        const deviceFilter = req.query.device || null;
        const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
        const [rows, [count]] = await Promise.all([
          ctx.db.query<Record<string, unknown>>('SELECT * FROM ph_alerts WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR device_id = $2) ORDER BY id DESC LIMIT 50 OFFSET $3', [status, deviceFilter, (page - 1) * 50]),
          ctx.db.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM ph_alerts WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR device_id = $2)', [status, deviceFilter]),
        ]);
        return { rows: rows.map(alertView), total: count.total, page };
      },
    });

    /** Breaches nobody has acknowledged yet: the alarm every pH screen shows. */
    ctx.http.route({
      method: 'GET',
      path: '/alerts/active',
      permission: 'ph.view',
      passive: true,
      async handler() {
        const rows = await ctx.db.query<Record<string, unknown>>("SELECT * FROM ph_alerts WHERE code = $1 AND status = 'OPEN' ORDER BY id", [ALARM_BREACH]);
        return rows.map(alertView);
      },
    });

    ctx.http.route({
      method: 'POST',
      path: '/alerts/:id/acknowledge',
      permission: 'ph.measure',
      async handler(req) {
        const rows = await ctx.db.query<Record<string, unknown>>(
          "UPDATE ph_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'OPEN' RETURNING *",
          [Number(req.params.id), req.principal.fullName],
        );
        if (!rows.length) throw new ModuleError(409, 'This alert is not open.');
        await ctx.audit.record({ action: 'PH_ALERT_ACKNOWLEDGED', result: 'INFO', principal: req.principal, recordId: String(rows[0].device_id), details: { device: String(rows[0].device_code), code: String(rows[0].code) } });
        return alertView(rows[0]);
      },
    });

    /** Close an alert by hand, with a reason. A range alarm closes itself when the reading returns. */
    ctx.http.route({
      method: 'POST',
      path: '/alerts/:id/resolve',
      permission: 'ph.measure',
      async handler(req) {
        const comment = (req.body as { comment?: unknown } | undefined)?.comment;
        const resolution = typeof comment === 'string' ? comment.trim() : '';
        if (resolution.length < 10 || resolution.length > 1000) throw new ModuleError(400, 'Enter what was done (10 to 1000 characters).', 'comment');
        const [alert] = await ctx.db.query<{ device_id: string; code: string; status: string }>('SELECT device_id, code, status FROM ph_alerts WHERE id = $1', [Number(req.params.id)]);
        if (!alert) throw new ModuleError(404, 'Alert not found.');
        if (alert.status === 'RESOLVED') throw new ModuleError(409, 'This alert is already resolved.');
        if (alert.code === ALARM_BREACH) throw new ModuleError(409, 'A range alarm closes when the reading returns to range, or when monitoring is stopped.');
        const d = await ctx.devices.get(alert.device_id);
        if (!d) throw new ModuleError(404, 'Instrument not found.');
        await resolveAlert(d, alert.code, resolution, req.principal);
        return { resolved: true };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/calibrations',
      permission: 'ph.view',
      async handler(req) {
        const all = await calibrationHistory(req);
        const pageSize = [10, 25, 50, 100].includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 25;
        const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
        return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/calibrations/export',
      permission: 'ph.view',
      async handler(req) {
        const rows = (await calibrationHistory(req)).reverse();
        const header = ['Report ID', 'Instrument', 'Performed (UTC)', 'Performed by', 'Result', 'Status', 'Slope (%)', 'Offset (mV)', 'Temperature (C)', 'Limits version', 'Data source'];
        const lines = [header.join(',')];
        for (const r of rows)
          lines.push(
            [r.code, r.deviceCode, r.performedAt, r.performedBy, r.outcome, STATE_TEXT[r.state] ?? r.state, r.slopePercent ?? '', r.offsetMv ?? '', r.temperatureC ?? '', r.limitsVersion ?? 'Built-in', r.dataSource].map(csvCell).join(','),
          );
        const data = Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
        await ctx.audit.record({ action: 'PH_CALIBRATIONS_EXPORTED', result: 'SUCCESS', principal: req.principal, details: { format: 'CSV', rows: rows.length, sha256: createHash('sha256').update(data).digest('hex') } });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        return { kind: 'file', contentType: 'text/csv; charset=utf-8', data, fileName: `nxgen-ph-calibrations-${stamp}.csv` };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments/:id/calibrations/:calibrationId/report',
      permission: 'ph.view',
      async handler(req) {
        const d = await device(req);
        const c = (await ctx.calibrations.forDevice(req.principal, d.id)).find((x) => x.id === req.params.calibrationId);
        if (!c) throw new ModuleError(404, 'Calibration not found.');
        return pdfFile(req, calibrationReport(c, d, req.principal.fullName), 'PH_CALIBRATION_REPORT_EXPORTED', `nxgen-${c.code}`, { code: c.code, state: c.workflow.state }, c.id);
      },
    });

    /** Thermistor type and ATC reference temperature, written to the meter. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/meter-settings',
      permission: 'ph.limits',
      async handler(req) {
        const d = await device(req);
        if (runs.has(d.id)) throw new ModuleError(409, 'A calibration is in progress on this instrument.');
        const { thermistor, atcReferenceC, problems } = parseMeterSettings(req.body);
        if (problems.length) throw new ModuleError(400, problems.join(' '), 'settings');
        const commands = [...(thermistor ? [phCommands.thermistor(thermistor)] : []), ...(atcReferenceC === null ? [] : [phCommands.atcReference(atcReferenceC)])];
        for (const command of commands) {
          const result = await ctx.gateway.send(d, command);
          await ctx.audit.record({
            action: 'PH_METER_SETTING_SENT',
            result: result.sent ? 'SUCCESS' : 'FAILURE',
            principal: req.principal,
            recordId: d.id,
            reason: result.sent ? null : result.reason,
            details: { device: d.code, setting: Object.keys(command)[0], value: String(Object.values(command)[0]) },
          });
          if (!result.sent) throw new ModuleError(409, result.reason);
        }
        return { sent: commands.length };
      },
    });

    const probeView = (r: Record<string, unknown>) => ({
      id: r.id,
      code: r.probe_code,
      type: r.probe_type,
      name: r.display_name,
      status: r.status,
      statusReason: r.status_reason,
      createdAt: (r.created_at as Date).toISOString(),
      deviceId: r.device_id ?? null,
      temperatureSensorId: r.temperature_sensor_id ?? null,
    });
    const probeRows = () =>
      ctx.db.query<Record<string, unknown>>(
        'SELECT p.*, a.device_id, a.temperature_sensor_id FROM ph_probes p LEFT JOIN ph_instrument_probes a ON a.probe_id = p.id ORDER BY p.probe_code',
      );
    const changeReason = (body: unknown) => {
      const reason = typeof (body as { reason?: unknown } | undefined)?.reason === 'string' ? ((body as { reason: string }).reason.trim()) : '';
      if (reason.length < 10 || reason.length > 1000) throw new ModuleError(400, 'Enter the reason for this change (10 to 1000 characters).', 'reason');
      return reason;
    };
    const shortText = (v: unknown, max: number, label: string, required = false) => {
      const text = typeof v === 'string' ? v.trim() : '';
      if (text.length > max || (required && !text)) throw new ModuleError(400, `${label} ${required ? 'is required and ' : ''}can be at most ${max} characters.`, label);
      return text;
    };

    ctx.http.route({
      method: 'GET',
      path: '/probes',
      permission: 'ph.view',
      async handler() {
        const devices = await ctx.devices.list('PH');
        return (await probeRows()).map((r) => ({ ...probeView(r), deviceCode: devices.find((d) => d.id === r.device_id)?.code ?? null }));
      },
    });

    ctx.http.route({
      method: 'POST',
      path: '/probes',
      permission: 'ph.probes',
      async handler(req) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const reason = changeReason(b);
        const code = shortText(b.code, 60, 'Probe ID', true);
        const type = shortText(b.type, 80, 'Probe type');
        const name = shortText(b.name, 120, 'Name');
        if ((await probeRows()).some((r) => r.probe_code === code)) throw new ModuleError(409, `Probe ${code} is already registered.`, 'code');
        const id = await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          const [row] = await tx.query<{ id: string }>('INSERT INTO ph_probes (probe_code, probe_type, display_name) VALUES ($1, $2, $3) RETURNING id', [code, type, name]);
          return row.id;
        });
        return { id };
      },
    });

    ctx.http.route({
      method: 'PUT',
      path: '/probes/:id',
      permission: 'ph.probes',
      async handler(req) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const reason = changeReason(b);
        const status = b.status as ProbeStatus;
        if (!PROBE_STATUSES.includes(status)) throw new ModuleError(400, 'Choose a status.', 'status');
        const row = (await probeRows()).find((r) => r.id === req.params.id);
        if (!row) throw new ModuleError(404, 'Probe not found.');
        if (row.status === 'RETIRED' && status !== 'RETIRED') throw new ModuleError(409, 'A retired probe cannot return to service.');
        if (status === 'RETIRED' && row.device_id) throw new ModuleError(409, 'Assign another probe to its instrument first.');
        await ctx.db.transaction(req.principal, reason, req.origin, (tx) =>
          tx.query('UPDATE ph_probes SET probe_type = $2, display_name = $3, status = $4, status_reason = $5 WHERE id = $1', [row.id, shortText(b.type, 80, 'Probe type'), shortText(b.name, 120, 'Name'), status, status === row.status ? row.status_reason : reason]),
        );
        return { id: row.id };
      },
    });

    /** Fit a probe to an instrument. Its history follows the probe, not the instrument. */
    ctx.http.route({
      method: 'PUT',
      path: '/instruments/:id/probe',
      permission: 'ph.probes',
      async handler(req) {
        const d = await device(req);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const reason = changeReason(b);
        const sensor = shortText(b.temperatureSensorId, 60, 'Temperature sensor ID', true);
        if (runs.has(d.id)) throw new ModuleError(409, 'A calibration is in progress on this instrument.');
        const row = (await probeRows()).find((r) => r.id === b.probeId);
        if (!row) throw new ModuleError(404, 'Probe not found.');
        if (row.status !== 'ACTIVE') throw new ModuleError(409, `Probe ${String(row.probe_code)} is ${String(row.status).toLowerCase()}.`);
        if (row.device_id && row.device_id !== d.id) throw new ModuleError(409, `Probe ${String(row.probe_code)} is assigned to another instrument.`);
        await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          const [existing] = await tx.query('SELECT 1 FROM ph_instrument_probes WHERE device_id = $1', [d.id]);
          await tx.query(
            existing
              ? 'UPDATE ph_instrument_probes SET probe_id = $2, temperature_sensor_id = $3, interrupted_runs = 0 WHERE device_id = $1'
              : 'INSERT INTO ph_instrument_probes (device_id, probe_id, temperature_sensor_id) VALUES ($1, $2, $3)',
            [d.id, row.id, sensor],
          );
        });
        return { assigned: true };
      },
    });

    // Saved product, batch and AR-number lists (the app's "Add List" on the Logs tab).
    const sampleLists = () => ctx.db.query<{ id: string; kind: SampleListKind; value: string }>('SELECT id, kind, value FROM ph_sample_lists WHERE NOT is_deleted ORDER BY kind, lower(value)');

    ctx.http.route({ method: 'GET', path: '/sample-lists', permission: 'ph.view', handler: () => sampleLists() });

    ctx.http.route({
      method: 'POST',
      path: '/sample-lists',
      permission: 'ph.measure',
      async handler(req) {
        const parsed = parseSampleListEntry(req.body);
        if ('problem' in parsed) throw new ModuleError(400, parsed.problem, 'value');
        if ((await sampleLists()).some((r) => r.kind === parsed.kind && r.value.toLowerCase() === parsed.value.toLowerCase())) throw new ModuleError(409, `${parsed.value} is already in the list.`, 'value');
        const id = await ctx.db.transaction(req.principal, null, req.origin, async (tx) => {
          const [row] = await tx.query<{ id: string }>('INSERT INTO ph_sample_lists (kind, value) VALUES ($1, $2) RETURNING id', [parsed.kind, parsed.value]);
          return row.id;
        });
        return { id };
      },
    });

    /** Removing an entry only hides it from the pickers; readings that used it keep their text. */
    ctx.http.route({
      method: 'POST',
      path: '/sample-lists/:id/remove',
      permission: 'ph.measure',
      async handler(req) {
        const reason = changeReason(req.body);
        if (!UUID.test(req.params.id)) throw new ModuleError(404, 'List entry not found.');
        const removed = await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          const rows = await tx.query<{ id: string }>('UPDATE ph_sample_lists SET is_deleted = true WHERE id = $1 AND NOT is_deleted RETURNING id', [req.params.id]);
          return rows.length > 0;
        });
        if (!removed) throw new ModuleError(404, 'List entry not found.');
        return { removed: true };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/instruments/:id/probe-health',
      permission: 'ph.view',
      passive: true,
      async handler(req) {
        const d = await device(req);
        const fitted = await instrumentProbe(d.id);
        const inForce = await limitsInForce();
        const s = live.get(d.id);
        const now = Date.now();
        let calibrations: ProbeCalibration[] = [];
        if (fitted) {
          const records = await ctx.calibrations.forDevice(req.principal, d.id);
          calibrations = records
            .filter((c) => c.workflow.state !== 'INVALIDATED' && (c.results.probe as { id?: string } | null | undefined)?.id === fitted.probe_id)
            .map((c) => {
              const deviations = (c.results.deviations ?? []) as { deviation: number | null }[];
              return {
                outcome: c.outcome,
                slopePercent: typeof c.results.slopePercent === 'number' ? c.results.slopePercent : null,
                offsetMv: typeof c.results.offsetMv === 'number' ? c.results.offsetMv : null,
                largestDeviation: deviations.length ? Math.max(...deviations.map((x) => x.deviation ?? 0)) : null,
              };
            });
        }
        const health = evaluateProbeHealth({
          assigned: !!fitted,
          probeStatus: fitted?.status ?? null,
          connected: s?.values.PROBE_CONNECTED,
          dueState: d.readiness.state,
          limits: inForce.limits,
          calibrations,
          interruptions: fitted?.interrupted_runs ?? 0,
          responseAgeSeconds: s ? Math.max(0, Math.round((now - s.lastSeenAt) / 1000)) : null,
          ageHours: fitted ? Math.max(0, Math.floor((now - fitted.created_at.getTime()) / 3_600_000)) : 0,
        });
        return {
          probe: fitted && { id: fitted.probe_id, code: fitted.probe_code, type: fitted.probe_type, name: fitted.display_name, status: fitted.status, temperatureSensorId: fitted.temperature_sensor_id },
          health,
          latest: calibrations[0] ?? null,
        };
      },
    });

    /** Switch the meter's automatic temperature compensation. The meter confirms by reporting ATC. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/atc',
      permission: 'ph.measure',
      async handler(req) {
        const d = await device(req);
        const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
        if (typeof enabled !== 'boolean') throw new ModuleError(400, 'Say whether ATC should be on or off.', 'enabled');
        const result = await ctx.gateway.send(d, phCommands.atc(enabled));
        await ctx.audit.record({
          action: 'PH_ATC_COMMAND',
          result: result.sent ? 'SUCCESS' : 'FAILURE',
          principal: req.principal,
          recordId: d.id,
          reason: result.sent ? null : result.reason,
          details: { device: d.code, atc: enabled ? 'ON' : 'OFF' },
        });
        if (!result.sent) throw new ModuleError(409, result.reason);
        return { sent: true };
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
        // One at a time, in arrival order: a packet used twice must be stored once.
        const stored = new Set<number>();
        for (const h of [...used].sort((a, b) => a.at - b.at)) stored.add(await persistHeld(d, h));
        const sourceMessages = [...stored].sort((a, b) => a - b);
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
        const inForce = await limitsInForce();
        const body = (req.body ?? {}) as { source?: string; temperatureC?: unknown; readings?: unknown; remarks?: unknown };
        const remarks = typeof body.remarks === 'string' ? body.remarks.trim().slice(0, 2000) : '';
        let readings: PhReading[];
        let temperatureC: number | null;
        let dataSource: CalibrationInput['dataSource'] = 'MANUAL';
        let sourceMessages: number[] = [];
        const extra: Record<string, unknown> = {};

        if (body.source === 'INSTRUMENT') {
          const s = live.get(d.id);
          const cal = await instrumentCalibration(d, inForce.limits);
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
        const result = computePh(readings, temperatureC!, inForce.limits);
        const { outcome, ...results } = result;
        const created = await ctx.calibrations.record(
          req.principal,
          d.id,
          {
            temperatureC,
            readings,
            limits: { ...inForce.limits, version: inForce.version },
            results: { ...results, ...extra },
            display: [...display(result, temperatureC!), { label: 'Acceptance limits', value: inForce.version === null ? 'Built-in defaults' : `Version ${inForce.version}` }],
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
          details: { code: created.code, device: d.code, dataSource, outcome, limitsVersion: inForce.version, sourceMessages: sourceMessages.join(',') },
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
    for (const id of [...runs.keys()]) endRun(id);
    for (const run of logRuns.values()) if (run.timer) clearInterval(run.timer);
    logRuns.clear();
    alarms.clear();
    live.clear();
  },
};

export default PhModule;
export const register = PhModule.register;
export const healthCheck = PhModule.healthCheck;
export const unload = PhModule.unload;
