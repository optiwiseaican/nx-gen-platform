import { createHash } from 'crypto';
import type { DeviceInfo, ModuleContext, ModuleFileResponse, ModuleRequest, ModuleTx, NxGenModule } from '@crescent/module-sdk';
import { ModuleError } from '@crescent/module-sdk';
import { Channel, ImageOps, PlateGeometry, Point, PostProcessing } from '../engine';
import { evaluate, ILLUMINATIONS, Illumination, imageType, parseRfWindows, RfWindow, TrackInput, validatePlate } from '../shared/tlc';
import { decodeImage, encodePng, pixelBytes } from './images';
import {
  ENGINE_VERSION,
  EvaluationInput,
  EvaluationResults,
  analyticalGray,
  autoLayout,
  computeEvaluation,
  evaluationContent,
  makePlate,
  parseEvaluationInput,
  parsePlateSpec,
  sha256,
  suggestOutline,
  verifyPlate,
} from './pipeline';

const TABLE = 'tlc_analyses';
const WORKFLOW = 'TLC_ANALYSIS_APPROVAL';
const MAX_IMAGE = 15 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/i;

interface AnalysisRow {
  id: string;
  code: string;
  device_id: string;
  method_id: string;
  method_version_id: string;
  method_code: string;
  method_version: number;
  method_name: string;
  rf_windows: RfWindow[];
  sample_id: string;
  batch: string;
  plate_type: string;
  plate_lot: string;
  mobile_phase: string;
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
  uploaded_by_name: string | null;
  uploaded_at: Date;
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
    `SELECT i.id, i.illumination, i.file_name, i.content_type, i.size_bytes, i.sha256, i.uploaded_at, u.full_name AS uploaded_by_name
       FROM tlc_images i LEFT JOIN users u ON u.id = i.uploaded_by WHERE i.analysis_id = $1 ORDER BY i.uploaded_at`,
    [analysisId],
  );
}

