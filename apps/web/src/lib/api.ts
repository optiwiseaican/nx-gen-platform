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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`License Service returned ${res.status}`);
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
