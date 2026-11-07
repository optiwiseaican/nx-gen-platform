import { createHash } from 'crypto';
import type { DeviceInfo, ModuleContext, ModuleFileResponse, ModuleRequest, ModuleTx, NxGenModule } from '@crescent/module-sdk';
import { ModuleError } from '@crescent/module-sdk';
import { evaluate, ILLUMINATIONS, Illumination, imageType, parseRfWindows, RfWindow, TrackInput, validatePlate } from '../shared/tlc';

const TABLE = 'tlc_analyses';
const WORKFLOW = 'TLC_ANALYSIS_APPROVAL';
const MAX_IMAGE = 15 * 1024 * 1024;

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

let ctx: ModuleContext;

const text = (v: unknown, field: string, label: string, min: number, max: number) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max)
    throw new ModuleError(400, min ? `Enter the ${label} (${min}–${max} characters).` : `${label} is too long (max ${max}).`, field);
  return s;
};

async function load(tx: Pick<ModuleTx, 'query'>, id: string): Promise<AnalysisRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ModuleError(404, 'Analysis not found.');
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

/** What reviewers and approvers sign: the record and the hashes of its original images. */
async function content(tx: Pick<ModuleTx, 'query'>, id: string) {
  const a = await load(tx, id);
  const imgs = await images(tx, id);
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
        if (a.solvent_front_mm === null || !a.tracks.length) return 'Evaluate the plate (solvent front and tracks) before submitting.';
        if (a.conclusion === 'INCOMPLETE') return 'The evaluation is incomplete: it needs standard and sample tracks and Rf windows from the method.';
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
        return { devices, methods };
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
          workflow: await ctx.workflow.forRecord(TABLE, a.id),
        };
      },
    });

    /** Save the plate evaluation (draft only, by the analyst). Results are computed here, not by the browser. */
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
          await ctx.workflow.assertEditable(tx, TABLE, req.params.id);
          const a = await load(tx, req.params.id);
          if (a.analyzed_by !== req.principal.userId) throw new ModuleError(403, 'Only the analyst who created the analysis can evaluate it.');
          const e = evaluate(front!, tracks, a.rf_windows);
          await tx.query(
            'UPDATE tlc_analyses SET solvent_front_mm = $2, tracks = $3, results = $4, conclusion = $5, remarks = $6 WHERE id = $1',
            [a.id, front, JSON.stringify(tracks), JSON.stringify(e), e.conclusion, typeof b.remarks === 'string' ? b.remarks.trim().slice(0, 2000) : a.remarks],
          );
        });
        const a = await load(ctx.db, req.params.id);
        await ctx.audit.record({ action: 'TLC_PLATE_EVALUATED', result: 'SUCCESS', principal: req.principal, recordId: a.id, details: { code: a.code, conclusion: a.conclusion, tracks: tracks.length } });
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
        const sha256 = createHash('sha256').update(data).digest('hex');
        const id = await ctx.db.transaction(req.principal, 'TLC plate image added', req.origin, async (tx) => {
          await ctx.workflow.assertEditable(tx, TABLE, req.params.id);
          const a = await load(tx, req.params.id);
          if (a.analyzed_by !== req.principal.userId) throw new ModuleError(403, 'Only the analyst who created the analysis can add images.');
          const [row] = await tx.query<{ id: string }>(
            `INSERT INTO tlc_images (analysis_id, illumination, file_name, content_type, size_bytes, sha256, data, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [a.id, illumination, name, type, data.length, sha256, data, req.principal.userId],
          );
          return row.id;
        });
        await ctx.audit.record({ action: 'TLC_IMAGE_ADDED', result: 'SUCCESS', principal: req.principal, recordId: req.params.id, details: { imageId: id, illumination, sha256, sizeBytes: data.length } });
        return { id, sha256, illumination, sizeBytes: data.length };
      },
    });

    ctx.http.route({
      method: 'GET',
      path: '/images/:imageId',
      permission: 'tlc.view',
      async handler(req): Promise<ModuleFileResponse> {
        if (!/^[0-9a-f-]{36}$/i.test(req.params.imageId)) throw new ModuleError(404, 'Image not found.');
        const [img] = await ctx.db.query<{ data: Buffer; content_type: string; file_name: string; sha256: string }>(
          'SELECT data, content_type, file_name, sha256 FROM tlc_images WHERE id = $1',
          [req.params.imageId],
        );
        if (!img) throw new ModuleError(404, 'Image not found.');
        if (createHash('sha256').update(img.data).digest('hex') !== img.sha256) throw new ModuleError(409, 'The stored image no longer matches its SHA-256.');
        return { kind: 'file', contentType: img.content_type, data: img.data, fileName: img.file_name };
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