const PLATE_COLUMNS = `p.id, p.analysis_id, p.image_id, p.illumination, p.corners, p.outline_source, p.width_mm, p.height_mm, p.width_px, p.height_px,
  p.channel, p.post_processing, p.rectified_sha256, p.pixels_sha256, p.is_current, p.created_by, p.created_at, u.full_name AS created_by_name`;

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
    isCurrent: p.is_current,
    createdBy: p.created_by_name ?? p.created_by,
    createdAt: p.created_at.toISOString(),
  };
}

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
  const [device] = await tx.query<{ code: string; name: string; serial_number: string }>('SELECT code, name, serial_number FROM devices WHERE id = $1', [a.device_id]);
  return {
    title: `${a.code} · ${a.sample_id}${a.batch ? ` (${a.batch})` : ''}`,
    content: {
      code: a.code,
      instrument: device,
      method: { code: a.method_code, version: a.method_version, name: a.method_name, rfWindows: a.rf_windows },
      sampleId: a.sample_id,
      batch: a.batch,
      plate: { type: a.plate_type, lot: a.plate_lot, mobilePhase: a.mobile_phase, solventFrontMm: a.solvent_front_mm === null ? null : Number(a.solvent_front_mm) },
      tracks: a.tracks,
      results: a.results,
      conclusion: a.conclusion,
      remarks: a.remarks,
      analyzedBy: a.analyzed_by,
      images: imgs.map((i) => ({ illumination: i.illumination, fileName: i.file_name, sha256: i.sha256, sizeBytes: i.size_bytes })),
      straightenedPlate: plate
        ? { imageId: plate.image_id, illumination: plate.illumination, corners: plate.corners, widthMm: Number(plate.width_mm), heightMm: Number(plate.height_mm), channel: plate.channel, postProcessing: plate.post_processing, pixelsSha256: plate.pixels_sha256 }
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
    method: { id: a.method_id, versionId: a.method_version_id, code: a.method_code, version: a.method_version, name: a.method_name, rfWindows: a.rf_windows },
    sampleId: a.sample_id,
    batch: a.batch,
    plateType: a.plate_type,
    plateLot: a.plate_lot,
    mobilePhase: a.mobile_phase,
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

async function originalImage(tx: Pick<ModuleTx, 'query'>, analysisId: string, imageId: unknown) {
  if (typeof imageId !== 'string' || !UUID.test(imageId)) throw new ModuleError(400, 'Choose one of the analysis’ plate images.', 'imageId');
  const [img] = await tx.query<{ id: string; illumination: Illumination; data: Buffer; sha256: string }>(
    'SELECT id, illumination, data, sha256 FROM tlc_images WHERE id = $1 AND analysis_id = $2',
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
        return { devices, methods, engineVersion: ENGINE_VERSION };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/analyses',
      permission: 'tlc.view',
      async handler() {
        const rows = await ctx.db.query<AnalysisRow & { device_code: string }>(
          `SELECT a.*, u.full_name AS analyzed_by_name, d.code AS device_code FROM tlc_analyses a
             LEFT JOIN users u ON u.id = a.analyzed_by JOIN devices d ON d.id = a.device_id
            WHERE NOT a.is_deleted ORDER BY a.created_at DESC LIMIT 200`,
        );
        return Promise.all(rows.map(async (r) => ({ ...view(r), deviceCode: r.device_code, workflow: await ctx.workflow.forRecord(TABLE, r.id) })));
      },
    });

    ctx.http.route({
      method: 'POST',
      path: '/analyses',
      permission: 'tlc.analyze',
      async handler(req: ModuleRequest) {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const device = await usableDevice(b.deviceId);
        const method = (await ctx.methods.effective('TLC')).find((m) => m.versionId === b.methodVersionId);
        if (!method) throw new ModuleError(400, 'Choose an approved TLC method.', 'methodVersionId');
        const { windows, problems } = parseRfWindows(method.parameters);
        if (problems.length) throw new ModuleError(409, `The method's Rf windows cannot be used: ${problems.join(' ')}`, 'methodVersionId');
        const f = {
          sampleId: text(b.sampleId, 'sampleId', 'sample ID', 1, 80),
          batch: text(b.batch ?? '', 'batch', 'Batch', 0, 80),
          plateType: text(b.plateType, 'plateType', 'plate type', 2, 120),
          plateLot: text(b.plateLot ?? '', 'plateLot', 'Plate lot', 0, 80),
          mobilePhase: text(b.mobilePhase ?? '', 'mobilePhase', 'Mobile phase', 0, 300),
          remarks: text(b.remarks ?? '', 'remarks', 'Remarks', 0, 2000),
        };
        const id = await ctx.db.transaction(req.principal, 'TLC analysis created', req.origin, async (tx) => {
          const [seq] = await tx.query<{ n: string }>("SELECT nextval('tlc_analysis_code_seq') AS n");
          const code = `TLC-${String(seq.n).padStart(4, '0')}`;
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_analyses (code, device_id, method_id, method_version_id, method_code, method_version, method_name, rf_windows,
                                       sample_id, batch, plate_type, plate_lot, mobile_phase, remarks, analyzed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
            [code, device.id, method.methodId, method.versionId, method.code, method.versionNumber, method.name, JSON.stringify(windows),
             f.sampleId, f.batch, f.plateType, f.plateLot, f.mobilePhase, f.remarks, req.principal.userId],
          );
          await ctx.workflow.start(tx, req.principal, { definitionCode: WORKFLOW, tableName: TABLE, recordId: row.id, seriesId: row.id, seriesVersion: 1 });
          return row.id;
        });
        await ctx.audit.record({ action: 'TLC_ANALYSIS_CREATED', result: 'SUCCESS', principal: req.principal, recordId: id, details: { device: device.code, method: `${method.code} v${method.versionNumber}`, sampleId: f.sampleId } });
        return view(await load(ctx.db, id));
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
          device: await ctx.devices.get(a.device_id),
          images: imgs.map((i) => ({
            id: i.id,
            illumination: i.illumination,
            fileName: i.file_name,
            contentType: i.content_type,
            sizeBytes: i.size_bytes,
            sha256: i.sha256,
            uploadedBy: i.uploaded_by_name,
            uploadedAt: i.uploaded_at.toISOString(),
          })),
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
        const id = await ctx.db.transaction(req.principal, 'TLC plate image added', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'add images');
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_images (analysis_id, illumination, file_name, content_type, size_bytes, sha256, data, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [a.id, illumination, name, type, data.length, sha, data, req.principal.userId],
          );
          return row.id;
        });
        await ctx.audit.record({ action: 'TLC_IMAGE_ADDED', result: 'SUCCESS', principal: req.principal, recordId: req.params.id, details: { imageId: id, illumination, sha256: sha, sizeBytes: data.length } });
        return { id, sha256: sha, illumination, sizeBytes: data.length };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/images/:imageId',
      permission: 'tlc.view',
      async handler(req): Promise<ModuleFileResponse> {
        if (!UUID.test(req.params.imageId)) throw new ModuleError(404, 'Image not found.');
        const [img] = await ctx.db.query<{ data: Buffer; content_type: string; file_name: string; sha256: string }>(
          'SELECT data, content_type, file_name, sha256 FROM tlc_images WHERE id = $1',
          [req.params.imageId],
        );
        if (!img) throw new ModuleError(404, 'Image not found.');
        if (createHash('sha256').update(img.data).digest('hex') !== img.sha256) throw new ModuleError(409, 'The stored image no longer matches its SHA-256.');
        return { kind: 'file', contentType: img.content_type, data: img.data, fileName: img.file_name };
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
        const out = await ctx.db.transaction(req.principal, 'TLC plate straightened', req.origin, async (tx) => {
          const a = await editable(tx, req, req.params.id, 'straighten the plate');
          const img = await originalImage(tx, a.id, b.imageId);
          const original = decodeImage(img.data);
          const spec = parsePlateSpec(b, original);
          const rectified = makePlate(original, spec);
          const png = encodePng(rectified);
          const pixels = sha256(pixelBytes(rectified));
          await tx.query('UPDATE tlc_plates SET is_current = false WHERE analysis_id = $1 AND is_current', [a.id]);
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_plates (analysis_id, image_id, illumination, corners, outline_source, width_mm, height_mm, width_px, height_px, channel, post_processing,
                                     rectified, rectified_sha256, pixels_sha256, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
            [a.id, img.id, img.illumination, JSON.stringify(spec.corners), outlineSource, spec.widthMm, spec.heightMm, rectified.width, rectified.height, spec.channel,
             JSON.stringify(spec.postProcessing), png, sha256(png), pixels, req.principal.userId],
          );
          // The last evaluation stays on record (it belongs to the retired plate) but no longer
          // counts: submission needs an evaluation of the current plate.
          await tx.query("UPDATE tlc_analyses SET current_plate_id = $2, conclusion = 'INCOMPLETE' WHERE id = $1", [a.id, row.id]);
          return { id: row.id, code: a.code, pixels, width: rectified.width, height: rectified.height, illumination: img.illumination };
        });
        await ctx.audit.record({
          action: 'TLC_PLATE_STRAIGHTENED',
          result: 'SUCCESS',
          principal: req.principal,
          recordId: req.params.id,
          details: { code: out.code, plateId: out.id, illumination: out.illumination, outlineSource, widthPx: out.width, heightPx: out.height, pixelsSha256: out.pixels },
        });
        return plateView((await loadPlate(ctx.db, out.id)) as PlateRow);
      },
    });

    /** The straightened plate as PNG; ?processed=1 applies the plate's post-processing (display only). */
    ctx.http.route({
      method: 'GET',
      path: '/plates/:plateId/image',
      permission: 'tlc.view',
      async handler(req): Promise<ModuleFileResponse> {
        const p = await loadPlate(ctx.db, req.params.plateId, true);
        if (!p?.rectified) throw new ModuleError(404, 'Plate not found.');
        if (sha256(p.rectified) !== p.rectified_sha256) throw new ModuleError(409, 'The stored plate no longer matches its SHA-256.');
        if (req.query.processed === '1') {
          const processed = ImageOps.apply(decodeImage(p.rectified), p.post_processing);
          return { kind: 'file', contentType: 'image/png', data: encodePng(processed), fileName: 'plate-processed.png' };
        }
        return { kind: 'file', contentType: 'image/png', data: p.rectified, fileName: 'plate.png' };
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
          const results = computeEvaluation(decodeImage(p.rectified), { ...spec, illumination: p.illumination, pixelsSha256: p.pixels_sha256 }, input, a.rf_windows);
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
        const results = computeEvaluation(stored, { ...spec, illumination: p.illumination, pixelsSha256: p.pixels_sha256 }, e.input, a.rf_windows);
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
};

export default TlcModule;
export const register = TlcModule.register;
