import { Pool, PoolClient } from 'pg';

/** An activation key AICAN sells: who it is for, what it unlocks, and on how many computers. */
export interface ActivationKey {
  code: string;
  customerId: string;
  customerName: string;
  site: string | null;
  licenseType: 'PERPETUAL' | 'SUBSCRIPTION';
  expiresAt: Date | null;
  modules: string[];
  deviceLimit: number;
  userLimit: number | null;
  instrumentLimit: number | null;
  note: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface ActivationRow {
  code: string;
  instanceUid: string;
  instanceId: string;
  licenseId: string;
  issuedAt: Date;
  channel: 'ONLINE' | 'OFFLINE';
}

const KEY_COLUMNS = `code, customer_id, customer_name, site, license_type, expires_at, modules, device_limit,
  user_limit, instrument_limit, note, created_at, revoked_at`;

function toKey(r: Record<string, unknown>): ActivationKey {
  return {
    code: r.code as string,
    customerId: r.customer_id as string,
    customerName: r.customer_name as string,
    site: (r.site as string) ?? null,
    licenseType: r.license_type as ActivationKey['licenseType'],
    expiresAt: (r.expires_at as Date) ?? null,
    modules: r.modules as string[],
    deviceLimit: r.device_limit as number,
    userLimit: (r.user_limit as number) ?? null,
    instrumentLimit: (r.instrument_limit as number) ?? null,
    note: (r.note as string) ?? null,
    createdAt: r.created_at as Date,
    revokedAt: (r.revoked_at as Date) ?? null,
  };
}

/** The portal's own PostgreSQL schema: activation keys and every licence issued against them. */
export class PortalStore {
  constructor(
    readonly pool: Pool,
    readonly schema = 'license_portal',
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Invalid schema name "${schema}"`);
  }

  private t(name: string): string {
    return `${this.schema}.${name}`;
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS ${this.schema};
      CREATE TABLE IF NOT EXISTS ${this.t('activation_keys')} (
        code             text PRIMARY KEY,
        customer_id      text NOT NULL,
        customer_name    text NOT NULL,
        site             text,
        license_type     text NOT NULL CHECK (license_type IN ('PERPETUAL', 'SUBSCRIPTION')),
        expires_at       timestamptz,
        modules          text[] NOT NULL DEFAULT '{}',
        device_limit     integer NOT NULL CHECK (device_limit >= 1),
        user_limit       integer,
        instrument_limit integer,
        note             text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        revoked_at       timestamptz
      );
      CREATE TABLE IF NOT EXISTS ${this.t('activations')} (
        id            bigserial PRIMARY KEY,
        code          text NOT NULL REFERENCES ${this.t('activation_keys')}(code),
        instance_uid  uuid NOT NULL,
        instance_id   text NOT NULL,
        request_id    uuid NOT NULL,
        license_id    uuid NOT NULL,
        license_text  text NOT NULL,
        channel       text NOT NULL CHECK (channel IN ('ONLINE', 'OFFLINE')),
        client_ip     text,
        issued_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS activations_code_idx ON ${this.t('activations')} (code, instance_uid);
    `);
  }

  async createKey(key: Omit<ActivationKey, 'createdAt' | 'revokedAt'>): Promise<ActivationKey> {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.t('activation_keys')}
         (code, customer_id, customer_name, site, license_type, expires_at, modules, device_limit, user_limit, instrument_limit, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${KEY_COLUMNS}`,
      [key.code, key.customerId, key.customerName, key.site, key.licenseType, key.expiresAt, key.modules, key.deviceLimit,
        key.userLimit, key.instrumentLimit, key.note],
    );
    return toKey(rows[0]);
  }

  async listKeys(): Promise<(ActivationKey & { computers: number })[]> {
    const { rows } = await this.pool.query(
      `SELECT ${KEY_COLUMNS.replace(/(\w+)/g, 'k.$1')},
              (SELECT count(DISTINCT a.instance_uid) FROM ${this.t('activations')} a WHERE a.code = k.code)::int AS computers
         FROM ${this.t('activation_keys')} k ORDER BY k.created_at`,
    );
    return rows.map((r) => ({ ...toKey(r), computers: r.computers as number }));
  }

  async revokeKey(code: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.t('activation_keys')} SET revoked_at = now() WHERE code = $1 AND revoked_at IS NULL`,
      [code],
    );
    return rowCount === 1;
  }

  async activations(code: string): Promise<ActivationRow[]> {
    const { rows } = await this.pool.query(
      `SELECT code, instance_uid, instance_id, license_id, issued_at, channel FROM ${this.t('activations')}
        WHERE code = $1 ORDER BY issued_at`,
      [code],
    );
    return rows.map((r) => ({
      code: r.code,
      instanceUid: r.instance_uid,
      instanceId: r.instance_id,
      licenseId: r.license_id,
      issuedAt: r.issued_at,
      channel: r.channel,
    }));
  }

  /** Runs fn with the key row locked, so two computers cannot both take a key's last slot. */
  async withLockedKey<T>(code: string, fn: (key: ActivationKey | null, tx: KeyTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT ${KEY_COLUMNS} FROM ${this.t('activation_keys')} WHERE code = $1 FOR UPDATE`, [code]);
      const result = await fn(rows[0] ? toKey(rows[0]) : null, new KeyTransaction(client, this.schema, code));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export class KeyTransaction {
  constructor(
    private readonly client: PoolClient,
    private readonly schema: string,
    private readonly code: string,
  ) {}

  async computers(): Promise<string[]> {
    const { rows } = await this.client.query(
      `SELECT DISTINCT instance_uid FROM ${this.schema}.activations WHERE code = $1`,
      [this.code],
    );
    return rows.map((r) => r.instance_uid as string);
  }

  async record(a: { instanceUid: string; instanceId: string; requestId: string; licenseId: string; licenseText: string; channel: 'ONLINE' | 'OFFLINE'; clientIp: string | null }) {
    await this.client.query(
      `INSERT INTO ${this.schema}.activations (code, instance_uid, instance_id, request_id, license_id, license_text, channel, client_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [this.code, a.instanceUid, a.instanceId, a.requestId, a.licenseId, a.licenseText, a.channel, a.clientIp],
    );
  }
}
