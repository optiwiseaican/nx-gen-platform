export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:4000" : "");

export type LicenseState =
  | "NOT_ACTIVATED"
  | "ACTIVATING"
  | "ACTIVE"
  | "ACTIVATION_ERROR"
  | "REACTIVATION_REQUIRED"
  | "EXPIRED";

export interface LicenseErrorInfo {
  title: string;
  message: string;
  action: string;
}

export interface LicensingStatus {
  platform: { name: string; version: string; instanceId: string | null };
  installation: { verification: string; environment: string; status: string; simulated: boolean };
  license: {
    state: LicenseState;
    restricted: boolean;
    errorCode: string | null;
    error: LicenseErrorInfo | null;
  };
  warnings: string[];
}

export type CheckStatus = "PASS" | "FAIL" | "NOT_RUN";
export interface VerificationCheck {
  id: string;
  label: string;
  status: CheckStatus;
}

export interface ActivationOutcome {
  ok: boolean;
  state: LicenseState;
  checks: VerificationCheck[];
  errorCode?: string;
  error?: LicenseErrorInfo;
  licensePackageRequired?: boolean;
  inputError?: "EMPTY" | "FORMAT" | "CHECKSUM";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { message?: string | string[]; code?: string; field?: string; problems?: string[] } | null,
  ) {
    const m = body?.message;
    super(Array.isArray(m) ? m.join(" ") : (m ?? `Request failed (${status})`));
  }
}

/** When the current session ends, as last reported by the server. */
export interface SessionTiming {
  idleExpiresAt: number;
  expiresAt: number;
}

let sessionTiming: SessionTiming | null = null;
const sessionListeners = new Set<(t: SessionTiming | null) => void>();

export const sessionClock = {
  get: () => sessionTiming,
  subscribe(fn: (t: SessionTiming | null) => void) {
    sessionListeners.add(fn);
    return () => void sessionListeners.delete(fn);
  },
  clear() {
    sessionTiming = null;
    sessionListeners.forEach((fn) => fn(null));
  },
};

function noteSession(res: Response) {
  const idle = res.headers.get("X-NxGen-Session-Idle-Expires");
  const max = res.headers.get("X-NxGen-Session-Expires");
  if (!idle || !max) return;
  // Convert to this computer's clock, in case it differs from the server's.
  const serverNow = Date.parse(res.headers.get("X-NxGen-Server-Time") ?? "");
  const skew = Number.isNaN(serverNow) ? 0 : Date.now() - serverNow;
  sessionTiming = { idleExpiresAt: Date.parse(idle) + skew, expiresAt: Date.parse(max) + skew };
  sessionListeners.forEach((fn) => fn(sessionTiming));
}

async function raw(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  noteSession(res);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body);
  }
  return res;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await raw(path, init)).json()) as T;
}

export interface SystemInformation {
  platform: LicensingStatus["platform"];
  installation: { installationId: string | null; verification: string; verifiedAt: string | null; simulated: boolean };
  license: LicensingStatus["license"] & {
    details: {
      licenseId: string;
      activationCode: string;
      customer: { id: string; name: string; site?: string };
      licenseType: "PERPETUAL" | "SUBSCRIPTION";
      versionScope: string;
      issuedAt: string;
      validFrom: string;
      expiresAt: string | null;
      limits: { users: number | null; devices: number | null };
      signingKeyId: string | null;
    } | null;
    hardwareBinding: { score: number; matched: number; changed: number; missing: number } | null;
  };
  entitlements: { id: string; expiresAt: string | null }[];
  audit: { events: number; chain: "INTACT" | "BROKEN" };
  warnings: string[];
}

export interface Principal {
  userId: string;
  username: string;
  fullName: string;
  roles: string[];
  permissions: string[];
  mustChangePassword: boolean;
  passwordExpiresAt: string | null;
  sessionIdleMinutes?: number;
  session?: { idleExpiresAt: string; expiresAt: string };
}

export interface SetupStatus {
  databaseConfigured: boolean;
  licenseActive: boolean;
  administratorExists: boolean;
  passwordPolicy: {
    minLength: number;
    maxAgeDays: number;
    history: number;
    maxFailedLogins: number;
    lockoutMinutes: number;
    sessionIdleMinutes: number;
    sessionMaxHours: number;
  };
}

