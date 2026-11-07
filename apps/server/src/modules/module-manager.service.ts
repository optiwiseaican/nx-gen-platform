import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, extname, join, resolve, sep } from 'path';
import {
  compareVersions,
  ModuleManifest,
  verifyModulePackage,
  VerifiedModulePackage,
} from '@crescent/licensing';
import type {
  ModuleContext,
  ModulePrincipal,
  ModuleTx,
  ModuleRoute,
  NxGenModule,
  PacketHandler,
} from '@crescent/module-sdk';
import { AuditService } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { DevicesService } from '../devices/devices.service';
import { GatewayService } from '../gateway/gateway.service';
import { LicensingService } from '../licensing/licensing.service';
import { SignatureService } from '../signatures/signature.service';
import type { SignatureInput } from '../signatures/signature.service';
import { lintModuleSql } from './migration-lint';
import { LoadedModule, ModuleRegistry } from './module-registry';
import { WorkflowService } from '../workflow/workflow.service';
import type { PoolClient } from 'pg';

const STAGING_TTL_MS = 30 * 60_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

interface InstalledRow {
  module_id: string;
  name: string;
  version: string;
  previous_version: string | null;
  module_status: 'ENABLED' | 'DISABLED';
  manifest: ModuleManifest;
  file_hashes: Record<string, string>;
  package_sha256: string;
  signing_key_id: string;
  install_path: string;
  created_at: Date;
  modified_at: Date | null;
}

type RuntimeState =
  | 'RUNNING'
  | 'DISABLED'
  | 'LICENSE_MISSING'
  | 'INTEGRITY_FAILED'
  | 'INCOMPATIBLE'
  | 'LOAD_FAILED';

const sha256 = (b: Buffer | string) =>
  createHash('sha256').update(b).digest('hex');

