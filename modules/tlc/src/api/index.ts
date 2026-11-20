import { createHash } from 'crypto';
import type { DeviceInfo, ModuleContext, ModuleFileResponse, ModuleRequest, ModuleTx, NxGenModule } from '@crescent/module-sdk';
import { ModuleError } from '@crescent/module-sdk';
import { autoRetakeEv, Channel, PlateGeometry, Point, PostProcessing, RgbImage, validatePostProcessing } from '../engine';
import { applyCameraAdjustment, cameraParametersOf, CameraDefaults, CameraSettingsInput, DEFAULT_CAMERA_DEFAULTS, parseCameraDefaults, withCameraDefaults, DEFAULT_CAMERA, evaluate, ILLUMINATIONS, Illumination, imageType, parseCameraSettings, parseRfWindows, RfWindow, TrackInput, validatePlate } from '../shared/tlc';
import { decodeImage, encodePng, pixelBytes } from './images';
import {
  ENGINE_VERSION,
  EvaluationInput,
  EvaluationResults,
  ImageQc,
  analyticalGray,
  autoLayout,
  computeEvaluation,
  evaluationContent,
  imageQc,
  makePlate,
  parseEvaluationInput,
  parsePlateSpec,
  sha256,
  suggestOutline,
  verifyPlate,
} from './pipeline';

/** Below this the quality gate has nothing to judge (and the tablet never captures such images). */
const MIN_QC_SIDE = 64;

const TABLE = 'tlc_analyses';
const WORKFLOW = 'TLC_ANALYSIS_APPROVAL';
const MAX_IMAGE = 15 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * In-memory cache of image bytes that never change once stored: raw images, straightened plates
 * (both append-only and SHA-256-checked when first read) and the analytical views rendered from
 * them. Saves a multi-megabyte database read (seconds on a hosted database) for every view of a
 * plate. Least recently used entries go first above 256 MB; entries are re-read and re-checked
 * against their SHA-256 after 15 minutes.
 */
interface CachedFile {
  contentType: string;
  data: Buffer;
  fileName: string;
  meta?: unknown;
}
const imageCache = (() => {
  const LIMIT_BYTES = 256 * 1024 * 1024;
  const MAX_AGE_MS = 15 * 60 * 1000;
  const entries = new Map<string, { file: CachedFile; at: number }>();
  let bytes = 0;
  const drop = (key: string) => {
    const e = entries.get(key);
    if (e) {
      bytes -= e.file.data.length;
      entries.delete(key);
    }
  };
  return {
    get(key: string): CachedFile | undefined {
      const e = entries.get(key);
      if (!e) return undefined;
      if (Date.now() - e.at > MAX_AGE_MS) {
        drop(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, e);
      return e.file;
    },
    set(key: string, file: CachedFile): void {
      if (file.data.length > LIMIT_BYTES / 4) return;
      drop(key);
      entries.set(key, { file, at: Date.now() });
      bytes += file.data.length;
      for (const k of entries.keys()) {
        if (bytes <= LIMIT_BYTES) break;
        drop(k);
      }
    },
    clear(): void {
      entries.clear();
      bytes = 0;
    },
  };
})();

interface AnalysisRow {
  id: string;
  code: string;
  /** Null until the analyst chooses them (required before submitting). */
  device_id: string | null;
  method_id: string | null;
  method_version_id: string | null;
  method_code: string | null;
  method_version: number | null;
  method_name: string | null;
  rf_windows: RfWindow[];
  name: string;
  department: string;
  project_status: 'ACTIVE' | 'ON_HOLD' | 'COMPLETED';
  sample_id: string;
  batch: string;
  plate_type: string;
  plate_lot: string;
  stationary_phase: string;
  mobile_phase: string;
  staining: string;
  solvent_front_mm: string | null;
  tracks: TrackInput[];
  results: Record<string, unknown>;
  conclusion: string;
  remarks: string;
  analyzed_by: string;
  analyzed_by_name?: string;
  current_plate_id: string | null;
  current_evaluation_id: string | null;
  created_at: Date;
  version_no: number;
}

interface ImageMeta {
  id: string;
  illumination: Illumination;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  qc: ImageQc | null;
  source: 'UPLOAD' | 'CAMERA';
  camera: CameraRecord | null;
  uploaded_by_name: string | null;
  uploaded_at: Date;
}

/** What tlc_images.camera keeps for a captured image (migration 005). */
interface CameraRecord {
  serial: string;
  model: string | null;
  simulated: boolean;
  exposureUs: number;
  gain: number;
  whiteBalance: [number, number, number];
  pixelFormat: string;
  sourceBits: number;
  temperatureC: number | null;
  saturatedFraction: number;
  settingsFromMethod: boolean;
  attempts: { exposureUs: number; exposureEv: number | null; verdict: string }[];
  capturedAt: string;
}

interface PlateRow {
  id: string;
  analysis_id: string;
  image_id: string;
  illumination: Illumination;
  corners: Point[];
  outline_source: 'AUTO' | 'MANUAL';
  width_mm: string;
  height_mm: string;
  width_px: number;
  height_px: number;
  channel: Channel;
  post_processing: PostProcessing;
  rectified?: Buffer;
  rectified_sha256: string;
  pixels_sha256: string;
  qc_override_reason: string;
  is_current: boolean;
  created_by: string;
  created_by_name?: string;
  created_at: Date;
}

interface EvaluationRow {
  id: string;
  analysis_id: string;
  plate_id: string;
  number: number;
  code: string;
  input: EvaluationInput;
  results: EvaluationResults;
  conclusion: string;
  engine_version: string;
  content_sha256: string;
  created_by: string;
  created_by_name?: string;
  created_at: Date;
}

let ctx: ModuleContext;

const projectStatus = (v: unknown): 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' => {
  if (v === undefined || v === null || v === '') return 'ACTIVE';
  if (v === 'ACTIVE' || v === 'ON_HOLD' || v === 'COMPLETED') return v;
  throw new ModuleError(400, 'Status must be Active, On hold or Completed.', 'projectStatus');
};

const text = (v: unknown, field: string, label: string, min: number, max: number) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max)
    throw new ModuleError(400, min ? `Enter the ${label} (${min}–${max} characters).` : `${label} is too long (max ${max}).`, field);
  return s;
};

async function load(tx: Pick<ModuleTx, 'query'>, id: string): Promise<AnalysisRow> {
  if (!UUID.test(id)) throw new ModuleError(404, 'Analysis not found.');
  const [row] = await tx.query<AnalysisRow>(
    `SELECT a.*, u.full_name AS analyzed_by_name FROM tlc_analyses a LEFT JOIN users u ON u.id = a.analyzed_by
      WHERE a.id = $1 AND NOT a.is_deleted`,
    [id],
  );
  if (!row) throw new ModuleError(404, 'Analysis not found.');
  return row;
}

async function images(tx: Pick<ModuleTx, 'query'>, analysisId: string) {
  return tx.query<ImageMeta>(
    `SELECT i.id, i.illumination, i.file_name, i.content_type, i.size_bytes, i.sha256, i.qc, i.source, i.camera, i.uploaded_at, u.full_name AS uploaded_by_name
       FROM tlc_images i LEFT JOIN users u ON u.id = i.uploaded_by WHERE i.analysis_id = $1 ORDER BY i.uploaded_at`,
    [analysisId],
  );
}

const PLATE_COLUMNS = `p.id, p.analysis_id, p.image_id, p.illumination, p.corners, p.outline_source, p.width_mm, p.height_mm, p.width_px, p.height_px,
  p.channel, p.post_processing, p.rectified_sha256, p.pixels_sha256, p.qc_override_reason, p.is_current, p.created_by, p.created_at, u.full_name AS created_by_name`;

