import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { SignatureService } from '../signatures/signature.service';
import type { SignatureInput } from '../signatures/signature.service';
import {
  WorkflowEvent,
  WorkflowInstance,
  WorkflowService,
  WorkflowStep,
} from '../workflow/workflow.service';
import {
  CalibrationOutcome,
  CheckReading,
  computeChecks,
  computePh,
  DEFAULT_PH_LIMITS,
  PhReading,
} from './calibration-math';

export const CALIBRATION_WORKFLOW = 'CALIBRATION_APPROVAL';
const CAL_TABLE = 'calibration_records';
const INSTRUMENT_TYPES = ['PH', 'EC', 'TLC', 'OTHER'] as const;
type InstrumentType = (typeof INSTRUMENT_TYPES)[number];
const STATUSES = ['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'] as const;
type DeviceStatus = (typeof STATUSES)[number];

export type Readiness =
  | 'READY'
  | 'DUE_SOON'
  | 'OVERDUE'
  | 'NOT_CALIBRATED'
  | 'CALIBRATION_FAILED'
  | 'OUT_OF_SERVICE'
  | 'RETIRED';

export interface DeviceReadiness {
  state: Readiness;
  /** True when the instrument may be used for GxP measurements now. */
  usable: boolean;
  message: string;
  lastCalibration: {
    id: string;
    code: string;
    performedAt: string;
    outcome: CalibrationOutcome;
  } | null;
  dueAt: string | null;
}

interface DeviceRow {
  id: string;
  code: string;
  instrument_type: InstrumentType;
  name: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  asset_tag: string | null;
  location: string;
  firmware_version: string;
  installed_on: string | null;
  device_status: DeviceStatus;
  calibration_interval_days: number;
  calibration_warning_days: number;
  created_at: Date;
  version_no: number;
}

interface CalibrationRow {
  id: string;
  code: string;
  device_id: string;
  performed_at: Date;
  performed_by: string;
  performed_by_name: string | null;
  data_source: string;
  temperature_c: string | null;
  readings: unknown[];
  limits: Record<string, number>;
  results: Record<string, unknown>;
  outcome: CalibrationOutcome;
  remarks: string;
  created_at: Date;
}

const DAY = 86_400_000;

const toDevice = (r: DeviceRow) => ({
  id: r.id,
  code: r.code,
  instrumentType: r.instrument_type,
  name: r.name,
  manufacturer: r.manufacturer,
  model: r.model,
  serialNumber: r.serial_number,
  assetTag: r.asset_tag,
  location: r.location,
  firmwareVersion: r.firmware_version,
  installedOn: r.installed_on,
  status: r.device_status,
  calibrationIntervalDays: r.calibration_interval_days,
  calibrationWarningDays: r.calibration_warning_days,
  createdAt: r.created_at.toISOString(),
  versionNo: r.version_no,
});

const toCalibration = (r: CalibrationRow) => ({
  id: r.id,
  code: r.code,
  deviceId: r.device_id,
  performedAt: r.performed_at.toISOString(),
  performedBy: {
    id: r.performed_by,
    name: r.performed_by_name ?? r.performed_by,
  },
  dataSource: r.data_source,
  temperatureC: r.temperature_c === null ? null : Number(r.temperature_c),
  readings: r.readings,
  limits: r.limits,
  results: r.results,
  outcome: r.outcome,
  remarks: r.remarks,
  createdAt: r.created_at.toISOString(),
});

const str = (
  v: unknown,
  field: string,
  label: string,
  min: number,
  max: number,
  fallback?: string,
) => {
  const s =
    v === undefined ? fallback : typeof v === 'string' ? v.trim() : undefined;
  if (s === undefined || s.length < min || s.length > max)
    throw new BadRequestException({
      message:
        min > 0
          ? `Enter the ${label} (${min}–${max} characters).`
          : `${label} is too long (max ${max}).`,
      field,
    });
  return s;
};

const int = (
  v: unknown,
  field: string,
  label: string,
  min: number,
  max: number,
  fallback?: number,
) => {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw new BadRequestException({
      message: `${label} must be a whole number from ${min} to ${max}.`,
      field,
    });
  return n;
};

