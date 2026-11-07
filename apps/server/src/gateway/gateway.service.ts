import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ReadlineParser, SerialPort } from 'serialport';
import type {
  DeviceInfo,
  InstrumentPacket,
  PacketDecision,
  Transport,
} from '@crescent/module-sdk';
import { AuditService } from '../audit/audit.service';
import type { Principal, RequestOrigin } from '../auth/auth.types';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import { DatabaseService } from '../database/database.service';
import { ModuleRegistry } from '../modules/module-registry';
import { parseEnvelope } from './packet';

export const GATEWAY_ACTOR = 'SYSTEM_DEVICE_GATEWAY';
export const SIMULATOR_PORT = 'SIMULATOR';
export const BAUD_RATES = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];
type Kind = PacketDecision['kind'];

/** Silence after which the next packet counts as a reconnection. */
const CONNECTED_GAP_MS = 60_000;
const REJECT_STORE_EVERY_MS = 60_000;
const REJECT_AUDIT_EVERY_MS = 10 * 60_000;
const DEVICE_CACHE_MS = 5_000;
const REOPEN_MS = 5_000;

interface PortRuntime {
  status: 'OPEN' | 'CLOSED' | 'ERROR' | 'DISABLED';
  error: string | null;
  packets: number;
  rejected: number;
  lastPacketAt: string | null;
  port: SerialPort | null;
  retry: NodeJS.Timeout | null;
  queue: Promise<unknown>;
}

const sha256 = (s: string) =>
  createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Device Gateway (master spec §9). Reads instrument packets from USB dongles
 * (serial / UART) and binds each to a registered instrument by its DEVICE_ID.
 * Packets from unknown, out-of-service or retired instruments, or for an
 * instrument type whose module is not loaded, are rejected and audited. The
 * module for the instrument type decides what the fields mean and which
 * originals to keep; the core stores them append-only with their SHA-256.
 */