export interface AuditEntry {
  sequence: number;
  occurredAt: string;
  category: string;
  action: string;
  result: "SUCCESS" | "FAILURE" | "INFO";
  actor: string;
  actorName: string | null;
  tableName: string | null;
  recordId: string | null;
  reason: string | null;
  machineName: string | null;
  ipAddress: string | null;
  errorCode: string | null;
  oldValue: unknown;
  newValue: unknown;
  details: Record<string, unknown> | null;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export const authApi = {
  setupStatus: () => call<SetupStatus>("/setup/status"),
  createAdministrator: (body: { username: string; fullName: string; email?: string; password: string }) =>
    post<{ userId: string; username: string }>("/setup/administrator", body),
  login: (username: string, password: string) => post<Principal>("/auth/login", { username, password }),
  logout: () => post<{ ok: true }>("/auth/logout", {}),
  me: () => call<Principal>("/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<Principal>("/auth/change-password", { currentPassword, newPassword }),
  extendSession: () => post<Principal>("/auth/session/extend", {}),
  audit: (params: AuditFilters & { before?: number } = {}) => {
    const q = auditQuery(params);
    q.set("limit", "50");
    if (params.before) q.set("before", String(params.before));
    return call<{ entries: AuditEntry[]; chain: { valid: boolean; brokenAtSequence?: number } }>(`/audit?${q}`);
  },
  /** CSV extract; the export is recorded in the audit trail. */
  auditExport: async (params: AuditFilters) => {
    const res = await raw(`/audit/export?${auditQuery(params)}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "nxgen-audit-trail.csv";
    return { blob: await res.blob(), filename: name, sha256: res.headers.get("X-NxGen-Export-SHA256") ?? "" };
  },
};

export interface AuditFilters {
  action?: string;
  actor?: string;
  category?: string;
  result?: string;
  /** ISO 8601 */
  from?: string;
  /** ISO 8601, exclusive */
  to?: string;
}

function auditQuery(f: AuditFilters): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (typeof v === "string" && v.trim()) q.set(k, v.trim());
  return q;
}

export interface SecurityPolicy {
  passwordMinLength: number;
  passwordHistory: number;
  passwordMaxAgeDays: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
}

export interface SecurityPolicyState {
  policy: SecurityPolicy;
  limits: Record<keyof SecurityPolicy, { min: number; max: number }>;
  labels: Record<keyof SecurityPolicy, string>;
  version: number | null;
  modifiedBy: string | null;
  modifiedAt: string | null;
}

export const securityApi = {
  policy: () => call<SecurityPolicyState>("/security/policy"),
  updatePolicy: (changes: Partial<SecurityPolicy>, reason: string, signature?: SignatureInput) =>
    put<SecurityPolicyState>("/security/policy", { changes, reason, signature }),
};

export const recoveryApi = {
  request: (username: string, reason: string) =>
    post<{ requestId: string; requestCode: string; expiresAt: string; platformInstanceId: string }>("/recovery/request", {
      username,
      reason,
    }),
  complete: (response: string) => post<{ username: string; temporaryPassword: string }>("/recovery/complete", { response }),
};

export interface UserSummary {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  status: "ACTIVE" | "DISABLED";
  roles: string[];
  locked: boolean;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  failedLoginCount: number;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  versionNo: number;
}

export interface RoleSummary {
  code: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  activeUsers: number;
  versionNo: number;
}

const put = <T>(path: string, body: unknown) => call<T>(path, { method: "PUT", body: JSON.stringify(body) });

export interface SignatureInput {
  username: string;
  password: string;
  meaning: string;
}

export interface SignaturePolicy {
  actionCode: string;
  description: string;
  required: boolean;
  defaultMeaning: string;
  locked: boolean;
}

export interface SignatureMeaning {
  code: string;
  label: string;
  statement: string;
}

export interface SignatureRecord {
  id: string;
  signedAt: string;
  signerUserId: string;
  signerUsername: string;
  signerFullName: string;
  meaningCode: string;
  meaningLabel: string;
  meaningStatement: string;
  reason: string;
  actionCode: string;
  tableName: string;
  recordId: string;
  recordVersion: number | null;
  signedContent: Record<string, unknown>;
  contentHash: string;
  intact: boolean;
}

export const signaturesApi = {
  policy: () => call<{ policies: SignaturePolicy[]; meanings: SignatureMeaning[] }>("/signatures/policy"),
  updatePolicy: (
    changes: { actionCode: string; required?: boolean; defaultMeaning?: string }[],
    reason: string,
    signature?: SignatureInput,
  ) => put<SignaturePolicy[]>("/signatures/policy", { changes, reason, signature }),
  list: (params: { table?: string; record?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.table) q.set("table", params.table);
    if (params.record) q.set("record", params.record);
    return call<SignatureRecord[]>(`/signatures?${q}`);
  },
};

export const usersApi = {
  list: () => call<UserSummary[]>("/users"),
  get: (id: string) => call<UserSummary>(`/users/${id}`),
  history: (id: string) => call<AuditEntry[]>(`/users/${id}/history`),
  create: (body: { username: string; fullName: string; email?: string; roles: string[]; reason: string; signature?: SignatureInput }) =>
    post<{ user: UserSummary; temporaryPassword: string }>("/users", body),
  updateProfile: (id: string, body: { fullName: string; email: string; reason: string; signature?: SignatureInput }) =>
    put<UserSummary>(`/users/${id}/profile`, body),
  setRoles: (id: string, roles: string[], reason: string, signature?: SignatureInput) =>
    put<UserSummary>(`/users/${id}/roles`, { roles, reason, signature }),
  disable: (id: string, reason: string, signature?: SignatureInput) =>
    post<UserSummary>(`/users/${id}/disable`, { reason, signature }),
  enable: (id: string, reason: string, signature?: SignatureInput) =>
    post<UserSummary>(`/users/${id}/enable`, { reason, signature }),
  unlock: (id: string, reason: string, signature?: SignatureInput) =>
    post<UserSummary>(`/users/${id}/unlock`, { reason, signature }),
  resetPassword: (id: string, reason: string, signature?: SignatureInput) =>
    post<{ user: UserSummary; temporaryPassword: string }>(`/users/${id}/reset-password`, { reason, signature }),
  roles: () => call<{ roles: RoleSummary[]; permissions: { code: string; description: string }[] }>("/roles"),
  createRole: (body: {
    code: string;
    name: string;
    description: string;
    permissions: string[];
    reason: string;
    signature?: SignatureInput;
  }) => post<RoleSummary>("/roles", body),
  setRolePermissions: (code: string, permissions: string[], reason: string, signature?: SignatureInput) =>
    put<RoleSummary>(`/roles/${code}/permissions`, { permissions, reason, signature }),
};

export const ROLE_NAMES: Record<string, string> = {
  SUPER_ADMINISTRATOR: "Super Administrator",
  IT_ADMINISTRATOR: "IT Administrator",
  QA_MANAGER: "QA Manager",
  QA_REVIEWER: "QA Reviewer",
  ANALYST: "Analyst",
  OPERATOR: "Operator",
  AUDITOR: "Auditor",
};

export const licensingApi = {
  status: () => call<LicensingStatus>("/licensing/status"),
  systemInformation: () => call<SystemInformation>("/licensing/system-information"),
  activate: (body: { activationCode: string; licenseFile?: string; licenseFileName?: string }) =>
    call<ActivationOutcome>("/licensing/activate", { method: "POST", body: JSON.stringify(body) }),
};

/** Shown when the local License Service itself cannot be reached (NX-LIC-E010). */
export const SERVICE_UNAVAILABLE: LicenseErrorInfo = {
  title: "License Service Unavailable",
  message: "The NxGen License Service could not complete the request. No laboratory data has been changed.",
  action: "Restart NxGen. If the problem continues, contact NxGen Support.",
};

// ---------------------------------------------------------------------------
// Workflow engine and methods
// ---------------------------------------------------------------------------
export type WorkflowState = "DRAFT" | "IN_REVIEW" | "REVIEWED" | "APPROVED" | "INVALIDATED" | "SUPERSEDED";
export type WorkflowStep = "SUBMIT" | "WITHDRAW" | "REVIEW" | "APPROVE" | "REJECT" | "INVALIDATE";

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

export interface WorkflowTask {
  instance: WorkflowInstance;
  step: "REVIEW" | "APPROVE";
  title: string;
  link: string;
  workflow: string;
}

export const workflowApi = {
  tasks: () => call<WorkflowTask[]>("/workflow/tasks"),
  act: (
    instanceId: string,
    step: WorkflowStep,
    body: { reason?: string; returnTo?: WorkflowState; signature?: SignatureInput },
  ) => post<WorkflowInstance>(`/workflow/instances/${instanceId}/${step.toLowerCase()}`, body),
};

export type InstrumentType = "PH" | "EC" | "TLC" | "OTHER";
export const INSTRUMENT_LABELS: Record<InstrumentType, string> = {
  PH: "pH meter",
  EC: "Conductivity meter",
  TLC: "TLC scanner",
  OTHER: "Other",
};

export interface MethodParameter {
  name: string;
  value: string;
  unit: string;
}

export interface MethodVersion {
  id: string;
  versionNumber: number;
  name: string;
  purpose: string;
  procedure: string;
  parameters: MethodParameter[];
  changeSummary: string;
  createdAt: string;
  createdByName: string | null;
  workflow: WorkflowInstance;
  allowedSteps: WorkflowStep[];
  history: WorkflowEvent[];
}

export interface MethodDetail {
  id: string;
  code: string;
  instrumentType: InstrumentType;
  createdAt: string;
  versions: MethodVersion[];
  canEditDraft: boolean;
  canStartNewVersion: boolean;
}

export interface MethodSummary {
  id: string;
  code: string;
  instrumentType: InstrumentType;
  name: string;
  latestVersion: number;
  latestState: WorkflowState;
  effectiveVersion: number | null;
  createdAt: string;
}

export type MethodContentInput = Partial<Pick<MethodVersion, "name" | "purpose" | "procedure" | "parameters" | "changeSummary">>;

export const methodsApi = {
  list: () => call<MethodSummary[]>("/methods"),
  get: (id: string) => call<MethodDetail>(`/methods/${id}`),
  create: (body: MethodContentInput & { instrumentType: InstrumentType }) => post<MethodDetail>("/methods", body),
  update: (id: string, versionId: string, body: MethodContentInput) =>
    put<MethodDetail>(`/methods/${id}/versions/${versionId}`, body),
  newVersion: (id: string, reason: string) => post<MethodDetail>(`/methods/${id}/versions`, { reason }),
};
