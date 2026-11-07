import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { computePh, PhLimits, PhResult, validateReadings } from "../shared/ph";
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
    idleExpiresAt = Date.parse(idle) + (Number.isNaN(now) ? 0 : Date.now() - now);
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

interface Principal {
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
};
function Badge({ tone, children }: { tone: keyof typeof toneClass; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide ${toneClass[tone]}`}>{children}</span>;
}
function Callout({ tone, title, children }: { tone: keyof typeof toneClass; title?: string; children: React.ReactNode }) {
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
const fmt = (v: number | null | undefined, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");

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

function Shell({ web, principal, title, children }: { web: string; principal: Principal; title: string; children: React.ReactNode }) {
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
          {item("/modules/ph/", "pH instruments", ICON.flask, true)}
          <p className="hidden px-3.5 pt-4 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted/70 lg:block">NxGen</p>
          {item(`${web}/home/`, "Home", ICON.home)}
          {item(`${web}/devices/`, "All instruments", ICON.list)}
        </nav>
        <p className="hidden items-center gap-2.5 border-t border-line px-8 py-5 text-sm text-muted lg:flex">
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
  const [data, setData] = useState<{ device: Device; live: Live | null; calibration: InstrumentCalibration | null; limits: PhLimits } | null>(null);
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
        </div>
        {!d.deviceIdentifier && <Callout tone="warn">Set this instrument’s ID (the DEVICE_ID it sends) on its instrument record to receive data.</Callout>}
        <div className="grid gap-3 sm:grid-cols-4">
          {tile("pH", fmt(live?.values.PH_VAL))}
          {tile("Temperature", `${fmt(live?.values.TEMP_VAL, 1)} °C`, live?.values.ATC === 1 ? "ATC on" : live?.values.ATC === 0 ? "ATC off" : undefined)}
          {tile("Battery", `${fmt(live?.values.BATTERY, 0)} %`)}
          {tile("Last data", live ? new Date(live.lastSeenAt).toLocaleTimeString() : "—")}
        </div>
      </section>

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
  const device = new URLSearchParams(location.search).get("device");
  return (
    <Shell web={boot.web} principal={boot.principal} title={device ? "Instrument" : "pH instruments"}>
      {device ? <Instrument id={device} web={boot.web} principal={boot.principal} /> : <InstrumentList />}
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