async function loadPlate(tx: Pick<ModuleTx, 'query'>, id: string | null, withData = false): Promise<PlateRow | null> {
  if (!id || !UUID.test(id)) return null;
  const [row] = await tx.query<PlateRow>(
    `SELECT ${PLATE_COLUMNS}${withData ? ', p.rectified' : ''} FROM tlc_plates p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`,
    [id],
  );
  return row ?? null;
}

async function loadEvaluation(tx: Pick<ModuleTx, 'query'>, id: string | null): Promise<EvaluationRow | null> {
  if (!id || !UUID.test(id)) return null;
  const [row] = await tx.query<EvaluationRow>('SELECT e.*, u.full_name AS created_by_name FROM tlc_evaluations e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1', [id]);
  return row ?? null;
}

const plateSpecOf = (p: PlateRow) => ({
  corners: p.corners,
  widthMm: Number(p.width_mm),
  heightMm: Number(p.height_mm),
  channel: p.channel,
  postProcessing: p.post_processing,
});

function plateView(p: PlateRow) {
  return {
    id: p.id,
    imageId: p.image_id,
    illumination: p.illumination,
    corners: p.corners,
    outlineSource: p.outline_source,
    widthMm: Number(p.width_mm),
    heightMm: Number(p.height_mm),
    widthPx: p.width_px,
    heightPx: p.height_px,
    channel: p.channel,
    postProcessing: p.post_processing,
    pixelsSha256: p.pixels_sha256,
    qcOverrideReason: p.qc_override_reason,
    isCurrent: p.is_current,
    createdBy: p.created_by_name ?? p.created_by,
    createdAt: p.created_at.toISOString(),
  };
}

const imageView = (i: ImageMeta) => ({
  id: i.id,
  illumination: i.illumination,
  fileName: i.file_name,
  contentType: i.content_type,
  sizeBytes: i.size_bytes,
  sha256: i.sha256,
  qc: i.qc,
  source: i.source,
  camera: i.camera,
  uploadedBy: i.uploaded_by_name,
  uploadedAt: i.uploaded_at.toISOString(),
});

function evaluationView(e: EvaluationRow, full: boolean) {
  const base = {
    id: e.id,
    code: e.code,
    number: e.number,
    plateId: e.plate_id,
    conclusion: e.conclusion,
    engineVersion: e.engine_version,
    contentSha256: e.content_sha256,
    createdBy: e.created_by_name ?? e.created_by,
    createdAt: e.created_at.toISOString(),
    reasons: e.results.rf.reasons,
    analyticalSaturation: e.results.analyticalSaturation,
    tracks: e.results.tracks.length,
    spots: e.results.tracks.reduce((n, t) => n + t.spots.length, 0),
  };
  return full ? { ...base, input: e.input, results: e.results } : base;
}

/** What reviewers and approvers sign: the record, the hashes of its original images, and the current plate and evaluation. */
async function content(tx: Pick<ModuleTx, 'query'>, id: string) {
  const a = await load(tx, id);
  const imgs = await images(tx, id);
  const plate = await loadPlate(tx, a.current_plate_id);
  const evaluation = await loadEvaluation(tx, a.current_evaluation_id);
  const [device] = a.device_id
    ? await tx.query<{ code: string; name: string; serial_number: string }>('SELECT code, name, serial_number FROM devices WHERE id = $1', [a.device_id])
    : [null];
  return {
    title: `${a.code} · ${a.name || a.sample_id}${a.batch ? ` (${a.batch})` : ''}`,
    content: {
      code: a.code,
      name: a.name,
      department: a.department,
      projectStatus: a.project_status,
      instrument: device,
      method: a.method_id ? { code: a.method_code, version: a.method_version, name: a.method_name, rfWindows: a.rf_windows } : null,
      sampleId: a.sample_id,
      batch: a.batch,
      plate: {
        type: a.plate_type,
        lot: a.plate_lot,
        stationaryPhase: a.stationary_phase,
        mobilePhase: a.mobile_phase,
        staining: a.staining,
        solventFrontMm: a.solvent_front_mm === null ? null : Number(a.solvent_front_mm),
      },
      tracks: a.tracks,
      results: a.results,
      conclusion: a.conclusion,
      remarks: a.remarks,
      analyzedBy: a.analyzed_by,
      images: imgs.map((i) => ({ illumination: i.illumination, fileName: i.file_name, sha256: i.sha256, sizeBytes: i.size_bytes, qcVerdict: i.qc?.verdict ?? null })),
      straightenedPlate: plate
        ? {
            imageId: plate.image_id,
            illumination: plate.illumination,
            corners: plate.corners,
            widthMm: Number(plate.width_mm),
            heightMm: Number(plate.height_mm),
            pixelsSha256: plate.pixels_sha256,
            qcOverrideReason: plate.qc_override_reason,
          }
        : null,
      evaluation: evaluation ? { code: evaluation.code, conclusion: evaluation.conclusion, engineVersion: evaluation.engine_version, contentSha256: evaluation.content_sha256 } : null,
    },
  };
}

function view(a: AnalysisRow) {
  return {
    id: a.id,
    code: a.code,
    deviceId: a.device_id,
    method: a.method_id
      ? { id: a.method_id, versionId: a.method_version_id, code: a.method_code, version: a.method_version, name: a.method_name, rfWindows: a.rf_windows }
      : null,
    name: a.name,
    department: a.department,
    projectStatus: a.project_status,
    sampleId: a.sample_id,
    batch: a.batch,
    plateType: a.plate_type,
    plateLot: a.plate_lot,
    stationaryPhase: a.stationary_phase,
    mobilePhase: a.mobile_phase,
    staining: a.staining,
    solventFrontMm: a.solvent_front_mm === null ? null : Number(a.solvent_front_mm),
    tracks: a.tracks,
    results: a.results,
    conclusion: a.conclusion,
    remarks: a.remarks,
    analyzedBy: { id: a.analyzed_by, name: a.analyzed_by_name ?? a.analyzed_by },
    currentPlateId: a.current_plate_id,
    currentEvaluationId: a.current_evaluation_id,
    createdAt: a.created_at.toISOString(),
  };
}

async function usableDevice(id: unknown): Promise<DeviceInfo> {
  const d = typeof id === 'string' ? await ctx.devices.get(id) : null;
  if (!d) throw new ModuleError(400, 'Choose a registered TLC instrument.', 'deviceId');
  if (!d.readiness.usable) throw new ModuleError(409, `${d.code} cannot be used: ${d.readiness.message}`, 'deviceId');
  return d;
}

async function approvedMethod(versionId: unknown) {
  const method = (await ctx.methods.effective('TLC')).find((m) => m.versionId === versionId);
  if (!method) throw new ModuleError(400, 'Choose an approved TLC method.', 'methodVersionId');
  const { windows, problems } = parseRfWindows(method.parameters);
  if (problems.length) throw new ModuleError(409, `The method's Rf windows cannot be used: ${problems.join(' ')}`, 'methodVersionId');
  return { method, windows };
}

function parseTracks(input: unknown): TrackInput[] {
  if (!Array.isArray(input)) throw new ModuleError(400, 'Tracks must be a list.', 'tracks');
  return input.map((t: { label?: unknown; role?: unknown; spots?: unknown }) => ({
    label: typeof t?.label === 'string' ? t.label.trim().slice(0, 40) : '',
    role: t?.role === 'STANDARD' ? 'STANDARD' : t?.role === 'SAMPLE' ? 'SAMPLE' : ('' as never),
    spots: Array.isArray(t?.spots)
      ? t.spots.map((s: { distanceMm?: unknown; compound?: unknown }) => ({
          distanceMm: Number(s?.distanceMm),
          compound: typeof s?.compound === 'string' ? s.compound.trim().slice(0, 80) : '',
        }))
      : [],
  }));
}

