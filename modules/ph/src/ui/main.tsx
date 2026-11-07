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
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${toneClass[tone]}`}>{children}</span>;
}
function Callout({ tone, title, children }: { tone: keyof typeof toneClass; title?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${toneClass[tone]}`} role={tone === "fail" ? "alert" : "status"}>
      {title && <p className="font-semibold">{title}</p>}
      <div className="text-ink">{children}</div>
    </div>
  );
}
const outcomeTone = (o: string) => (o === "PASS" ? "pass" : o === "WARNING" ? "warn" : "fail");
const readinessTone = (r: Readiness) => (r.state === "READY" ? "pass" : r.state === "DUE_SOON" ? "warn" : "fail");
const btn = "inline-flex min-h-11 items-center justify-center rounded-md px-5 font-semibold disabled:cursor-not-allowed";
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

function Shell({ web, principal, children }: { web: string; principal: Principal; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <a href={`${web}/home/`} className="block">
            <p className="text-xl font-bold tracking-tight">
              Nx<span className="text-[#7fb0ff]">Gen</span> <span className="font-semibold text-white/80">· pH</span>
            </p>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">Compliance Platform · Module</p>
          </a>
          <div className="text-right text-sm">
            <p className="font-semibold">{principal.fullName}</p>
            <p className="text-white/70">{principal.username}</p>
          </div>
        </div>
      </header>
      <SessionBanner />
      <nav className="border-b border-line bg-white" aria-label="Main">
        <ul className="mx-auto flex max-w-6xl gap-1 px-4 text-sm font-semibold sm:px-6">
          <li>
            <a href={`${web}/home/`} className="block px-3 py-3 text-muted hover:text-ink">
              NxGen home
            </a>
          </li>
          <li>
            <a href="/modules/ph/" className="block border-b-2 border-brand px-3 py-3 text-brand">
              pH instruments
            </a>
          </li>
          <li>
            <a href={`${web}/devices/`} className="block px-3 py-3 text-muted hover:text-ink">
              All instruments
            </a>
          </li>
        </ul>
      </nav>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
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
      <h1 className="text-2xl font-semibold">pH instruments</h1>
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
    <div className="rounded-lg border border-line bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="font-mono text-3xl font-semibold tabular-nums">{value}</p>
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
          <h1 className="text-2xl font-semibold">{d.name}</h1>
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
    <Shell web={boot.web} principal={boot.principal}>
      {device ? <Instrument id={device} web={boot.web} principal={boot.principal} /> : <InstrumentList />}
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
