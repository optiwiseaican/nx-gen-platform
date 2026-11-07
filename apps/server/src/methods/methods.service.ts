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
import {
  WorkflowEvent,
  WorkflowInstance,
  WorkflowService,
  WorkflowStep,
} from '../workflow/workflow.service';

export const METHOD_WORKFLOW = 'METHOD_APPROVAL';
const TABLE = 'method_versions';
export const INSTRUMENT_TYPES = ['PH', 'EC', 'TLC', 'OTHER'] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export interface MethodParameter {
  name: string;
  value: string;
  unit: string;
}

export interface MethodContent {
  name: string;
  purpose: string;
  procedure: string;
  parameters: MethodParameter[];
}

export interface MethodVersion extends MethodContent {
  id: string;
  versionNumber: number;
  changeSummary: string;
  createdAt: string;
  createdByName: string | null;
  workflow: WorkflowInstance;
}

export interface MethodSummary {
  id: string;
  code: string;
  instrumentType: InstrumentType;
  name: string;
  latestVersion: number;
  latestState: string;
  effectiveVersion: number | null;
  createdAt: string;
}

interface VersionRow {
  id: string;
  method_id: string;
  version_number: number;
  name: string;
  purpose: string;
  procedure_text: string;
  parameters: MethodParameter[];
  change_summary: string;
  created_at: Date;
  created_by_name: string | null;
}

/** Validates editable method content. */
function parseContent(
  input: Record<string, unknown>,
  current?: MethodContent,
): MethodContent {
  const text = (
    v: unknown,
    fallback: string | undefined,
    field: string,
    max: number,
    min = 0,
  ) => {
    const s =
      v === undefined ? fallback : typeof v === 'string' ? v.trim() : undefined;
    if (s === undefined || s.length < min || s.length > max)
      throw new BadRequestException({
        message:
          field === 'name'
            ? 'Enter a method name (3–200 characters).'
            : `${field} is too long (max ${max} characters).`,
        field,
      });
    return s;
  };
  let parameters = current?.parameters ?? [];
  if (input.parameters !== undefined) {
    if (!Array.isArray(input.parameters) || input.parameters.length > 50)
      throw new BadRequestException({
        message: 'Up to 50 parameters.',
        field: 'parameters',
      });
    parameters = input.parameters.map(
      (p: Record<string, unknown>, i: number) => {
        const name = typeof p?.name === 'string' ? p.name.trim() : '';
        const value = typeof p?.value === 'string' ? p.value.trim() : '';
        const unit = typeof p?.unit === 'string' ? p.unit.trim() : '';
        if (!name || name.length > 80 || value.length > 200 || unit.length > 30)
          throw new BadRequestException({
            message: `Parameter ${i + 1}: enter a name (max 80), value (max 200) and unit (max 30).`,
            field: 'parameters',
          });
        return { name, value, unit };
      },
    );
  }
  return {
    name: text(input.name, current?.name, 'name', 200, 3),
    purpose: text(input.purpose, current?.purpose ?? '', 'purpose', 2000),
    procedure: text(
      input.procedure,
      current?.procedure ?? '',
      'procedure',
      20000,
    ),
    parameters,
  };
}

/**
 * Method management (master spec §7 "Method Approval"; TLC PRD methods;
 * LabApp acceptance profiles). The first consumer of the Workflow Engine.
 *
 * A method is a series (code MTH-0001) of versions. Each version is a row in
 * method_versions with its own workflow instance; it can be edited only while
 * it is a DRAFT. Exactly one version can be in progress and one effective
 * (APPROVED) at a time; approving a new version supersedes the previous one.
 */
