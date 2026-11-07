import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CalibrationInput, DeviceInfo } from '@crescent/module-sdk';
import { AuditService } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { ModuleRegistry } from '../modules/module-registry';
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
} from './calibration-math';

export const CALIBRATION_WORKFLOW = 'CALIBRATION_APPROVAL';
const CAL_TABLE = 'calibration_records';
/** Instrument type whose calibration (a checklist) is built into the core. */
export const CORE_INSTRUMENT_TYPE = 'OTHER';
const STATUSES = ['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'] as const;
type DeviceStatus = (typeof STATUSES)[number];
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

export type Readiness =
  | 'READY'
  | 'DUE_SOON'
  | 'OVERDUE'
  | 'NOT_CALIBRATED'
  | 'CALIBRATION_FAILED'
  | 'MODULE_UNAVAILABLE'
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
  instrument_type: string;
  name: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  asset_tag: string | null;
  location: string;
  firmware_version: string;
  installed_on: string | null;
  device_status: DeviceStatus;
  device_identifier: string | null;
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
  limits: Record<string, unknown>;
  results: Record<string, unknown>;
  display: { label: string; value: string }[];
  source_messages: number[];
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
  deviceIdentifier: r.device_identifier,
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
  display: r.display,
  sourceMessages: r.source_messages,
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
 * Device Layer (master spec §4, §9): instrument register, calibration records
 * and readiness. Instrument-specific calibration (e.g. pH slope and offset)
 * belongs to the module that provides the instrument type; the core keeps the
 * record, the approval workflow and the usability rule:
 * an instrument is usable only when it is ACTIVE, its module is available, and
 * its latest approved calibration passed and is not overdue.
 */
