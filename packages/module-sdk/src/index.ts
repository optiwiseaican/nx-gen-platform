/**
 * NxGen module contract — core API version 1 (Technical Architecture §5–§6).
 *
 * A module's API bundle exports `register(ctx)` and talks to the core ONLY
 * through the ModuleContext it receives. It owns tables with its prefix
 * (e.g. ph_*) and never writes core tables directly: calibrations, audit,
 * signatures and devices go through the context, so core rules (workflow,
 * audit trail, permissions, readiness) always apply.
 */
export const CORE_API_VERSION = 1 as const;

export type Outcome = 'PASS' | 'WARNING' | 'FAIL';
export type Transport = 'SERIAL' | 'SIMULATOR';

export interface ModulePrincipal {
  userId: string;
  username: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}

export interface RequestOrigin {
  ipAddress: string | null;
  machineName: string;
  userAgent: string | null;
}

export interface ModuleRequest {
  principal: ModulePrincipal;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  origin: RequestOrigin;
}

export interface ModuleRoute {
  method: 'GET' | 'POST' | 'PUT';
  /** Relative to /api/modules/<id>/api, e.g. "/instruments/:id/live". */
  path: string;
  /** Required permission (a core permission or one declared in module.json). */
  permission: string;
  /** Background polling that must not count as user activity (session idle timer). */
  passive?: boolean;
  handler(req: ModuleRequest): Promise<unknown>;
}

export interface DeviceInfo {
  id: string;
  code: string;
  instrumentType: string;
  name: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  location: string;
  status: 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED';
  deviceIdentifier: string | null;
  readiness: { state: string; usable: boolean; message: string; dueAt: string | null };
}

/** What a module hands the core to store as a calibration record (draft, then core workflow). */
export interface CalibrationInput {
  performedAt?: string;
  temperatureC: number | null;
  readings: unknown[];
  limits: Record<string, unknown>;
  results: Record<string, unknown>;
  /** Shown by the core wherever the calibration is listed. */
  display: { label: string; value: string }[];
  outcome: Outcome;
  remarks: string;
  dataSource: 'MANUAL' | 'INSTRUMENT' | 'SIMULATED';
  /** device_messages ids the readings were taken from. */
  sourceMessages: number[];
}

/** An instrument packet as framed by the core gateway: a flat JSON object with DEVICE_ID. */
export interface InstrumentPacket {
  deviceIdentifier: string;
  fields: Record<string, string | number>;
  raw: string;
  transport: Transport;
  portPath: string;
  receivedAt: string;
}

export interface PacketDecision {
  /** Reject the packet (stored and audited by the core as rejected). */
  reject?: string;
  kind: 'MEASUREMENT' | 'CALIBRATION' | 'STATUS' | 'LOG' | 'UNKNOWN';
  /** Keep the original packet in the append-only device_messages table. */
  persist: boolean;
  /** Parsed values, stored with the packet. */
  payload?: unknown;
}

export interface PacketHandler {
  instrumentType: string;
  decide(packet: InstrumentPacket, device: DeviceInfo): PacketDecision;
  /** Called after the core accepted (and, if requested, stored) the packet. */
  accepted(packet: InstrumentPacket, device: DeviceInfo, messageId: number | null): void | Promise<void>;
}

/**
 * Throw from a route handler to answer with an error. Recognised by name
 * (the module bundles its own copy of this class).
 */
export class ModuleError extends Error {
  readonly name = 'ModuleError';
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface ModuleContext {
  readonly apiVersion: typeof CORE_API_VERSION;
  readonly module: { id: string; name: string; version: string };
  readonly production: boolean;
  logger: { log(m: string): void; warn(m: string): void; error(m: string): void };
  http: { route(route: ModuleRoute): void };
  /** Queries on the module's own tables (prefix enforced by convention and review). */
  db: {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  };
  audit: {
    record(e: {
      action: string;
      result: 'SUCCESS' | 'FAILURE' | 'INFO';
      principal?: ModulePrincipal | null;
      recordId?: string | null;
      reason?: string | null;
      details?: Record<string, string | number | boolean | null>;
    }): Promise<void>;
  };
  devices: {
    get(id: string): Promise<DeviceInfo | null>;
    list(instrumentType: string): Promise<DeviceInfo[]>;
  };
  calibrations: {
    /** Creates a DRAFT calibration through the core workflow; core checks calibration.perform. */
    record(principal: ModulePrincipal, deviceId: string, input: CalibrationInput, origin: RequestOrigin): Promise<{ calibrationId: string; code: string }>;
  };
  gateway: {
    registerHandler(handler: PacketHandler): void;
    /** Store an original packet the module kept in memory (e.g. the measurement a record used). */
    persist(device: DeviceInfo, packet: InstrumentPacket, kind: PacketDecision['kind'], payload?: unknown): Promise<number>;
  };
}

export interface NxGenModule {
  register(ctx: ModuleContext): void | Promise<void>;
  /** Run after loading; a failure keeps the module out of service. */
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
  unload?(): void;
}
