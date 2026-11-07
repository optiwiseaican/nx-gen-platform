import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { DatabaseService, Queryable } from '../database/database.service';
import {
  AuditEventInput,
  AuditRecord,
  BootstrapJournal,
} from './bootstrap-journal';

export { SYSTEM_LICENSE_SERVICE } from './bootstrap-journal';
export type { AuditEventInput } from './bootstrap-journal';

export interface AuditEntry {
  sequence: number;
  eventId: string;
  occurredAt: string;
  category: string;
  action: string;
  result: string;
  actor: string;
  actorName: string | null;
  tableName: string | null;
  recordId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  machineName: string | null;
  ipAddress: string | null;
  platformInstanceId: string | null;
  errorCode: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditQuery {
  limit?: number;
  beforeSequence?: number;
  action?: string;
  actor?: string;
  category?: string;
  /** Entries about this record, including composite keys that start with it (e.g. "<userId>:ROLE"). */
  recordId?: string;
  result?: string;
  /** Inclusive lower bound (ISO 8601). */
  from?: string;
  /** Exclusive upper bound (ISO 8601). */
  to?: string;
}

/** Response header carrying the SHA-256 of an exported file. */
export const AUDIT_EXPORT_HASH_HEADER = 'X-NxGen-Export-SHA256';
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

export interface AuditExport {
  csv: string;
  rows: number;
  sha256: string;
  firstSequence: number | null;
  lastSequence: number | null;
  truncated: boolean;
}

const CSV_COLUMNS = [
  'sequence',
  'event_id',
  'occurred_at_utc',
  'category',
  'action',
  'result',
  'actor_id',
  'actor_name',
  'table_name',
  'record_id',
  'old_value',
  'new_value',
  'reason',
  'machine_name',
  'ip_address',
  'platform_instance_id',
  'error_code',
  'details',
  'prev_hash',
  'hash',
] as const;

/** RFC 4180 field; neutralises spreadsheet formula injection (=, +, -, @). */
function csvField(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) return '';
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = `${value as string | number | boolean | bigint}`;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

interface AuditRow {
  sequence: string;
  event_id: string;
  occurred_at: Date;
  category: string;
  action: string;
  result: string;
  actor_id: string;
  actor_name: string | null;
  table_name: string | null;
  record_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
  machine_name: string | null;
  ip_address: string | null;
  platform_instance_id: string | null;
  error_code: string | null;
  details: Record<string, unknown> | null;
  prev_hash?: string;
  hash?: string;
}

const fromRow = (r: AuditRow): AuditEntry => ({
  sequence: Number(r.sequence),
  eventId: r.event_id,
  occurredAt: r.occurred_at.toISOString(),
  category: r.category,
  action: r.action,
  result: r.result,
  actor: r.actor_id,
  actorName: r.actor_name,
  tableName: r.table_name,
  recordId: r.record_id,
  oldValue: r.old_value,
  newValue: r.new_value,
  reason: r.reason,
  machineName: r.machine_name,
  ipAddress: r.ip_address,
  platformInstanceId: r.platform_instance_id,
  errorCode: r.error_code,
  details: r.details,
});

const fromJournal = (r: AuditRecord): AuditEntry => ({
  sequence: r.sequence,
  eventId: r.eventId,
  occurredAt: r.timestamp,
  category: r.category,
  action: r.action,
  result: r.result,
  actor: r.actor,
  actorName: null,
  tableName: null,
  recordId: r.certificateId ?? r.licenseReference ?? null,
  oldValue: r.previousState ? { state: r.previousState } : null,
  newValue: r.newState ? { state: r.newState } : null,
  reason: r.reason ?? null,
  machineName: null,
  ipAddress: null,
  platformInstanceId: r.platformInstanceId ?? null,
  errorCode: r.errorCode ?? null,
  details: r.details ?? null,
});

/**
 * System audit trail (master spec §6).
 *
 * With a database configured, events go to the append-only, hash-chained
 * `audit_trail` table — and there is NO silent fallback: if the database write
 * fails, the caller's operation fails. Without a database (pre-installation /
 * licensing-only development) events go to the Bootstrap Journal file.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly journal: BootstrapJournal,
    private readonly db: DatabaseService | null,
  ) {}

  private get useDb(): boolean {
    return !!this.db?.enabled;
  }

  async record(event: AuditEventInput, client?: Queryable): Promise<void> {
    if (!this.useDb) {
      this.journal.record(event);
      return;
    }
    const details = {
      ...(event.details ?? {}),
      ...(event.licenseReference
        ? { licenseReference: event.licenseReference }
        : {}),
      ...(event.certificateId ? { certificateId: event.certificateId } : {}),
    };
    const sql = `INSERT INTO audit_trail (category, action, result, actor_id, actor_name, table_name, record_id,
                                old_value, new_value, reason, platform_instance_id, error_code, details, ip_address, machine_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;
    const params = [
      event.category,
      event.action,
      event.result,
      event.actor,
      event.actorName ?? null,
      event.tableName ?? (event.category === 'LICENSING' ? 'license' : null),
      event.recordId ?? event.certificateId ?? event.licenseReference ?? null,
      event.previousState
        ? JSON.stringify({ state: event.previousState })
        : null,
      event.newState ? JSON.stringify({ state: event.newState }) : null,
      event.reason ?? null,
      event.platformInstanceId ?? null,
      event.errorCode ?? null,
      Object.keys(details).length ? JSON.stringify(details) : null,
      event.ipAddress ?? null,
      event.machineName ?? null,
    ];
    if (client) await client.query(sql, params);
    else await this.db!.query(sql, params);
  }

  async list(q: AuditQuery = {}): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    if (!this.useDb) {
      return this.journal
        .readAll()
        .map(fromJournal)
        .filter(
          (e) =>
            (!q.action || e.action === q.action) &&
            (!q.actor || e.actor === q.actor),
        )
        .filter((e) => !q.beforeSequence || e.sequence < q.beforeSequence)
        .filter((e) => !q.recordId || e.recordId === q.recordId)
        .reverse()
        .slice(0, limit);
    }
    const { where, params } = this.filter(q);
    const rows = await this.db!.query<AuditRow>(
      `SELECT * FROM audit_trail WHERE ${where}
        ORDER BY sequence DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    return rows.map(fromRow);
  }

  private filter(q: AuditQuery): { where: string; params: unknown[] } {
    const params = [
      q.beforeSequence ?? null,
      q.action ?? null,
      q.actor ?? null,
      q.category ?? null,
      q.recordId ?? null,
      q.result ?? null,
      q.from ?? null,
      q.to ?? null,
    ];
    const where = `($1::bigint IS NULL OR sequence < $1)
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR actor_id = $3
               OR actor_name ILIKE '%' || replace(replace(replace($3, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
          AND ($4::text IS NULL OR category = $4)
          AND ($5::text IS NULL OR record_id = $5 OR record_id LIKE $5 || ':%')
          AND ($6::text IS NULL OR result = $6)
          AND ($7::timestamptz IS NULL OR occurred_at >= $7)
          AND ($8::timestamptz IS NULL OR occurred_at < $8)`;
    return { where, params };
  }

  /**
   * CSV export (master spec §6 "Exportable"; Annex 11 §8.1 accurate printed
   * copies). Oldest first, UTC timestamps, and every row's prev_hash/hash, so
   * the extract can be checked against the chain outside NxGen. The caller
   * records the export itself in the trail.
   */
  async exportCsv(q: AuditQuery): Promise<AuditExport> {
    if (!this.useDb)
      throw new Error('Audit export requires the NxGen database.');
    const { where, params } = this.filter({ ...q, beforeSequence: undefined });
    const rows = await this.db!.query<AuditRow>(
      `SELECT * FROM audit_trail WHERE ${where}
        ORDER BY sequence LIMIT $${params.length + 1}`,
      [...params, AUDIT_EXPORT_MAX_ROWS + 1],
    );
    const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
    if (truncated) rows.length = AUDIT_EXPORT_MAX_ROWS;
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.sequence,
          r.event_id,
          r.occurred_at,
          r.category,
          r.action,
          r.result,
          r.actor_id,
          r.actor_name,
          r.table_name,
          r.record_id,
          r.old_value,
          r.new_value,
          r.reason,
          r.machine_name,
          r.ip_address,
          r.platform_instance_id,
          r.error_code,
          r.details,
          r.prev_hash,
          r.hash,
        ]
          .map(csvField)
          .join(','),
      );
    }
    // BOM so spreadsheet tools read UTF-8 names correctly.
    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
    return {
      csv,
      rows: rows.length,
      sha256: createHash('sha256').update(csv, 'utf8').digest('hex'),
      firstSequence: rows.length ? Number(rows[0].sequence) : null,
      lastSequence: rows.length ? Number(rows[rows.length - 1].sequence) : null,
      truncated,
    };
  }

  /** Oldest-first; intended for tests and exports of small trails. */
  async readAll(): Promise<AuditEntry[]> {
    if (!this.useDb) return this.journal.readAll().map(fromJournal);
    return (
      await this.db!.query<AuditRow>(
        'SELECT * FROM audit_trail ORDER BY sequence',
      )
    ).map(fromRow);
  }

  async count(): Promise<number> {
    if (!this.useDb) return this.journal.readAll().length;
    const [row] = await this.db!.query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_trail',
    );
    return Number(row.n);
  }

  async verifyChain(): Promise<{ valid: boolean; brokenAtSequence?: number }> {
    if (!this.useDb) return this.journal.verifyChain();
    const [row] = await this.db!.query<{ broken: string | null }>(
      'SELECT verify_audit_chain() AS broken',
    );
    return row.broken === null
      ? { valid: true }
      : { valid: false, brokenAtSequence: Number(row.broken) };
  }

  /**
   * Imports the Bootstrap Journal into the database trail once (Smart Installer
   * PRD §46: "Journal is finalized, journal hash is generated, installation
   * summary is registered, journal becomes installation evidence").
   */
  async importBootstrapJournal(): Promise<number> {
    if (!this.useDb || !existsSync(this.journal.path)) return 0;
    const [{ last }] = await this.db!.query<{ last: string | null }>(
      `SELECT max((details ->> 'journalSequence')::bigint) AS last FROM audit_trail WHERE details ? 'journalSequence'`,
    );
    const lastImported = Number(last ?? 0);
    const records = this.journal
      .readAll()
      .filter((r) => r.sequence > lastImported);
    if (!records.length) return 0;

    const content = readFileSync(this.journal.path, 'utf8');
    const journalHash = createHash('sha256').update(content).digest('hex');
    const chain = this.journal.verifyChain();
    await this.db!.transaction(
      { actorId: 'SYSTEM_AUDIT_SERVICE', actorName: 'Audit service' },
      async (client) => {
        for (const r of records) {
          await this.record(
            {
              ...r,
              details: {
                ...(r.details ?? {}),
                journalSequence: r.sequence,
                journalTimestamp: r.timestamp,
                journalHash: r.hash,
              },
            },
            client,
          );
        }
        await this.record(
          {
            category: 'PLATFORM',
            action: 'BOOTSTRAP_JOURNAL_IMPORTED',
            result: chain.valid ? 'SUCCESS' : 'FAILURE',
            actor: 'SYSTEM_AUDIT_SERVICE',
            reason: 'Bootstrap journal registered into the NxGen audit trail',
            details: {
              journalFileHash: journalHash,
              fromSequence: records[0].sequence,
              toSequence: records[records.length - 1].sequence,
              chainValid: chain.valid,
            },
          },
          client,
        );
      },
    );
    this.logger.log(
      `Imported ${records.length} bootstrap journal records into the audit trail`,
    );
    return records.length;
  }
}
