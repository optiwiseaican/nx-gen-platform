/** Shared by the module's screens: API access, session timers, badges and the theme classes. */
import type { Illumination } from "../shared/tlc";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Session clocks fed by the core's response headers. */
export const session = { idleExpiresAt: null as number | null, maxExpiresAt: null as number | null, listeners: new Set<() => void>() };

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api${path}`, { ...init, credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers } });
  const idle = res.headers.get("X-NxGen-Session-Idle-Expires");
  const now = Date.parse(res.headers.get("X-NxGen-Server-Time") ?? "");
  if (idle) {
    const skew = Number.isNaN(now) ? 0 : Date.now() - now;
    session.idleExpiresAt = Date.parse(idle) + skew;
    const max = res.headers.get("X-NxGen-Session-Expires");
    if (max) session.maxExpiresAt = Date.parse(max) + skew;
    session.listeners.forEach((f) => f());
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
    const m = body?.message;
    throw new HttpError(res.status, Array.isArray(m) ? m.join(" ") : (m ?? `Request failed (${res.status})`));
  }
  return res;
}
export const api = async <T,>(path: string, init?: RequestInit) => (await (await request(path, init)).json()) as T;
export const mod = <T,>(path: string, init?: RequestInit) => api<T>(`/modules/tlc/api${path}`, init);
export const send = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });

export const toneClass = {
  pass: "border-pass/30 bg-pass-50 text-pass",
  warn: "border-warn/30 bg-warn-50 text-warn",
  fail: "border-fail/30 bg-fail-50 text-fail",
  info: "border-brand/30 bg-brand-50 text-brand-700",
  muted: "border-line bg-canvas text-muted",
};
export type Tone = keyof typeof toneClass;
export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide ${toneClass[tone]}`}>{children}</span>;
}
export function Callout({ tone, title, children }: { tone: Exclude<Tone, "muted">; title?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass[tone]}`} role={tone === "fail" ? "alert" : "status"}>
      {title && <p className="font-semibold">{title}</p>}
      <div className="text-ink">{children}</div>
    </div>
  );
}
export const primary =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-brand px-5 font-semibold text-white shadow-[var(--shadow-brand)] hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-brand/40 disabled:shadow-none";
export const secondary = "inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-white px-5 font-semibold text-ink hover:border-brand/30 disabled:text-muted";
export const small = "inline-flex min-h-9 items-center justify-center rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink hover:border-brand/30 disabled:text-muted";
export const field = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal";
export const card = "rounded-lg border border-line bg-white p-5";
export const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

export const CONCLUSION: Record<string, { label: string; tone: Tone }> = {
  CONFORMS: { label: "CONFORMS", tone: "pass" },
  DOES_NOT_CONFORM: { label: "DOES NOT CONFORM", tone: "fail" },
  SST_FAILED: { label: "SUITABILITY FAILED", tone: "fail" },
  INCOMPLETE: { label: "NOT EVALUATED", tone: "muted" },
};
export const ILLUMINATION_LABEL: Record<Illumination, string> = { WHITE: "White light", UV254: "UV 254 nm", UV366: "UV 366 nm" };