/** The analysis must be a draft and the caller its analyst. */
async function editable(tx: ModuleTx, req: ModuleRequest, id: string, what: string): Promise<AnalysisRow> {
  await ctx.workflow.assertEditable(tx, TABLE, id);
  const a = await load(tx, id);
  if (a.analyzed_by !== req.principal.userId) throw new ModuleError(403, `Only the analyst who created the analysis can ${what}.`);
  return a;
}

/** Camera settings from the analysis' method version (the parameters as approved). */
async function methodCamera(a: AnalysisRow): Promise<{ settings: CameraSettingsInput; problems: string[] }> {
  if (!a.method_version_id) return parseCameraSettings([]);
  const [mv] = await ctx.db.query<{ parameters: { name: string; value: string; unit: string }[] }>('SELECT parameters FROM method_versions WHERE id = $1', [a.method_version_id]);
  return parseCameraSettings(mv?.parameters ?? []);
}

interface CameraDefaultsRow {
  camera_serial: string;
  exposure_us: string;
  gain: string;
  white_balance: number[];
  digital_gain: string | null;
  black_level_auto: boolean;
  black_level: string | null;
  frame_rate: string | null;
  auto_target: string;
  note: string;
  modified_at: Date | null;
  created_at: Date;
  modified_by: string | null;
  created_by: string;
}

function cameraDefaultsView(r: CameraDefaultsRow): CameraDefaults & { changedAt: string; changedBy: string } {
  return {
    cameraSerial: r.camera_serial,
    exposureUs: Number(r.exposure_us),
    gain: Number(r.gain),
    whiteBalance: r.white_balance.map(Number) as [number, number, number],
    digitalGain: r.digital_gain === null ? null : Number(r.digital_gain),
    blackLevelAuto: r.black_level_auto,
    blackLevel: r.black_level === null ? null : Number(r.black_level),
    frameRate: r.frame_rate === null ? null : Number(r.frame_rate),
    autoTarget: Number(r.auto_target),
    note: r.note,
    changedAt: (r.modified_at ?? r.created_at).toISOString(),
    changedBy: r.modified_by ?? r.created_by,
  };
}

/** The saved camera settings for a serial: its own row, else the '*' row, else the built-in defaults. */
async function cameraDefaults(serial: string | null): Promise<CameraDefaults> {
  const rows = await ctx.db.query<CameraDefaultsRow>(
    "SELECT * FROM tlc_camera_settings WHERE NOT is_deleted AND camera_serial IN ($1, '*') ORDER BY (camera_serial = '*') LIMIT 1",
    [serial ?? '*'],
  );
  return rows[0] ? cameraDefaultsView(rows[0]) : { cameraSerial: serial ?? '*', ...DEFAULT_CAMERA_DEFAULTS, whiteBalance: [1, 1, 1] };
}

/**
 * The camera for this analysis: the one whose serial is the instrument's serial number if it is
 * connected, else the only camera connected; null when it cannot be decided.
 */
async function deviceCameraSerial(a: AnalysisRow, cameras: { serial: string }[]): Promise<string | null> {
  if (!a.device_id) return cameras.length === 1 ? cameras[0].serial : null;
  const [d] = await ctx.db.query<{ serial_number: string | null }>('SELECT serial_number FROM devices WHERE id = $1', [a.device_id]);
  const own = cameras.find((c) => d?.serial_number && c.serial === d.serial_number);
  if (own) return own.serial;
  return cameras.length === 1 ? cameras[0].serial : null;
}

async function originalImage(tx: Pick<ModuleTx, 'query'>, analysisId: string, imageId: unknown) {
  if (typeof imageId !== 'string' || !UUID.test(imageId)) throw new ModuleError(400, 'Choose one of the analysis’ plate images.', 'imageId');
  const [img] = await tx.query<{ id: string; illumination: Illumination; data: Buffer; sha256: string; qc: ImageQc | null }>(
    'SELECT id, illumination, data, sha256, qc FROM tlc_images WHERE id = $1 AND analysis_id = $2',
    [imageId, analysisId],
  );
  if (!img) throw new ModuleError(404, 'Plate image not found on this analysis.', 'imageId');
  if (createHash('sha256').update(img.data).digest('hex') !== img.sha256) throw new ModuleError(409, 'The stored image no longer matches its SHA-256.');
  return img;
}

