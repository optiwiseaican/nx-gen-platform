import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { canonicalize } from '@crescent/licensing';
import { AuditService } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import {
  SignatureRecord,
  SignatureService,
} from '../signatures/signature.service';
import type { SignatureInput } from '../signatures/signature.service';

export type WorkflowState =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'REVIEWED'
  | 'APPROVED'
  | 'INVALIDATED'
  | 'SUPERSEDED';
export type WorkflowStep =
  'SUBMIT' | 'WITHDRAW' | 'REVIEW' | 'APPROVE' | 'REJECT' | 'INVALIDATE';
export const WORKFLOW_STEPS: WorkflowStep[] = [
  'SUBMIT',
  'WITHDRAW',
  'REVIEW',
  'APPROVE',
  'REJECT',
  'INVALIDATE',
];

/** Signature action and fixed meaning per step; WITHDRAW is unsigned. */
const SIGNED_STEP: Partial<
  Record<WorkflowStep, { action: string; meaning: string }>
> = {
  SUBMIT: { action: 'WORKFLOW_SUBMIT', meaning: 'AUTHORED' },
  REVIEW: { action: 'WORKFLOW_REVIEW', meaning: 'REVIEWED' },
  APPROVE: { action: 'WORKFLOW_APPROVE', meaning: 'APPROVED' },
  REJECT: { action: 'WORKFLOW_REJECT', meaning: 'REJECTED' },
  INVALIDATE: { action: 'WORKFLOW_INVALIDATE', meaning: 'INVALIDATED' },
};

const DEFAULT_REASON: Record<WorkflowStep, string> = {
  SUBMIT: 'Submitted for review',
  WITHDRAW: '',
  REVIEW: 'Reviewed',
  APPROVE: 'Approved',
  REJECT: '',
  INVALIDATE: '',
};

/** What a module provides so the engine can hash and describe its records. */
export interface WorkflowRecordType {
  tableName: string;
  load(
    client: PoolClient,
    recordId: string,
  ): Promise<{ title: string; content: Record<string, unknown> }>;
  /** Client route that shows the record. */
  link(seriesId: string): string;
}

export interface WorkflowDefinition {
  code: string;
  name: string;
  recordTable: string;
  editPermission: string;
  reviewPermission: string;
  approvePermission: string;
  requireReview: boolean;
  independentReviewer: boolean;
  independentApprover: boolean;
}

export interface PersonRef {
  id: string;
  name: string;
}