@Injectable()
export class MethodsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
  ) {}

  onModuleInit() {
    this.workflow.registerRecordType({
      tableName: TABLE,
      load: async (client, recordId) => {
        const v = await this.loadVersion(client, recordId);
        const { rows } = await client.query<{
          code: string;
          instrument_type: string;
        }>('SELECT code, instrument_type FROM methods WHERE id = $1', [
          v.method_id,
        ]);
        return {
          title: `${rows[0].code} v${v.version_number} · ${v.name}`,
          content: {
            methodCode: rows[0].code,
            instrumentType: rows[0].instrument_type,
            versionNumber: v.version_number,
            name: v.name,
            purpose: v.purpose,
            procedure: v.procedure_text,
            parameters: v.parameters,
            changeSummary: v.change_summary,
          },
        };
      },
      link: (seriesId) => `/methods/view/?id=${seriesId}`,
    });
  }

  private async loadVersion(
    client: PoolClient,
    id: string,
  ): Promise<VersionRow> {
    const { rows } = await client.query<VersionRow>(
      'SELECT * FROM method_versions WHERE id = $1 AND NOT is_deleted',
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Method version not found.');
    return rows[0];
  }

  private requireEdit(principal: Principal) {
    if (!principal.permissions.includes('methods.edit'))
      throw new ForbiddenException('You cannot edit methods.');
  }

  async list(): Promise<MethodSummary[]> {
    const rows = await this.db.query<{
      id: string;
      code: string;
      instrument_type: InstrumentType;
      created_at: Date;
      name: string;
      latest_version: number;
      latest_state: string;
      effective_version: number | null;
    }>(
      `SELECT m.id, m.code, m.instrument_type, m.created_at,
              lv.name, lv.version_number AS latest_version, li.state AS latest_state,
              (SELECT wi.series_version FROM workflow_instances wi
                WHERE wi.definition_code = $1 AND wi.series_id = m.id::text AND wi.state = 'APPROVED') AS effective_version
         FROM methods m
         JOIN LATERAL (SELECT * FROM method_versions v WHERE v.method_id = m.id AND NOT v.is_deleted
                        ORDER BY v.version_number DESC LIMIT 1) lv ON true
         JOIN workflow_instances li ON li.table_name = '${TABLE}' AND li.record_id = lv.id::text
        WHERE NOT m.is_deleted
        ORDER BY m.code`,
      [METHOD_WORKFLOW],
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      instrumentType: r.instrument_type,
      name: r.name,
      latestVersion: r.latest_version,
      latestState: r.latest_state,
      effectiveVersion: r.effective_version,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async get(id: string, principal: Principal) {
    const [m] = await this.db.query<{
      id: string;
      code: string;
      instrument_type: InstrumentType;
      created_at: Date;
    }>(
      'SELECT id, code, instrument_type, created_at FROM methods WHERE id = $1 AND NOT is_deleted',
      [id],
    );
    if (!m) throw new NotFoundException('Method not found.');
    const rows = await this.db.query<VersionRow>(
      `SELECT v.*, u.full_name AS created_by_name FROM method_versions v
         LEFT JOIN users u ON u.id::text = v.created_by
        WHERE v.method_id = $1 AND NOT v.is_deleted ORDER BY v.version_number DESC`,
      [id],
    );
    const instances = await this.workflow.forSeries(METHOD_WORKFLOW, id);
    const versions: (MethodVersion & {
      allowedSteps: WorkflowStep[];
      history: WorkflowEvent[];
    })[] = [];
    for (const r of rows) {
      const wf = instances.find((i) => i.recordId === r.id)!;
      versions.push({
        id: r.id,
        versionNumber: r.version_number,
        name: r.name,
        purpose: r.purpose,
        procedure: r.procedure_text,
        parameters: r.parameters,
        changeSummary: r.change_summary,
        createdAt: r.created_at.toISOString(),
        createdByName: r.created_by_name,
        workflow: wf,
        allowedSteps: await this.workflow.allowedSteps(wf, principal),
        history: await this.workflow.history(wf.id),
      });
    }
    const latest = versions[0];
    const canEdit = principal.permissions.includes('methods.edit');
    return {
      id: m.id,
      code: m.code,
      instrumentType: m.instrument_type,
      createdAt: m.created_at.toISOString(),
      versions,
      canEditDraft: canEdit && latest?.workflow.state === 'DRAFT',
      canStartNewVersion:
        canEdit &&
        ['APPROVED', 'INVALIDATED'].includes(latest?.workflow.state ?? ''),
    };
  }

  async create(
    principal: Principal,
    input: Record<string, unknown>,
    origin: RequestOrigin,
  ) {
    this.requireEdit(principal);
    const type = input.instrumentType as InstrumentType;
    if (!INSTRUMENT_TYPES.includes(type))
      throw new BadRequestException({
        message: 'Choose the instrument type.',
        field: 'instrumentType',
      });
    const content = parseContent(input);
    const id = await this.db.transaction(
      this.workflow.actor(principal, 'Method created as draft', origin),
      async (client) => {
        const { rows: seq } = await client.query<{ n: string }>(
          "SELECT nextval('method_code_seq') AS n",
        );
        const code = `MTH-${String(seq[0].n).padStart(4, '0')}`;
        const { rows } = await client.query<{ id: string }>(
          'INSERT INTO methods (code, instrument_type) VALUES ($1, $2) RETURNING id',
          [code, type],
        );
        const methodId = rows[0].id;
        const versionId = await this.insertVersion(
          client,
          methodId,
          1,
          content,
          'Initial version',
        );
        await this.workflow.start(client, principal, {
          definitionCode: METHOD_WORKFLOW,
          tableName: TABLE,
          recordId: versionId,
          seriesId: methodId,
          seriesVersion: 1,
        });
        await this.event(
          client,
          principal,
          origin,
          'METHOD_CREATED',
          versionId,
          { code, version: 1 },
        );
        return methodId;
      },
    );
    return this.get(id, principal);
  }

  private async insertVersion(
    client: PoolClient,
    methodId: string,
    n: number,
    c: MethodContent,
    changeSummary: string,
  ) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO method_versions (method_id, version_number, name, purpose, procedure_text, parameters, change_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        methodId,
        n,
        c.name,
        c.purpose,
        c.procedure,
        JSON.stringify(c.parameters),
        changeSummary,
      ],
    );
    return rows[0].id;
  }

  /** Edit the draft version. Locked versions are refused by the engine and the database. */
  async updateDraft(
    principal: Principal,
    methodId: string,
    versionId: string,
    input: Record<string, unknown>,
    origin: RequestOrigin,
  ) {
    this.requireEdit(principal);
    await this.db.transaction(
      this.workflow.actor(principal, 'Draft method edited', origin),
      async (client) => {
        await this.workflow.assertEditable(client, TABLE, versionId);
        const v = await this.loadVersion(client, versionId);
        if (v.method_id !== methodId)
          throw new NotFoundException('Method version not found.');
        const c = parseContent(input, {
          name: v.name,
          purpose: v.purpose,
          procedure: v.procedure_text,
          parameters: v.parameters,
        });
        const changeSummary =
          typeof input.changeSummary === 'string'
            ? input.changeSummary.trim().slice(0, 2000)
            : v.change_summary;
        await client.query(
          `UPDATE method_versions SET name = $2, purpose = $3, procedure_text = $4, parameters = $5, change_summary = $6
            WHERE id = $1`,
          [
            versionId,
            c.name,
            c.purpose,
            c.procedure,
            JSON.stringify(c.parameters),
            changeSummary,
          ],
        );
      },
    );
    return this.get(methodId, principal);
  }

  /** Start version n+1 from the latest approved or invalidated version. */
  async newVersion(
    principal: Principal,
    methodId: string,
    reasonInput: unknown,
    origin: RequestOrigin,
  ) {
    this.requireEdit(principal);
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 10)
      throw new BadRequestException({
        message: 'Describe what will change and why (at least 10 characters).',
        field: 'reason',
      });
    await this.db.transaction(
      this.workflow.actor(principal, reason, origin),
      async (client) => {
        const { rows } = await client.query<VersionRow & { state: string }>(
          `SELECT v.*, wi.state FROM method_versions v
           JOIN workflow_instances wi ON wi.table_name = '${TABLE}' AND wi.record_id = v.id::text
          WHERE v.method_id = $1 AND NOT v.is_deleted
          ORDER BY v.version_number DESC LIMIT 1 FOR UPDATE OF wi`,
          [methodId],
        );
        const latest = rows[0];
        if (!latest) throw new NotFoundException('Method not found.');
        if (!['APPROVED', 'INVALIDATED'].includes(latest.state))
          throw new ConflictException(
            'A new version can start only from the approved or invalidated version. Finish the version in progress first.',
          );
        const n = latest.version_number + 1;
        const versionId = await this.insertVersion(
          client,
          methodId,
          n,
          {
            name: latest.name,
            purpose: latest.purpose,
            procedure: latest.procedure_text,
            parameters: latest.parameters,
          },
          reason,
        );
        await this.workflow.start(client, principal, {
          definitionCode: METHOD_WORKFLOW,
          tableName: TABLE,
          recordId: versionId,
          seriesId: methodId,
          seriesVersion: n,
        });
        await this.event(
          client,
          principal,
          origin,
          'METHOD_VERSION_STARTED',
          versionId,
          {
            version: n,
            fromVersion: latest.version_number,
          },
        );
      },
    );
    return this.get(methodId, principal);
  }

  private async event(
    client: PoolClient,
    principal: Principal,
    origin: RequestOrigin,
    action: string,
    versionId: string,
    details: Record<string, string | number>,
  ) {
    await this.audit.record(
      {
        category: 'METHODS',
        action,
        result: 'SUCCESS',
        actor: principal.userId,
        actorName: principal.fullName,
        tableName: TABLE,
        recordId: versionId,
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        details,
      },
      client,
    );
  }
}