@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DeviceGateway');
  private readonly ports = new Map<string, PortRuntime>();
  private readonly seen = new Map<
    string,
    {
      deviceId: string;
      code: string;
      portPath: string;
      transport: Transport;
      lastSeenAt: number;
    }
  >();
  private readonly devices = new Map<
    string,
    { info: DeviceInfo | null; at: number }
  >();
  private readonly unknown = new Map<
    string,
    { firstSeenAt: string; lastSeenAt: string; portPath: string; count: number }
  >();
  private readonly throttle = new Map<string, number>();

  constructor(
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly registry: ModuleRegistry,
  ) {}

  get simulatorAvailable() {
    return !this.config.production;
  }

  async onModuleInit() {
    if (!this.db.enabled || process.env.NXGEN_GATEWAY === 'off') return;
    try {
      for (const p of await this.configured())
        if (p.enabled) this.open(p.portPath, p.baudRate);
    } catch (e) {
      this.logger.error(
        `Could not start the device gateway: ${(e as Error).message}`,
      );
    }
  }

  onModuleDestroy() {
    for (const [path, rt] of this.ports) {
      if (rt.retry) clearTimeout(rt.retry);
      rt.port?.removeAllListeners();
      if (rt.port?.isOpen) rt.port.close();
      this.ports.delete(path);
    }
  }

  // ---------------------------------------------------------------------------
  // Serial ports
  // ---------------------------------------------------------------------------

  private runtime(path: string): PortRuntime {
    let rt = this.ports.get(path);
    if (!rt) {
      rt = {
        status: 'CLOSED',
        error: null,
        packets: 0,
        rejected: 0,
        lastPacketAt: null,
        port: null,
        retry: null,
        queue: Promise.resolve(),
      };
      this.ports.set(path, rt);
    }
    return rt;
  }

  private setStatus(
    path: string,
    status: PortRuntime['status'],
    error: string | null = null,
  ) {
    const rt = this.runtime(path);
    if (rt.status === status && rt.error === error) return;
    rt.status = status;
    rt.error = error;
    void this.event(
      status === 'OPEN'
        ? 'GATEWAY_PORT_OPENED'
        : status === 'ERROR'
          ? 'GATEWAY_PORT_ERROR'
          : 'GATEWAY_PORT_CLOSED',
      status === 'ERROR' ? 'FAILURE' : 'INFO',
      { recordId: path, reason: error, details: { port: path } },
    );
  }

  private open(path: string, baudRate: number) {
    const rt = this.runtime(path);
    if (rt.retry) clearTimeout(rt.retry);
    rt.retry = null;
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    rt.port = port;
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line: string) => {
      void this.enqueue(path, line, 'SERIAL');
    });
    const retry = (err?: Error | null) => {
      if (rt.port !== port) return; // replaced or closed on purpose
      this.setStatus(path, 'ERROR', err?.message ?? 'Port closed');
      rt.retry = setTimeout(() => this.open(path, baudRate), REOPEN_MS);
    };
    port.on('error', retry);
    port.on('close', () => retry(null));
    port.open((err) => (err ? retry(err) : this.setStatus(path, 'OPEN')));
  }

  private close(path: string, status: 'CLOSED' | 'DISABLED' = 'CLOSED') {
    const rt = this.ports.get(path);
    if (!rt) return;
    if (rt.retry) clearTimeout(rt.retry);
    rt.retry = null;
    const port = rt.port;
    rt.port = null;
    if (port?.isOpen) port.close();
    this.setStatus(path, status);
  }

  /** Serial ports on this workstation, for choosing the dongle. */
  async available() {
    try {
      return (await SerialPort.list()).map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer ?? null,
        serialNumber: p.serialNumber ?? null,
        vendorId: p.vendorId ?? null,
        productId: p.productId ?? null,
      }));
    } catch {
      return [];
    }
  }

  async configured() {
    const rows = await this.db.query<{
      id: string;
      port_path: string;
      label: string;
      baud_rate: number;
      enabled: boolean;
    }>(
      'SELECT id, port_path, label, baud_rate, enabled FROM gateway_ports WHERE NOT is_deleted ORDER BY port_path',
    );
    return rows.map((r) => {
      const rt = this.ports.get(r.port_path);
      return {
        id: r.id,
        portPath: r.port_path,
        label: r.label,
        baudRate: r.baud_rate,
        enabled: r.enabled,
        status: r.enabled ? (rt?.status ?? 'CLOSED') : 'DISABLED',
        error: rt?.error ?? null,
        packets: rt?.packets ?? 0,
        rejected: rt?.rejected ?? 0,
        lastPacketAt: rt?.lastPacketAt ?? null,
      };
    });
  }

  async overview() {
    const sim = this.ports.get(SIMULATOR_PORT);
    return {
      available: await this.available(),
      configured: await this.configured(),
      simulator: this.simulatorAvailable
        ? {
            packets: sim?.packets ?? 0,
            rejected: sim?.rejected ?? 0,
            lastPacketAt: sim?.lastPacketAt ?? null,
          }
        : null,
      connected: [...this.seen.entries()].map(([deviceIdentifier, s]) => ({
        deviceIdentifier,
        deviceId: s.deviceId,
        code: s.code,
        portPath: s.portPath,
        transport: s.transport,
        lastSeenAt: new Date(s.lastSeenAt).toISOString(),
        online: Date.now() - s.lastSeenAt < CONNECTED_GAP_MS,
      })),
      unknownDevices: [...this.unknown.entries()].map(
        ([deviceIdentifier, u]) => ({ deviceIdentifier, ...u }),
      ),
    };
  }

  async savePort(
    principal: Principal,
    id: string | null,
    input: {
      portPath?: unknown;
      baudRate?: unknown;
      label?: unknown;
      enabled?: unknown;
      reason?: unknown;
    },
    origin: RequestOrigin,
  ) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 5)
      throw new BadRequestException({
        message: 'Enter a reason for this change (at least 5 characters).',
        field: 'reason',
      });
    const baudRate =
      input.baudRate === undefined ? undefined : Number(input.baudRate);
    if (baudRate !== undefined && !BAUD_RATES.includes(baudRate))
      throw new BadRequestException({
        message: `Baud rate must be one of ${BAUD_RATES.join(', ')}.`,
        field: 'baudRate',
      });
    const label =
      typeof input.label === 'string'
        ? input.label.trim().slice(0, 120)
        : undefined;
    const enabled =
      typeof input.enabled === 'boolean' ? input.enabled : undefined;
    const actor = {
      actorId: principal.userId,
      actorName: principal.fullName,
      reason,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
    };

    let saved: { port_path: string; baud_rate: number; enabled: boolean };
    if (!id) {
      const portPath =
        typeof input.portPath === 'string' ? input.portPath.trim() : '';
      if (!portPath || portPath.length > 200 || portPath === SIMULATOR_PORT)
        throw new BadRequestException({
          message: 'Choose the serial port of the USB dongle.',
          field: 'portPath',
        });
      saved = await this.db.transaction(actor, async (c) => {
        const exists = await c.query(
          'SELECT 1 FROM gateway_ports WHERE port_path = $1',
          [portPath],
        );
        if (exists.rows.length)
          throw new ConflictException({
            message: 'This port is already configured.',
            field: 'portPath',
          });
        const { rows } = await c.query<{
          port_path: string;
          baud_rate: number;
          enabled: boolean;
        }>(
          'INSERT INTO gateway_ports (port_path, label, baud_rate, enabled) VALUES ($1, $2, $3, $4) RETURNING port_path, baud_rate, enabled',
          [portPath, label ?? '', baudRate ?? 115200, enabled ?? true],
        );
        return rows[0];
      });
    } else {
      saved = await this.db.transaction(actor, async (c) => {
        const { rows } = await c.query<{
          port_path: string;
          baud_rate: number;
          enabled: boolean;
          label: string;
        }>(
          'SELECT port_path, baud_rate, enabled, label FROM gateway_ports WHERE id = $1 AND NOT is_deleted FOR UPDATE',
          [id],
        );
        const cur = rows[0];
        if (!cur) throw new NotFoundException('Port not found.');
        const next = {
          baud: baudRate ?? cur.baud_rate,
          enabled: enabled ?? cur.enabled,
          label: label ?? cur.label,
        };
        if (
          next.baud === cur.baud_rate &&
          next.enabled === cur.enabled &&
          next.label === cur.label
        )
          throw new BadRequestException('Nothing changed.');
        const { rows: out } = await c.query<{
          port_path: string;
          baud_rate: number;
          enabled: boolean;
        }>(
          'UPDATE gateway_ports SET baud_rate = $2, enabled = $3, label = $4 WHERE id = $1 RETURNING port_path, baud_rate, enabled',
          [id, next.baud, next.enabled, next.label],
        );
        return out[0];
      });
    }
    this.close(saved.port_path, saved.enabled ? 'CLOSED' : 'DISABLED');
    if (saved.enabled && process.env.NXGEN_GATEWAY !== 'off')
      this.open(saved.port_path, saved.baud_rate);
    return this.configured();
  }

  // ---------------------------------------------------------------------------
  // Packet pipeline
  // ---------------------------------------------------------------------------

  /** Keeps packets from one port in arrival order. */
  private enqueue(path: string, line: string, transport: Transport) {
    const rt = this.runtime(path);
    const next = rt.queue.then(() => this.ingest(line, transport, path));
    rt.queue = next.catch((e: Error) =>
      this.logger.error(`Packet handling failed on ${path}: ${e.message}`),
    );
    return next;
  }

  private due(key: string, every: number) {
    const now = Date.now();
    if (now - (this.throttle.get(key) ?? 0) < every) return false;
    this.throttle.set(key, now);
    return true;
  }

  private async device(identifier: string): Promise<DeviceInfo | null> {
    const cached = this.devices.get(identifier);
    if (cached && Date.now() - cached.at < DEVICE_CACHE_MS) return cached.info;
    const info = await this.registry.devices.byIdentifier(identifier);
    this.devices.set(identifier, { info, at: Date.now() });
    return info;
  }

  private async store(
    transport: Transport,
    portPath: string,
    raw: string,
    kind: Kind,
    identifier: string | null,
    deviceId: string | null,
    payload: unknown,
    accepted: boolean,
    rejection: string | null,
  ): Promise<number> {
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO device_messages (transport, port_path, raw, raw_sha256, device_identifier, device_id, kind, payload, accepted, rejection_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        transport,
        portPath,
        raw,
        sha256(raw),
        identifier,
        deviceId,
        kind,
        payload === undefined ? null : JSON.stringify(payload),
        accepted,
        rejection,
      ],
    );
    return Number(row.id);
  }

  /** For modules: keep an original packet they held in memory (e.g. the reading a record used). */
  persist(
    device: DeviceInfo,
    packet: InstrumentPacket,
    kind: Kind,
    payload?: unknown,
  ) {
    return this.store(
      packet.transport,
      packet.portPath,
      packet.raw,
      kind,
      packet.deviceIdentifier,
      device.id,
      payload,
      true,
      null,
    );
  }

  private async event(
    action: string,
    result: 'SUCCESS' | 'FAILURE' | 'INFO',
    e: {
      recordId?: string | null;
      reason?: string | null;
      details?: Record<string, string | number | boolean | null>;
    },
  ) {
    try {
      await this.audit.record({
        category: 'DEVICES',
        action,
        result,
        actor: GATEWAY_ACTOR,
        actorName: 'Device gateway',
        tableName: 'devices',
        recordId: e.recordId ?? null,
        reason: e.reason ?? null,
        details: e.details,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${action}: ${(err as Error).message}`,
      );
    }
  }

  private async reject(
    transport: Transport,
    portPath: string,
    raw: string,
    reason: string,
    identifier: string | null,
    deviceId: string | null,
    kind: Kind = 'UNKNOWN',
  ) {
    this.runtime(portPath).rejected++;
    const key = `${portPath}|${identifier ?? '-'}|${reason}`;
    if (this.due(`store|${key}`, REJECT_STORE_EVERY_MS))
      await this.store(
        transport,
        portPath,
        raw.slice(0, 4096),
        kind,
        identifier,
        deviceId,
        undefined,
        false,
        reason,
      );
    if (this.due(`audit|${key}`, REJECT_AUDIT_EVERY_MS))
      await this.event('DEVICE_PACKET_REJECTED', 'FAILURE', {
        recordId: deviceId ?? identifier,
        reason,
        details: { port: portPath, deviceIdentifier: identifier, transport },
      });
    return { accepted: false as const, reason };
  }

  /** One line from a dongle (or the development simulator). */
  async ingest(
    line: string,
    transport: Transport,
    portPath: string,
  ): Promise<{
    accepted: boolean;
    reason?: string;
    kind?: Kind;
    messageId?: number | null;
  }> {
    const raw = line.replace(/\r?\n$/, '').trim();
    if (!raw) return { accepted: false, reason: 'Empty line' };
    if (transport === 'SIMULATOR' && !this.simulatorAvailable)
      return { accepted: false, reason: 'Simulator disabled in production' };
    const rt = this.runtime(portPath);
    rt.packets++;
    rt.lastPacketAt = new Date().toISOString();

    const env = parseEnvelope(raw);
    if (!env.ok)
      return this.reject(
        transport,
        portPath,
        raw,
        env.reason,
        env.deviceIdentifier ?? null,
        null,
      );

    const device = await this.device(env.deviceIdentifier);
    if (!device) {
      const now = new Date().toISOString();
      const u = this.unknown.get(env.deviceIdentifier);
      this.unknown.set(env.deviceIdentifier, {
        firstSeenAt: u?.firstSeenAt ?? now,
        lastSeenAt: now,
        portPath,
        count: (u?.count ?? 0) + 1,
      });
      if (this.due(`unknown|${env.deviceIdentifier}`, 60 * 60_000))
        await this.event('UNKNOWN_DEVICE_SEEN', 'INFO', {
          recordId: env.deviceIdentifier,
          reason: 'Packets from an instrument that is not registered',
          details: {
            port: portPath,
            deviceIdentifier: env.deviceIdentifier,
            transport,
          },
        });
      return this.reject(
        transport,
        portPath,
        raw,
        'Instrument not registered',
        env.deviceIdentifier,
        null,
      );
    }
    this.unknown.delete(env.deviceIdentifier);
    if (device.status !== 'ACTIVE')
      return this.reject(
        transport,
        portPath,
        raw,
        `Instrument ${device.code} is ${device.status.replace(/_/g, ' ').toLowerCase()}`,
        env.deviceIdentifier,
        device.id,
      );
    const handler = this.registry.handlerFor(device.instrumentType);
    if (!handler)
      return this.reject(
        transport,
        portPath,
        raw,
        `No module loaded for ${device.instrumentType} instruments`,
        env.deviceIdentifier,
        device.id,
      );

    const packet: InstrumentPacket = {
      deviceIdentifier: env.deviceIdentifier,
      fields: env.fields,
      raw,
      transport,
      portPath,
      receivedAt: new Date().toISOString(),
    };
    let decision: PacketDecision;
    try {
      decision = handler.decide(packet, device);
    } catch (e) {
      return this.reject(
        transport,
        portPath,
        raw,
        `Module could not read the packet: ${(e as Error).message}`,
        env.deviceIdentifier,
        device.id,
      );
    }
    if (decision.reject)
      return this.reject(
        transport,
        portPath,
        raw,
        decision.reject,
        env.deviceIdentifier,
        device.id,
        decision.kind,
      );

    const last = this.seen.get(env.deviceIdentifier);
    if (!last || Date.now() - last.lastSeenAt > CONNECTED_GAP_MS)
      await this.event('DEVICE_CONNECTED', 'INFO', {
        recordId: device.id,
        details: {
          device: device.code,
          deviceIdentifier: env.deviceIdentifier,
          port: portPath,
          transport,
        },
      });
    this.seen.set(env.deviceIdentifier, {
      deviceId: device.id,
      code: device.code,
      portPath,
      transport,
      lastSeenAt: Date.now(),
    });

    const messageId = decision.persist
      ? await this.store(
          transport,
          portPath,
          raw,
          decision.kind,
          env.deviceIdentifier,
          device.id,
          decision.payload,
          true,
          null,
        )
      : null;
    await handler.accepted(packet, device, messageId);
    return { accepted: true, kind: decision.kind, messageId };
  }

  async messages(deviceId: string, limit = 50) {
    const rows = await this.db.query<{
      id: string;
      received_at: Date;
      transport: string;
      port_path: string;
      raw: string;
      raw_sha256: string;
      kind: string;
      accepted: boolean;
      rejection_reason: string | null;
    }>(
      `SELECT id, received_at, transport, port_path, raw, raw_sha256, kind, accepted, rejection_reason
         FROM device_messages WHERE device_id = $1 ORDER BY id DESC LIMIT $2`,
      [deviceId, Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      receivedAt: r.received_at.toISOString(),
      transport: r.transport,
      portPath: r.port_path,
      raw: r.raw,
      sha256: r.raw_sha256,
      kind: r.kind,
      accepted: r.accepted,
      rejectionReason: r.rejection_reason,
    }));
  }

  /** Development only: feed lines as if they came from a dongle. */
  async simulate(lines: unknown) {
    if (!this.simulatorAvailable)
      throw new ForbiddenException(
        'The device simulator is not available in production.',
      );
    if (
      !Array.isArray(lines) ||
      lines.length === 0 ||
      lines.length > 100 ||
      lines.some((l) => typeof l !== 'string')
    )
      throw new BadRequestException('Send 1–100 packet lines.');
    const out = [];
    for (const l of lines as string[])
      out.push(await this.enqueue(SIMULATOR_PORT, l, 'SIMULATOR'));
    return out;
  }
}
