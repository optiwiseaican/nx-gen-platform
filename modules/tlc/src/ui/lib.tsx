/** Shared by the module's screens: API access, session timers, badges and the tablet's component styles. */
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
  info: "border-brand-border bg-brand-50 text-brand-text",
  muted: "border-line bg-surface-2 text-muted",
};
export type Tone = keyof typeof toneClass;
export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide ${toneClass[tone]}`}>{children}</span>;
}
export function Callout({ tone, title, children }: { tone: Exclude<Tone, "muted">; title?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-[10px] border px-4 py-3 text-sm ${toneClass[tone]}`} role={tone === "fail" ? "alert" : "status"}>
      {title && <p className="font-semibold">{title}</p>}
      <div className="text-ink">{children}</div>
    </div>
  );
}

// The tablet's controls (app ui/components/Panels.kt): PrimaryButton is the dark teal, 12 dp
// radius, 50 dp high; SecondaryButton is outlined, 10 dp radius; OptionBox is light teal when
// selected; PanelCard is a white card with a hairline border and 16 dp radius.
export const primary = "inline-flex h-[50px] items-center justify-center rounded-xl bg-navy px-6 text-[15px] font-semibold text-white hover:bg-navy-700 disabled:cursor-not-allowed disabled:bg-navy/45";
export const secondary = "inline-flex h-11 items-center justify-center rounded-[10px] border border-outline bg-white px-5 text-[15px] font-medium text-navy hover:bg-canvas disabled:cursor-not-allowed disabled:text-muted/60";
export const strong = "inline-flex h-[50px] items-center justify-center rounded-[10px] border border-navy bg-white px-5 text-[15px] font-semibold text-navy hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-muted/60";
export const small = "inline-flex h-9 items-center justify-center rounded-[10px] border border-outline bg-white px-3 text-sm font-medium text-navy hover:bg-canvas disabled:cursor-not-allowed disabled:text-muted/60";
export const accent = "inline-flex h-[50px] items-center justify-center rounded-xl bg-accent px-6 text-[15px] font-semibold text-accent-text hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50";
export const optionBox = (selected: boolean, disabled = false) =>
  `inline-flex h-11 items-center justify-center rounded-[10px] border px-3 text-sm ${selected ? "border-brand-border bg-brand-50 font-semibold text-brand-text" : "border-line bg-white text-muted hover:border-outline"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`;
export const toolToggle = (selected: boolean) => `inline-flex h-[42px] items-center gap-2 rounded-[10px] px-3 text-sm text-navy ${selected ? "bg-brand-50" : "border border-outline bg-white hover:bg-canvas"}`;
export const field = "mt-1 w-full rounded-[10px] border border-outline bg-white px-3 py-2 font-normal text-ink";
export const card = "rounded-2xl border border-line bg-white p-5";
export const panelTitle = "text-[22px] font-semibold text-navy";
export const panelLabel = "text-[15px] font-semibold text-navy";
export const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

export const CONCLUSION: Record<string, { label: string; tone: Tone }> = {
  CONFORMS: { label: "CONFORMS", tone: "pass" },
  DOES_NOT_CONFORM: { label: "DOES NOT CONFORM", tone: "fail" },
  SST_FAILED: { label: "SUITABILITY FAILED", tone: "fail" },
  INCOMPLETE: { label: "NOT EVALUATED", tone: "muted" },
};
export const ILLUMINATION_LABEL: Record<Illumination, string> = { WHITE: "White light", UV254: "UV 254 nm", UV366: "UV 366 nm" };
