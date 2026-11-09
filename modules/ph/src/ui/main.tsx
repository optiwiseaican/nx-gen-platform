import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { computePh, windowSpanMs, MeasurementDetails, PhLimits, PhResult, Stability, StabilityRule, validateDetails, validateReadings } from "../shared/ph";
import "./styles.css";

// ---------------------------------------------------------------------------
// API (same origin: the core serves this page and the API)
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let idleExpiresAt: number | null = null;
let maxExpiresAt: number | null = null;
const idleListeners = new Set<() => void>();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const idle = res.headers.get("X-NxGen-Session-Idle-Expires");
  const now = Date.parse(res.headers.get("X-NxGen-Server-Time") ?? "");
  if (idle) {
    const skew = Number.isNaN(now) ? 0 : Date.now() - now;
    idleExpiresAt = Date.parse(idle) + skew;
    const max = res.headers.get("X-NxGen-Session-Expires");
    if (max) maxExpiresAt = Date.parse(max) + skew;
    idleListeners.forEach((f) => f());
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
    const m = body?.message;
    throw new HttpError(res.status, Array.isArray(m) ? m.join(" ") : (m ?? `Request failed (${res.status})`));
  }
  return (await res.json()) as T;
}
const mod = <T,>(path: string, init?: RequestInit) => api<T>(`/modules/ph/api${path}`, init);
const send = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });

interface Principal {
  userId: string;
  fullName: string;
  username: string;
  permissions: string[];
}
interface Readiness {
  state: string;
  usable: boolean;
  message: string;
  dueAt: string | null;
}
interface Device {
  id: string;
  code: string;
  name: string;
  model: string;
  manufacturer: string;
  serialNumber: string;
  location: string;
  status: string;
  deviceIdentifier: string | null;
  readiness: Readiness;
}
interface Live {
  values: Record<string, number | null>;
  valueAt: Record<string, string>;
  lastSeenAt: string;
  online: boolean;
  simulated: boolean;
  stability: Stability;
}
interface Workflow {
  id: string;
  state: "DRAFT" | "IN_REVIEW" | "REVIEWED" | "APPROVED" | "INVALIDATED" | "SUPERSEDED";
  preparedBy: { name: string } | null;
  reviewedBy: { name: string } | null;
  approvedBy: { name: string } | null;
}
interface Measurement {
  id: string;
  code: string;
  device: { id: string; code?: string; name?: string };
  sampleId: string;
  batch: string;
  arNumber: string;
  product: string;
  remarks: string;
  ph: number;
  temperatureC: number;
  atc: "ON" | "OFF" | "UNKNOWN";
  stability: Stability;
  dataSource: "INSTRUMENT" | "SIMULATED";
  sourceMessages: number[];
  calibration: { code: string | null; outcome: string | null; performedAt: string | null; dueAt: string | null };
  measuredBy: { id: string; name: string };
  measuredAt: string;
  workflow: Workflow | null;
}
interface Signature {
  meaningLabel: string;
  signerFullName: string;
  signerUsername: string;
  signedAt: string;
  intact: boolean;
}
type Step = "SUBMIT" | "WITHDRAW" | "REVIEW" | "APPROVE" | "REJECT" | "INVALIDATE";
interface WorkflowDetail {
  instance: Workflow;
  allowedSteps: Step[];
  history: { id: string; step: string; toState: string; actorName: string | null; comment: string | null; occurredAt: string; signature: Signature | null }[];
}
interface InstrumentCalibration {
  bufferSet: string;
  readings: { buffer: number; bufferPh: number; mv: number }[];
  temperatureC: number | null;
  deviceReported: { slope: unknown; offset: unknown };
  deviceTimes: Record<string, unknown>;
  receivedAt: string;
  preview: PhResult | null;
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

const toneClass = {
  pass: "border-pass/30 bg-pass-50 text-pass",
  warn: "border-warn/30 bg-warn-50 text-warn",
  fail: "border-fail/30 bg-fail-50 text-fail",
  info: "border-brand/30 bg-brand-50 text-brand-700",
  muted: "border-line bg-canvas text-muted",
};
type Tone = keyof typeof toneClass;
function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide ${toneClass[tone]}`}>{children}</span>;
}
function Callout({ tone, title, children }: { tone: Exclude<Tone, "muted">; title?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass[tone]}`} role={tone === "fail" ? "alert" : "status"}>
      {title && <p className="font-semibold">{title}</p>}
      <div className="text-ink">{children}</div>
    </div>
  );
}
const outcomeTone = (o: string) => (o === "PASS" ? "pass" : o === "WARNING" ? "warn" : "fail");
const readinessTone = (r: Readiness) => (r.state === "READY" ? "pass" : r.state === "DUE_SOON" ? "warn" : "fail");
const btn = "inline-flex min-h-11 items-center justify-center rounded-xl px-5 font-semibold shadow-[var(--shadow-brand)] disabled:cursor-not-allowed disabled:shadow-none";
const secondary = "inline-flex min-h-11 items-center justify-center rounded-xl border border-line bg-white px-5 font-semibold text-ink hover:border-brand/30 disabled:text-muted";
const primary = `${btn} bg-brand text-white hover:bg-brand-700 disabled:bg-brand/40`;
const field = "mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 font-normal";
const card = "rounded-lg border border-line bg-white p-5";
const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }) : "—");
const STATE: Record<Workflow["state"], { label: string; tone: Tone }> = {
  DRAFT: { label: "DRAFT", tone: "muted" },
  IN_REVIEW: { label: "IN REVIEW", tone: "warn" },
  REVIEWED: { label: "REVIEWED", tone: "warn" },
  APPROVED: { label: "APPROVED", tone: "pass" },
  INVALIDATED: { label: "INVALIDATED", tone: "fail" },
  SUPERSEDED: { label: "SUPERSEDED", tone: "muted" },
};
const fmt = (v: number | null | undefined, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");

function SessionTimer({ className = "" }: { className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    idleListeners.add(f);
    const t = setInterval(f, 1000);
    return () => {
      idleListeners.delete(f);
      clearInterval(t);
    };
  }, []);
  if (!maxExpiresAt) return null;
  const s = Math.max(0, Math.ceil((maxExpiresAt - Date.now()) / 1000));
  const seconds = String(s % 60).padStart(2, "0");
  const text = s < 3600 ? `${Math.floor(s / 60)}:${seconds}` : `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${seconds}`;
  return (
    <span role="timer" aria-label="Time until the session ends" className={`text-muted ${className}`}>
      Session ends in <span className="font-mono font-semibold tabular-nums">{text}</span>
    </span>
  );
}