@Injectable()
export class DevicesService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly signatures: SignatureService,
    private readonly workflow: WorkflowService,
    private readonly registry: ModuleRegistry,
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
            sourceMessages: c.source_messages,
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
    this.registry.setDeviceDirectory({
      get: (id) => this.info({ id }),
      byIdentifier: (identifier) => this.info({ identifier }),
      list: async (type) => {
        const rows = await this.db.query<DeviceRow>(
          'SELECT * FROM devices WHERE instrument_type = $1 AND NOT is_deleted ORDER BY code',
          [type],
        );
        return Promise.all(rows.map((r) => this.toInfo(r)));
      },
    });
  }

  private async info(by: {
    id?: string;
    identifier?: string;
  }): Promise<DeviceInfo | null> {
    if (by.id && !/^[0-9a-f-]{36}$/i.test(by.id)) return null;
    const [r] = await this.db.query<DeviceRow>(
      `SELECT * FROM devices WHERE ${by.id ? 'id = $1' : 'device_identifier = $1'} AND NOT is_deleted`,
      [by.id ?? by.identifier],
    );
    return r ? this.toInfo(r) : null;
  }

  private async toInfo(r: DeviceRow): Promise<DeviceInfo> {
    const rd = await this.readiness(r);
    return {
      id: r.id,
      code: r.code,
      instrumentType: r.instrument_type,
      name: r.name,
      manufacturer: r.manufacturer,
      model: r.model,
      serialNumber: r.serial_number,
      location: r.location,
      status: r.device_status,
      deviceIdentifier: r.device_identifier,
      readiness: {
        state: rd.state,
        usable: rd.usable,
        message: rd.message,
        dueAt: rd.dueAt,
      },
    };
  }

  private requireAny(
    principal: Pick<Principal, 'permissions'>,
    ...perms: string[]
  ) {
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

  private actor(
    principal: Pick<Principal, 'userId' | 'fullName'>,
    reason: string | null,
    origin: RequestOrigin,
  ) {
    return {
      actorId: principal.userId,
      actorName: principal.fullName,
      reason: reason ?? undefined,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
    };
  }

  private async event(
    client: PoolClient,
    principal: Pick<Principal, 'userId' | 'fullName'>,
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
  // Instrument types
  // ---------------------------------------------------------------------------

  async instrumentTypes() {
    const rows = await this.db.query<{
      code: string;
      label: string;
      module_id: string | null;
    }>(
      'SELECT code, label, module_id FROM instrument_types WHERE NOT is_deleted ORDER BY code = $1, label',
      [CORE_INSTRUMENT_TYPE],
    );
    return rows.map((r) => {
      const provider = this.registry.providerOf(r.code);
      return {
        code: r.code,
        label: r.label,
        moduleId: r.module_id,
        available: this.registry.typeAvailable(r.code),
        moduleName: provider?.manifest.name ?? null,
        moduleUi: provider?.manifest.uiEntry
          ? `/modules/${provider.id}/`
          : null,
      };
    });
  }

  private async typeLabel(code: string) {
    const [r] = await this.db.query<{
      label: string;
      module_id: string | null;
    }>('SELECT label, module_id FROM instrument_types WHERE code = $1', [code]);
    return r;
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
    if (!this.registry.typeAvailable(d.instrument_type))
      return {
        ...base,
        state: 'MODULE_UNAVAILABLE',
        usable: false,
        message: `The NxGen module for this instrument type (${d.instrument_type}) is not installed, enabled or licensed.`,
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
    const provider = this.registry.providerOf(d.instrument_type);
    const open = calibrations.some((c) =>
      ['DRAFT', 'IN_REVIEW'].includes(c.workflow.state),
    );
    return {
      ...toDevice(d),
      instrumentTypeLabel:
        (await this.typeLabel(d.instrument_type))?.label ?? d.instrument_type,
      readiness: await this.readiness(d),
      calibrations,
      history: await this.audit.list({ recordId: id, limit: 100 }),
      module: provider
        ? {
            id: provider.id,
            name: provider.manifest.name,
            ui: provider.manifest.uiEntry
              ? `/modules/${provider.id}/?device=${d.id}`
              : null,
          }
        : null,
      canManage: principal.permissions.includes('devices.manage'),
      /** Checklist calibration in the core (OTHER). Module types calibrate in their module. */
      canCalibrate:
        d.instrument_type === CORE_INSTRUMENT_TYPE &&
        principal.permissions.includes('calibration.perform') &&
        d.device_status === 'ACTIVE' &&
        !open,
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
    const optional = (
      v: unknown,
      fallback: string | null | undefined,
      max: number,
    ) =>
      v === undefined
        ? (fallback ?? null)
        : typeof v === 'string' && v.trim()
          ? v.trim().slice(0, max)
          : null;
    const identifier = optional(
      input.deviceIdentifier,
      current?.device_identifier,
      64,
    );
    if (identifier && !IDENTIFIER.test(identifier))
      throw new BadRequestException({
        message:
          'The instrument ID (DEVICE_ID in its data) may contain letters, digits and . _ : - only (max 64).',
        field: 'deviceIdentifier',
      });
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
      assetTag: optional(input.assetTag, current?.asset_tag, 60),
      deviceIdentifier: identifier,
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
      deviceIdentifier: string | null;
    },
    exceptId?: string,
  ) {
    const { rows } = await client.query<{ field: string }>(
      `SELECT CASE WHEN manufacturer = $1 AND model = $2 AND serial_number = $3 THEN 'serialNumber'
                   WHEN $6::text IS NOT NULL AND device_identifier = $6 THEN 'deviceIdentifier'
                   ELSE 'assetTag' END AS field
         FROM devices
        WHERE id IS DISTINCT FROM $5
          AND ((manufacturer = $1 AND model = $2 AND serial_number = $3)
               OR ($4::text IS NOT NULL AND lower(asset_tag) = lower($4))
               OR ($6::text IS NOT NULL AND device_identifier = $6))
        LIMIT 1`,
      [
        f.manufacturer,
        f.model,
        f.serialNumber,
        f.assetTag,
        exceptId ?? null,
        f.deviceIdentifier,
      ],
    );
    if (rows[0])
      throw new ConflictException({
        message: {
          serialNumber:
            'An instrument with this manufacturer, model and serial number is already registered.',
          assetTag: 'This asset tag is already used by another instrument.',
          deviceIdentifier:
            'This instrument ID is already linked to another instrument.',
        }[rows[0].field],
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
    const type =
      typeof input.instrumentType === 'string' ? input.instrumentType : '';
    const typeRow = type ? await this.typeLabel(type) : undefined;
    if (!typeRow)
      throw new BadRequestException({
        message: 'Choose the instrument type.',
        field: 'instrumentType',
      });
    if (!this.registry.typeAvailable(type))
      throw new ConflictException({
        message: `Install and enable the NxGen module for ${typeRow.label} instruments first.`,
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
          `INSERT INTO devices (code, instrument_type, name, manufacturer, model, serial_number, asset_tag, device_identifier, location,
                              firmware_version, installed_on, calibration_interval_days, calibration_warning_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, version_no`,
          [
            code,
            type,
            f.name,
            f.manufacturer,
            f.model,
            f.serialNumber,
            f.assetTag,
            f.deviceIdentifier,
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
          {
            code,
            serialNumber: f.serialNumber,
            instrumentType: type,
          },
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
          `UPDATE devices SET name = $2, manufacturer = $3, model = $4, serial_number = $5, asset_tag = $6, device_identifier = $7,
                location = $8, firmware_version = $9, installed_on = $10, calibration_interval_days = $11, calibration_warning_days = $12
          WHERE id = $1 RETURNING version_no`,
          [
            id,
            f.name,
            f.manufacturer,
            f.model,
            f.serialNumber,
            f.assetTag,
            f.deviceIdentifier,
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

  /** Core checklist calibration for OTHER instruments. */
  private checklist(input: Record<string, unknown>): CalibrationInput {
    const remarks = str(input.remarks, 'remarks', 'Remarks', 0, 2000, '');
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
    return {
      performedAt:
        typeof input.performedAt === 'string' ? input.performedAt : undefined,
      temperatureC: null,
      readings,
      limits: {},
      results,
      display: [
        {
          label: 'Checks passed',
          value: `${results.passed} of ${readings.length}`,
        },
      ],
      outcome,
      remarks,
      dataSource: 'MANUAL',
      sourceMessages: [],
    };
  }

  private performedAt(v: string | undefined) {
    const at = v === undefined ? new Date() : new Date(v);
    if (
      Number.isNaN(at.getTime()) ||
      at.getTime() > Date.now() + 5 * 60_000 ||
      at.getTime() < Date.now() - 7 * DAY
    )
      throw new BadRequestException({
        message:
          'The calibration time must be within the last 7 days and not in the future.',
        field: 'performedAt',
      });
    return at;
  }

  /** HTTP: checklist calibration of an OTHER instrument. */
  async recordCalibration(
    principal: Principal,
    deviceId: string,
    input: Record<string, unknown>,
    origin: RequestOrigin,
  ) {
    this.requireAny(principal, 'calibration.perform');
    const d = await this.info({ id: deviceId });
    if (!d) throw new NotFoundException('Instrument not found.');
    if (d.instrumentType !== CORE_INSTRUMENT_TYPE) {
      const provider = this.registry.providerOf(d.instrumentType);
      throw new ConflictException(
        provider
          ? `Calibrate ${d.code} in the ${provider.manifest.name} module.`
          : `The module for ${d.instrumentType} instruments is not installed or enabled.`,
      );
    }
    const { calibrationId } = await this.createCalibration(
      principal,
      deviceId,
      this.checklist(input),
      origin,
      null,
    );
    return { calibrationId, device: await this.get(deviceId, principal) };
  }

  /**
   * Creates a DRAFT calibration record and starts its approval workflow.
   * Used by the core (checklist) and by modules through ModuleContext; a
   * module may only record calibrations for the instrument types it provides.
   */
  async createCalibration(
    principal: Pick<Principal, 'userId' | 'fullName' | 'permissions'>,
    deviceId: string,
    c: CalibrationInput,
    origin: RequestOrigin,
    moduleId: string | null,
  ): Promise<{ calibrationId: string; code: string }> {
    this.requireAny(principal, 'calibration.perform');
    if (!['PASS', 'WARNING', 'FAIL'].includes(c.outcome))
      throw new BadRequestException('Invalid calibration outcome.');
    if (!['MANUAL', 'INSTRUMENT', 'SIMULATED'].includes(c.dataSource))
      throw new BadRequestException('Invalid data source.');
    const performedAt = this.performedAt(c.performedAt);
    const remarks = (c.remarks ?? '').slice(0, 2000);
    return this.db.transaction(
      this.actor(principal, 'Calibration recorded', origin),
      async (client) => {
        const d = await this.loadDevice(client, deviceId, true);
        const provider = this.registry.providerOf(d.instrument_type);
        if (
          moduleId !==
          (d.instrument_type === CORE_INSTRUMENT_TYPE
            ? null
            : (provider?.id ?? '-'))
        )
          throw new ForbiddenException(
            'This calibration must be recorded by the module that provides the instrument type.',
          );
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
        const { rows: seq } = await client.query<{ n: string }>(
          "SELECT nextval('calibration_code_seq') AS n",
        );
        const code = `CAL-${String(seq[0].n).padStart(5, '0')}`;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO calibration_records (code, device_id, performed_at, performed_by, data_source, temperature_c, readings, limits,
                                          results, display, source_messages, outcome, remarks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [
            code,
            deviceId,
            performedAt,
            principal.userId,
            c.dataSource,
            c.temperatureC,
            JSON.stringify(c.readings),
            JSON.stringify(c.limits),
            JSON.stringify(c.results),
            JSON.stringify(c.display ?? []),
            JSON.stringify(c.sourceMessages ?? []),
            c.outcome,
            remarks,
          ],
        );
        await this.workflow.start(
          client,
          {
            userId: principal.userId,
            fullName: principal.fullName,
          } as Principal,
          {
            definitionCode: CALIBRATION_WORKFLOW,
            tableName: CAL_TABLE,
            recordId: rows[0].id,
            seriesId: rows[0].id,
            seriesVersion: 1,
          },
        );
        await this.event(
          client,
          principal,
          origin,
          'CALIBRATION_RECORDED',
          CAL_TABLE,
          rows[0].id,
          null,
          {
            code,
            device: d.code,
            outcome: c.outcome,
            dataSource: c.dataSource,
            module: moduleId,
          },
        );
        return { calibrationId: rows[0].id, code };
      },
    );
  }

  /**
   * Withdraw a calibration that was never submitted, or was rejected back to
   * draft (instrument readings cannot be edited). Soft delete, audited.
   */
  async discardCalibration(
    principal: Principal,
    deviceId: string,
    calibrationId: string,
    reasonInput: unknown,
    origin: RequestOrigin,
  ) {
    this.requireAny(principal, 'calibration.perform');
    const reason = this.reason(reasonInput, 10);
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        await this.workflow.assertEditable(client, CAL_TABLE, calibrationId);
        const { rows } = await client.query<{
          device_id: string;
          performed_by: string;
          code: string;
        }>(
          'SELECT device_id, performed_by, code FROM calibration_records WHERE id = $1 AND NOT is_deleted',
          [calibrationId],
        );
        if (!rows[0] || rows[0].device_id !== deviceId)
          throw new NotFoundException('Calibration not found.');
        if (rows[0].performed_by !== principal.userId)
          throw new ForbiddenException(
            'Only the person who performed the calibration can discard it.',
          );
        await client.query(
          'UPDATE calibration_records SET is_deleted = true WHERE id = $1',
          [calibrationId],
        );
        await this.event(
          client,
          principal,
          origin,
          'CALIBRATION_DISCARDED',
          CAL_TABLE,
          calibrationId,
          reason,
          { code: rows[0].code },
        );
      },
    );
    return this.get(deviceId, principal);
  }

  /** Correct a draft checklist calibration before submission; only the person who performed it. */
  async updateCalibration(
    principal: Principal,
    deviceId: string,
    calibrationId: string,
    input: Record<string, unknown>,
    origin: RequestOrigin,
  ) {
    this.requireAny(principal, 'calibration.perform');
    await this.db.transaction(
      this.actor(principal, 'Draft calibration corrected', origin),
      async (client) => {
        await this.workflow.assertEditable(client, CAL_TABLE, calibrationId);
        const { rows } = await client.query<{
          device_id: string;
          performed_by: string;
          data_source: string;
        }>(
          'SELECT device_id, performed_by, data_source FROM calibration_records WHERE id = $1',
          [calibrationId],
        );
        if (!rows[0] || rows[0].device_id !== deviceId)
          throw new NotFoundException('Calibration not found.');
        if (rows[0].performed_by !== principal.userId)
          throw new ForbiddenException(
            'Only the person who performed the calibration can correct it.',
          );
        const d = await this.loadDevice(client, deviceId);
        if (
          d.instrument_type !== CORE_INSTRUMENT_TYPE ||
          rows[0].data_source !== 'MANUAL'
        )
          throw new ConflictException(
            'This calibration was recorded by a module. Withdraw or reject it and record a new one.',
          );
        const c = this.checklist(input);
        await client.query(
          `UPDATE calibration_records SET performed_at = $2, readings = $3, results = $4, display = $5, outcome = $6, remarks = $7 WHERE id = $1`,
          [
            calibrationId,
            this.performedAt(c.performedAt),
            JSON.stringify(c.readings),
            JSON.stringify(c.results),
            JSON.stringify(c.display),
            c.outcome,
            c.remarks,
          ],
        );
      },
    );
    return this.get(deviceId, principal);
  }
}