/**
 * Device Layer (master spec §4, §9): instrument register and calibration
 * management. A device is usable only when it is ACTIVE and its latest
 * approved calibration passed and is not overdue (LabApp
 * CalibrationComplianceHelper: measurement is blocked when overdue).
 */
@Injectable()
export class DevicesService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly signatures: SignatureService,
    private readonly workflow: WorkflowService,
  ) {}

  onModuleInit() {
    this.workflow.registerRecordType({
      tableName: CAL_TABLE,
      load: async (client, recordId) => {
        const { rows } = await client.query<
          CalibrationRow & {
            device_code: string;
            device_name: string;
            serial_number: string;
          }
        >(
          `SELECT c.*, d.code AS device_code, d.name AS device_name, d.serial_number
             FROM calibration_records c JOIN devices d ON d.id = c.device_id WHERE c.id = $1`,
          [recordId],
        );
        const c = rows[0];
        if (!c) throw new NotFoundException('Calibration not found.');
        return {
          title: `${c.code} · ${c.device_code} ${c.device_name}`,
          content: {
            calibrationCode: c.code,
            device: {
              code: c.device_code,
              name: c.device_name,
              serialNumber: c.serial_number,
            },
            performedAt: c.performed_at.toISOString(),
            performedBy: c.performed_by,
            dataSource: c.data_source,
            temperatureC:
              c.temperature_c === null ? null : Number(c.temperature_c),
            readings: c.readings,
            limits: c.limits,
            results: c.results,
            outcome: c.outcome,
            remarks: c.remarks,
          },
        };
      },
      link: (seriesId) => `/devices/view/?calibration=${seriesId}`,
      authorOf: async (client, recordId) => {
        const { rows } = await client.query<{ performed_by: string }>(
          'SELECT performed_by FROM calibration_records WHERE id = $1',
          [recordId],
        );
        return rows[0]?.performed_by ?? null;
      },
    });
  }

  private requireAny(principal: Principal, ...perms: string[]) {
    if (!perms.some((p) => principal.permissions.includes(p)))
      throw new ForbiddenException(
        'You do not have permission for this action.',
      );
  }

  private reason(input: unknown, min = 5) {
    const r = typeof input === 'string' ? input.trim() : '';
    if (r.length < min)
      throw new BadRequestException({
        message: `Enter a reason for this change (at least ${min} characters).`,
        field: 'reason',
      });
    return r;
  }

  private async event(
    client: PoolClient,
    principal: Principal,
    origin: RequestOrigin,
    action: string,
    tableName: string,
    recordId: string,
    reason: string | null,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    await this.audit.record(
      {
        category: 'DEVICES',
        action,
        result: 'SUCCESS',
        actor: principal.userId,
        actorName: principal.fullName,
        tableName,
        recordId,
        reason,
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        details,
      },
      client,
    );
  }

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------

  private async readiness(
    d: DeviceRow,
    now = new Date(),
  ): Promise<DeviceReadiness> {
    const [last] = await this.db.query<{
      id: string;
      code: string;
      performed_at: Date;
      outcome: CalibrationOutcome;
    }>(
      `SELECT c.id, c.code, c.performed_at, c.outcome FROM calibration_records c
         JOIN workflow_instances wi ON wi.table_name = '${CAL_TABLE}' AND wi.record_id = c.id::text
        WHERE c.device_id = $1 AND wi.state = 'APPROVED' AND NOT c.is_deleted
        ORDER BY c.performed_at DESC LIMIT 1`,
      [d.id],
    );
    const lastCalibration = last
      ? {
          id: last.id,
          code: last.code,
          performedAt: last.performed_at.toISOString(),
          outcome: last.outcome,
        }
      : null;
    const dueAt = last
      ? new Date(
          last.performed_at.getTime() + d.calibration_interval_days * DAY,
        )
      : null;
    const base = { lastCalibration, dueAt: dueAt?.toISOString() ?? null };
    if (d.device_status === 'RETIRED')
      return {
        ...base,
        state: 'RETIRED',
        usable: false,
        message: 'Retired. It can no longer be used.',
      };
    if (d.device_status === 'OUT_OF_SERVICE')
      return {
        ...base,
        state: 'OUT_OF_SERVICE',
        usable: false,
        message: 'Out of service. Return it to service before use.',
      };
    if (!last)
      return {
        ...base,
        state: 'NOT_CALIBRATED',
        usable: false,
        message: 'No approved calibration. Calibrate before use.',
      };
    if (last.outcome === 'FAIL')
      return {
        ...base,
        state: 'CALIBRATION_FAILED',
        usable: false,
        message: `Last approved calibration (${last.code}) failed. Recalibrate or take it out of service.`,
      };
    if (now.getTime() > dueAt!.getTime())
      return {
        ...base,
        state: 'OVERDUE',
        usable: false,
        message:
          'Calibration overdue. Measurements are blocked until it is recalibrated.',
      };
    if (now.getTime() > dueAt!.getTime() - d.calibration_warning_days * DAY)
      return {
        ...base,
        state: 'DUE_SOON',
        usable: true,
        message: 'Calibration due soon.',
      };
    return {
      ...base,
      state: 'READY',
      usable: true,
      message: 'Calibrated and ready.',
    };
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  private async loadDevice(
    client: Pick<PoolClient, 'query'>,
    id: string,
    lock = false,
  ): Promise<DeviceRow> {
    const { rows } = await client.query<DeviceRow>(
      `SELECT * FROM devices WHERE id = $1 AND NOT is_deleted${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Instrument not found.');
    return rows[0];
  }

  async list() {
    const rows = await this.db.query<DeviceRow>(
      'SELECT * FROM devices WHERE NOT is_deleted ORDER BY code',
    );
    return Promise.all(
      rows.map(async (r) => ({
        ...toDevice(r),
        readiness: await this.readiness(r),
      })),
    );
  }

  async get(id: string, principal: Principal) {
    const client = await this.db.connect();
    let d: DeviceRow;
    try {
      d = await this.loadDevice(client, id);
    } finally {
      client.release();
    }
    const cals = await this.db.query<CalibrationRow>(
      `SELECT c.*, u.full_name AS performed_by_name FROM calibration_records c
         LEFT JOIN users u ON u.id = c.performed_by
        WHERE c.device_id = $1 AND NOT c.is_deleted ORDER BY c.performed_at DESC`,
      [id],
    );
    const calibrations: (ReturnType<typeof toCalibration> & {
      workflow: WorkflowInstance;
      allowedSteps: WorkflowStep[];
      history: WorkflowEvent[];
    })[] = [];
    for (const c of cals) {
      const [wf] = await this.workflow.forSeries(CALIBRATION_WORKFLOW, c.id);
      calibrations.push({
        ...toCalibration(c),
        workflow: wf,
        allowedSteps: await this.workflow.allowedSteps(wf, principal),
        history: await this.workflow.history(wf.id),
      });
    }
    return {
      ...toDevice(d),
      readiness: await this.readiness(d),
      calibrations,
      history: await this.audit.list({ recordId: id, limit: 100 }),
      canManage: principal.permissions.includes('devices.manage'),
      canCalibrate:
        principal.permissions.includes('calibration.perform') &&
        d.device_status === 'ACTIVE' &&
        !calibrations.some((c) =>
          ['DRAFT', 'IN_REVIEW'].includes(c.workflow.state),
        ),
    };
  }

  /** Device of a calibration, for links from the review queue. */
  async deviceOfCalibration(calibrationId: string) {
    const [row] = await this.db.query<{ device_id: string }>(
      'SELECT device_id FROM calibration_records WHERE id = $1',
      [calibrationId],
    );
    if (!row) throw new NotFoundException('Calibration not found.');
    return { deviceId: row.device_id };
  }

  private parseDevice(input: Record<string, unknown>, current?: DeviceRow) {
    const date = (v: unknown, fallback: string | null | undefined) => {
      if (v === undefined) return fallback ?? null;
      if (v === null || v === '') return null;
      if (
        typeof v !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
        Number.isNaN(Date.parse(v))
      )
        throw new BadRequestException({
          message: 'Enter the installation date as YYYY-MM-DD.',
          field: 'installedOn',
        });
      return v;
    };
    const tag =
      input.assetTag === undefined
        ? (current?.asset_tag ?? null)
        : typeof input.assetTag === 'string' && input.assetTag.trim()
          ? input.assetTag.trim().slice(0, 60)
          : null;
    return {
      name: str(input.name, 'name', 'instrument name', 2, 120, current?.name),
      manufacturer: str(
        input.manufacturer,
        'manufacturer',
        'manufacturer',
        1,
        120,
        current?.manufacturer,
      ),
      model: str(input.model, 'model', 'model', 1, 120, current?.model),
      serialNumber: str(
        input.serialNumber,
        'serialNumber',
        'serial number',
        1,
        80,
        current?.serial_number,
      ),
      assetTag: tag,
      location: str(
        input.location,
        'location',
        'Location',
        0,
        200,
        current?.location ?? '',
      ),
      firmwareVersion: str(
        input.firmwareVersion,
        'firmwareVersion',
        'Firmware version',
        0,
        60,
        current?.firmware_version ?? '',
      ),
      installedOn: date(input.installedOn, current?.installed_on),
      intervalDays: int(
        input.calibrationIntervalDays,
        'calibrationIntervalDays',
        'Calibration interval (days)',
        1,
        730,
        current?.calibration_interval_days ?? 30,
      ),
      warningDays: int(
        input.calibrationWarningDays,
        'calibrationWarningDays',
        'Warning before due (days)',
        0,
        60,
        current?.calibration_warning_days ?? 7,
      ),
    };
  }

  private async assertUnique(
    client: PoolClient,
    f: {
      manufacturer: string;
      model: string;
      serialNumber: string;
      assetTag: string | null;
    },
    exceptId?: string,
  ) {
    const { rows } = await client.query<{ field: string }>(
      `SELECT CASE WHEN manufacturer = $1 AND model = $2 AND serial_number = $3 THEN 'serialNumber' ELSE 'assetTag' END AS field
         FROM devices
        WHERE id IS DISTINCT FROM $5
          AND ((manufacturer = $1 AND model = $2 AND serial_number = $3) OR ($4::text IS NOT NULL AND lower(asset_tag) = lower($4)))
        LIMIT 1`,
      [f.manufacturer, f.model, f.serialNumber, f.assetTag, exceptId ?? null],
    );
    if (rows[0])
      throw new ConflictException({
        message:
          rows[0].field === 'serialNumber'
            ? 'An instrument with this manufacturer, model and serial number is already registered.'
            : 'This asset tag is already used by another instrument.',
        field: rows[0].field,
      });
  }

  async register(
    principal: Principal,
    input: Record<string, unknown>,
    origin: RequestOrigin,
    signature?: SignatureInput,
  ) {
    this.requireAny(principal, 'devices.manage');
    const reason = this.reason(input.reason);
    const type = input.instrumentType as InstrumentType;
    if (!INSTRUMENT_TYPES.includes(type))
      throw new BadRequestException({
        message: 'Choose the instrument type.',
        field: 'instrumentType',
      });
    const f = this.parseDevice(input);
    const signer = await this.signatures.authorize(
      'DEVICE_REGISTER',
      principal,
      signature,
      reason,
      origin,
    );
    const id = await this.db.transaction(
      this.workflow.actor(principal, reason, origin),
      async (client) => {
        await this.assertUnique(client, f);
        const { rows: seq } = await client.query<{ n: string }>(
          "SELECT nextval('device_code_seq') AS n",
        );
        const code = `DEV-${String(seq[0].n).padStart(4, '0')}`;
        const { rows } = await client.query<{ id: string; version_no: number }>(
          `INSERT INTO devices (code, instrument_type, name, manufacturer, model, serial_number, asset_tag, location,
                              firmware_version, installed_on, calibration_interval_days, calibration_warning_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, version_no`,
          [
            code,
            type,
            f.name,
            f.manufacturer,
            f.model,
            f.serialNumber,
            f.assetTag,
            f.location,
            f.firmwareVersion,
            f.installedOn,
            f.intervalDays,
            f.warningDays,
          ],
        );
        await this.event(
          client,
          principal,
          origin,
          'DEVICE_REGISTERED',
          'devices',
          rows[0].id,
          reason,
          { code, serialNumber: f.serialNumber },
        );
        if (signer)
          await this.signatures.apply(
            client,
            signer,
            {
              tableName: 'devices',
              recordId: rows[0].id,
              recordVersion: rows[0].version_no,
              content: { code, instrumentType: type, ...f },
            },
            origin,
          );
        return rows[0].id;
      },
    );
    return this.get(id, principal);
  }

  async update(
    principal: Principal,
    id: string,
    input: Record<string, unknown>,
    origin: RequestOrigin,
    signature?: SignatureInput,
  ) {
    this.requireAny(principal, 'devices.manage');
    const reason = this.reason(input.reason);
    const signer = await this.signatures.authorize(
      'DEVICE_UPDATE',
      principal,
      signature,
      reason,
      origin,
    );
    await this.db.transaction(
      this.workflow.actor(principal, reason, origin),
      async (client) => {
        const d = await this.loadDevice(client, id, true);
        if (d.device_status === 'RETIRED')
          throw new ConflictException(
            'A retired instrument cannot be changed.',
          );
        const f = this.parseDevice(input, d);
        await this.assertUnique(client, f, id);
        const before = this.parseDevice({}, d);
        const changed = (Object.keys(f) as (keyof typeof f)[]).filter(
          (k) => f[k] !== before[k],
        );
        if (!changed.length) throw new BadRequestException('Nothing changed.');
        const { rows } = await client.query<{ version_no: number }>(
          `UPDATE devices SET name = $2, manufacturer = $3, model = $4, serial_number = $5, asset_tag = $6, location = $7,
                firmware_version = $8, installed_on = $9, calibration_interval_days = $10, calibration_warning_days = $11
          WHERE id = $1 RETURNING version_no`,
          [
            id,
            f.name,
            f.manufacturer,
            f.model,
            f.serialNumber,
            f.assetTag,
            f.location,
            f.firmwareVersion,
            f.installedOn,
            f.intervalDays,
            f.warningDays,
          ],
        );
        await this.event(
          client,
          principal,
          origin,
          'DEVICE_UPDATED',
          'devices',
          id,
          reason,
          { changed: changed.join(',') },
        );
        if (signer)
          await this.signatures.apply(
            client,
            signer,
            {
              tableName: 'devices',
              recordId: id,
              recordVersion: rows[0].version_no,
              content: {
                code: d.code,
                changes: Object.fromEntries(
                  changed.map((k) => [k, { from: before[k], to: f[k] }]),
                ),
              },
            },
            origin,
          );
      },
    );
    return this.get(id, principal);
  }

  async setStatus(
    principal: Principal,
    id: string,
    statusInput: unknown,
    reasonInput: unknown,
    origin: RequestOrigin,
    signature?: SignatureInput,
  ) {
    this.requireAny(principal, 'devices.manage');
    const status = statusInput as DeviceStatus;
    if (!STATUSES.includes(status))
      throw new BadRequestException('Unknown status.');
    const reason = this.reason(reasonInput, 10);
    const signer = await this.signatures.authorize(
      'DEVICE_STATUS_CHANGE',
      principal,
      signature,
      reason,
      origin,
    );
    await this.db.transaction(
      this.workflow.actor(principal, reason, origin),
      async (client) => {
        const d = await this.loadDevice(client, id, true);
        if (d.device_status === status)
          throw new BadRequestException(
            'The instrument already has this status.',
          );
        if (d.device_status === 'RETIRED')
          throw new ConflictException(
            'A retired instrument cannot return to service.',
          );
        const { rows } = await client.query<{ version_no: number }>(
          'UPDATE devices SET device_status = $2 WHERE id = $1 RETURNING version_no',
          [id, status],
        );
        await this.event(
          client,
          principal,
          origin,
          'DEVICE_STATUS_CHANGED',
          'devices',
          id,
          reason,
          { from: d.device_status, to: status },
        );
        if (signer)
          await this.signatures.apply(
            client,
            signer,
            {
              tableName: 'devices',
              recordId: id,
              recordVersion: rows[0].version_no,
              content: {
                code: d.code,
                status: { from: d.device_status, to: status },
              },
            },
            origin,
          );
      },
    );
    return this.get(id, principal);
  }

  // ---------------------------------------------------------------------------
  // Calibrations
  // ---------------------------------------------------------------------------

  private parseCalibration(
    type: InstrumentType,
    input: Record<string, unknown>,
  ) {
    const remarks = str(input.remarks, 'remarks', 'Remarks', 0, 2000, '');
    const performedAt =
      input.performedAt === undefined
        ? new Date()
        : typeof input.performedAt === 'string'
          ? new Date(input.performedAt)
          : new Date(NaN);
    if (
      Number.isNaN(performedAt.getTime()) ||
      performedAt.getTime() > Date.now() + 5 * 60_000 ||
      performedAt.getTime() < Date.now() - 7 * DAY
    )
      throw new BadRequestException({
        message:
          'The calibration time must be within the last 7 days and not in the future.',
        field: 'performedAt',
      });

    if (type === 'PH') {
      const t = input.temperatureC;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 100)
        throw new BadRequestException({
          message: 'Enter the buffer temperature (0–100 °C).',
          field: 'temperatureC',
        });
      if (
        !Array.isArray(input.readings) ||
        input.readings.length < 2 ||
        input.readings.length > 5
      )
        throw new BadRequestException({
          message: 'Enter 2 to 5 buffer readings.',
          field: 'readings',
        });
      const readings: PhReading[] = input.readings.map(
        (r: Record<string, unknown>, i: number) => {
          const bufferPh = r?.bufferPh;
          const mv = r?.mv;
          if (
            typeof bufferPh !== 'number' ||
            bufferPh < 0 ||
            bufferPh > 14 ||
            typeof mv !== 'number' ||
            Math.abs(mv) > 1000
          )
            throw new BadRequestException({
              message: `Buffer ${i + 1}: pH 0–14 and potential within ±1000 mV.`,
              field: 'readings',
            });
          return { bufferPh, mv };
        },
      );
      if (new Set(readings.map((r) => r.bufferPh)).size !== readings.length)
        throw new BadRequestException({
          message: 'Each buffer must have a different pH.',
          field: 'readings',
        });
      if (
        Math.max(...readings.map((r) => r.bufferPh)) -
          Math.min(...readings.map((r) => r.bufferPh)) <
        2
      )
        throw new BadRequestException({
          message: 'Buffers must span at least 2 pH units.',
          field: 'readings',
        });
      const limits = DEFAULT_PH_LIMITS;
      const { outcome, ...results } = computePh(readings, t, limits);
      return {
        performedAt,
        temperatureC: t,
        readings,
        limits: { ...limits },
        results,
        outcome,
        remarks,
      };
    }

    if (
      !Array.isArray(input.readings) ||
      input.readings.length < 1 ||
      input.readings.length > 30
    )
      throw new BadRequestException({
        message: 'Enter 1 to 30 calibration checks.',
        field: 'readings',
      });
    const readings: CheckReading[] = input.readings.map(
      (r: Record<string, unknown>, i: number) => {
        const check = typeof r?.check === 'string' ? r.check.trim() : '';
        const expected =
          typeof r?.expected === 'string' ? r.expected.trim() : '';
        const observed =
          typeof r?.observed === 'string' ? r.observed.trim() : '';
        if (
          !check ||
          check.length > 120 ||
          expected.length > 120 ||
          !observed ||
          observed.length > 120 ||
          typeof r?.pass !== 'boolean'
        )
          throw new BadRequestException({
            message: `Check ${i + 1}: enter what was checked, the observed value and whether it passed.`,
            field: 'readings',
          });
        return { check, expected, observed, pass: r.pass };
      },
    );
    const { outcome, ...results } = computeChecks(readings);
    const temperatureC =
      typeof input.temperatureC === 'number' ? input.temperatureC : null;
    return {
      performedAt,
      temperatureC,
      readings,
      limits: {},
      results,
      outcome,
      remarks,
    };
  }

  /** Record a calibration as a draft; the performer then submits it for approval. */
  async recordCalibration(
    principal: Principal,
    deviceId: string,
    input: Record<string, unknown>,
    origin: RequestOrigin,
  ) {
    this.requireAny(principal, 'calibration.perform');
    const calibrationId = await this.db.transaction(
      this.workflow.actor(principal, 'Calibration recorded', origin),
      async (client) => {
        const d = await this.loadDevice(client, deviceId, true);
        if (d.device_status !== 'ACTIVE')
          throw new ConflictException(
            'Only an active instrument can be calibrated. Return it to service first.',
          );
        const { rows: open } = await client.query(
          `SELECT 1 FROM calibration_records c JOIN workflow_instances wi ON wi.table_name = '${CAL_TABLE}' AND wi.record_id = c.id::text
          WHERE c.device_id = $1 AND wi.state IN ('DRAFT', 'IN_REVIEW')`,
          [deviceId],
        );
        if (open.length)
          throw new ConflictException(
            'This instrument already has a calibration in progress. Finish or withdraw it first.',
          );
        const c = this.parseCalibration(d.instrument_type, input);
        const { rows: seq } = await client.query<{ n: string }>(
          "SELECT nextval('calibration_code_seq') AS n",
        );
        const code = `CAL-${String(seq[0].n).padStart(5, '0')}`;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO calibration_records (code, device_id, performed_at, performed_by, temperature_c, readings, limits, results, outcome, remarks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            code,
            deviceId,
            c.performedAt,
            principal.userId,
            c.temperatureC,
            JSON.stringify(c.readings),
            JSON.stringify(c.limits),
            JSON.stringify(c.results),
            c.outcome,
            c.remarks,
          ],
        );
        await this.workflow.start(client, principal, {
          definitionCode: CALIBRATION_WORKFLOW,
          tableName: CAL_TABLE,
          recordId: rows[0].id,
          seriesId: rows[0].id,
          seriesVersion: 1,
        });
        await this.event(
          client,
          principal,
          origin,
          'CALIBRATION_RECORDED',
          CAL_TABLE,
          rows[0].id,
          null,
          { code, device: d.code, outcome: c.outcome },
        );
        return rows[0].id;
      },
    );
    return { calibrationId, device: await this.get(deviceId, principal) };
  }

  /** Correct a draft calibration before submission; only the person who performed it. */
  async updateCalibration(
    principal: Principal,
    deviceId: string,
    calibrationId: string,
    input: Record<string, unknown>,
    origin: RequestOrigin,
  ) {
    this.requireAny(principal, 'calibration.perform');
    await this.db.transaction(
      this.workflow.actor(principal, 'Draft calibration corrected', origin),
      async (client) => {
        await this.workflow.assertEditable(client, CAL_TABLE, calibrationId);
        const { rows } = await client.query<{
          device_id: string;
          performed_by: string;
        }>(
          'SELECT device_id, performed_by FROM calibration_records WHERE id = $1',
          [calibrationId],
        );
        if (!rows[0] || rows[0].device_id !== deviceId)
          throw new NotFoundException('Calibration not found.');
        if (rows[0].performed_by !== principal.userId)
          throw new ForbiddenException(
            'Only the person who performed the calibration can correct it.',
          );
        const d = await this.loadDevice(client, deviceId);
        const c = this.parseCalibration(d.instrument_type, input);
        await client.query(
          `UPDATE calibration_records SET performed_at = $2, temperature_c = $3, readings = $4, limits = $5, results = $6, outcome = $7, remarks = $8
          WHERE id = $1`,
          [
            calibrationId,
            c.performedAt,
            c.temperatureC,
            JSON.stringify(c.readings),
            JSON.stringify(c.limits),
            JSON.stringify(c.results),
            c.outcome,
            c.remarks,
          ],
        );
      },
    );
    return this.get(deviceId, principal);
  }
}
