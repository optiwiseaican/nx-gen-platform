import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'os';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { DatabaseConfig, NxGenConfig } from '../config/nxgen.config';

/**
 * Who is acting, and why. Every write transaction carries this context into
 * PostgreSQL (set_config, transaction-local) so the database triggers can
 * stamp created_by/modified_by and write the audit trail themselves —
 * application code cannot "forget" to audit a change.
 */
export interface ActorContext {
  actorId: string;
  actorName?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
  machineName?: string | null;
  platformInstanceId?: string | null;
}

export type Queryable = Pick<PoolClient, 'query'>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;
  readonly config: DatabaseConfig | null;

  constructor(@Inject(NXGEN_CONFIG) config: NxGenConfig) {
    this.config = config.database;
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  private getPool(): Pool {
    if (!this.config) throw new Error('No database configured (DATABASE_URL)');
    if (!this.pool) {
      const { schema } = this.config;
      this.pool = new Pool({
        connectionString: this.config.connectionString,
        ssl: this.config.ssl || undefined,
        max: 10,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        application_name: 'nxgen-core',
      });
      this.pool.on('connect', (client) => {
        void client.query(
          `SET search_path TO ${schema}, public; SET TIME ZONE 'UTC'`,
        );
      });
      this.pool.on('error', (err) =>
        this.logger.error(`Idle database client error: ${err.message}`),
      );
    }
    return this.pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.getPool().query<T>(sql, params);
    return result.rows;
  }

  /** Runs fn in a transaction with the actor context applied. */
  async transaction<T>(
    actor: ActorContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await applyActorContext(client, actor);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** A dedicated client (e.g. for the migrator's advisory lock). */
  async connect(): Promise<PoolClient> {
    return this.getPool().connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}

export async function applyActorContext(
  client: Queryable,
  actor: ActorContext,
): Promise<void> {
  await client.query(
    `SELECT set_config('nxgen.actor_id', $1, true), set_config('nxgen.actor_name', $2, true),
            set_config('nxgen.reason', $3, true), set_config('nxgen.ip_address', $4, true),
            set_config('nxgen.machine_name', $5, true), set_config('nxgen.platform_instance_id', $6, true)`,
    [
      actor.actorId,
      actor.actorName ?? '',
      actor.reason ?? '',
      actor.ipAddress ?? '',
      actor.machineName ?? hostname(),
      actor.platformInstanceId ?? '',
    ],
  );
}