export interface WorkflowInstance {
  id: string;
  definitionCode: string;
  tableName: string;
  recordId: string;
  seriesId: string;
  seriesVersion: number;
  state: WorkflowState;
  contentHash: string | null;
  preparedBy: PersonRef | null;
  reviewedBy: PersonRef | null;
  approvedBy: PersonRef | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface WorkflowEvent {
  id: string;
  step: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  actorName: string | null;
  comment: string | null;
  contentHash: string | null;
  occurredAt: string;
  signature: SignatureRecord | null;
}

interface InstanceRow {
  id: string;
  definition_code: string;
  table_name: string;
  record_id: string;
  series_id: string;
  series_version: number;
  state: WorkflowState;
  content_hash: string | null;
  prepared_by: string | null;
  prepared_name: string | null;
  reviewed_by: string | null;
  reviewed_name: string | null;
  approved_by: string | null;
  approved_name: string | null;
  submitted_at: Date | null;
  approved_at: Date | null;
  created_at: Date;
}

const INSTANCE_SELECT = `
  SELECT wi.*, pu.full_name AS prepared_name, ru.full_name AS reviewed_name, au.full_name AS approved_name
    FROM workflow_instances wi
    LEFT JOIN users pu ON pu.id = wi.prepared_by
    LEFT JOIN users ru ON ru.id = wi.reviewed_by
    LEFT JOIN users au ON au.id = wi.approved_by`;

const person = (id: string | null, name: string | null): PersonRef | null =>
  id ? { id, name: name ?? id } : null;

const toInstance = (r: InstanceRow): WorkflowInstance => ({
  id: r.id,
  definitionCode: r.definition_code,
  tableName: r.table_name,
  recordId: r.record_id,
  seriesId: r.series_id,
  seriesVersion: r.series_version,
  state: r.state,
  contentHash: r.content_hash,
  preparedBy: person(r.prepared_by, r.prepared_name),
  reviewedBy: person(r.reviewed_by, r.reviewed_name),
  approvedBy: person(r.approved_by, r.approved_name),
  submittedAt: r.submitted_at?.toISOString() ?? null,
  approvedAt: r.approved_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export const contentHash = (content: unknown) =>
  createHash('sha256').update(canonicalize(content), 'utf8').digest('hex');

/**
 * Workflow Engine (master spec §4 "Workflow Engine", "Approvals", "Review
 * Workflows"; §7 signatures for approvals).
 *
 * Generic over record types: a module registers how to load a record's
 * content, starts an instance for each new version, and calls assertEditable
 * before changing it. The engine enforces:
 *   - the state machine and the permission for each step;
 *   - independence: reviewer ≠ preparer, approver ≠ preparer and reviewer;
 *   - a signature with a fixed meaning on every step except withdraw;
 *   - a content hash taken at submission and re-checked at review/approval;
 *   - a locked record from submission on (also enforced by the database);
 *   - one version in progress and one effective version per series, the
 *     previous effective version becoming SUPERSEDED on approval.
 */
@Injectable()
export class WorkflowService {
  private readonly types = new Map<string, WorkflowRecordType>();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly platform: PlatformIdentityService,
    private readonly signatures: SignatureService,
  ) {}

  registerRecordType(type: WorkflowRecordType) {
    this.types.set(type.tableName, type);
  }

  private type(tableName: string): WorkflowRecordType {
    const t = this.types.get(tableName);
    if (!t) throw new Error(`No workflow record type for ${tableName}`);
    return t;
  }

  private platformId(): string | null {
    return this.platform.getIdentity().identity?.instanceId ?? null;
  }

  actor(principal: Principal, reason: string | null, origin: RequestOrigin) {
    return {
      actorId: principal.userId,
      actorName: principal.fullName,
      reason: reason ?? undefined,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
      platformInstanceId: this.platformId(),
    };
  }

  async definition(code: string): Promise<WorkflowDefinition> {
    const [d] = await this.db.query<{
      code: string;
      name: string;
      record_table: string;
      edit_permission: string;
      review_permission: string;
      approve_permission: string;
      require_review: boolean;
      independent_reviewer: boolean;
      independent_approver: boolean;
    }>(
      'SELECT * FROM workflow_definitions WHERE code = $1 AND NOT is_deleted',
      [code],
    );
    if (!d) throw new NotFoundException(`Unknown workflow ${code}`);
    return {
      code: d.code,
      name: d.name,
      recordTable: d.record_table,
      editPermission: d.edit_permission,
      reviewPermission: d.review_permission,
      approvePermission: d.approve_permission,
      requireReview: d.require_review,
      independentReviewer: d.independent_reviewer,
      independentApprover: d.independent_approver,
    };
  }

  /** Called by a module, inside its transaction, when it creates a new version. */
  async start(
    client: PoolClient,
    principal: Principal,
    input: {
      definitionCode: string;
      tableName: string;
      recordId: string;
      seriesId: string;
      seriesVersion: number;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO workflow_instances (definition_code, table_name, record_id, series_id, series_version)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        input.definitionCode,
        input.tableName,
        input.recordId,
        input.seriesId,
        input.seriesVersion,
      ],
    );
    await client.query(
      `INSERT INTO workflow_events (instance_id, step, from_state, to_state, actor_id, actor_name)
       VALUES ($1, 'CREATE', NULL, 'DRAFT', $2, $3)`,
      [rows[0].id, principal.userId, principal.fullName],
    );
    return rows[0].id;
  }

  /** Throws unless the record's version is still a DRAFT. */
  async assertEditable(
    client: PoolClient,
    tableName: string,
    recordId: string,
  ) {
    const { rows } = await client.query<{ state: WorkflowState }>(
      'SELECT state FROM workflow_instances WHERE table_name = $1 AND record_id = $2 FOR UPDATE',
      [tableName, recordId],
    );
    if (rows[0] && rows[0].state !== 'DRAFT')
      throw new ConflictException({
        code: 'NX-WF-LOCKED',
        message: `This version is ${rows[0].state.replace('_', ' ').toLowerCase()} and locked. Start a new version to change it.`,
      });
  }

  async get(id: string): Promise<WorkflowInstance> {
    const [r] = await this.db.query<InstanceRow>(
      `${INSTANCE_SELECT} WHERE wi.id = $1`,
      [id],
    );
    if (!r) throw new NotFoundException('Workflow not found.');
    return toInstance(r);
  }

  async forSeries(definitionCode: string, seriesId: string) {
    const rows = await this.db.query<InstanceRow>(
      `${INSTANCE_SELECT} WHERE wi.definition_code = $1 AND wi.series_id = $2 ORDER BY wi.series_version DESC`,
      [definitionCode, seriesId],
    );
    return rows.map(toInstance);
  }

  async history(instanceId: string): Promise<WorkflowEvent[]> {
    const rows = await this.db.query<{
      id: string;
      step: string;
      from_state: string | null;
      to_state: string;
      actor_id: string;
      actor_name: string | null;
      comment: string | null;
      content_hash: string | null;
      occurred_at: Date;
      signature_id: string | null;
    }>(
      'SELECT * FROM workflow_events WHERE instance_id = $1 ORDER BY occurred_at, id',
      [instanceId],
    );
    const instance = await this.get(instanceId);
    const sigs = await this.signatures.list({
      tableName: instance.tableName,
      recordId: instance.recordId,
    });
    return rows.map((r) => ({
      id: r.id,
      step: r.step,
      fromState: r.from_state,
      toState: r.to_state,
      actorId: r.actor_id,
      actorName: r.actor_name,
      comment: r.comment,
      contentHash: r.content_hash,
      occurredAt: r.occurred_at.toISOString(),
      signature: sigs.find((s) => s.id === r.signature_id) ?? null,
    }));
  }

  /**
   * Why `principal` may not take `step` now, or null if allowed. Shared by
   * the UI (which buttons to show) and act() (the enforcement).
   */
  blocker(
    step: WorkflowStep,
    i: WorkflowInstance,
    d: WorkflowDefinition,
    principal: Principal,
    returnTo?: WorkflowState,
  ): string | null {
    const can = (perm: string) => principal.permissions.includes(perm);
    const me = principal.userId;
    switch (step) {
      case 'SUBMIT':
        if (i.state !== 'DRAFT') return 'Only a draft can be submitted.';
        return can(d.editPermission) ? null : 'You cannot edit these records.';
      case 'WITHDRAW':
        if (i.state !== 'IN_REVIEW')
          return 'Only a version awaiting review can be withdrawn.';
        return i.preparedBy?.id === me
          ? null
          : 'Only the person who submitted it can withdraw it.';
      case 'REVIEW':
        if (!d.requireReview) return 'This workflow has no review step.';
        if (i.state !== 'IN_REVIEW')
          return 'This version is not awaiting review.';
        if (!can(d.reviewPermission)) return 'You cannot review these records.';
        if (d.independentReviewer && i.preparedBy?.id === me)
          return 'You prepared this version, so someone else must review it.';
        return null;
      case 'APPROVE': {
        const ready = d.requireReview ? 'REVIEWED' : 'IN_REVIEW';
        if (i.state !== ready)
          return d.requireReview
            ? 'This version must be reviewed before it can be approved.'
            : 'This version is not awaiting approval.';
        if (!can(d.approvePermission))
          return 'You cannot approve these records.';
        if (d.independentApprover && i.preparedBy?.id === me)
          return 'You prepared this version, so someone else must approve it.';
        if (d.independentApprover && i.reviewedBy?.id === me)
          return 'You reviewed this version, so someone else must approve it.';
        return null;
      }
      case 'REJECT':
        if (i.state === 'IN_REVIEW') {
          if (!can(d.reviewPermission) && !can(d.approvePermission))
            return 'You cannot review these records.';
          if (returnTo && returnTo !== 'DRAFT')
            return 'A version awaiting review can only go back to draft.';
        } else if (i.state === 'REVIEWED') {
          if (!can(d.approvePermission))
            return 'You cannot approve these records.';
          if (returnTo && returnTo !== 'DRAFT' && returnTo !== 'IN_REVIEW')
            return 'Choose whether it returns to draft or to review.';
        } else return 'Only a version under review can be rejected.';
        if (i.preparedBy?.id === me)
          return 'You prepared this version; withdraw it instead.';
        return null;
      case 'INVALIDATE':
        if (i.state !== 'APPROVED')
          return 'Only the approved version can be invalidated.';
        return can(d.approvePermission)
          ? null
          : 'You cannot approve these records.';
    }
  }

  async allowedSteps(i: WorkflowInstance, principal: Principal) {
    const d = await this.definition(i.definitionCode);
    return WORKFLOW_STEPS.filter(
      (s) => this.blocker(s, i, d, principal) === null,
    );
  }

  async act(
    principal: Principal,
    instanceId: string,
    stepInput: unknown,
    input: {
      comment?: unknown;
      signature?: SignatureInput;
      returnTo?: unknown;
    },
    origin: RequestOrigin,
  ): Promise<WorkflowInstance> {
    const step = stepInput as WorkflowStep;
    if (!WORKFLOW_STEPS.includes(step))
      throw new BadRequestException(`Unknown step ${String(stepInput)}.`);
    const comment =
      typeof input.comment === 'string'
        ? input.comment.trim().slice(0, 1000)
        : '';
    const needsComment = ['WITHDRAW', 'REJECT', 'INVALIDATE'].includes(step);
    if (needsComment && comment.length < 10)
      throw new BadRequestException({
        message: 'Explain the reason (at least 10 characters).',
        field: 'reason',
      });
    const returnTo = (
      step === 'REJECT'
        ? input.returnTo === 'IN_REVIEW'
          ? 'IN_REVIEW'
          : 'DRAFT'
        : undefined
    ) as WorkflowState | undefined;

    const before = await this.get(instanceId);
    const d = await this.definition(before.definitionCode);
    const blocked = this.blocker(step, before, d, principal, returnTo);
    if (blocked)
      throw new ForbiddenException({
        code: 'NX-WF-NOT-ALLOWED',
        message: blocked,
      });

    const reason = comment || DEFAULT_REASON[step];
    const signed = SIGNED_STEP[step];
    // Outside the transaction so failed attempts count even though we throw.
    const signer = signed
      ? await this.signatures.authorize(
          signed.action,
          principal,
          { ...(input.signature ?? {}), meaning: signed.meaning },
          reason,
          origin,
        )
      : null;

    const type = this.type(before.tableName);
    await this.db.transaction(
      this.actor(principal, reason, origin),
      async (client) => {
        const { rows } = await client.query<InstanceRow>(
          `${INSTANCE_SELECT} WHERE wi.id = $1 FOR UPDATE OF wi`,
          [instanceId],
        );
        const i = toInstance(rows[0]);
        // Re-check under the row lock: someone may have acted meanwhile.
        const now = this.blocker(step, i, d, principal, returnTo);
        if (now)
          throw new ConflictException({
            code: 'NX-WF-NOT-ALLOWED',
            message: now,
          });

        const { title, content } = await type.load(client, i.recordId);
        const hash = contentHash(content);
        if (step !== 'SUBMIT' && i.contentHash && hash !== i.contentHash) {
          throw new ConflictException({
            code: 'NX-WF-CONTENT-CHANGED',
            message:
              'The record no longer matches what was submitted. It cannot be signed; contact QA.',
          });
        }

        let to: WorkflowState;
        const sets: string[] = [];
        const params: unknown[] = [i.id];
        const set = (col: string, value: unknown) => {
          params.push(value);
          sets.push(`${col} = $${params.length}`);
        };
        switch (step) {
          case 'SUBMIT':
            to = 'IN_REVIEW';
            set('content_hash', hash);
            set('prepared_by', principal.userId);
            set('submitted_at', new Date());
            set('reviewed_by', null);
            break;
          case 'WITHDRAW':
            to = 'DRAFT';
            set('content_hash', null);
            set('submitted_at', null);
            break;
          case 'REVIEW':
            to = 'REVIEWED';
            set('reviewed_by', principal.userId);
            break;
          case 'APPROVE': {
            to = 'APPROVED';
            set('approved_by', principal.userId);
            set('approved_at', new Date());
            // The previously effective version is superseded by this one.
            const { rows: prev } = await client.query<{ id: string }>(
              `UPDATE workflow_instances SET state = 'SUPERSEDED'
              WHERE definition_code = $1 AND series_id = $2 AND state = 'APPROVED' AND id <> $3
              RETURNING id`,
              [i.definitionCode, i.seriesId, i.id],
            );
            for (const p of prev)
              await client.query(
                `INSERT INTO workflow_events (instance_id, step, from_state, to_state, actor_id, actor_name, comment)
               VALUES ($1, 'SUPERSEDE', 'APPROVED', 'SUPERSEDED', $2, $3, $4)`,
                [
                  p.id,
                  principal.userId,
                  principal.fullName,
                  `Superseded by version ${i.seriesVersion}`,
                ],
              );
            break;
          }
          case 'REJECT':
            to = returnTo ?? 'DRAFT';
            if (to === 'DRAFT') {
              set('content_hash', null);
              set('submitted_at', null);
            }
            set('reviewed_by', null);
            break;
          case 'INVALIDATE':
            to = 'INVALIDATED';
            break;
        }
        set('state', to);
        await client.query(
          `UPDATE workflow_instances SET ${sets.join(', ')} WHERE id = $1`,
          params,
        );

        let signatureId: string | null = null;
        if (signer) {
          const sig = await this.signatures.apply(
            client,
            signer,
            {
              tableName: i.tableName,
              recordId: i.recordId,
              recordVersion: i.seriesVersion,
              content: {
                workflow: i.definitionCode,
                step,
                title,
                seriesId: i.seriesId,
                seriesVersion: i.seriesVersion,
                fromState: i.state,
                toState: to,
                contentHash: hash,
                record: content,
              },
            },
            origin,
          );
          signatureId = sig.id;
        }
        await client.query(
          `INSERT INTO workflow_events (instance_id, step, from_state, to_state, actor_id, actor_name, comment, signature_id, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            i.id,
            step,
            i.state,
            to,
            principal.userId,
            principal.fullName,
            comment || null,
            signatureId,
            hash,
          ],
        );
        await this.audit.record(
          {
            category: 'WORKFLOW',
            action: `WORKFLOW_${step}`,
            result: 'SUCCESS',
            actor: principal.userId,
            actorName: principal.fullName,
            tableName: i.tableName,
            recordId: i.recordId,
            previousState: i.state,
            newState: to,
            reason,
            platformInstanceId: this.platformId(),
            ipAddress: origin.ipAddress,
            machineName: origin.machineName,
            details: {
              workflow: i.definitionCode,
              title,
              seriesVersion: i.seriesVersion,
              contentHash: hash,
              signatureId,
            },
          },
          client,
        );
      },
    );
    return this.get(instanceId);
  }

  /** Versions waiting for this user's review or approval. */
  async tasks(principal: Principal) {
    const rows = await this.db.query<InstanceRow>(
      `${INSTANCE_SELECT} WHERE wi.state IN ('IN_REVIEW', 'REVIEWED') ORDER BY wi.submitted_at`,
    );
    const out: {
      instance: WorkflowInstance;
      step: WorkflowStep;
      title: string;
      link: string;
      workflow: string;
    }[] = [];
    const defs = new Map<string, WorkflowDefinition>();
    for (const r of rows) {
      const i = toInstance(r);
      const d =
        defs.get(i.definitionCode) ?? (await this.definition(i.definitionCode));
      defs.set(d.code, d);
      const step = (['REVIEW', 'APPROVE'] as const).find(
        (s) => this.blocker(s, i, d, principal) === null,
      );
      if (!step) continue;
      const type = this.type(i.tableName);
      const client = await this.db.connect();
      try {
        const { title } = await type.load(client, i.recordId);
        out.push({
          instance: i,
          step,
          title,
          link: type.link(i.seriesId),
          workflow: d.name,
        });
      } finally {
        client.release();
      }
    }
    return out;
  }
}
