import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { canonicalize } from '@crescent/licensing';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';

/** Identity used for events before any administrator exists (License PRD §43). */
export const SYSTEM_LICENSE_SERVICE = 'SYSTEM_LICENSE_SERVICE';

export interface AuditEventInput {
  category:
    | 'LICENSING'
    | 'PLATFORM'
    | 'SECURITY'
    | 'USER_MANAGEMENT'
    | 'SYSTEM'
    | 'WORKFLOW'
    | 'METHODS'
    | 'DEVICES'
    | 'MODULES';
  action: string;
  result: 'SUCCESS' | 'FAILURE' | 'INFO';
  /** User ID, or a system identity such as SYSTEM_LICENSE_SERVICE. */
  actor: string;
  actorName?: string | null;
  platformInstanceId?: string | null;
  tableName?: string | null;
  recordId?: string | null;
  licenseReference?: string | null;
  certificateId?: string | null;
  previousState?: string | null;
  newState?: string | null;
  reason?: string | null;
  errorCode?: string | null;
  ipAddress?: string | null;
  machineName?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

export interface AuditRecord extends AuditEventInput {
  eventId: string;
  timestamp: string;
  sequence: number;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

/**
 * Bootstrap Installation Journal (Smart Installer PRD §46) / pre-database audit.
 *
 * INTERIM system audit trail: append-only, hash-chained JSON Lines file.
 *
 * Each record carries the hash of the previous one, so deletion, reordering or
 * editing of any record is detectable by verifyChain(). This is tamper-EVIDENT,
 * not tamper-proof; it will be replaced by the PostgreSQL audit engine
 * (append-only table, revoked UPDATE/DELETE) once the database layer exists,
 * and this file then becomes the bootstrap journal imported into it.
 *
 * Never pass secrets (keys, passwords, license file contents) in events.
 */
@Injectable()
export class BootstrapJournal {
  readonly path: string;
  private lastHash = GENESIS;
  private sequence = 0;
  private loaded = false;

  constructor(@Inject(NXGEN_CONFIG) config: NxGenConfig) {
    this.path = join(config.dataDir, 'audit', 'system-audit.jsonl');
  }

  private load(): void {
    if (this.loaded) return;
    if (existsSync(this.path)) {
      const lines = readFileSync(this.path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]) as AuditRecord;
        this.lastHash = last.hash;
        this.sequence = last.sequence;
      }
    }
    this.loaded = true;
  }

  private static hashOf(record: Omit<AuditRecord, 'hash'>): string {
    return createHash('sha256').update(canonicalize(record)).digest('hex');
  }

  record(event: AuditEventInput): AuditRecord {
    this.load();
    const base: Omit<AuditRecord, 'hash'> = {
      ...event,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      sequence: this.sequence + 1,
      prevHash: this.lastHash,
    };
    // Drop undefined so the hashed form equals the stored JSON form.
    const clean = JSON.parse(JSON.stringify(base)) as Omit<AuditRecord, 'hash'>;
    const record: AuditRecord = {
      ...clean,
      hash: BootstrapJournal.hashOf(clean),
    };

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // Opened for writing: Windows refuses to flush (fsync) a read-only handle (EPERM).
    const fd = openSync(this.path, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    this.lastHash = record.hash;
    this.sequence = record.sequence;
    return record;
  }

  readAll(): AuditRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditRecord);
  }

  verifyChain(): { valid: boolean; brokenAtSequence?: number } {
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const record of this.readAll()) {
      const { hash, ...rest } = record;
      if (
        record.sequence !== expectedSeq ||
        record.prevHash !== prev ||
        BootstrapJournal.hashOf(rest) !== hash
      ) {
        return { valid: false, brokenAtSequence: record.sequence };
      }
      prev = hash;
      expectedSeq++;
    }
    return { valid: true };
  }
}