const TlcModule: NxGenModule = {
  register(c) {
    ctx = c;

    ctx.workflow.registerRecordType({
      tableName: TABLE,
      load: (tx, id) => content(tx, id),
      link: (seriesId) => `?analysis=${seriesId}`,
      authorOf: async (tx, id) => (await load(tx, id)).analyzed_by,
      beforeSubmit: async (tx, id) => {
        const a = await load(tx, id);
        if (!a.device_id) return 'Choose the TLC instrument for this analysis before submitting.';
        if (!a.method_version_id) return 'Choose the approved TLC method for this analysis before submitting.';
        if (!(await images(tx, id)).length) return 'Add at least one plate image before submitting.';
        if (a.current_evaluation_id) {
          const e = await loadEvaluation(tx, a.current_evaluation_id);
          if (!e || e.plate_id !== a.current_plate_id) return 'The plate was straightened again after the last evaluation; evaluate it again.';
          if (e.conclusion === 'INCOMPLETE') return 'The evaluation is incomplete: it needs standard and sample tracks, Rf windows from the method, and no saturation in the lanes.';
        } else {
          if (a.solvent_front_mm === null || !a.tracks.length) return 'Evaluate the plate (solvent front and tracks) before submitting.';
          if (a.conclusion === 'INCOMPLETE') return 'The evaluation is incomplete: it needs standard and sample tracks and Rf windows from the method.';
        }
        const d = await ctx.devices.get(a.device_id);
        if (!d?.readiness.usable) return `The instrument cannot be used now: ${d?.readiness.message ?? 'not found'}`;
        return null;
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/setup',
      permission: 'tlc.view',
      async handler() {
        const devices = await ctx.devices.list('TLC');
        const methods = (await ctx.methods.effective('TLC')).map((m) => ({ ...m, ...parseRfWindows(m.parameters) }));
        // The code the next analysis will get (as the tablet shows the project ID before creation).
        const [seq] = await ctx.db.query<{ last_value: string; is_called: boolean }>('SELECT last_value, is_called FROM tlc_analysis_code_seq');
        const next = seq.is_called ? Number(seq.last_value) + 1 : Number(seq.last_value);
        return { devices, methods, engineVersion: ENGINE_VERSION, nextCode: `TLC-${String(next).padStart(4, '0')}` };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/analyses',
      permission: 'tlc.view',
      async handler() {
        const rows = await ctx.db.query<AnalysisRow & { device_code: string | null; thumbnail: string | null; image_count: string }>(
          `SELECT a.*, u.full_name AS analyzed_by_name, d.code AS device_code,
                  (SELECT i.id FROM tlc_images i WHERE i.analysis_id = a.id ORDER BY i.uploaded_at LIMIT 1) AS thumbnail,
                  (SELECT count(*) FROM tlc_images i WHERE i.analysis_id = a.id) AS image_count
             FROM tlc_analyses a
             LEFT JOIN users u ON u.id = a.analyzed_by LEFT JOIN devices d ON d.id = a.device_id
            WHERE NOT a.is_deleted ORDER BY a.created_at DESC LIMIT 200`,
        );
        return Promise.all(
          rows.map(async (r) => ({
            ...view(r),
            deviceCode: r.device_code,
            thumbnail: r.thumbnail ? (r.current_plate_id ? { kind: 'plate', id: r.current_plate_id } : { kind: 'image', id: r.thumbnail }) : null,
            imageCount: Number(r.image_count),
            workflow: await ctx.workflow.forRecord(TABLE, r.id),
          })),
        );
      },
    });

    ctx.http.route({
      method: 'POST',
      path: '/analyses',
      permission: 'tlc.analyze',
      async handler(req: ModuleRequest) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        // Both optional here; chosen later on the draft, required before submitting.
        const device = b.deviceId ? await usableDevice(b.deviceId) : null;
        const chosen = b.methodVersionId ? await approvedMethod(b.methodVersionId) : null;
        if (b.type !== undefined && b.type !== 'ROUTINE_ANALYSIS') throw new ModuleError(400, 'Only routine analyses are available; reaction monitoring comes later.', 'type');
        const f = {
          name: text(b.name, 'name', 'project name', 1, 100),
          department: text(b.department ?? '', 'department', 'Department', 0, 80),
          projectStatus: projectStatus(b.projectStatus),
          sampleId: text(b.sampleId ?? '', 'sampleId', 'Sample / batch ID', 0, 80),
          batch: text(b.batch ?? '', 'batch', 'Batch', 0, 80),
          plateType: text(b.plateType ?? 'Silica gel 60 F254', 'plateType', 'plate type', 2, 120),
          plateLot: text(b.plateLot ?? '', 'plateLot', 'Plate lot', 0, 80),
          stationaryPhase: text(b.stationaryPhase ?? '', 'stationaryPhase', 'Stationary phase', 0, 120),
          mobilePhase: text(b.mobilePhase ?? '', 'mobilePhase', 'Mobile phase', 0, 300),
          staining: text(b.staining ?? '', 'staining', 'Staining / derivatization', 0, 120),
          remarks: text(b.remarks ?? '', 'remarks', 'Description', 0, 2000),
        };
        const id = await ctx.db.transaction(req.principal, 'TLC analysis created', req.origin, async (tx) => {
          const [seq] = await tx.query<{ n: string }>("SELECT nextval('tlc_analysis_code_seq') AS n");
          const code = `TLC-${String(seq.n).padStart(4, '0')}`;
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_analyses (code, device_id, method_id, method_version_id, method_code, method_version, method_name, rf_windows,
                                       sample_id, batch, plate_type, plate_lot, mobile_phase, remarks, analyzed_by,
                                       name, department, project_status, stationary_phase, staining)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
            [code, device?.id ?? null, chosen?.method.methodId ?? null, chosen?.method.versionId ?? null, chosen?.method.code ?? null,
             chosen?.method.versionNumber ?? null, chosen?.method.name ?? null, JSON.stringify(chosen?.windows ?? []),
             f.sampleId, f.batch, f.plateType, f.plateLot, f.mobilePhase, f.remarks, req.principal.userId,
             f.name, f.department, f.projectStatus, f.stationaryPhase, f.staining],
          );
          await ctx.workflow.start(tx, req.principal, { definitionCode: WORKFLOW, tableName: TABLE, recordId: row.id, seriesId: row.id, seriesVersion: 1 });
          return row.id;
        });
        await ctx.audit.record({
          action: 'TLC_ANALYSIS_CREATED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: id,
          details: {
            device: device?.code ?? null,
            method: chosen ? `${chosen.method.code} v${chosen.method.versionNumber}` : null,
            name: f.name,
            sampleId: f.sampleId,
          },
        });
        return view(await load(ctx.db, id));
      },
    });

    /**
     * Instrument and method of a draft (chosen at creation or later), by its analyst. Choosing another
     * method replaces the Rf windows, so an existing evaluation no longer counts: evaluate again.
     */
    ctx.http.route({
      method: 'PUT',
      path: '/analyses/:id/setup',
      permission: 'tlc.analyze',
      async handler(req) {
        const b = (req.body ?? {}) as { deviceId?: unknown; methodVersionId?: unknown };
        const device = b.deviceId === undefined ? undefined : b.deviceId ? await usableDevice(b.deviceId) : null;
        const chosen = b.methodVersionId === undefined ? undefined : b.methodVersionId ? await approvedMethod(b.methodVersionId) : null;
        const change = await ctx.db.transaction(req.principal, 'TLC analysis instrument / method chosen', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'choose its instrument and method');
          const deviceId = device === undefined ? a.device_id : (device?.id ?? null);
          const methodChanged = chosen !== undefined && (chosen?.method.versionId ?? null) !== a.method_version_id;
          if (methodChanged) {
            await tx.query(
              `UPDATE tlc_analyses SET device_id = $2, method_id = $3, method_version_id = $4, method_code = $5, method_version = $6, method_name = $7,
                      rf_windows = $8, results = '{}'::jsonb, conclusion = 'INCOMPLETE', current_evaluation_id = NULL WHERE id = $1`,
              [a.id, deviceId, chosen?.method.methodId ?? null, chosen?.method.versionId ?? null, chosen?.method.code ?? null,
               chosen?.method.versionNumber ?? null, chosen?.method.name ?? null, JSON.stringify(chosen?.windows ?? [])],
            );
          } else if (deviceId !== a.device_id) {
            await tx.query('UPDATE tlc_analyses SET device_id = $2 WHERE id = $1', [a.id, deviceId]);
          }
          return { methodChanged, deviceChanged: deviceId !== a.device_id, evaluationCleared: methodChanged && !!a.current_evaluation_id };
        });
        const a = await load(ctx.db, req.params.id);
        if (change.methodChanged || change.deviceChanged)
          await ctx.audit.record({
            action: 'TLC_ANALYSIS_SETUP_CHANGED',
            result: 'SUCCESS',
            principal: req.principal,
            recordId: a.id,
            details: {
              code: a.code,
              device: change.deviceChanged ? (device?.code ?? null) : null,
              method: change.methodChanged ? (chosen ? `${chosen.method.code} v${chosen.method.versionNumber}` : 'none') : null,
              evaluationCleared: change.evaluationCleared,
            },
          });
        return view(a);
      },
    });

    /** Project and plate details (the tablet's Plate info and project fields); draft only, by the analyst. */
    ctx.http.route({
      method: 'PUT',
      path: '/analyses/:id/details',
      permission: 'tlc.analyze',
      async handler(req) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const changed = await ctx.db.transaction(req.principal, 'TLC analysis details changed', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'change its details');
          const f = {
            name: text(b.name ?? a.name, 'name', 'project name', 1, 100),
            department: text(b.department ?? a.department, 'department', 'Department', 0, 80),
            projectStatus: projectStatus(b.projectStatus ?? a.project_status),
            sampleId: text(b.sampleId ?? a.sample_id, 'sampleId', 'Sample / batch ID', 0, 80),
            batch: text(b.batch ?? a.batch, 'batch', 'Batch', 0, 80),
            plateType: text(b.plateType ?? a.plate_type, 'plateType', 'plate type', 2, 120),
            plateLot: text(b.plateLot ?? a.plate_lot, 'plateLot', 'Plate lot', 0, 80),
            stationaryPhase: text(b.stationaryPhase ?? a.stationary_phase, 'stationaryPhase', 'Stationary phase', 0, 120),
            mobilePhase: text(b.mobilePhase ?? a.mobile_phase, 'mobilePhase', 'Mobile phase', 0, 300),
            staining: text(b.staining ?? a.staining, 'staining', 'Staining / derivatization', 0, 120),
            remarks: text(b.remarks ?? a.remarks, 'remarks', 'Notes', 0, 2000),
          };
          await tx.query(
            `UPDATE tlc_analyses SET name = $2, department = $3, project_status = $4, sample_id = $5, batch = $6, plate_type = $7, plate_lot = $8,
                    stationary_phase = $9, mobile_phase = $10, staining = $11, remarks = $12 WHERE id = $1`,
            [a.id, f.name, f.department, f.projectStatus, f.sampleId, f.batch, f.plateType, f.plateLot, f.stationaryPhase, f.mobilePhase, f.staining, f.remarks],
          );
          return Object.keys(f).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
        });
        const a = await load(ctx.db, req.params.id);
        await ctx.audit.record({ action: 'TLC_ANALYSIS_DETAILS_CHANGED', result: 'SUCCESS', principal: req.principal, recordId: a.id, details: { code: a.code, fields: changed.join(',') } });
        return view(a);
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/analyses/:id',
      permission: 'tlc.view',
      async handler(req) {
        const a = await load(ctx.db, req.params.id);
        const imgs = await images(ctx.db, a.id);
        const plate = await loadPlate(ctx.db, a.current_plate_id);
        const evaluations = await ctx.db.query<EvaluationRow>(
          'SELECT e.*, u.full_name AS created_by_name FROM tlc_evaluations e LEFT JOIN users u ON u.id = e.created_by WHERE e.analysis_id = $1 ORDER BY e.number DESC',
          [a.id],
        );
        return {
          ...view(a),
          device: a.device_id ? await ctx.devices.get(a.device_id) : null,
          images: imgs.map(imageView),
          plate: plate ? plateView(plate) : null,
          evaluations: evaluations.map((e) => evaluationView(e, false)),
          workflow: await ctx.workflow.forRecord(TABLE, a.id),
        };
      },
    });

    /** Save a manual plate evaluation (distances typed in; draft only, by the analyst). */
    ctx.http.route({
      method: 'PUT',
      path: '/analyses/:id/evaluation',
      permission: 'tlc.analyze',
      async handler(req) {
        const b = (req.body ?? {}) as { solventFrontMm?: unknown; tracks?: unknown; remarks?: unknown };
        const tracks = parseTracks(b.tracks);
        const front = b.solventFrontMm === null || b.solventFrontMm === '' ? null : Number(b.solventFrontMm);
        const problems = validatePlate(front, tracks);
        if (problems.length) throw new ModuleError(400, problems.join(' '), 'tracks');
        await ctx.db.transaction(req.principal, 'TLC plate evaluated', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'evaluate it');
          const e = evaluate(front!, tracks, a.rf_windows);
          await tx.query(
            'UPDATE tlc_analyses SET solvent_front_mm = $2, tracks = $3, results = $4, conclusion = $5, remarks = $6, current_evaluation_id = NULL WHERE id = $1',
            [a.id, front, JSON.stringify(tracks), JSON.stringify(e), e.conclusion, typeof b.remarks === 'string' ? b.remarks.trim().slice(0, 2000) : a.remarks],
          );
        });
        const a = await load(ctx.db, req.params.id);
        await ctx.audit.record({ action: 'TLC_PLATE_EVALUATED', result: 'SUCCESS', principal: req.principal, recordId: a.id, details: { code: a.code, conclusion: a.conclusion, tracks: tracks.length, mode: 'MANUAL' } });
        return view(a);
      },
    });

    // ------------------------------------------------------------------
    // Camera (the lamp box camera on the server's computer; see core CameraService)
    // ------------------------------------------------------------------

    /**
     * Cameras the server can use, and the settings the analysis' method asks for. The live preview
     * itself is the core stream GET /api/cameras/<serial>/preview.
     */
    ctx.http.route({
      method: 'GET',
      path: '/camera',
      permission: 'tlc.view',
      passive: true,
      async handler(req) {
        const status = ctx.cameras.status();
        let cameras: Awaited<ReturnType<ModuleContext['cameras']['list']>> = [];
        let error: string | null = null;
        try {
          cameras = await ctx.cameras.list();
        } catch (e) {
          error = (e as Error).message;
        }
        let settings = DEFAULT_CAMERA;
        let problems: string[] = [];
        let preferred: string | null = null;
        if (typeof req.query.analysis === 'string' && UUID.test(req.query.analysis)) {
          const a = await load(ctx.db, req.query.analysis);
          ({ settings, problems } = await methodCamera(a));
          preferred = await deviceCameraSerial(a, cameras);
        } else if (cameras.length === 1) preferred = cameras[0].serial;
        // The saved defaults (Advanced settings) under the method, and what the camera can do.
        const defaults = await cameraDefaults(preferred);
        settings = withCameraDefaults(settings, defaults);
        let capabilities: Awaited<ReturnType<ModuleContext['cameras']['info']>>['capabilities'] | null = null;
        if (preferred) {
          try {
            capabilities = (await ctx.cameras.info(preferred)).capabilities ?? null;
          } catch {
            capabilities = null;
          }
        }
        return {
          status: { ...ctx.cameras.status(), error: error ?? status.error },
          cameras,
          settings,
          problems,
          preferredSerial: preferred,
          defaults,
          parameters: cameraParametersOf(defaults).parameters,
          capabilities,
        };
      },
    });

    // ------------------------------------------------------------------
    // Camera settings (the module's "Advanced settings"), per camera serial
    // ------------------------------------------------------------------

    ctx.http.route({
      method: 'GET',
      path: '/camera-settings',
      permission: 'tlc.view',
      passive: true,
      async handler() {
        const rows = await ctx.db.query<CameraDefaultsRow>("SELECT * FROM tlc_camera_settings WHERE NOT is_deleted ORDER BY (camera_serial = '*') DESC, camera_serial");
        return { settings: rows.map(cameraDefaultsView), builtIn: { cameraSerial: '*', ...DEFAULT_CAMERA_DEFAULTS } };
      },
    });

    ctx.http.route({
      method: 'PUT',
      path: '/camera-settings/:serial',
      permission: 'tlc.settings',
      async handler(req) {
        const serial = req.params.serial;
        if (serial !== '*' && !/^[A-Za-z0-9._-]{1,64}$/.test(serial)) throw new ModuleError(400, 'Unknown camera serial.', 'serial');
        const { defaults: d, problems } = parseCameraDefaults(req.body, serial);
        if (problems.length) throw new ModuleError(400, problems.join(' '));
        const reason = typeof (req.body as { reason?: unknown })?.reason === 'string' ? (req.body as { reason: string }).reason.trim() : '';
        if (reason.length < 5) throw new ModuleError(400, 'Give the reason for the change (at least 5 characters).', 'reason');
        await ctx.db.transaction(req.principal, reason, req.origin, async (tx) => {
          await tx.query(
            `INSERT INTO tlc_camera_settings (camera_serial, exposure_us, gain, white_balance, digital_gain, black_level_auto, black_level, frame_rate, auto_target, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (camera_serial) DO UPDATE SET exposure_us = EXCLUDED.exposure_us, gain = EXCLUDED.gain, white_balance = EXCLUDED.white_balance,
               digital_gain = EXCLUDED.digital_gain, black_level_auto = EXCLUDED.black_level_auto, black_level = EXCLUDED.black_level,
               frame_rate = EXCLUDED.frame_rate, auto_target = EXCLUDED.auto_target, note = EXCLUDED.note, is_deleted = false`,
            [serial, d.exposureUs, d.gain, JSON.stringify(d.whiteBalance), d.digitalGain, d.blackLevelAuto, d.blackLevel, d.frameRate, d.autoTarget, d.note],
          );
        });
        await ctx.audit.record({
          action: 'TLC_CAMERA_SETTINGS_CHANGED',
          result: 'SUCCESS',
          principal: req.principal,
          reason,
          details: {
            camera: serial,
            exposureUs: d.exposureUs,
            gain: d.gain,
            whiteBalance: d.whiteBalance.join('/'),
            digitalGain: d.digitalGain,
            blackLevelAuto: d.blackLevelAuto,
            blackLevel: d.blackLevel,
            frameRate: d.frameRate,
            autoTarget: d.autoTarget,
          },
        });
        return (await cameraDefaults(serial === '*' ? null : serial)) as CameraDefaults;
      },
    });

    /**
     * Capture the plate with the camera: the tablet's sequence on the server. Settings come from the
     * method; without a method exposure the exposure is corrected automatically (up to 2 retakes
     * when the quality gate finds it ≥ 0.3 EV off). The kept still is stored like an upload (original
     * bytes, SHA-256, quality gate) together with the camera and settings that took it.
     */
    ctx.http.route({
      method: 'POST',
      path: '/analyses/:id/capture',
      permission: 'tlc.analyze',
      async handler(req) {
        const body = (req.body ?? {}) as { illumination?: string; serial?: string; settings?: unknown };
        const illumination = body.illumination as Illumination;
        if (!ILLUMINATIONS.includes(illumination)) throw new ModuleError(400, 'Choose the illumination: white, UV 254 or UV 366.', 'illumination');
        const a = await load(ctx.db, req.params.id);
        if (a.analyzed_by !== req.principal.userId) throw new ModuleError(403, 'Only the analyst who created the analysis can add images.');
        // The instrument may still be open (it is required before submitting); when chosen it must be usable.
        if (a.device_id) await usableDevice(a.device_id);
        const fromMethod = await methodCamera(a);
        if (fromMethod.problems.length) throw new ModuleError(409, `The method's camera settings are not usable: ${fromMethod.problems.join(' ')}`);
        let cameras: Awaited<ReturnType<ModuleContext['cameras']['list']>>;
        try {
          cameras = await ctx.cameras.list();
        } catch (e) {
          throw new ModuleError(409, (e as Error).message);
        }
        const serial = typeof body.serial === 'string' && body.serial ? body.serial : await deviceCameraSerial(a, cameras);
        if (!serial || !cameras.some((c) => c.serial === serial)) throw new ModuleError(409, 'No camera is connected to this computer. Check the USB 3 cable, or upload an image instead.');
        // Saved defaults (Advanced settings) under the method, then what the analyst set on the
        // Picture stage where the method does not set it.
        const defaults = await cameraDefaults(serial);
        const { settings, problems: adjustProblems, adjusted } = applyCameraAdjustment(withCameraDefaults(fromMethod.settings, defaults), (body as { settings?: unknown }).settings);
        if (adjustProblems.length) throw new ModuleError(400, adjustProblems.join(' '), 'settings');
        const { parameters, problems: parameterProblems } = cameraParametersOf(defaults, (body as { parameters?: unknown }).parameters);
        if (parameterProblems.length) throw new ModuleError(400, parameterProblems.join(' '), 'parameters');

        // The tablet's capture loop: take, check, correct the exposure, retake (≤ 2).
        let exposureUs = settings.exposureUs;
        const attempts: { exposureUs: number; exposureEv: number | null; verdict: string }[] = [];
        let still: Awaited<ReturnType<ModuleContext['cameras']['still']>>;
        let rgb: ReturnType<typeof decodeImage>;
        let qc: ImageQc | null;
        for (;;) {
          try {
            still = await ctx.cameras.still(
              req.principal,
              { serial, exposureUs, gain: settings.gain, whiteBalance: settings.whiteBalance, parameters, purpose: `${a.code} plate image` },
              req.origin,
            );
          } catch (e) {
            throw new ModuleError(409, (e as Error).message);
          }
          rgb = decodeImage(still.data);
          qc = rgb.width >= MIN_QC_SIDE && rgb.height >= MIN_QC_SIDE ? imageQc(rgb, illumination, true) : null;
          attempts.push({ exposureUs: still.exposureUs, exposureEv: qc?.exposureEv ?? null, verdict: qc?.verdict ?? 'NOT_ASSESSED' });
          const ev = qc && !settings.fixed ? autoRetakeEv({ items: qc.items, exposureEv: qc.exposureEv, stats: null }) : null;
          if (ev === null || attempts.length > 2) break;
          exposureUs = Math.round(Math.min(2_000_000, Math.max(31, exposureUs * 2 ** ev)));
        }
        const camera = {
          serial: still.serial,
          model: cameras.find((c) => c.serial === still.serial)?.model ?? null,
          simulated: still.simulated,
          exposureUs: still.exposureUs,
          gain: still.gain,
          whiteBalance: still.whiteBalance,
          pixelFormat: still.pixelFormat,
          sourceBits: still.sourceBits,
          temperatureC: still.temperatureC,
          saturatedFraction: still.saturatedFraction,
          settingsFromMethod: settings.fromMethod ?? null,
          settingsSetByAnalyst: adjusted,
          parameters,
          attempts,
          capturedAt: still.capturedAt,
        };
        const fileName = `${a.code}-${illumination}-${still.capturedAt.replace(/[:.]/g, '-')}.png`;
        const id = await ctx.db.transaction(req.principal, 'TLC plate image captured', req.origin, async (tx) => {
          const row = await editable(tx, req, req.params.id, 'add images');
          const [r] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_images (analysis_id, illumination, file_name, content_type, size_bytes, sha256, data, uploaded_by, qc, source, camera)
             VALUES ($1, $2, $3, 'image/png', $4, $5, $6, $7, $8, 'CAMERA', $9) RETURNING id`,
            [row.id, illumination, fileName, still.data.length, still.sha256, still.data, req.principal.userId, qc ? JSON.stringify(qc) : null, JSON.stringify(camera)],
          );
          return r.id;
        });
        await ctx.audit.record({
          action: 'TLC_IMAGE_CAPTURED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: req.params.id,
          details: {
            imageId: id,
            illumination,
            sha256: still.sha256,
            sizeBytes: still.data.length,
            width: rgb.width,
            height: rgb.height,
            camera: still.serial,
            simulated: still.simulated,
            exposureUs: still.exposureUs,
            gain: still.gain,
            whiteBalance: still.whiteBalance.join('/'),
            setByAnalyst: adjusted.join(',') || null,
            attempts: attempts.length,
            qcVerdict: qc?.verdict ?? null,
          },
        });
        return { id, sha256: still.sha256, illumination, sizeBytes: still.data.length, width: rgb.width, height: rgb.height, qc, camera };
      },
    });

    /** Original plate image as raw bytes (image/png or image/jpeg). Stored with its SHA-256, never changed. */
    ctx.http.route({
      method: 'POST',
      path: '/analyses/:id/images',
      permission: 'tlc.analyze',
      async handler(req) {
        const data = req.body;
        if (!Buffer.isBuffer(data) || !data.length) throw new ModuleError(400, 'Upload a PNG or JPEG image.');
        if (data.length > MAX_IMAGE) throw new ModuleError(400, 'Images can be at most 15 MB.');
        const type = imageType(data);
        if (!type) throw new ModuleError(400, 'The file is not a PNG or JPEG image.');
        const illumination = req.query.illumination as Illumination;
        if (!ILLUMINATIONS.includes(illumination)) throw new ModuleError(400, 'Choose the illumination: white, UV 254 or UV 366.', 'illumination');
        const name = (req.query.name ?? 'plate').replace(/[^\w. -]/g, '_').slice(0, 120) || 'plate';
        const sha = sha256(data);
        // The capture quality gate, as the tablet runs it on every picture; kept with the image.
        let rgb: ReturnType<typeof decodeImage>;
        try {
          rgb = decodeImage(data);
        } catch {
          throw new ModuleError(400, 'The image could not be decoded.');
        }
        const qc = rgb.width >= MIN_QC_SIDE && rgb.height >= MIN_QC_SIDE ? imageQc(rgb, illumination) : null;
        const id = await ctx.db.transaction(req.principal, 'TLC plate image added', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'add images');
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_images (analysis_id, illumination, file_name, content_type, size_bytes, sha256, data, uploaded_by, qc)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [a.id, illumination, name, type, data.length, sha, data, req.principal.userId, qc ? JSON.stringify(qc) : null],
          );
          return row.id;
        });
        await ctx.audit.record({
          action: 'TLC_IMAGE_ADDED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: req.params.id,
          details: { imageId: id, illumination, sha256: sha, sizeBytes: data.length, width: rgb.width, height: rgb.height, qcVerdict: qc?.verdict ?? null },
        });
        return { id, sha256: sha, illumination, sizeBytes: data.length, width: rgb.width, height: rgb.height, qc };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/images/:imageId',
      permission: 'tlc.view',
      async handler(req): Promise<ModuleFileResponse> {
        if (!UUID.test(req.params.imageId)) throw new ModuleError(404, 'Image not found.');
        const key = `image:${req.params.imageId}`;
        const hit = imageCache.get(key);
        if (hit) return { kind: 'file', contentType: hit.contentType, data: hit.data, fileName: hit.fileName, immutable: true };
        const [img] = await ctx.db.query<{ data: Buffer; content_type: string; file_name: string; sha256: string }>(
          'SELECT data, content_type, file_name, sha256 FROM tlc_images WHERE id = $1',
          [req.params.imageId],
        );
        if (!img) throw new ModuleError(404, 'Image not found.');
        if (createHash('sha256').update(img.data).digest('hex') !== img.sha256) throw new ModuleError(409, 'The stored image no longer matches its SHA-256.');
        imageCache.set(key, { contentType: img.content_type, data: img.data, fileName: img.file_name });
        // Raw images are append-only and addressed by id, so the browser may keep them.
        return { kind: 'file', contentType: img.content_type, data: img.data, fileName: img.file_name, immutable: true };
      },
    });

    // ------------------------------------------------------------------
    // Straightened plates (crop step)
    // ------------------------------------------------------------------

    /** Suggested plate outline on an original image, with the matching size preset. */
    ctx.http.route({
      method: 'GET',
      path: '/analyses/:id/outline',
      permission: 'tlc.view',
      async handler(req) {
        const a = await load(ctx.db, req.params.id);
        const img = await originalImage(ctx.db, a.id, req.query.imageId);
        const rgb = decodeImage(img.data);
        const s = suggestOutline(rgb);
        return { image: { id: img.id, width: rgb.width, height: rgb.height, illumination: img.illumination }, outline: s };
      },
    });

    /** Straighten the plate from an original image; replaces the current plate (the old one is kept). */
    ctx.http.route({
      method: 'POST',
      path: '/analyses/:id/plate',
      permission: 'tlc.analyze',
      async handler(req) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const outlineSource = b.outlineSource === 'AUTO' ? 'AUTO' : 'MANUAL';
        const override = typeof b.qcOverrideReason === 'string' ? b.qcOverrideReason.trim().slice(0, 500) : '';
        const out = await ctx.db.transaction(req.principal, 'TLC plate straightened', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'straighten the plate');
          const img = await originalImage(tx, a.id, b.imageId);
          // The tablet refuses a picture that failed the gate unless Expert mode is on; here the
          // analyst must give a reason, which stays with the plate and in the audit trail.
          if (img.qc?.verdict === 'RECAPTURE_REQUIRED' && override.length < 10) {
            const why = img.qc.items.filter((i) => i.status === 'FAIL').map((i) => i.message).join(' ');
            throw new ModuleError(409, `This image failed the capture quality gate: ${why} Upload a better image, or give a reason (at least 10 characters) to use it anyway.`, 'qcOverrideReason');
          }
          const original = decodeImage(img.data);
          const spec = parsePlateSpec(b, original);
          const rectified = makePlate(original, spec);
          const png = encodePng(rectified);
          const pixels = sha256(pixelBytes(rectified));
          await tx.query('UPDATE tlc_plates SET is_current = false WHERE analysis_id = $1 AND is_current', [a.id]);
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_plates (analysis_id, image_id, illumination, corners, outline_source, width_mm, height_mm, width_px, height_px, channel, post_processing,
                                     rectified, rectified_sha256, pixels_sha256, created_by, qc_override_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
            [a.id, img.id, img.illumination, JSON.stringify(spec.corners), outlineSource, spec.widthMm, spec.heightMm, rectified.width, rectified.height, spec.channel,
             JSON.stringify(spec.postProcessing), png, sha256(png), pixels, req.principal.userId, img.qc?.verdict === 'RECAPTURE_REQUIRED' ? override : ''],
          );
          // The last evaluation stays on record (it belongs to the retired plate) but no longer
          // counts: submission needs an evaluation of the current plate.
          await tx.query("UPDATE tlc_analyses SET current_plate_id = $2, conclusion = 'INCOMPLETE' WHERE id = $1", [a.id, row.id]);
          return { id: row.id, code: a.code, pixels, width: rectified.width, height: rectified.height, illumination: img.illumination, qcVerdict: img.qc?.verdict ?? null };
        });
        await ctx.audit.record({
          action: 'TLC_PLATE_STRAIGHTENED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: req.params.id,
          details: {
            code: out.code,
            plateId: out.id,
            illumination: out.illumination,
            outlineSource,
            widthPx: out.width,
            heightPx: out.height,
            pixelsSha256: out.pixels,
            qcVerdict: out.qcVerdict,
            qcOverrideReason: out.qcVerdict === 'RECAPTURE_REQUIRED' ? override : null,
          },
        });
        return plateView((await loadPlate(ctx.db, out.id)) as PlateRow);
      },
    });

    /**
     * The straightened plate as PNG (the RAW view). ?view=analytical renders the image the
     * calculations use: post-processing then one channel, with ?channel=, ?black=, ?white= and
     * ?denoise=1 overriding the plate's defaults.
     */
    ctx.http.route({
      method: 'GET',
      path: '/plates/:plateId/image',
      permission: 'tlc.view',
      async handler(req): Promise<ModuleFileResponse> {
        if (!UUID.test(req.params.plateId)) throw new ModuleError(404, 'Plate not found.');
        // Straightened plates are append-only (NXGEN-TLC-003), so their pixels never change: after
        // one checked database read they are served from memory, and the browser may keep them.
        const plateKey = `plate:${req.params.plateId}`;
        let cached = imageCache.get(plateKey);
        if (!cached) {
          const p = await loadPlate(ctx.db, req.params.plateId, true);
          if (!p?.rectified) throw new ModuleError(404, 'Plate not found.');
          if (sha256(p.rectified) !== p.rectified_sha256) throw new ModuleError(409, 'The stored plate no longer matches its SHA-256.');
          cached = { contentType: 'image/png', data: p.rectified, fileName: 'plate.png', meta: { channel: p.channel, postProcessing: p.post_processing } };
          imageCache.set(plateKey, cached);
        }
        if (req.query.view === 'analytical') {
          const meta = cached.meta as { channel: Channel; postProcessing: PostProcessing };
          const channel = (['INTENSITY', 'RED', 'GREEN', 'BLUE'].includes(req.query.channel ?? '') ? req.query.channel : meta.channel) as Channel;
          const pp: PostProcessing = {
            blackPoint: Number(req.query.black ?? meta.postProcessing.blackPoint),
            whitePoint: Number(req.query.white ?? meta.postProcessing.whitePoint),
            denoise: req.query.denoise === undefined ? meta.postProcessing.denoise : req.query.denoise === '1',
          };
          if (validatePostProcessing(pp).length) throw new ModuleError(400, 'Levels must be 0–255 with black below white.');
          const key = `analytical:${req.params.plateId}:${channel}:${pp.blackPoint}:${pp.whitePoint}:${pp.denoise ? 1 : 0}`;
          let view = imageCache.get(key);
          if (!view) {
            const gray = analyticalGray(decodeImage(cached.data), { channel, postProcessing: pp });
            view = { contentType: 'image/png', data: encodePng(new RgbImage(gray.width, gray.height, gray.toArgb())), fileName: 'plate-analytical.png' };
            imageCache.set(key, view);
          }
          return { kind: 'file', contentType: 'image/png', data: view.data, fileName: view.fileName, immutable: true };
        }
        return { kind: 'file', contentType: 'image/png', data: cached.data, fileName: 'plate.png', immutable: true };
      },
    });

    /** Automatic layout of the straightened plate: baseline, front, lanes, width and each lane's spots. */
    ctx.http.route({
      method: 'GET',
      path: '/plates/:plateId/layout',
      permission: 'tlc.view',
      async handler(req) {
        const p = await loadPlate(ctx.db, req.params.plateId, true);
        if (!p?.rectified) throw new ModuleError(404, 'Plate not found.');
        const gray = analyticalGray(decodeImage(p.rectified), plateSpecOf(p));
        const layout = autoLayout(gray, new PlateGeometry(gray.width, gray.height, Number(p.width_mm), Number(p.height_mm)), p.illumination);
        return {
          baselineMm: layout.development.baselineMm,
          solventFrontMm: layout.development.solventFrontMm,
          trackWidthMm: layout.development.trackWidthMm,
          baselineFound: layout.baselineFound,
          frontFound: layout.frontFound,
          widthEstimated: layout.widthEstimated,
          lanes: layout.lanes,
        };
      },
    });

    // ------------------------------------------------------------------
    // Evaluation snapshots
    // ------------------------------------------------------------------

    /** Evaluate the current plate: computed here, stored as the next immutable snapshot (E01, E02, …). */
    ctx.http.route({
      method: 'POST',
      path: '/analyses/:id/evaluations',
      permission: 'tlc.analyze',
      async handler(req) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out = await ctx.db.transaction(req.principal, 'TLC plate evaluated', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'evaluate it');
          const p = await loadPlate(tx, a.current_plate_id, true);
          if (!p?.rectified) throw new ModuleError(409, 'Straighten the plate before evaluating it.');
          const spec = plateSpecOf(p);
          const input = parseEvaluationInput(b, spec);
          const results = computeEvaluation(decodeImage(p.rectified), { widthMm: spec.widthMm, heightMm: spec.heightMm, illumination: p.illumination, pixelsSha256: p.pixels_sha256 }, input, a.rf_windows);
          const [{ n }] = await tx.query<{ n: string }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tlc_evaluations WHERE analysis_id = $1', [a.id]);
          const number = Number(n);
          const code = `E${String(number).padStart(2, '0')}`;
          const contentHash = sha256(evaluationContent(input, results));
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_evaluations (analysis_id, plate_id, number, code, input, results, conclusion, engine_version, content_sha256, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [a.id, p.id, number, code, JSON.stringify(input), JSON.stringify(results), results.conclusion, ENGINE_VERSION, contentHash, req.principal.userId],
          );
          await tx.query(
            'UPDATE tlc_analyses SET current_evaluation_id = $2, results = $3, conclusion = $4, solvent_front_mm = $5, remarks = $6 WHERE id = $1',
            [a.id, row.id, JSON.stringify(results.rf), results.conclusion, input.layout.solventFrontMm, typeof b.remarks === 'string' ? b.remarks.trim().slice(0, 2000) : a.remarks],
          );
          return { id: row.id, code: a.code, evaluation: code, conclusion: results.conclusion, contentHash, tracks: input.tracks.length };
        });
        await ctx.audit.record({
          action: 'TLC_PLATE_EVALUATED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: req.params.id,
          details: { code: out.code, evaluation: out.evaluation, conclusion: out.conclusion, tracks: out.tracks, contentSha256: out.contentHash, mode: 'DENSITOMETRY' },
        });
        return evaluationView((await loadEvaluation(ctx.db, out.id)) as EvaluationRow, true);
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/evaluations/:evaluationId',
      permission: 'tlc.view',
      async handler(req) {
        const e = await loadEvaluation(ctx.db, req.params.evaluationId);
        if (!e) throw new ModuleError(404, 'Evaluation not found.');
        return evaluationView(e, true);
      },
    });

    /**
     * Recompute the snapshot from the original image and compare: the straightened plate from its
     * corners, then the evaluation from the plate and the stored inputs. Any difference is audited.
     */
    ctx.http.route({
      method: 'GET',
      path: '/evaluations/:evaluationId/verify',
      permission: 'tlc.view',
      async handler(req) {
        const e = await loadEvaluation(ctx.db, req.params.evaluationId);
        if (!e) throw new ModuleError(404, 'Evaluation not found.');
        const p = (await loadPlate(ctx.db, e.plate_id, true)) as PlateRow;
        const a = await load(ctx.db, e.analysis_id);
        const img = await originalImage(ctx.db, a.id, p.image_id);
        const spec = plateSpecOf(p);
        const plateCheck = verifyPlate(decodeImage(img.data), spec, p.pixels_sha256);
        const stored = decodeImage(p.rectified as Buffer);
        const storedPixels = sha256(pixelBytes(stored));
        const results = computeEvaluation(stored, { widthMm: spec.widthMm, heightMm: spec.heightMm, illumination: p.illumination, pixelsSha256: p.pixels_sha256 }, e.input, a.rf_windows);
        const recomputed = sha256(evaluationContent(e.input, results));
        const checks = {
          originalImage: { ok: true, sha256: img.sha256 },
          storedPlate: { ok: storedPixels === p.pixels_sha256, stored: p.pixels_sha256, recomputed: storedPixels },
          plateFromOriginal: { ok: plateCheck.ok, stored: p.pixels_sha256, recomputed: plateCheck.recomputed },
          evaluation: { ok: recomputed === e.content_sha256, stored: e.content_sha256, recomputed, engineVersion: e.engine_version, currentEngine: ENGINE_VERSION },
        };
        const ok = checks.storedPlate.ok && checks.plateFromOriginal.ok && checks.evaluation.ok;
        await ctx.audit.record({
          action: ok ? 'TLC_EVALUATION_VERIFIED' : 'TLC_EVALUATION_MISMATCH',
          result: ok ? 'INFO' : 'FAILURE',
          principal: req.principal,
          recordId: a.id,
          details: { code: a.code, evaluation: e.code, plateOk: checks.plateFromOriginal.ok, storedPlateOk: checks.storedPlate.ok, evaluationOk: checks.evaluation.ok },
        });
        return { ok, code: e.code, checks };
      },
    });

    /** Instrument check (camera and lamps) as a calibration record approved in the core. */
    ctx.http.route({
      method: 'POST',
      path: '/instruments/:id/calibrations',
      permission: 'calibration.perform',
      async handler(req) {
        const d = await ctx.devices.get(req.params.id);
        if (!d) throw new ModuleError(404, 'TLC instrument not found.');
        const b = (req.body ?? {}) as { readings?: unknown; remarks?: unknown };
        if (!Array.isArray(b.readings) || !b.readings.length || b.readings.length > 30) throw new ModuleError(400, 'Enter 1 to 30 checks.', 'readings');
        const readings = b.readings.map((r: { check?: unknown; expected?: unknown; observed?: unknown; pass?: unknown }, i: number) => {
          const check = typeof r?.check === 'string' ? r.check.trim() : '';
          const observed = typeof r?.observed === 'string' ? r.observed.trim() : '';
          if (!check || !observed || typeof r?.pass !== 'boolean') throw new ModuleError(400, `Check ${i + 1}: enter what was checked, the observation and the result.`, 'readings');
          return { check: check.slice(0, 120), expected: typeof r?.expected === 'string' ? r.expected.trim().slice(0, 120) : '', observed: observed.slice(0, 120), pass: r.pass };
        });
        const failed = readings.filter((r) => !r.pass).length;
        return ctx.calibrations.record(
          req.principal,
          d.id,
          {
            temperatureC: null,
            readings,
            limits: {},
            results: { passed: readings.length - failed, failed },
            display: [{ label: 'Checks passed', value: `${readings.length - failed} of ${readings.length}` }],
            outcome: failed ? 'FAIL' : 'PASS',
            remarks: typeof b.remarks === 'string' ? b.remarks.trim().slice(0, 2000) : '',
            dataSource: 'MANUAL',
            sourceMessages: [],
          },
          req.origin,
        );
      },
    });
  },
  unload() {
    imageCache.clear();
  },
};

export default TlcModule;
export const register = TlcModule.register;
