import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import type { PoolClient } from 'pg';
import { applyActorContext } from './database.service';

export const MIGRATIONS_DIR = join(__dirname, 'migrations');
export const MIGRATION_ACTOR = 'SYSTEM_MIGRATION';

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  current: number;
}

/**
 * SHA-256 of the migration text with LF line endings, so a checkout that converted the file to
 * CRLF (Git for Windows' default) has the same checksum as the one recorded when it was applied.
 * Any other change, including whitespace inside a line, still changes the checksum.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: Number(file.slice(0, 3)),
        name: file.replace(/\.sql$/, ''),
        sql,
        checksum: migrationChecksum(sql),
      };
    });
}

/**
 * Applies pending migrations, each in its own transaction, under a
 * session-level advisory lock so two services can never migrate concurrently.
 *
 * Applied migrations are immutable: if the checksum of an applied file no
 * longer matches, startup is refused (a validated schema must not drift
 * silently; changes go into a new migration under change control).
 */
export async function migrate(
  client: PoolClient,
  schema: string,
  migrations = loadMigrations(),
): Promise<MigrationResult> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [
    `${schema}.migrations`,
  ]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text NOT NULL
      )`);
    const applied = new Map(
      (
        await client.query<{ version: number; checksum: string; name: string }>(
          'SELECT version, checksum, name FROM schema_migrations',
        )
      ).rows.map((r) => [r.version, r]),
    );

    for (const [version, row] of applied) {
      const file = migrations.find((m) => m.version === version);
      if (!file)
        throw new Error(
          `Database has migration ${row.name} which this NxGen version does not know about`,
        );
      if (file.checksum !== row.checksum) {
        throw new Error(
          `Migration ${row.name} was modified after it was applied (checksum mismatch); startup refused`,
        );
      }
    }

    const done: string[] = [];
    for (const m of migrations.filter((m) => !applied.has(m.version))) {
      await client.query('BEGIN');
      try {
        await applyActorContext(client, {
          actorId: MIGRATION_ACTOR,
          actorName: 'Schema migration',
          reason: `Apply ${m.name}`,
          machineName: hostname(),
        });
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, applied_by) VALUES ($1, $2, $3, $4)',
          [m.version, m.name, m.checksum, MIGRATION_ACTOR],
        );
        await client.query(
          `INSERT INTO audit_trail (category, action, result, actor_id, actor_name, table_name, record_id, details)
           VALUES ('SYSTEM', 'SCHEMA_MIGRATION_APPLIED', 'SUCCESS', $1, 'Schema migration', 'schema_migrations', $2, $3)`,
          [
            MIGRATION_ACTOR,
            String(m.version),
            JSON.stringify({ name: m.name, checksum: m.checksum }),
          ],
        );
        await client.query('COMMIT');
        done.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${m.name} failed: ${(err as Error).message}`,
        );
      }
    }
    const current = Math.max(0, ...migrations.map((m) => m.version));
    return { applied: done, current };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
      `${schema}.migrations`,
    ]);
  }
}