function SessionBanner() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    idleListeners.add(f);
    const t = setInterval(f, 1000);
    return () => {
      idleListeners.delete(f);
      clearInterval(t);
    };
  }, []);
  if (!idleExpiresAt) return null;
  const left = idleExpiresAt - Date.now();
  if (left > 120_000) return null;
  if (left <= 0) return null;
  const s = Math.ceil(left / 1000);
  return (
    <div className="border-b border-warn/30 bg-warn-50 px-4 py-2 text-center text-sm" role="alert">
      You will be signed out in {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} because of inactivity.{" "}
      <button className="font-semibold text-brand underline" onClick={() => void api("/auth/session/extend", { method: "POST", body: "{}" })}>
        Stay signed in
      </button>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function Logo() {
  return (
    <span className="inline-grid h-11 w-11 shrink-0 place-items-center rounded-[30%] bg-gradient-to-br from-[#3b82f6] via-brand to-[#1e40af] text-white shadow-[var(--shadow-brand)]" aria-hidden>
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 3.5h5M10.5 3.5v5.5L6 17a2.2 2.2 0 0 0 1.9 3.3h8.2A2.2 2.2 0 0 0 18 17l-4.5-8V3.5" />
        <path d="m9.5 15 1.8 1.8 3.3-3.3" />
      </svg>
    </span>
  );
}

const ICON = {
  flask: "M9 3.5h6M10 3.5v6L5.5 17a2.3 2.3 0 0 0 2 3.5h9a2.3 2.3 0 0 0 2-3.5L14 9.5v-6M8.5 14h7",
  home: "M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19z",
  list: "M9 6.5h11M9 12h11M9 17.5h11M4 6.5h.01M4 12h.01M4 17.5h.01",
};
const Svg = ({ d }: { d: string }) => (
  <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

function Shell({ web, principal, title, active, children }: { web: string; principal: Principal; title: string; active: "instruments" | "measurements"; children: React.ReactNode }) {
  const item = (href: string, label: string, d: string, active = false) => (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[15px] font-semibold ${
        active ? "bg-brand-50 text-brand" : "text-ink/75 hover:bg-canvas hover:text-ink"
      }`}
    >
      <span className={active ? "text-brand" : "text-muted"}>
        <Svg d={d} />
      </span>
      {label}
    </a>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="border-b border-line/80 bg-white/85 backdrop-blur lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[17rem] lg:shrink-0 lg:flex-col lg:border-r lg:border-b-0">
        <a href={`${web}/home/`} className="flex items-center gap-3 px-5 pt-6 pb-5">
          <Logo />
          <span className="leading-tight">
            <span className="block text-lg font-extrabold tracking-tight">
              Nx<span className="text-brand">Gen</span>
            </span>
            <span className="block text-[13px] font-semibold text-muted">pH module</span>
          </span>
        </a>
        <nav aria-label="Main" className="flex gap-1 px-3 pb-3 lg:flex-1 lg:flex-col lg:space-y-1">
          <p className="hidden px-3.5 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted/70 lg:block">pH</p>
          {item("/modules/ph/", "pH instruments", ICON.flask, active === "instruments")}
          {item("/modules/ph/?measurements=1", "Measurements", ICON.list, active === "measurements")}
          <p className="hidden px-3.5 pt-4 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted/70 lg:block">NxGen</p>
          {item(`${web}/home/`, "Home", ICON.home)}
          {item(`${web}/devices/`, "All instruments", ICON.list)}
        </nav>
        <SessionTimer className="hidden border-t border-line px-8 pt-5 text-sm lg:block" />
        <p className="hidden items-center gap-2.5 px-8 pt-2 pb-5 text-sm text-muted lg:flex">
          <span className="h-2 w-2 rounded-full bg-pass shadow-[0_0_0_3px_rgb(19_150_90/0.15)]" aria-hidden />
          Connected
        </p>
      </aside>
      <div className="min-w-0 flex-1">
        <SessionBanner />
        <header className="flex flex-wrap items-center justify-between gap-4 px-4 pt-6 pb-2 sm:px-8 lg:pt-8">
          <div>
            <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-muted">pH module</p>
            <h1 className="text-[28px] font-extrabold leading-tight tracking-tight">{title}</h1>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-line/70 bg-white/80 py-1.5 pr-4 pl-1.5 shadow-[var(--shadow-card)]">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-navy-700 to-navy text-sm font-bold text-white" aria-hidden>
              {initials(principal.fullName)}
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-bold">{principal.fullName}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-pass" aria-hidden />
                {principal.username}
              </span>
              <SessionTimer className="block text-xs lg:hidden" />
            </span>
          </div>
        </header>
        <main className="max-w-[84rem] px-4 py-6 sm:px-8">{children}</main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function InstrumentList() {
  const [devices, setDevices] = useState<(Device & { live: Live | null })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      mod<(Device & { live: Live | null })[]>("/instruments")
        .then(setDevices)
        .catch((e: Error) => setError(e.message));
    void load();
  }, []);
  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!devices) return <p className="text-muted">Loading…</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Instruments send their data through the USB dongle. Register a pH meter, with the DEVICE_ID it sends, under All instruments.
      </p>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Instrument</th>
              <th className="px-4 py-3">Instrument ID</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Live pH</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {devices.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-3">
                  <a href={`/modules/ph/?device=${d.id}`} className="font-semibold text-brand hover:underline">
                    {d.code} · {d.name}
                  </a>
                  <p className="text-xs text-muted">
                    {d.manufacturer} {d.model} · {d.location || "—"}
                  </p>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{d.deviceIdentifier ?? <span className="text-fail">not set</span>}</td>
                <td className="px-4 py-3">
                  <Badge tone={readinessTone(d.readiness)}>{d.readiness.state.replace(/_/g, " ")}</Badge>
                </td>
                <td className="px-4 py-3 font-mono tabular-nums">
                  {d.live?.online ? `pH ${fmt(d.live.values.PH_VAL)}` : <span className="text-muted">offline</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {devices.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No pH instruments registered yet.</p>}
      </div>
    </div>
  );
}

const DEFAULT_BUFFERS = ["4.01", "7.00", "10.01"];

function Instrument({ id, web, principal }: { id: string; web: string; principal: Principal }) {
  const [data, setData] = useState<{ device: Device; live: Live | null; calibration: InstrumentCalibration | null; limits: PhLimits; stabilityRule: StabilityRule } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"INSTRUMENT" | "MANUAL">("INSTRUMENT");
  const [temperature, setTemperature] = useState("25.0");
  const [buffers, setBuffers] = useState(DEFAULT_BUFFERS.map((b) => ({ bufferPh: b, mv: "" })));
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ calibrationId: string; code: string; outcome: string; dataSource: string } | null>(null);

  const load = useCallback(() => {
    mod<NonNullable<typeof data>>(`/instruments/${id}/live`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: HttpError) => {
        if (e.status === 401) window.location.href = `${web}/login/?reason=session`;
        else setError(e.message);
      });
  }, [id, web]);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  if (error && !data) return <Callout tone="fail">{error}</Callout>;
  if (!data) return <p className="text-muted">Loading…</p>;
  const { device: d, live, calibration: cal } = data;
  const canCalibrate = principal.permissions.includes("calibration.perform") && d.status === "ACTIVE";

  const manual = buffers
    .filter((b) => b.bufferPh.trim() && b.mv.trim())
    .map((b) => ({ bufferPh: Number(b.bufferPh), mv: Number(b.mv) }));
  const t = cal?.temperatureC ?? Number(temperature);
  const readings = mode === "INSTRUMENT" ? (cal?.readings ?? []) : manual;
  const problems = readings.length ? validateReadings(readings, Number.isFinite(t) ? t : null) : ["Enter at least two buffers."];
  const preview = !problems.length ? computePh(readings, t) : null;

  async function record() {
    setBusy(true);
    setSaveError(null);
    try {
      const r = await mod<{ calibrationId: string; code: string; outcome: string; dataSource: string }>(`/instruments/${id}/calibrations`, {
        method: "POST",
        body: JSON.stringify(
          mode === "INSTRUMENT"
            ? { source: "INSTRUMENT", temperatureC: cal?.temperatureC === null ? Number(temperature) : undefined, remarks }
            : { source: "MANUAL", temperatureC: Number(temperature), readings: manual, remarks },
        ),
      });
      setCreated(r);
      load();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-line bg-white px-5 py-4">
      <p className="text-xs font-bold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-3xl font-extrabold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm text-muted">
            {d.code} · ID {d.deviceIdentifier ?? "not set"}
          </p>
          <h2 className="text-xl font-bold">{d.name}</h2>
        </div>
        <a href={`${web}/devices/view/?id=${d.id}`} className="text-sm font-semibold text-brand hover:underline">
          Instrument record and approvals
        </a>
      </div>
      <Callout tone={readinessTone(d.readiness)} title={d.readiness.usable ? "Can be used" : "Blocked from use"}>
        {d.readiness.message}
      </Callout>

      <section className="space-y-3" aria-label="Live readings">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">Live readings</h2>
          {live?.online ? <Badge tone="pass">CONNECTED</Badge> : <Badge tone="fail">NO DATA</Badge>}
          {live?.simulated && <Badge tone="warn">SIMULATED</Badge>}
          {live?.online && <StabilityBadge stability={live.stability} />}
        </div>
        {!d.deviceIdentifier && <Callout tone="warn">Set this instrument’s ID (the DEVICE_ID it sends) on its instrument record to receive data.</Callout>}
        <div className="grid gap-3 sm:grid-cols-4">
          {tile("pH", fmt(live?.values.PH_VAL))}
          {tile("Temperature", `${fmt(live?.values.TEMP_VAL, 1)} °C`, live?.values.ATC === 1 ? "ATC on" : live?.values.ATC === 0 ? "ATC off" : undefined)}
          {tile("Battery", `${fmt(live?.values.BATTERY, 0)} %`)}
          {tile("Last data", live ? new Date(live.lastSeenAt).toLocaleTimeString() : "—")}
        </div>
      </section>

      {principal.permissions.includes("ph.measure") && (
        <RecordMeasurement device={d} live={live} rule={data.stabilityRule} onRecorded={load} />
      )}

      {canCalibrate && (
        <section className="space-y-4 rounded-lg border border-line bg-white p-5" aria-label="Record calibration">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Record calibration</h2>
            <div className="flex gap-1 rounded-md border border-line p-1 text-sm" role="tablist">
              {(["INSTRUMENT", "MANUAL"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded px-3 py-1 font-semibold ${mode === m ? "bg-brand text-white" : "text-muted"}`}
                >
                  {m === "INSTRUMENT" ? "From the instrument" : "Enter manually"}
                </button>
              ))}
            </div>
          </div>

          {created && (
            <Callout tone="pass" title={`${created.code} saved as a draft (${created.outcome})`}>
              Recorded {created.dataSource === "MANUAL" ? "manually" : created.dataSource === "SIMULATED" ? "from the simulator" : "from the instrument"}.{" "}
              <a className="font-semibold text-brand underline" href={`${web}/devices/view/?calibration=${created.calibrationId}`}>
                Open it to submit for approval
              </a>
              .
            </Callout>
          )}

          {mode === "INSTRUMENT" ? (
            cal ? (
              <div className="space-y-2">
                <p className="text-sm text-muted">
                  Received {new Date(cal.receivedAt).toLocaleTimeString()} · buffer set {cal.bufferSet}. These values are taken from the stored
                  instrument packets and cannot be edited.
                </p>
                <table className="text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="pb-1 pr-6">Slot</th>
                      <th className="pb-1 pr-6">Buffer</th>
                      <th className="pb-1">Potential</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {cal.readings.map((r) => (
                      <tr key={r.buffer}>
                        <td className="pr-6">MV_{r.buffer}</td>
                        <td className="pr-6">pH {r.bufferPh.toFixed(2)}</td>
                        <td>{r.mv.toFixed(2)} mV</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-muted">
                  Instrument reported slope {String(cal.deviceReported.slope ?? "—")} %, offset {String(cal.deviceReported.offset ?? "—")}. NxGen recalculates
                  both below.
                </p>
              </div>
            ) : (
              <Callout tone="info">Calibrate on the pH meter. When it sends its calibration (MV_1 … MV_5), the readings appear here.</Callout>
            )
          ) : (
            <table className="text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-1 pr-2">Buffer (pH)</th>
                  <th className="pb-1">Potential (mV)</th>
                </tr>
              </thead>
              <tbody>
                {buffers.map((b, i) => (
                  <tr key={i}>
                    {(["bufferPh", "mv"] as const).map((k) => (
                      <td key={k} className="py-1 pr-2">
                        <input
                          aria-label={`Buffer ${i + 1} ${k === "mv" ? "mV" : "pH"}`}
                          inputMode="decimal"
                          value={b[k]}
                          onChange={(e) => setBuffers(buffers.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))}
                          className="w-36 rounded-md border border-line px-3 py-2 font-mono tabular-nums"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(mode === "MANUAL" || (cal && cal.temperatureC === null)) && (
            <label className="block max-w-xs text-sm font-semibold">
              Buffer temperature (°C)
              <input
                inputMode="decimal"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="mt-1 w-full rounded-md border border-line px-3 py-2 font-mono font-normal"
              />
            </label>
          )}

          {(mode === "MANUAL" || cal) && (
            <>
              <div className="rounded-md border border-line bg-canvas p-4 text-sm" aria-live="polite">
                {preview ? (
                  <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
                    <span>
                      Slope <b className="font-mono">{fmt(preview.slopePercent)} %</b> <Badge tone={outcomeTone(preview.slopeOutcome)}>{preview.slopeOutcome}</Badge>
                    </span>
                    <span>
                      Offset <b className="font-mono">{fmt(preview.offsetMv)} mV</b> <Badge tone={outcomeTone(preview.offsetOutcome)}>{preview.offsetOutcome}</Badge>
                    </span>
                    <span className="font-semibold">
                      Result <Badge tone={outcomeTone(preview.outcome)}>{preview.outcome}</Badge>
                    </span>
                  </div>
                ) : (
                  <span className="text-muted">{problems.join(" ")}</span>
                )}
                <p className="mt-2 text-xs text-muted">
                  Limits: slope {data.limits.slopePassMin}–{data.limits.slopePassMax} % (warning {data.limits.slopeWarnMin}–{data.limits.slopeWarnMax} %), offset
                  within ±{data.limits.offsetPassMaxAbs} mV (warning ±{data.limits.offsetWarnMaxAbs} mV).
                </p>
              </div>
              <label className="block text-sm font-semibold">
                Remarks
                <textarea
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="e.g. Buffer lots B-4471, B-7012, B-1003"
                  className="mt-1 w-full rounded-md border border-line px-3 py-2 font-normal"
                />
              </label>
              {saveError && <Callout tone="fail">{saveError}</Callout>}
              <button onClick={() => void record()} disabled={busy || !preview} className={`${btn} bg-brand text-white hover:bg-brand-700 disabled:bg-brand/40`}>
                {busy ? "Saving…" : "Save calibration as draft"}
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

function StabilityBadge({ stability }: { stability: Stability }) {
  if (stability.state === "STABLE") return <Badge tone="pass">STABLE</Badge>;
  if (stability.state === "NO_READING") return <Badge tone="muted">NO READING</Badge>;
  return <Badge tone="warn">SETTLING</Badge>;
}

function stabilityText(st: Stability) {
  const rule = `needs a spread of at most ${st.rule.tolerance} pH for ${st.rule.windowMs / 1000} s`;
  if (st.state === "NO_READING") return "No pH reading is arriving.";
  const span = (windowSpanMs(st) / 1000).toFixed(1);
  if (st.state === "STABLE") return `Stable: ${st.samples} readings within ${fmt(st.spread, 3)} pH over ${span} s.`;
  return `Settling: spread ${fmt(st.spread, 3)} pH over ${span} s (${rule}).`;
}

const EMPTY_DETAILS: MeasurementDetails = { sampleId: "", batch: "", arNumber: "", product: "", remarks: "" };
const DETAIL_LABELS: [keyof MeasurementDetails, string, string][] = [
  ["sampleId", "Sample ID", "e.g. SMP-2026-1187"],
  ["batch", "Batch / lot number", "e.g. B-24-0311"],
  ["arNumber", "AR number", "e.g. AR-2026-118"],
  ["product", "Product", "e.g. Paracetamol oral suspension"],
];

function DetailFields({ value, onChange, errors, idPrefix }: { value: MeasurementDetails; onChange: (v: MeasurementDetails) => void; errors: Partial<Record<keyof MeasurementDetails, string>>; idPrefix: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {DETAIL_LABELS.map(([k, label, ph]) => (
        <label key={k} className="block text-sm font-semibold" htmlFor={`${idPrefix}-${k}`}>
          {label}
          <input
            id={`${idPrefix}-${k}`}
            value={value[k]}
            placeholder={ph}
            onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            aria-invalid={!!errors[k]}
            className={`${field} ${errors[k] ? "border-fail" : ""}`}
          />
          {errors[k] && <span className="mt-1 block text-xs font-normal text-fail">{errors[k]}</span>}
        </label>
      ))}
      <label className="block text-sm font-semibold sm:col-span-2" htmlFor={`${idPrefix}-remarks`}>
        Remarks (optional)
        <textarea id={`${idPrefix}-remarks`} rows={2} value={value.remarks} onChange={(e) => onChange({ ...value, remarks: e.target.value })} className={field} />
      </label>
    </div>
  );
}

function RecordMeasurement({ device, live, rule, onRecorded }: { device: Device; live: Live | null; rule: StabilityRule; onRecorded: () => void }) {
  const [form, setForm] = useState<MeasurementDetails>(EMPTY_DETAILS);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Measurement | null>(null);
  const errors = touched ? validateDetails(form) : {};
  const stable = live?.online && live.stability.state === "STABLE";
  async function record() {
    setTouched(true);
    if (Object.keys(validateDetails(form)).length) return;
    setBusy(true);
    setError(null);
    try {
      const m = await mod<Measurement>(`/instruments/${device.id}/measurements`, send(form));
      setCreated(m);
      setForm({ ...form, sampleId: "", remarks: "" });
      setTouched(false);
      onRecorded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-lg border border-line bg-white p-5" aria-label="Record measurement">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Record measurement</h2>
        {live?.online && <StabilityBadge stability={live.stability} />}
      </div>
      <p className="text-sm text-muted">
        NxGen records the reading the instrument is sending, only once it is stable (spread at most {rule.tolerance} pH for {rule.windowMs / 1000} s). The
        value cannot be typed or changed; the packets it came from are kept with it.
      </p>
      {created && (
        <Callout tone="pass" title={`${created.code} recorded: pH ${created.ph.toFixed(2)} at ${created.temperatureC.toFixed(1)} °C`}>
          Saved as a draft.{" "}
          <a className="font-semibold text-brand underline" href={`/modules/ph/?measurement=${created.id}`}>
            Open it to submit for review
          </a>
          .
        </Callout>
      )}
      <DetailFields value={form} onChange={setForm} errors={errors} idPrefix="m" />
      <div className="rounded-md border border-line bg-canvas p-4 text-sm" aria-live="polite">
        {live?.online ? (
          <p>
            <b className="font-mono text-lg tabular-nums">pH {fmt(live.stability.latest ?? live.values.PH_VAL)}</b>{" "}
            <span className="text-muted">· {fmt(live.values.TEMP_VAL, 1)} °C · {stabilityText(live.stability)}</span>
          </p>
        ) : (
          <p className="text-muted">No data from the instrument.</p>
        )}
      </div>
      {!device.readiness.usable && <Callout tone="fail">This instrument cannot be used: {device.readiness.message}</Callout>}
      {error && <Callout tone="fail">{error}</Callout>}
      <button className={primary} disabled={busy || !stable || !device.readiness.usable} onClick={() => void record()}>
        {busy ? "Recording…" : stable ? "Record stable reading" : "Waiting for a stable reading…"}
      </button>
    </section>
  );
}

function MeasurementList({ principal }: { principal: Principal }) {
  const [rows, setRows] = useState<Measurement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "todo">("all");
  useEffect(() => {
    mod<Measurement[]>("/measurements").then(setRows).catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!rows) return <p className="text-muted">Loading…</p>;
  const mine = (m: Measurement) =>
    (m.workflow?.state === "DRAFT" && m.measuredBy.id === principal.userId) ||
    (m.workflow?.state === "IN_REVIEW" && principal.permissions.includes("ph.review")) ||
    (m.workflow?.state === "REVIEWED" && principal.permissions.includes("ph.approve"));
  const shown = filter === "todo" ? rows.filter(mine) : rows;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          Each measurement is the stable reading an instrument sent, with sample, batch and AR number. It is reviewed and approved with electronic
          signatures; once submitted it is locked.
        </p>
        <div className="flex gap-1 rounded-xl border border-line bg-white p-1 text-sm">
          {(["all", "todo"] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)} className={`rounded-lg px-3 py-1.5 font-semibold ${filter === f ? "bg-brand text-white" : "text-muted"}`}>
              {f === "all" ? "All" : "Waiting for me"}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full min-w-[46rem] text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Measurement</th>
              <th className="px-4 py-3">Sample</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3 text-right">pH</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-3">
                  <a href={`/modules/ph/?measurement=${m.id}`} className="font-semibold text-brand hover:underline">
                    {m.code}
                  </a>
                  <p className="text-xs text-muted">
                    {m.device.code} · {fmtDate(m.measuredAt)}
                  </p>
                </td>
                <td className="px-4 py-3">
                  {m.sampleId}
                  <p className="text-xs text-muted">
                    {m.batch} · {m.arNumber}
                  </p>
                </td>
                <td className="px-4 py-3">{m.product}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">
                  {m.ph.toFixed(2)}
                  <p className="text-xs text-muted">{m.temperatureC.toFixed(1)} °C</p>
                </td>
                <td className="space-x-1 px-4 py-3">
                  {m.workflow && <Badge tone={STATE[m.workflow.state].tone}>{STATE[m.workflow.state].label}</Badge>}
                  {m.dataSource === "SIMULATED" && <Badge tone="warn">SIMULATED</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">{filter === "todo" ? "Nothing is waiting for you." : "No measurements yet."}</p>}
      </div>
    </div>
  );
}

const STEP_UI: Record<Step, { label: string; title: string; meaning?: string; minReason: number; tone: "primary" | "secondary" }> = {
  SUBMIT: { label: "Submit for review…", title: "Submit for review", meaning: "Authored", minReason: 0, tone: "primary" },
  WITHDRAW: { label: "Withdraw…", title: "Withdraw to draft", minReason: 10, tone: "secondary" },
  REVIEW: { label: "Review…", title: "Sign as reviewed", meaning: "Reviewed", minReason: 0, tone: "primary" },
  APPROVE: { label: "Approve…", title: "Approve the measurement", meaning: "Approved", minReason: 0, tone: "primary" },
  REJECT: { label: "Reject…", title: "Reject the measurement", meaning: "Rejected", minReason: 10, tone: "secondary" },
  INVALIDATE: { label: "Invalidate…", title: "Invalidate the approved measurement", meaning: "Invalidated", minReason: 10, tone: "secondary" },
};

function StepDialog({ step, principal, onClose, onSign }: { step: Step | null; principal: Principal; onClose: () => void; onSign: (comment: string, password: string) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [comment, setComment] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (step && !d.open) {
      setComment("");
      setPassword("");
      setError(null);
      d.showModal();
    } else if (!step && d.open) d.close();
  }, [step]);
  const ui = step ? STEP_UI[step] : null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ui) return;
    if (comment.trim().length < ui.minReason) return setError(`Enter the reason (at least ${ui.minReason} characters).`);
    if (ui.meaning && !password) return setError("Enter your password to sign.");
    setBusy(true);
    setError(null);
    try {
      await onSign(comment.trim(), password);
    } catch (err) {
      setPassword("");
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={ref} onClose={onClose} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[1.375rem] border border-line p-0 shadow-2xl backdrop:bg-navy/35">
      <form onSubmit={submit} className="space-y-4 p-6">
        <h2 className="text-lg font-bold">{ui?.title}</h2>
        <label className="block text-sm font-semibold">
          {ui?.minReason ? "Reason" : "Comment (optional)"}
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} className={field} />
        </label>
        {ui?.meaning && (
          <fieldset className="space-y-3 rounded-xl border border-brand/30 bg-brand-50 p-4">
            <legend className="px-1 text-sm font-semibold text-brand-700">Electronic signature</legend>
            <p className="text-sm">
              Meaning: <b>{ui.meaning}</b> · set by this step
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold">
                Username
                <input value={principal.username} readOnly className={`${field} bg-canvas`} />
              </label>
              <label className="text-sm font-semibold">
                Password
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={field} />
              </label>
            </div>
            <p className="text-xs text-muted">
              By signing, I, <b className="text-ink">{principal.fullName}</b>, confirm that this electronic signature is the legally binding equivalent of
              my handwritten signature.
            </p>
          </fieldset>
        )}
        {error && <Callout tone="fail">{error}</Callout>}
        <div className="flex justify-end gap-3">
          <button type="button" className={secondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={primary} disabled={busy}>
            {busy ? "Signing…" : ui?.meaning ? `Sign & ${ui.label.replace("…", "")}` : ui?.label.replace("…", "")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

type MeasurementFull = Measurement & { packets: { id: number; receivedAt: string; raw: string; sha256: string; transport: string }[] };

function MeasurementPage({ id, principal, web }: { id: string; principal: Principal; web: string }) {
  const [m, setM] = useState<MeasurementFull | null>(null);
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<MeasurementDetails>(EMPTY_DETAILS);
  const [reason, setReason] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showPackets, setShowPackets] = useState(false);

  const load = useCallback(async () => {
    try {
      const x = await mod<MeasurementFull>(`/measurements/${id}`);
      setM(x);
      if (x.workflow) setWf(await api<WorkflowDetail>(`/workflow/instances/${x.workflow.id}`));
    } catch (e) {
      if ((e as HttpError).status === 401) location.href = `${web}/login/?reason=session`;
      else setError((e as Error).message);
    }
  }, [id, web]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!m || !wf) return <p className="text-muted">Loading…</p>;
  const canCorrect = wf.instance.state === "DRAFT" && m.measuredBy.id === principal.userId && principal.permissions.includes("ph.measure");

  async function sign(comment: string, password: string) {
    const ui = STEP_UI[step!];
    await api(`/workflow/instances/${wf!.instance.id}/${step!.toLowerCase()}`, send({ reason: comment, signature: ui.meaning ? { username: principal.username, password } : undefined }));
    const done = step!;
    await load();
    setStep(null);
    setNotice({ SUBMIT: "Submitted for review and locked.", WITHDRAW: "Withdrawn to draft.", REVIEW: "Signed as reviewed.", APPROVE: "Approved.", REJECT: "Rejected.", INVALIDATE: "Invalidated." }[done]);
  }

  async function saveDetails() {
    setSaveError(null);
    if (Object.keys(validateDetails(form)).length) return setSaveError("Correct the highlighted fields.");
    try {
      await mod(`/measurements/${id}/details`, send({ ...form, reason }, "PUT"));
      await load();
      setEditing(false);
      setNotice("Sample details corrected. The change and its reason are on the audit trail.");
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }

  const stages = [
    { label: "Prepared", who: wf.instance.preparedBy?.name, done: wf.instance.state !== "DRAFT" },
    { label: "Reviewed", who: wf.instance.reviewedBy?.name, done: ["REVIEWED", "APPROVED", "INVALIDATED", "SUPERSEDED"].includes(wf.instance.state) },
    { label: "Approved", who: wf.instance.approvedBy?.name, done: ["APPROVED", "INVALIDATED", "SUPERSEDED"].includes(wf.instance.state) },
  ];
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm text-muted">
            {m.code} · {m.device.code} {m.device.name}
          </p>
          <h2 className="text-xl font-bold">
            {m.sampleId} <span className="font-normal text-muted">· batch {m.batch}</span>
          </h2>
        </div>
        <span className="flex flex-wrap gap-2">
          <Badge tone={STATE[wf.instance.state].tone}>{STATE[wf.instance.state].label}</Badge>
          {m.dataSource === "SIMULATED" && <Badge tone="warn">SIMULATED DATA</Badge>}
        </span>
      </div>
      {notice && <Callout tone="pass">{notice}</Callout>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-line bg-white px-5 py-4">
          <p className="text-xs font-bold uppercase tracking-wide text-muted">pH</p>
          <p className="mt-1 text-4xl font-extrabold tabular-nums tracking-tight">{m.ph.toFixed(2)}</p>
          <p className="text-xs text-muted">Stable · spread {fmt(m.stability.spread, 3)} pH over {(windowSpanMs(m.stability) / 1000).toFixed(1)} s · {m.stability.samples} readings</p>
        </div>
        <div className="rounded-lg border border-line bg-white px-5 py-4">
          <p className="text-xs font-bold uppercase tracking-wide text-muted">Temperature</p>
          <p className="mt-1 text-4xl font-extrabold tabular-nums tracking-tight">{m.temperatureC.toFixed(1)} °C</p>
          <p className="text-xs text-muted">ATC {m.atc === "UNKNOWN" ? "not reported" : m.atc.toLowerCase()}</p>
        </div>
        <div className="rounded-lg border border-line bg-white px-5 py-4">
          <p className="text-xs font-bold uppercase tracking-wide text-muted">Calibration in force</p>
          <p className="mt-1 text-xl font-bold">{m.calibration.code ?? "—"}</p>
          <p className="text-xs text-muted">
            {m.calibration.outcome ?? ""} · due {m.calibration.dueAt ? new Date(m.calibration.dueAt).toLocaleDateString() : "—"}
          </p>
        </div>
      </div>

      <ol className="grid gap-2 sm:grid-cols-3" aria-label="Approval progress">
        {stages.map((s, i) => (
          <li key={s.label} className={`rounded-xl border px-4 py-2.5 text-sm ${s.done ? "border-pass/30 bg-pass-50" : "border-line bg-white"}`}>
            <p className="text-xs font-bold uppercase tracking-wide text-muted">
              {i + 1}. {s.label}
            </p>
            <p className="font-semibold">{s.done ? (s.who ?? "—") : "Not yet"}</p>
          </li>
        ))}
      </ol>
      {wf.allowedSteps.length > 0 && !editing && (
        <div className="flex flex-wrap gap-3">
          {wf.allowedSteps.map((s) => (
            <button key={s} className={STEP_UI[s].tone === "primary" ? primary : secondary} onClick={() => setStep(s)}>
              {STEP_UI[s].label}
            </button>
          ))}
        </div>
      )}

      <section className={card}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-bold">Sample details</h3>
          {canCorrect && !editing && (
            <button
              className="text-sm font-semibold text-brand hover:underline"
              onClick={() => {
                setForm({ sampleId: m.sampleId, batch: m.batch, arNumber: m.arNumber, product: m.product, remarks: m.remarks });
                setReason("");
                setEditing(true);
              }}
            >
              Correct…
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-4">
            <DetailFields value={form} onChange={setForm} errors={validateDetails(form)} idPrefix="c" />
            <label className="block text-sm font-semibold" htmlFor="c-reason">
              Reason for the correction
              <input id="c-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={field} placeholder="e.g. AR number mistyped; correct number from the sample label" />
            </label>
            <p className="text-xs text-muted">Only the sample details can be corrected. The measured pH and temperature are original data and cannot change.</p>
            {saveError && <Callout tone="fail">{saveError}</Callout>}
            <div className="flex gap-3">
              <button className={secondary} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className={primary} onClick={() => void saveDetails()}>
                Save correction
              </button>
            </div>
          </div>
        ) : (
          <dl className="divide-y divide-line text-sm">
            {row("Sample ID", m.sampleId)}
            {row("Batch / lot", m.batch)}
            {row("AR number", m.arNumber)}
            {row("Product", m.product)}
            {row("Remarks", m.remarks || "—")}
            {row("Measured by", `${m.measuredBy.name} · ${fmtDate(m.measuredAt)}`)}
            {row("Instrument", `${m.device.code} · ${m.device.name}`)}
          </dl>
        )}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-bold">Original instrument data</h3>
            <p className="text-sm text-muted">
              {m.packets.length} packets stored unchanged with their SHA-256; the readings in the stability window and the temperature.
            </p>
          </div>
          <button className="text-sm font-semibold text-brand hover:underline" onClick={() => setShowPackets(!showPackets)} aria-expanded={showPackets}>
            {showPackets ? "Hide packets" : "Show packets"}
          </button>
        </div>
        {showPackets && (
          <ul className="mt-3 space-y-2 text-xs">
            {m.packets.map((x) => (
              <li key={x.id} className="rounded-lg border border-line bg-canvas/60 p-3">
                <p className="text-muted">
                  #{x.id} · {fmtDate(x.receivedAt)} · {x.transport === "SIMULATOR" ? "simulator" : "USB dongle"}
                </p>
                <p className="break-all font-mono">{x.raw}</p>
                <p className="break-all font-mono text-muted">SHA-256 {x.sha256}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="font-bold">History</h3>
        {[...wf.history].reverse().map((e) => (
          <div key={e.id} className={card}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <p className="font-semibold">
                {e.step.charAt(0) + e.step.slice(1).toLowerCase()} <span className="font-normal text-muted">· {e.actorName}</span>
              </p>
              <p className="text-xs text-muted">{fmtDate(e.occurredAt)}</p>
            </div>
            {e.comment && <p className="mt-1 text-sm text-muted">“{e.comment}”</p>}
            {e.signature && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-canvas/60 p-3 text-sm">
                <span>
                  <b>{e.signature.meaningLabel}</b> — {e.signature.signerFullName} ({e.signature.signerUsername}) · {fmtDate(e.signature.signedAt)}
                </span>
                <Badge tone={e.signature.intact ? "pass" : "fail"}>{e.signature.intact ? "SIGNATURE VERIFIED" : "SIGNATURE INVALID"}</Badge>
              </div>
            )}
          </div>
        ))}
      </section>
      <StepDialog step={step} principal={principal} onClose={() => setStep(null)} onSign={sign} />
    </div>
  );
}

function App() {
  const [boot, setBoot] = useState<{ web: string; principal: Principal } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api<{ webBaseUrl: string }>("/modules/ph/context"), api<Principal>("/auth/me")])
      .then(([c, p]) => setBoot({ web: c.webBaseUrl, principal: p }))
      .catch((e: HttpError) => {
        if (e.status === 401 || e.status === 403) {
          const web = location.port === "4000" ? "http://localhost:3000" : "";
          window.location.href = `${web}/login/?reason=session`;
        } else setError(e.message);
      });
  }, []);
  if (error) return <div className="p-8"><Callout tone="fail">{error}</Callout></div>;
  if (!boot) return <p className="p-8 text-muted">Loading…</p>;
  const q = new URLSearchParams(location.search);
  const device = q.get("device");
  const measurement = q.get("measurement");
  const list = q.get("measurements");
  const title = measurement ? "pH measurement" : list ? "Measurements" : device ? "Instrument" : "pH instruments";
  return (
    <Shell web={boot.web} principal={boot.principal} title={title} active={measurement || list ? "measurements" : "instruments"}>
      {measurement ? (
        <MeasurementPage id={measurement} principal={boot.principal} web={boot.web} />
      ) : list ? (
        <MeasurementList principal={boot.principal} />
      ) : device ? (
        <Instrument id={device} web={boot.web} principal={boot.principal} />
      ) : (
        <InstrumentList />
      )}
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