/** Paths like "/instruments/:id/live" → matcher. */
function matcher(path: string) {
  const names: string[] = [];
  const re = new RegExp(
    '^' +
      path
        .split('/')
        .map((seg) =>
          seg.startsWith(':')
            ? (names.push(seg.slice(1)), '([^/]+)')
            : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/') +
      '/?$',
  );
  return (p: string) => {
    const m = re.exec(p);
    return m
      ? Object.fromEntries(
          names.map((n, i) => [n, decodeURIComponent(m[i + 1])]),
        )
      : null;
  };
}

/**
 * Module manager (Technical Architecture §3–§6, Option B). Installs signed
 * .nxmod packages: verifies signature, every file hash, licence entitlement and
 * core compatibility; extracts to a versioned folder (the previous version is
 * kept for rollback); runs the module's checksum-locked, prefix-checked
 * migrations; registers its permissions and instrument types; loads it through
 * the ModuleContext adapter; and audits every step. At start-up each enabled
 * module is re-verified file by file before it is loaded.
 */
@Injectable()
export class ModuleManagerService implements OnModuleInit {
  private readonly logger = new Logger('Modules');
  private readonly staged = new Map<
    string,
    { pkg: VerifiedModulePackage; userId: string; at: number; fileName: string }
  >();
  private readonly runtime = new Map<
    string,
    { state: RuntimeState; message: string | null }
  >();
  private readonly ui = new Map<string, Map<string, Buffer>>();
  private readonly matchers = new Map<
    ModuleRoute,
    ReturnType<typeof matcher>
  >();

  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly signatures: SignatureService,
    private readonly licensing: LicensingService,
    private readonly registry: ModuleRegistry,
    private readonly devices: DevicesService,
    private readonly gateway: GatewayService,
    private readonly workflow: WorkflowService,
  ) {}

  /** Transactions handed to modules, mapped back to their database client. */
  private readonly txClients = new WeakMap<ModuleTx, PoolClient>();

  private txOf(client: PoolClient): ModuleTx {
    const tx: ModuleTx = {
      query: async <T>(sql: string, params: unknown[] = []) =>
        (await client.query(sql, params)).rows as T[],
    };
    this.txClients.set(tx, client);
    return tx;
  }

  private clientOf(tx: ModuleTx): PoolClient {
    const c = this.txClients.get(tx);
    if (!c) throw new Error('Not a transaction opened by ctx.db.transaction');
    return c;
  }

  private get root() {
    return join(this.config.dataDir, 'modules');
  }

  async onModuleInit() {
    if (!this.db.enabled) return;
    for (const row of await this.rows()) {
      if (row.module_status !== 'ENABLED') {
        this.runtime.set(row.module_id, { state: 'DISABLED', message: null });
        continue;
      }
      await this.load(row);
    }
  }

  private async rows(): Promise<InstalledRow[]> {
    return this.db.query<InstalledRow>(
      'SELECT * FROM installed_modules WHERE NOT is_deleted ORDER BY module_id',
    );
  }

  private async row(id: string): Promise<InstalledRow | undefined> {
    const [r] = await this.db.query<InstalledRow>(
      'SELECT * FROM installed_modules WHERE module_id = $1 AND NOT is_deleted',
      [id],
    );
    return r;
  }

  private event(
    action: string,
    result: 'SUCCESS' | 'FAILURE' | 'INFO',
    e: {
      principal?: Pick<Principal, 'userId' | 'fullName'> | null;
      recordId: string;
      reason?: string | null;
      details?: Record<string, string | number | boolean | null>;
    },
    client?: Parameters<AuditService['record']>[1],
  ) {
    return this.audit.record(
      {
        category: 'MODULES',
        action,
        result,
        actor: e.principal?.userId ?? 'SYSTEM_MODULE_MANAGER',
        actorName: e.principal?.fullName ?? 'Module manager',
        tableName: 'installed_modules',
        recordId: e.recordId,
        reason: e.reason ?? null,
        details: e.details,
      },
      client,
    );
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  private compatibility(manifest: ModuleManifest): string | null {
    if (
      compareVersions(this.config.platformVersion, manifest.minCoreVersion) < 0
    )
      return `Requires NxGen ${manifest.minCoreVersion} or later (this is ${this.config.platformVersion}).`;
    return null;
  }

  /** Verify files on disk against the signed hashes, then load through the adapter. */
  private async load(row: InstalledRow): Promise<boolean> {
    const id = row.module_id;
    const fail = async (state: RuntimeState, message: string) => {
      this.runtime.set(id, { state, message });
      this.logger.error(`Module ${id} ${row.version} not loaded: ${message}`);
      await this.event('MODULE_LOAD_FAILED', 'FAILURE', {
        recordId: id,
        reason: message,
        details: { version: row.version, state },
      });
      return false;
    };
    this.registry.remove(id);
    this.ui.delete(id);

    const incompatible = this.compatibility(row.manifest);
    if (incompatible) return fail('INCOMPATIBLE', incompatible);
    if (!this.licensing.hasModule(row.manifest.entitlement))
      return fail(
        'LICENSE_MISSING',
        `The licence does not include the "${row.manifest.entitlement}" module.`,
      );

    const ui = new Map<string, Buffer>();
    for (const [path, hash] of Object.entries(row.file_hashes)) {
      const full = join(row.install_path, ...path.split('/'));
      let data: Buffer;
      try {
        data = readFileSync(full);
      } catch {
        return fail('INTEGRITY_FAILED', `File ${path} is missing.`);
      }
      if (sha256(data) !== hash)
        return fail(
          'INTEGRITY_FAILED',
          `File ${path} does not match its signed hash; it may have been altered.`,
        );
      if (path.startsWith('ui/')) ui.set(path.slice(3), data);
    }

    const routes: ModuleRoute[] = [];
    const handlers: PacketHandler[] = [];
    let mod: NxGenModule;
    try {
      const entry = resolve(row.install_path, row.manifest.apiEntry);
      const req = createRequire(entry);
      delete req.cache[entry];
      const loaded = req(entry) as NxGenModule | { default: NxGenModule };
      mod = 'register' in loaded ? loaded : loaded.default;
      if (typeof mod?.register !== 'function')
        throw new Error(
          `${row.manifest.apiEntry} does not export register(ctx)`,
        );
      await mod.register(this.context(row.manifest, routes, handlers));
      const health = mod.healthCheck ? await mod.healthCheck() : { ok: true };
      if (!health.ok)
        throw new Error(
          `Health check failed: ${health.message ?? 'no details'}`,
        );
    } catch (e) {
      return fail('LOAD_FAILED', (e as Error).message);
    }
    for (const r of routes) this.matchers.set(r, matcher(r.path));
    const lm: LoadedModule = {
      id,
      manifest: row.manifest,
      installPath: row.install_path,
      routes,
      handlers,
      unload: mod.unload?.bind(mod),
    };
    this.registry.add(lm);
    this.ui.set(id, ui);
    this.runtime.set(id, { state: 'RUNNING', message: null });
    this.logger.log(
      `Module ${id} ${row.version} loaded (${routes.length} routes, ${handlers.length} packet handlers)`,
    );
    await this.event('MODULE_LOADED', 'INFO', {
      recordId: id,
      details: { version: row.version },
    });
    return true;
  }

  /** The only door from a module into the core (core API v1). */
  private context(
    manifest: ModuleManifest,
    routes: ModuleRoute[],
    handlers: PacketHandler[],
  ): ModuleContext {
    const own = new Set(manifest.permissions.map((p) => p.code));
    const types = new Set(manifest.instrumentTypes.map((t) => t.code));
    const logger = new Logger(`Module:${manifest.id}`);
    return {
      apiVersion: 1,
      module: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
      },
      production: this.config.production,
      logger: {
        log: (m) => logger.log(m),
        warn: (m) => logger.warn(m),
        error: (m) => logger.error(m),
      },
      http: {
        route: (r) => {
          if (
            !['GET', 'POST', 'PUT'].includes(r.method) ||
            !/^\/[A-Za-z0-9/:_-]*$/.test(r.path)
          )
            throw new Error(`Invalid route ${r.method} ${r.path}`);
          if (
            !own.has(r.permission) &&
            r.permission.startsWith(`${manifest.id}.`)
          )
            throw new Error(
              `Route ${r.path} uses undeclared permission ${r.permission}`,
            );
          routes.push(r);
        },
      },
      db: {
        query: (sql, params = []) => this.db.query(sql, params) as never,
        transaction: (principal, reason, origin, fn) =>
          this.db.transaction(
            {
              actorId: principal.userId,
              actorName: principal.fullName,
              reason: reason ?? undefined,
              ipAddress: origin.ipAddress,
              machineName: origin.machineName,
            },
            (client) => fn(this.txOf(client)),
          ),
      },
      workflow: {
        registerRecordType: (t) => {
          if (!t.tableName.startsWith(manifest.tablePrefix))
            throw new Error(
              `Record table ${t.tableName} is not a ${manifest.tablePrefix} table`,
            );
          this.workflow.registerRecordType({
            tableName: t.tableName,
            load: (client, id) => t.load(this.txOf(client), id),
            link: (seriesId) =>
              `/modules/${manifest.id}/${t.link(seriesId).replace(/^\/+/, '')}`,
            authorOf: t.authorOf
              ? (client, id) => t.authorOf!(this.txOf(client), id)
              : undefined,
            beforeSubmit: t.beforeSubmit
              ? (client, id) => t.beforeSubmit!(this.txOf(client), id)
              : undefined,
          });
        },
        start: (tx, principal, input) => {
          if (
            !manifest.workflows.some(
              (w) =>
                w.code === input.definitionCode &&
                w.recordTable === input.tableName,
            )
          )
            throw new Error(
              `Workflow ${input.definitionCode} is not declared by module ${manifest.id} for ${input.tableName}`,
            );
          return this.workflow.start(
            this.clientOf(tx),
            {
              userId: principal.userId,
              fullName: principal.fullName,
            } as Principal,
            input,
          );
        },
        assertEditable: (tx, tableName, recordId) =>
          this.workflow.assertEditable(this.clientOf(tx), tableName, recordId),
        forRecord: async (tableName, recordId) => {
          if (!tableName.startsWith(manifest.tablePrefix))
            throw new Error('Not this module’s table');
          const [row] = await this.db.query<{ id: string }>(
            'SELECT id FROM workflow_instances WHERE table_name = $1 AND record_id = $2',
            [tableName, recordId],
          );
          if (!row) return null;
          const i = await this.workflow.get(row.id);
          return {
            id: i.id,
            definitionCode: i.definitionCode,
            state: i.state,
            contentHash: i.contentHash,
            preparedBy: i.preparedBy,
            reviewedBy: i.reviewedBy,
            approvedBy: i.approvedBy,
            submittedAt: i.submittedAt,
            approvedAt: i.approvedAt,
          };
        },
      },
      methods: {
        effective: async (instrumentType) => {
          if (!types.has(instrumentType))
            throw new Error(
              `Module ${manifest.id} does not provide ${instrumentType} instruments`,
            );
          const rows = await this.db.query<{
            method_id: string;
            code: string;
            version_id: string;
            version_number: number;
            name: string;
            purpose: string;
            parameters: { name: string; value: string; unit: string }[];
          }>(
            `SELECT m.id AS method_id, m.code, v.id AS version_id, v.version_number, v.name, v.purpose, v.parameters
               FROM methods m
               JOIN method_versions v ON v.method_id = m.id AND NOT v.is_deleted
               JOIN workflow_instances wi ON wi.table_name = 'method_versions' AND wi.record_id = v.id::text AND wi.state = 'APPROVED'
              WHERE m.instrument_type = $1 AND NOT m.is_deleted ORDER BY m.code`,
            [instrumentType],
          );
          return rows.map((r) => ({
            methodId: r.method_id,
            code: r.code,
            versionId: r.version_id,
            versionNumber: r.version_number,
            name: r.name,
            purpose: r.purpose,
            parameters: r.parameters,
          }));
        },
      },
      audit: {
        record: (e) =>
          this.audit.record({
            category: 'MODULES',
            action: e.action,
            result: e.result,
            actor: e.principal?.userId ?? `MODULE:${manifest.id}`,
            actorName: e.principal?.fullName ?? manifest.name,
            tableName: `${manifest.tablePrefix}*`,
            recordId: e.recordId ?? null,
            reason: e.reason ?? null,
            details: { ...(e.details ?? {}), module: manifest.id },
          }),
      },
      devices: {
        get: async (id) => {
          const d = await this.registry.devices.get(id);
          return d && types.has(d.instrumentType) ? d : null;
        },
        list: async (type) => {
          if (!types.has(type))
            throw new Error(
              `Module ${manifest.id} does not provide ${type} instruments`,
            );
          return this.registry.devices.list(type);
        },
      },
      calibrations: {
        record: (principal: ModulePrincipal, deviceId, input, origin) =>
          this.devices.createCalibration(
            principal,
            deviceId,
            input,
            origin,
            manifest.id,
          ),
      },
      gateway: {
        registerHandler: (h) => {
          if (!types.has(h.instrumentType))
            throw new Error(
              `Module ${manifest.id} does not provide ${h.instrumentType} instruments`,
            );
          handlers.push(h);
        },
        persist: (device, packet, kind, payload) => {
          if (!types.has(device.instrumentType))
            throw new Error('Not this module’s instrument');
          return this.gateway.persist(device, packet, kind, payload);
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list() {
    return (await this.rows()).map((r) => ({
      id: r.module_id,
      name: r.name,
      version: r.version,
      previousVersion: r.previous_version,
      description: r.manifest.description,
      status: r.module_status,
      runtime: this.runtime.get(r.module_id) ?? {
        state: 'DISABLED',
        message: null,
      },
      entitled: this.licensing.hasModule(r.manifest.entitlement),
      instrumentTypes: r.manifest.instrumentTypes,
      permissions: r.manifest.permissions.map((p) => p.code),
      packageSha256: r.package_sha256,
      signingKeyId: r.signing_key_id,
      installedAt: r.created_at.toISOString(),
      updatedAt: r.modified_at?.toISOString() ?? null,
      ui: r.manifest.uiEntry ? `/modules/${r.module_id}/` : null,
    }));
  }

  /** Menu entries for the signed-in user (only running modules, only permitted items). */
  menu(principal: Pick<Principal, 'permissions'>) {
    return this.registry.all().flatMap((m) =>
      m.manifest.menu
        .filter((item) => principal.permissions.includes(item.permission))
        .map((item) => ({
          module: m.id,
          label: item.label,
          href: `/modules/${m.id}${item.path}`,
        })),
    );
  }

  context4ui(id: string) {
    const m = this.registry.get(id);
    if (!m)
      throw new NotFoundException(
        'This module is not installed or not running.',
      );
    return {
      module: { id: m.id, name: m.manifest.name, version: m.manifest.version },
      webBaseUrl:
        process.env.NXGEN_WEB_URL ??
        (this.config.production ? '' : 'http://localhost:3000'),
    };
  }

  // ---------------------------------------------------------------------------
  // Install
  // ---------------------------------------------------------------------------

  /** Step 1: upload and verify; nothing is changed yet. Returns what would be installed. */
  async stage(principal: Principal, data: unknown, fileName: string) {
    if (!Buffer.isBuffer(data) || data.length === 0)
      throw new BadRequestException(
        'Upload the .nxmod file as application/octet-stream.',
      );
    const v = verifyModulePackage(data, this.config.trustedKeys);
    if (!v.ok) {
      await this.event('MODULE_PACKAGE_REJECTED', 'FAILURE', {
        principal,
        recordId: fileName.slice(0, 120) || 'upload',
        reason: v.message,
        details: { check: v.reason },
      });
      throw new BadRequestException({
        code: `NX-MOD-${v.reason}`,
        message: v.message,
      });
    }
    const m = v.pkg.manifest;
    const problems: string[] = [];
    const incompatible = this.compatibility(m);
    if (incompatible) problems.push(incompatible);
    if (!this.licensing.hasModule(m.entitlement))
      problems.push(
        `The licence does not include the "${m.entitlement}" module. Contact AICAN to add it.`,
      );
    const current = await this.row(m.id);
    if (current && compareVersions(m.version, current.version) < 0)
      problems.push(
        `Version ${current.version} is installed; downgrading to ${m.version} is not allowed.`,
      );
    if (
      current &&
      compareVersions(m.version, current.version) === 0 &&
      current.package_sha256 === v.pkg.packageSha256
    )
      problems.push(`${m.name} ${m.version} is already installed.`);
    const migrations = v.pkg.files
      .filter((f) => f.path.startsWith('migrations/'))
      .map((f) => f.path.slice(11))
      .sort();
    const applied = new Map(
      (
        await this.db.query<{ filename: string; checksum: string }>(
          'SELECT filename, checksum FROM module_migrations WHERE module_id = $1',
          [m.id],
        )
      ).map((r) => [r.filename, r.checksum]),
    );
    for (const f of v.pkg.files.filter((x) =>
      x.path.startsWith('migrations/'),
    )) {
      const name = f.path.slice(11);
      const prior = applied.get(name);
      if (prior && prior !== sha256(f.data))
        problems.push(
          `Migration ${name} differs from the one already applied.`,
        );
      for (const p of lintModuleSql(f.data.toString('utf8'), m.tablePrefix))
        problems.push(`${name}: ${p}`);
    }
    for (const t of m.instrumentTypes) {
      const [owner] = await this.db.query<{ module_id: string | null }>(
        'SELECT module_id FROM instrument_types WHERE code = $1',
        [t.code],
      );
      if (owner && owner.module_id !== m.id)
        problems.push(
          `Instrument type ${t.code} belongs to ${owner.module_id ?? 'the core'}.`,
        );
    }
    for (const [k, s] of this.staged)
      if (Date.now() - s.at > STAGING_TTL_MS) this.staged.delete(k);
    const stagingId = randomUUID();
    if (!problems.length)
      this.staged.set(stagingId, {
        pkg: v.pkg,
        userId: principal.userId,
        at: Date.now(),
        fileName,
      });
    return {
      stagingId: problems.length ? null : stagingId,
      problems,
      module: {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        installedVersion: current?.version ?? null,
        instrumentTypes: m.instrumentTypes,
        permissions: m.permissions,
        menu: m.menu,
        migrations: migrations.map((name) => ({
          name,
          applied: applied.has(name),
        })),
        files: v.pkg.files.length,
        packageSha256: v.pkg.packageSha256,
        signingKeyId: v.pkg.keyId,
      },
    };
  }

  /** Step 2: install the staged package (signed, with a reason). */
  async install(
    principal: Principal,
    stagingIdInput: unknown,
    reasonInput: unknown,
    signature: SignatureInput | undefined,
    origin: RequestOrigin,
  ) {
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 10)
      throw new BadRequestException({
        message:
          'Enter the reason for installing (at least 10 characters), e.g. the change request.',
        field: 'reason',
      });
    const staged =
      typeof stagingIdInput === 'string'
        ? this.staged.get(stagingIdInput)
        : undefined;
    if (
      !staged ||
      staged.userId !== principal.userId ||
      Date.now() - staged.at > STAGING_TTL_MS
    )
      throw new ConflictException(
        'Upload the module package again; the verified upload has expired.',
      );
    const { pkg } = staged;
    const m = pkg.manifest;
    const signer = await this.signatures.authorize(
      'MODULE_INSTALL',
      principal,
      signature,
      reason,
      origin,
    );
    this.staged.delete(stagingIdInput as string);

    const current = await this.row(m.id);
    const installPath = join(this.root, m.id, m.version);
    if (!resolve(installPath).startsWith(resolve(this.root) + sep))
      throw new ForbiddenException('Invalid module id.');
    rmSync(installPath, { recursive: true, force: true });
    for (const f of pkg.files) {
      const target = resolve(installPath, ...f.path.split('/'));
      if (!target.startsWith(resolve(installPath) + sep))
        throw new ForbiddenException(`Invalid path ${f.path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.data, { mode: 0o644 });
    }

    try {
      await this.db.transaction(
        {
          actorId: principal.userId,
          actorName: principal.fullName,
          reason,
          ipAddress: origin.ipAddress,
          machineName: origin.machineName,
        },
        async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `nxgen.module.${m.id}`,
          ]);
          const fileHashes = pkg.fileHashes;
          if (current)
            await client.query(
              `UPDATE installed_modules SET name = $2, version = $3, previous_version = $4, module_status = 'ENABLED', manifest = $5,
                      file_hashes = $6, package_sha256 = $7, signing_key_id = $8, install_path = $9 WHERE module_id = $1`,
              [
                m.id,
                m.name,
                m.version,
                current.version,
                JSON.stringify(m),
                JSON.stringify(fileHashes),
                pkg.packageSha256,
                pkg.keyId,
                installPath,
              ],
            );
          else
            await client.query(
              `INSERT INTO installed_modules (module_id, name, version, manifest, file_hashes, package_sha256, signing_key_id, install_path)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                m.id,
                m.name,
                m.version,
                JSON.stringify(m),
                JSON.stringify(fileHashes),
                pkg.packageSha256,
                pkg.keyId,
                installPath,
              ],
            );
          const { rows: done } = await client.query<{
            filename: string;
            checksum: string;
          }>(
            'SELECT filename, checksum FROM module_migrations WHERE module_id = $1',
            [m.id],
          );
          const applied = new Map(done.map((r) => [r.filename, r.checksum]));
          const migrations = pkg.files
            .filter((f) => f.path.startsWith('migrations/'))
            .sort((a, b) => a.path.localeCompare(b.path));
          for (const f of migrations) {
            const name = f.path.slice(11);
            const checksum = sha256(f.data);
            if (applied.get(name) === checksum) continue;
            if (applied.has(name))
              throw new ConflictException(
                `Migration ${name} differs from the one already applied.`,
              );
            const problems = lintModuleSql(
              f.data.toString('utf8'),
              m.tablePrefix,
            );
            if (problems.length)
              throw new ConflictException(
                `Migration ${name} is not allowed: ${problems.join('; ')}`,
              );
            await client.query(f.data.toString('utf8'));
            await client.query(
              'INSERT INTO module_migrations (module_id, filename, checksum, module_version, applied_by) VALUES ($1, $2, $3, $4, $5)',
              [m.id, name, checksum, m.version, principal.userId],
            );
            await this.event(
              'MODULE_MIGRATION_APPLIED',
              'SUCCESS',
              {
                principal,
                recordId: m.id,
                reason,
                details: { migration: name, version: m.version },
              },
              client,
            );
          }
          for (const p of m.permissions) {
            const { rowCount } = await client.query(
              'INSERT INTO permissions (code, description) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING',
              [p.code, p.description],
            );
            if (rowCount)
              for (const role of p.defaultRoles)
                await client.query(
                  `INSERT INTO role_permissions (role_code, permission_code)
                   SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM roles WHERE code = $1) ON CONFLICT DO NOTHING`,
                  [role, p.code],
                );
          }
          for (const w of m.workflows)
            await client.query(
              `INSERT INTO workflow_definitions (code, name, record_table, edit_permission, review_permission, approve_permission,
                                                 require_review, independent_reviewer, independent_approver)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (code) DO NOTHING`,
              [
                w.code,
                w.name,
                w.recordTable,
                w.editPermission,
                w.reviewPermission,
                w.approvePermission,
                w.requireReview,
                w.independentReviewer,
                w.independentApprover,
              ],
            );
          for (const t of m.instrumentTypes)
            await client.query(
              `INSERT INTO instrument_types (code, label, module_id) VALUES ($1, $2, $3)
               ON CONFLICT (code) DO NOTHING`,
              [t.code, t.label, m.id],
            );
          await this.event(
            current ? 'MODULE_UPGRADED' : 'MODULE_INSTALLED',
            'SUCCESS',
            {
              principal,
              recordId: m.id,
              reason,
              details: {
                version: m.version,
                previousVersion: current?.version ?? null,
                packageSha256: pkg.packageSha256,
                signingKeyId: pkg.keyId,
                databaseBackup: 'not taken: backup and restore is deferred',
              },
            },
            client,
          );
          if (signer)
            await this.signatures.apply(
              client,
              signer,
              {
                tableName: 'installed_modules',
                recordId: m.id,
                content: {
                  module: m.id,
                  version: m.version,
                  previousVersion: current?.version ?? null,
                  packageSha256: pkg.packageSha256,
                  signingKeyId: pkg.keyId,
                },
              },
              origin,
            );
        },
      );
    } catch (e) {
      // Nothing was committed: remove the new folder, keep the previous version running.
      if (!current || current.version !== m.version)
        rmSync(installPath, { recursive: true, force: true });
      throw e;
    }

    const loaded = await this.load((await this.row(m.id))!);
    if (
      !loaded &&
      current &&
      existsSync(current.install_path) &&
      current.version !== m.version
    ) {
      this.logger.warn(
        `Module ${m.id} ${m.version} failed to load; previous version ${current.version} is still on disk for rollback.`,
      );
    }
    return { module: (await this.list()).find((x) => x.id === m.id), loaded };
  }

  async setEnabled(
    principal: Principal,
    id: string,
    enabled: boolean,
    reasonInput: unknown,
    signature: SignatureInput | undefined,
    origin: RequestOrigin,
  ) {
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (reason.length < 10)
      throw new BadRequestException({
        message: 'Enter the reason (at least 10 characters).',
        field: 'reason',
      });
    const row = await this.row(id);
    if (!row) throw new NotFoundException('Module not installed.');
    if ((row.module_status === 'ENABLED') === enabled)
      throw new BadRequestException(
        `The module is already ${enabled ? 'enabled' : 'disabled'}.`,
      );
    const signer = await this.signatures.authorize(
      enabled ? 'MODULE_ENABLE' : 'MODULE_DISABLE',
      principal,
      signature,
      reason,
      origin,
    );
    await this.db.transaction(
      {
        actorId: principal.userId,
        actorName: principal.fullName,
        reason,
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
      },
      async (client) => {
        await client.query(
          'UPDATE installed_modules SET module_status = $2 WHERE module_id = $1',
          [id, enabled ? 'ENABLED' : 'DISABLED'],
        );
        await this.event(
          enabled ? 'MODULE_ENABLED' : 'MODULE_DISABLED',
          'SUCCESS',
          {
            principal,
            recordId: id,
            reason,
            details: { version: row.version },
          },
          client,
        );
        if (signer)
          await this.signatures.apply(
            client,
            signer,
            {
              tableName: 'installed_modules',
              recordId: id,
              content: { module: id, version: row.version, enabled },
            },
            origin,
          );
      },
    );
    if (enabled) await this.load((await this.row(id))!);
    else {
      this.registry.remove(id);
      this.ui.delete(id);
      this.runtime.set(id, { state: 'DISABLED', message: null });
    }
    return (await this.list()).find((x) => x.id === id);
  }

  // ---------------------------------------------------------------------------
  // Serving
  // ---------------------------------------------------------------------------

  route(id: string, method: string, path: string) {
    const m = this.registry.get(id);
    if (!m) return null;
    for (const r of m.routes) {
      if (r.method !== method) continue;
      const params = this.matchers.get(r)?.(path);
      if (params) return { route: r, params };
    }
    return null;
  }

  /** Static UI files of a running module, served from verified memory copies. */
  uiFile(id: string, rel: string): { data: Buffer; type: string } | null {
    const files = this.ui.get(id);
    if (!files) return null;
    const clean = rel.replace(/^\/+/, '') || 'index.html';
    const data =
      files.get(clean) ??
      (extname(clean) ? undefined : files.get('index.html'));
    if (!data) return null;
    const name = files.has(clean) ? clean : 'index.html';
    return { data, type: MIME[extname(name)] ?? 'application/octet-stream' };
  }
}
