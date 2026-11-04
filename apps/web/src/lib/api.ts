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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
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
}

export interface SetupStatus {
  databaseConfigured: boolean;
  licenseActive: boolean;
  administratorExists: boolean;
  passwordPolicy: { minLength: number; maxAgeDays: number; history: number };
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
  audit: (params: { before?: number; action?: string } = {}) => {
    const q = new URLSearchParams({ limit: "50" });
    if (params.before) q.set("before", String(params.before));
    if (params.action) q.set("action", params.action);
    return call<{ entries: AuditEntry[]; chain: { valid: boolean; brokenAtSequence?: number } }>(`/audit?${q}`);
  },
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
