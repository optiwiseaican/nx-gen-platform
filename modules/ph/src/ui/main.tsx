import { createContext, StrictMode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BATTERY_CONDITION_LABEL, CALIBRATION_BUCKET_LABEL, CalibrationBucket, DashboardFilter, DashboardRowLike, DashboardSummary, DEFAULT_DASHBOARD_FILTER, filterDashboardDevices, LOG_METHOD_LABEL, LogMethod, LogMode, nernstSlope, parseLimits, SAMPLE_LIST_KINDS, SAMPLE_LIST_LABEL, SampleListKind, validateLimits, windowSpanMs, MeasurementDetails, PhLimits, PhResult, Stability, StabilityRule, validateDetails } from "../shared/ph";
import { TrendChart } from "./TrendChart";
import phDeviceImage from "./ph-device.png";
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
  roles?: string[];
  session?: { idleExpiresAt: string; expiresAt: string; startedAt?: string };
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
  /** DEVICE_STATUS, CHARGING_STATUS, CURRENT_USER, as the meter reports them. */
  text: Record<string, string>;
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

function StepDialog({ step, principal, subject = "measurement", onClose, onSign }: { step: Step | null; principal: Principal; subject?: string; onClose: () => void; onSign: (comment: string, password: string) => Promise<void> }) {
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
        <h2 className="text-lg font-bold">{ui?.title.replace("measurement", subject)}</h2>
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

const LIMIT_FIELDS: { key: keyof PhLimits; label: string; unit: string }[] = [
  { key: "slopePassMin", label: "Slope pass, minimum", unit: "%" },
  { key: "slopePassMax", label: "Slope pass, maximum", unit: "%" },
  { key: "slopeWarnMin", label: "Slope warning, minimum", unit: "%" },
  { key: "slopeWarnMax", label: "Slope warning, maximum", unit: "%" },
  { key: "offsetPassMaxAbs", label: "Offset pass, within ±", unit: "mV" },
  { key: "offsetWarnMaxAbs", label: "Offset warning, within ±", unit: "mV" },
  { key: "deviationMaxPh", label: "Deviation from the buffer, at most", unit: "pH" },
];
const limitsText = (l: PhLimits) => `Slope ${l.slopePassMin}–${l.slopePassMax} % (warning ${l.slopeWarnMin}–${l.slopeWarnMax} %) · offset ±${l.offsetPassMaxAbs} mV (warning ±${l.offsetWarnMaxAbs} mV) · deviation ≤ ${l.deviationMaxPh} pH`;

interface LimitsVersion {
  id: string;
  version: number;
  limits: PhLimits;
  reason: string;
  preparedById: string;
  createdAt: string;
  workflow: Workflow | null;
}
interface LimitsData {
  inForce: { version: number | null; limits: PhLimits };
  defaults: PhLimits;
  versions: LimitsVersion[];
}

interface PreCheck {
  label: string;
  result: "PASS" | "WARN" | "FAIL";
  detail: string;
}
interface RunPoint {
  slot: number;
  bufferPh: number;
  status: "PENDING" | "MEASURING" | "WAITING" | "ACCEPTED" | "NO_REPLY" | "UNSTABLE" | "FAILED";
  message: string | null;
  secondsLeft: number | null;
  measuredPh: number | null;
  mv: number | null;
  temperatureC: number | null;
  stable: boolean | null;
  postPh: number | null;
  segmentSlope: number | null;
}
interface GuidedRun {
  startedById: string;
  startedByName: string;
  limits: PhLimits;
  limitsVersion: number | null;
  deviceSlope: number | null;
  deviceOffset: number | null;
  timerSeconds?: number;
  points: RunPoint[];
  evaluation: { result: PhResult; points: { slot: number; deviation: number | null; deviationOutcome: "PASS" | "FAIL" }[]; outcome: "PASS" | "WARNING" | "FAIL" } | null;
  saveProblem: string | null;
}
interface CalSettings {
  pointCount: 3 | 5;
  timerSeconds: number;
  requireStable: boolean;
  buffers: Record<number, number>;
}
interface GuidedData {
  settings: CalSettings;
  checks: PreCheck[];
  run: GuidedRun | null;
  inForce: { version: number | null; limits: PhLimits };
}


const alarmSound = () => {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.frequency.value = 880;
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => void ctx.close();
  } catch {
    // Sound is an extra; the dialog carries the alarm.
  }
};

interface AlertRow {
  id: number;
  deviceId: string;
  deviceCode: string;
  code: string;
  severity: "WARNING" | "CRITICAL";
  message: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  raisedAt: string;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
}

/** Shows an unacknowledged range alarm on every pH screen. */
function AlarmWatcher({ principal }: { principal: Principal }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [alert, setAlert] = useState<AlertRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const announced = useRef<number | null>(null);
  const canAct = principal.permissions.includes("ph.measure");

  useEffect(() => {
    const load = () =>
      mod<AlertRow[]>("/alerts/active")
        .then((rows) => setAlert(rows[0] ?? null))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (alert && !d.open) d.showModal();
    if (!alert && d.open) d.close();
    if (alert && announced.current !== alert.id) {
      announced.current = alert.id;
      alarmSound();
    }
  }, [alert]);

  async function run(path: string, body: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      await mod(path, send(body));
      setAlert(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} onCancel={(e) => e.preventDefault()} aria-labelledby="ph-alarm-title" className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-[1.375rem] border border-line p-0 shadow-2xl backdrop:bg-navy/40">
      {alert && (
        <div className="space-y-4 p-6">
          <h2 id="ph-alarm-title" className="text-lg font-bold text-fail">pH alarm · {alert.deviceCode}</h2>
          <p>{alert.message}</p>
          <p className="text-sm text-muted">Raised {fmtDate(alert.raisedAt)}</p>
          {error && <Callout tone="fail">{error}</Callout>}
          {canAct ? (
            <div className="flex flex-wrap justify-end gap-3">
              <button className={secondary} disabled={busy} onClick={() => void run(`/instruments/${alert.deviceId}/alarm/stop`)}>Stop monitoring</button>
              <button className={primary} disabled={busy} autoFocus onClick={() => void run(`/alerts/${alert.id}/acknowledge`)}>Acknowledge</button>
            </div>
          ) : (
            <p className="text-sm text-muted">Someone with measuring access needs to acknowledge this alarm.</p>
          )}
        </div>
      )}
    </dialog>
  );
}

const ALERT_STATUS: Record<AlertRow["status"], Tone> = { OPEN: "fail", ACKNOWLEDGED: "warn", RESOLVED: "pass" };

function AlertsPage({ principal, web, deviceId }: { principal: Principal; web: string; deviceId?: string }) {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: AlertRow[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<AlertRow | null>(null);
  const [comment, setComment] = useState("");
  const canAct = principal.permissions.includes("ph.measure");

  const load = useCallback(() => {
    mod<{ rows: AlertRow[]; total: number }>(`/alerts?page=${page}${status ? `&status=${status}` : ""}${deviceId ? `&device=${deviceId}` : ""}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: HttpError) => {
        if (e.status === 401) location.href = `${web}/login/?reason=session`;
        else setError(e.message);
      });
  }, [page, status, web, deviceId]);
  useEffect(() => {
    load();
  }, [load]);

  async function act(path: string, body: unknown = {}) {
    try {
      await mod(path, send(body));
      setResolving(null);
      setComment("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const lastPage = Math.max(1, Math.ceil((data?.total ?? 0) / 50));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted">Alerts are permanent records. Each stays open until it is resolved, and a repeat of an open alert does not create another.</p>
        <label className="text-sm font-semibold">
          Status{" "}
          <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} className="rounded-xl border border-line bg-white px-3 py-2 font-normal">
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
            <option value="RESOLVED">Resolved</option>
          </select>
        </label>
      </div>
      {error && <Callout tone="fail">{error}</Callout>}
      {resolving && (
        <section className={`${card} space-y-3`} aria-label="Resolve alert">
          <h3 className="font-bold">Resolve {resolving.code} on {resolving.deviceCode}</h3>
          <label className="block text-sm font-semibold">
            What was done
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} className={field} />
          </label>
          <div className="flex justify-end gap-3">
            <button className={secondary} onClick={() => setResolving(null)}>Cancel</button>
            <button className={primary} onClick={() => void act(`/alerts/${resolving.id}/resolve`, { comment })}>Resolve</button>
          </div>
        </section>
      )}
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              {["Raised", "Instrument", "Severity", "Alert", "Status", "Handled by", ""].map((h) => (
                <th key={h} className="px-4 py-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.rows.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap px-4 py-2.5">{fmtDate(a.raisedAt)}</td>
                <td className="px-4 py-2.5">{a.deviceCode}</td>
                <td className="px-4 py-2.5"><Badge tone={a.severity === "CRITICAL" ? "fail" : "warn"}>{a.severity}</Badge></td>
                <td className="px-4 py-2.5">
                  {a.message}
                  <span className="block font-mono text-xs text-muted">{a.code}</span>
                  {a.resolution && <span className="block text-xs text-muted">{a.resolution}</span>}
                </td>
                <td className="px-4 py-2.5"><Badge tone={ALERT_STATUS[a.status]}>{a.status}</Badge></td>
                <td className="px-4 py-2.5">{a.resolvedBy ?? a.acknowledgedBy ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  {canAct && a.status === "OPEN" && <button className="font-semibold text-brand hover:underline" onClick={() => void act(`/alerts/${a.id}/acknowledge`)}>Acknowledge</button>}
                  {canAct && a.status !== "RESOLVED" && a.code !== "PH-ALARM-LIMIT-BREACH" && <button className="ml-3 font-semibold text-brand hover:underline" onClick={() => setResolving(a)}>Resolve</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No alerts.</p>}
      </div>
      {data && data.total > 50 && (
        <nav className="flex items-center justify-end gap-2" aria-label="Alert pages">
          <button className={secondary} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="px-2 text-sm text-muted">Page {page} of {lastPage}</span>
          <button className={secondary} disabled={page === lastPage} onClick={() => setPage(page + 1)}>Next</button>
        </nav>
      )}
    </div>
  );
}

async function downloadFile(path: string) {
  const res = await fetch(`/api/modules/ph/api${path}`, { credentials: "include", cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "The export failed.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "nxgen-ph-export";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface CalibrationRow {
  id: string;
  code: string;
  deviceId: string;
  deviceCode: string;
  performedAt: string;
  performedBy: string;
  outcome: string;
  state: Workflow["state"];
  slopePercent: number | null;
  offsetMv: number | null;
  temperatureC: number | null;
  readings: { bufferPh: number; mv: number }[];
  dataSource: string;
  limitsVersion: number | null;
  limits: PhLimits | null;
  rSquared: number | null;
  slopeOutcome: string | null;
  offsetOutcome: string | null;
  points: RunPoint[];
  deviations: { slot: number; deviation: number | null; deviationOutcome: "PASS" | "FAIL" }[];
}

function CalibrationsPage({ device, web }: { device: string | null; web: string }) {
  const [draft, setDraft] = useState({ outcome: "", from: "", to: "" });
  const [applied, setApplied] = useState(draft);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: CalibrationRow[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const query = useCallback(() => {
    const q = new URLSearchParams();
    if (device) q.set("device", device);
    if (applied.outcome) q.set("outcome", applied.outcome);
    if (applied.from) q.set("from", new Date(`${applied.from}T00:00:00`).toISOString());
    if (applied.to) {
      const end = new Date(`${applied.to}T00:00:00`);
      end.setDate(end.getDate() + 1);
      q.set("to", end.toISOString());
    }
    return q;
  }, [device, applied]);

  useEffect(() => {
    const q = query();
    q.set("page", String(page));
    mod<{ rows: CalibrationRow[]; total: number }>(`/calibrations?${q}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: HttpError) => {
        if (e.status === 401) location.href = `${web}/login/?reason=session`;
        else setError(e.message);
      });
  }, [query, page, web]);

  async function download(key: string, path: string) {
    setBusy(key);
    setError(null);
    try {
      await downloadFile(path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const lastPage = Math.max(1, Math.ceil((data?.total ?? 0) / 25));
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied({ ...draft });
        }}
      >
        <label className="text-sm font-semibold">
          Result
          <select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })} className={field}>
            <option value="">All</option>
            <option value="PASS">Pass</option>
            <option value="WARNING">Warning</option>
            <option value="FAIL">Fail</option>
          </select>
        </label>
        <label className="text-sm font-semibold">
          From
          <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} className={field} />
        </label>
        <label className="text-sm font-semibold">
          To
          <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} className={field} />
        </label>
        <button className={primary}>Apply filters</button>
        <span className="flex-1" />
        <button type="button" className={secondary} disabled={busy !== null || !data?.total} onClick={() => void download("csv", `/calibrations/export?${query()}`)}>
          {busy === "csv" ? "Exporting…" : "Export CSV"}
        </button>
      </form>
      {error && <Callout tone="fail">{error}</Callout>}
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              {["Report", "Instrument", "Performed", "By", "Result", "Status", "Slope %", "Offset mV", ""].map((h) => (
                <th key={h} className="px-4 py-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 font-mono text-xs">
                  <a className="font-semibold text-brand hover:underline" href={`${web}/devices/view/?calibration=${r.id}`}>{r.code}</a>
                  {r.dataSource === "SIMULATED" && <span className="ml-2 font-sans"><Badge tone="warn">SIMULATED</Badge></span>}
                </td>
                <td className="px-4 py-2.5">{r.deviceCode}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{fmtDate(r.performedAt)}</td>
                <td className="px-4 py-2.5">{r.performedBy}</td>
                <td className="px-4 py-2.5"><Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge></td>
                <td className="px-4 py-2.5"><Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge></td>
                <td className="px-4 py-2.5 font-mono tabular-nums">{fmt(r.slopePercent)}</td>
                <td className="px-4 py-2.5 font-mono tabular-nums">{fmt(r.offsetMv)}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <button className="font-semibold text-brand hover:underline disabled:text-muted" disabled={busy !== null} onClick={() => void download(r.id, `/instruments/${r.deviceId}/calibrations/${r.id}/report`)}>
                    {busy === r.id ? "Preparing…" : "PDF report"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No calibrations match.</p>}
      </div>
      {data && data.total > 25 && (
        <nav className="flex items-center justify-end gap-2" aria-label="Calibration pages">
          <button className={secondary} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="px-2 text-sm text-muted">Page {page} of {lastPage}</span>
          <button className={secondary} disabled={page === lastPage} onClick={() => setPage(page + 1)}>Next</button>
        </nav>
      )}
    </div>
  );
}

function MeterSettings({ deviceId }: { deviceId: string }) {
  const [thermistor, setThermistor] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "pass" | "fail"; text: string } | null>(null);

  async function sendSettings() {
    setBusy(true);
    setMessage(null);
    try {
      await mod(`/instruments/${deviceId}/meter-settings`, send({ thermistor: thermistor || undefined, atcReferenceC: reference.trim() === "" ? undefined : Number(reference) }));
      setMessage({ tone: "pass", text: "Sent to the meter. The meter does not confirm these settings." });
    } catch (e) {
      setMessage({ tone: "fail", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-line bg-canvas/50 p-4">
      <h3 className="text-sm font-bold">Settings on the meter</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-semibold">
          Thermistor type
          <select value={thermistor} onChange={(e) => setThermistor(e.target.value)} className={field}>
            <option value="">No change</option>
            <option value="NTC">NTC</option>
            <option value="PTC">PTC</option>
          </select>
        </label>
        <label className="text-sm font-semibold">
          ATC reference (°C)
          <input inputMode="decimal" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="No change" className={`${field} w-36 font-mono`} />
        </label>
        <button className={secondary} disabled={busy || (!thermistor && reference.trim() === "")} onClick={() => void sendSettings()}>Send to meter</button>
      </div>
      {message && <Callout tone={message.tone}>{message.text}</Callout>}
    </div>
  );
}

const HEALTH: Record<string, { label: string; tone: Tone }> = {
  GOOD: { label: "GOOD", tone: "pass" },
  WARNING: { label: "WARNING", tone: "warn" },
  REPLACEMENT_RECOMMENDED: { label: "REPLACEMENT RECOMMENDED", tone: "warn" },
  CRITICAL: { label: "CRITICAL", tone: "fail" },
  NOT_CONNECTED: { label: "NOT CONNECTED", tone: "fail" },
  UNAUTHORIZED: { label: "NOT AUTHORIZED", tone: "fail" },
  NOT_CONFIGURED: { label: "NOT CONFIGURED", tone: "muted" },
};
interface ProbeRow {
  id: string;
  code: string;
  type: string;
  name: string;
  status: "ACTIVE" | "BLOCKED" | "INACTIVE" | "RETIRED";
  statusReason: string;
  deviceId: string | null;
  deviceCode: string | null;
  temperatureSensorId: string | null;
}
interface ProbeHealthView {
  probe: { id: string; code: string; type: string; status: string; temperatureSensorId: string } | null;
  health: { status: string; reasons: string[]; stability: string; drift: number | null; repeatedFailures: number; usageCount: number; replacement: string };
  latest: { slopePercent: number | null; offsetMv: number | null } | null;
}

const PROBE_TONE: Record<ProbeRow["status"], Tone> = { ACTIVE: "pass", BLOCKED: "fail", INACTIVE: "muted", RETIRED: "muted" };

function ProbesPage({ principal, web }: { principal: Principal; web: string }) {
  const [rows, setRows] = useState<ProbeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string | null; code: string; type: string; name: string; status: ProbeRow["status"]; reason: string } | null>(null);
  const canManage = principal.permissions.includes("ph.probes");

  const load = useCallback(() => {
    mod<ProbeRow[]>("/probes")
      .then(setRows)
      .catch((e: HttpError) => {
        if (e.status === 401) location.href = `${web}/login/?reason=session`;
        else setError(e.message);
      });
  }, [web]);
  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!form) return;
    setError(null);
    try {
      const { id, ...body } = form;
      await mod(id ? `/probes/${id}` : "/probes", send(body, id ? "PUT" : "POST"));
      setForm(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!rows) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted">A guided calibration needs an active probe assigned to the instrument. Assign probes on each instrument's page.</p>
        {canManage && !form && <button className={primary} onClick={() => setForm({ id: null, code: "", type: "", name: "", status: "ACTIVE", reason: "" })}>Register probe</button>}
      </div>
      {error && <Callout tone="fail">{error}</Callout>}
      {form && (
        <section className={`${card} space-y-3`} aria-label={form.id ? "Edit probe" : "Register probe"}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm font-semibold">
              Probe ID
              <input value={form.code} disabled={!!form.id} onChange={(e) => setForm({ ...form, code: e.target.value })} className={field} />
            </label>
            <label className="text-sm font-semibold">
              Probe type
              <input value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={field} />
            </label>
            <label className="text-sm font-semibold">
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} />
            </label>
            {form.id && (
              <label className="text-sm font-semibold">
                Status
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ProbeRow["status"] })} className={field}>
                  <option value="ACTIVE">Active</option>
                  <option value="BLOCKED">Blocked</option>
                  <option value="INACTIVE">Inactive</option>
                  <option value="RETIRED">Retired</option>
                </select>
              </label>
            )}
          </div>
          <label className="block text-sm font-semibold">
            Reason
            <textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={field} />
          </label>
          <div className="flex justify-end gap-3">
            <button className={secondary} onClick={() => setForm(null)}>Cancel</button>
            <button className={primary} onClick={() => void save()}>Save</button>
          </div>
        </section>
      )}
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              {["Probe ID", "Type", "Name", "Status", "Instrument", "Temperature sensor", ""].map((h) => (
                <th key={h} className="px-4 py-3">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-2.5 font-mono text-xs">{p.code}</td>
                <td className="px-4 py-2.5">{p.type || "—"}</td>
                <td className="px-4 py-2.5">{p.name || "—"}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={PROBE_TONE[p.status]}>{p.status}</Badge>
                  {p.status !== "ACTIVE" && p.statusReason && <span className="mt-1 block text-xs text-muted">{p.statusReason}</span>}
                </td>
                <td className="px-4 py-2.5">{p.deviceId ? <a className="font-semibold text-brand hover:underline" href={`/modules/ph/?device=${p.deviceId}`}>{p.deviceCode ?? "Open"}</a> : "—"}</td>
                <td className="px-4 py-2.5">{p.temperatureSensorId ?? "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  {canManage && p.status !== "RETIRED" && <button className="font-semibold text-brand hover:underline" onClick={() => setForm({ id: p.id, code: p.code, type: p.type, name: p.name, status: p.status, reason: "" })}>Edit</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No probes registered yet.</p>}
      </div>
    </div>
  );
}

function AcceptanceLimits({ principal, web }: { principal: Principal; web: string }) {
  const [data, setData] = useState<LimitsData | null>(null);
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Record<keyof PhLimits, string> | null>(null);
  const [reason, setReason] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step | null>(null);

  const canEdit = principal.permissions.includes("ph.limits");
  const canSeeSteps = canEdit || principal.permissions.includes("ph.approve");

  const load = useCallback(async () => {
    try {
      const d = await mod<LimitsData>("/acceptance-limits");
      setData(d);
      const open = d.versions.find((v) => v.workflow && ["DRAFT", "IN_REVIEW", "REVIEWED"].includes(v.workflow.state));
      setWf(open?.workflow && canSeeSteps ? await api<WorkflowDetail>(`/workflow/instances/${open.workflow.id}`) : null);
    } catch (e) {
      if ((e as HttpError).status === 401) location.href = `${web}/login/?reason=session`;
      else setError((e as Error).message);
    }
  }, [web, canSeeSteps]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!data) return <p className="text-muted">Loading…</p>;
  const open = data.versions.find((v) => v.workflow && ["DRAFT", "IN_REVIEW", "REVIEWED"].includes(v.workflow.state)) ?? null;
  const editingDraft = !!open && open.workflow!.state === "DRAFT" && open.preparedById === principal.userId;
  const canStart = canEdit && (!open || editingDraft);

  function startEditing() {
    const from = editingDraft ? open!.limits : data!.inForce.limits;
    setForm(Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(from[f.key])])) as Record<keyof PhLimits, string>);
    setReason(editingDraft ? open!.reason : "");
    setProblems([]);
    setNotice(null);
  }

  async function save() {
    const limits = parseLimits(form);
    const found = validateLimits(limits);
    if (reason.trim().length < 10) found.push("Enter the reason for this change (at least 10 characters).");
    setProblems(found);
    if (found.length) return;
    setBusy(true);
    try {
      if (editingDraft) await mod(`/acceptance-limits/${open!.id}`, send({ limits, reason }, "PUT"));
      else await mod("/acceptance-limits", send({ limits, reason }));
      setForm(null);
      await load();
      setNotice("Saved as a draft. These limits apply only after they are approved.");
    } catch (e) {
      setProblems([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  async function sign(comment: string, password: string) {
    const ui = STEP_UI[step!];
    await api(`/workflow/instances/${wf!.instance.id}/${step!.toLowerCase()}`, send({ reason: comment, signature: ui.meaning ? { username: principal.username, password } : undefined }));
    const done = step!;
    await load();
    setStep(null);
    setNotice({ SUBMIT: "Submitted for approval and locked.", WITHDRAW: "Withdrawn to draft.", REVIEW: "Signed as reviewed.", APPROVE: "Approved. These limits are now in force.", REJECT: "Rejected.", INVALIDATE: "Invalidated." }[done]);
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        These limits grade every pH calibration. A change takes effect only after someone other than its author approves it. Calibrations already recorded keep the limits they were judged by.
      </p>
      {notice && <Callout tone="pass">{notice}</Callout>}

      <section className={card} aria-label="Limits in force">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold">In force: {data.inForce.version === null ? "built-in defaults" : `version ${data.inForce.version}`}</h3>
            <p className="mt-1 text-sm">{limitsText(data.inForce.limits)}</p>
          </div>
          {canStart && !form && (
            <button className={secondary} onClick={startEditing}>
              {editingDraft ? `Edit draft version ${open!.version}` : "Change limits"}
            </button>
          )}
        </div>
      </section>

      {form && (
        <section className={`${card} space-y-4`} aria-label="Edit limits">
          <h3 className="font-bold">{editingDraft ? `Edit draft version ${open!.version}` : `New version ${(data.versions[0]?.version ?? 0) + 1}`}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LIMIT_FIELDS.map((f) => (
              <label key={f.key} className="text-sm font-semibold">
                {f.label} ({f.unit})
                <input inputMode="decimal" value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} className={`${field} font-mono`} />
              </label>
            ))}
          </div>
          <label className="block text-sm font-semibold">
            Reason for the change
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Aligned with SOP QC-114 revision 3" className={field} />
          </label>
          {problems.length > 0 && <Callout tone="fail">{problems.join(" ")}</Callout>}
          <div className="flex justify-end gap-3">
            <button className={secondary} onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </button>
            <button className={primary} onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save as draft"}
            </button>
          </div>
        </section>
      )}

      {open && (
        <section className={`${card} space-y-3`} aria-label="Version in progress">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold">Version {open.version} in progress</h3>
            <Badge tone={STATE[open.workflow!.state].tone}>{STATE[open.workflow!.state].label}</Badge>
          </div>
          <p className="text-sm">{limitsText(open.limits)}</p>
          <p className="text-sm text-muted">
            Prepared by {open.workflow!.preparedBy?.name ?? "—"} · {open.reason}
          </p>
          {wf && wf.allowedSteps.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {wf.allowedSteps.map((s) => (
                <button key={s} className={STEP_UI[s].tone === "primary" ? primary : secondary} onClick={() => setStep(s)}>
                  {STEP_UI[s].label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="overflow-x-auto rounded-lg border border-line bg-white" aria-label="Version history">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Limits</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Prepared by</th>
              <th className="px-4 py-3">Approved by</th>
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.versions.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-3 font-mono">{v.version}</td>
                <td className="px-4 py-3">{limitsText(v.limits)}</td>
                <td className="px-4 py-3">{v.workflow && <Badge tone={STATE[v.workflow.state].tone}>{STATE[v.workflow.state].label}</Badge>}</td>
                <td className="px-4 py-3">{v.workflow?.preparedBy?.name ?? "—"}</td>
                <td className="px-4 py-3">{v.workflow?.approvedBy?.name ?? "—"}</td>
                <td className="px-4 py-3 text-muted">{v.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.versions.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No versions yet. The built-in defaults are in force.</p>}
      </section>
      <StepDialog step={step} principal={principal} subject="acceptance limits" onClose={() => setStep(null)} onSign={sign} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Device console, laid out like the NxGen Sense (LabApp) pH screens
// ---------------------------------------------------------------------------

const baseBtn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const btnGreen = `${baseBtn} bg-[#10B981] text-white hover:bg-[#0EA371]`;
const btnPurple = `${baseBtn} bg-[#5D5FEF] text-white hover:bg-[#4B4DDB]`;
const btnRed = `${baseBtn} bg-[#EF4444] text-white hover:bg-[#DC2626]`;
const btnRedOutline = `${baseBtn} border border-[#FCA5A5] bg-white text-[#DC2626] hover:bg-[#FEF2F2]`;
const btnGray = `${baseBtn} border border-[#E2E8F0] bg-white text-[#33415C] hover:bg-[#F8FAFD]`;
const eyebrow = "text-[11px] font-bold uppercase tracking-wide text-[#64748B]";
const panel = "rounded-xl border border-[#E5EAF2] bg-white";
const pageTitle = "text-xl font-extrabold text-[#071847]";

type Tab = "overview" | "calibrate" | "logs" | "trends" | "alarms";
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "overview", icon: "⌂", label: "Overview" },
  { id: "calibrate", icon: "⚗", label: "Calibrate" },
  { id: "logs", icon: "▤", label: "Logs" },
  { id: "trends", icon: "⌁", label: "Trends" },
  { id: "alarms", icon: "🔔", label: "Alarms" },
];

interface LiveData {
  device: Device;
  live: Live | null;
  limits: PhLimits;
  limitsVersion: number | null;
  stabilityRule: StabilityRule;
}
const LiveContext = createContext<{ data: LiveData | null; error: string | null; reload: () => Promise<void> }>({ data: null, error: null, reload: async () => undefined });

function useLivePoll(id: string | null, web: string) {
  const [data, setData] = useState<LiveData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!id) return;
    return mod<LiveData>(`/instruments/${id}/live`)
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
    reload();
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [reload]);
  return { data, error, reload };
}

function Modal({ open, title, onClose, wide, children }: { open: boolean; title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className={`m-auto rounded-2xl border border-line p-0 shadow-2xl backdrop:bg-navy/35 ${wide ? "w-[min(44rem,calc(100vw-2rem))]" : "w-[min(30rem,calc(100vw-2rem))]"}`}>
      {open && (
        <div className="space-y-4 p-6">
          <h2 className="text-lg font-bold text-[#071847]">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

type Connection = { text: string; color: string; signal: string };
const connectionOf = (data: LiveData | null, connecting: boolean): Connection =>
  connecting
    ? { text: "Connecting…", color: "#D97706", signal: "Connecting" }
    : !data?.live
      ? { text: "Disconnected", color: "#EF4444", signal: "Offline" }
      : data.live.online
        ? { text: "Connected", color: "#10B981", signal: "Strong" }
        : { text: "Waiting for device", color: "#D97706", signal: "Waiting for data" };

const hms = (totalSeconds: number) => {
  const s = Math.max(0, Math.floor(totalSeconds));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};

/** The app's sidebar session clock: time left of the whole session, against its full length. */
function SessionClock({ principal }: { principal: Principal }) {
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
  const end = maxExpiresAt ?? (principal.session ? Date.parse(principal.session.expiresAt) : null);
  if (!end) return null;
  const started = principal.session?.startedAt ? Date.parse(principal.session.startedAt) : null;
  const expires = principal.session ? Date.parse(principal.session.expiresAt) : null;
  const total = started !== null && expires !== null ? (expires - started) / 1000 : null;
  const left = (end - Date.now()) / 1000;
  return (
    <p role="timer" aria-label="Time left in this session" className="rounded-2xl bg-[#0B1B4A] px-3 py-2 text-center text-xs leading-snug font-bold text-white tabular-nums">
      Session {hms(left)}
      {total !== null && total > 0 && <> /<br />{hms(total)}</>}
    </p>
  );
}

const roleLabel = (p: Principal) => {
  const r = p.roles?.[0];
  if (!r) return "User";
  return r
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

/** The app's pH screen shell: white sidebar with the five tabs, device status and the signed-in user. */
function Shell({ web, principal, deviceId, tab, onTab, children }: { web: string; principal: Principal; deviceId: string; tab: Tab; onTab: (t: Tab) => void; children: React.ReactNode }) {
  const poll = useLivePoll(deviceId, web);
  const [connecting, setConnecting] = useState(false);
  const conn = connectionOf(poll.data, connecting);
  const navItem = (active: boolean) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold ${active ? "bg-[#5D5FEF] text-white shadow-sm" : "text-[#64748B] hover:bg-[#F1F5F9]"}`;
  const battery = poll.data?.live?.values.BATTERY;
  const device = poll.data?.device;

  async function reconnect() {
    setConnecting(true);
    try {
      await Promise.all([poll.reload(), new Promise((r) => setTimeout(r, 800))]);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <LiveContext.Provider value={poll}>
      <div className="min-h-screen bg-[#F4F6F9] lg:flex">
        <aside className="border-b border-[#E2E8F0] bg-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[14rem] lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0">
          <div className="flex items-center gap-2 px-4 pt-5 pb-3">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-[#C7D2FE] bg-[#EEF0FF] text-[#5D5FEF]" aria-hidden>⚗</span>
            <span className="font-extrabold text-[#0F172A]">pH Calibration</span>
          </div>
          <div className="mx-4 mb-2 border-t border-[#F1F5F9]" />
          <div className="px-3 pb-3">
            <a href="/modules/ph/" className="block rounded-2xl border border-[#E2E8F0] bg-[#F1F5F9] px-3 py-2.5 text-xs font-bold text-[#334155] hover:bg-[#E2E8F0]">
              ‹&nbsp; Back to Dashboard
            </a>
          </div>
          <nav aria-label="Device" className="flex flex-wrap gap-1 px-3 lg:flex-nowrap lg:flex-col">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <a
                  key={t.id}
                  href={`/modules/ph/?device=${deviceId}&tab=${t.id}`}
                  aria-current={active ? "page" : undefined}
                  className={navItem(active)}
                  onClick={(e) => {
                    e.preventDefault();
                    onTab(t.id);
                  }}
                >
                  <span aria-hidden className="w-5 text-center">{t.icon}</span>
                  {t.label}
                </a>
              );
            })}
          </nav>
          <div className="mt-auto space-y-2 p-3">
            <SessionClock principal={principal} />
            <div className="flex items-center gap-2.5 rounded-2xl border border-[#E2E8F0] bg-[#F1F5F9] px-3 py-2.5">
              <img src={phDeviceImage} alt="" className="h-12 w-auto shrink-0" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold tracking-wide text-[#94A3B8] uppercase">Device{device?.deviceIdentifier ? ` · ${device.deviceIdentifier}` : ""}</p>
                <p className="truncate text-sm font-bold" style={{ color: conn.color }}>{conn.text}</p>
                <p className="truncate text-xs text-[#64748B]">📶 Signal: {conn.signal}</p>
                {typeof battery === "number" && poll.data?.live?.online && <p className="text-xs text-[#64748B]">🔋 Battery: {Math.round(battery)} %</p>}
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-2xl border border-[#C7D2FE] bg-[#EEF0FF] px-3 py-2.5">
              <span aria-hidden className="text-lg">👤</span>
              <div className="min-w-0">
                <p className="text-[10px] font-bold tracking-wide text-[#64748B] uppercase">Signed in</p>
                <p className="truncate text-sm font-bold text-[#0F172A]" title={principal.username}>{principal.fullName}</p>
                <p className="truncate text-xs font-bold text-[#5D5FEF]">{roleLabel(principal)}</p>
              </div>
            </div>
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <SessionBanner />
          <AlarmWatcher principal={principal} />
          <header className="flex flex-wrap items-center justify-end gap-2 border-b border-[#E2E8F0] bg-white px-5 py-3">
            {poll.data?.live?.simulated && <Badge tone="warn">SIMULATED</Badge>}
            <span className="sr-only">{device ? `${device.code} · ${device.name}` : "pH Calibration"}</span>
            <span role="status" className="rounded-full border px-3.5 py-1.5 text-sm font-bold" style={{ color: conn.color, borderColor: `${conn.color}55`, background: "#F0FDF4" }}>
              ●&nbsp; {connecting ? "Connecting" : conn.text}
            </span>
            <button
              type="button"
              disabled={connecting}
              onClick={() => void reconnect()}
              title="Check the connection to this meter again"
              className="rounded-xl border border-[#FCA5A5] bg-white px-3.5 py-1.5 text-sm font-bold text-[#EF4444] hover:bg-[#FEF2F2] disabled:opacity-50"
            >
              ↻&nbsp; {connecting ? "Connecting…" : "Reconnect"}
            </button>
          </header>
          <main className="max-w-[90rem] p-4 sm:p-5">{children}</main>
        </div>
      </div>
    </LiveContext.Provider>
  );
}

// --- Device list -----------------------------------------------------------

const EMPTY_DEVICE = { name: "", deviceIdentifier: "", manufacturer: "", model: "", serialNumber: "", location: "", probeCode: "", probeType: "", temperatureSensorId: "", pointCount: "5", reason: "", password: "" };

/** Registers a pH meter in the core and, in one go, sets up what the app's device form asks for. */
function AddDevice({ principal, open, onClose, onAdded }: { principal: Principal; open: boolean; onClose: () => void; onAdded: (result: { id: string; warning: string | null }) => void }) {
  const [form, setForm] = useState(EMPTY_DEVICE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canProbe = principal.permissions.includes("ph.probes");
  const canMode = principal.permissions.includes("ph.limits");

  function problem(): string | null {
    if (form.name.trim().length < 2) return "Enter the device name.";
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(form.deviceIdentifier.trim())) return "Enter the DEVICE_ID exactly as the meter sends it (letters, numbers, _ . : -).";
    if (!form.manufacturer.trim()) return "Enter the manufacturer.";
    if (!form.model.trim()) return "Enter the model.";
    if (!form.serialNumber.trim()) return "Enter the serial number from the label.";
    if (canProbe && !form.probeCode.trim()) return "Enter the probe ID.";
    if (canProbe && !form.temperatureSensorId.trim()) return "Enter the temperature sensor ID.";
    if (form.reason.trim().length < 10) return "Enter the reason (at least 10 characters).";
    if (!form.password) return "Enter your password to sign.";
    return null;
  }

  /** The device exists by now; anything failing here is reported but does not undo it. */
  async function finishSetup(id: string, reason: string): Promise<string | null> {
    const missed: string[] = [];
    if (canProbe) {
      try {
        const code = form.probeCode.trim();
        const existing = (await mod<ProbeRow[]>("/probes")).find((p) => p.code === code);
        const probeId = existing?.id ?? (await mod<{ id: string }>("/probes", send({ code, type: form.probeType.trim(), reason }))).id;
        await mod(`/instruments/${id}/probe`, send({ probeId, temperatureSensorId: form.temperatureSensorId.trim(), reason }, "PUT"));
      } catch (e) {
        missed.push(`The probe was not assigned: ${(e as Error).message}`);
      }
    }
    if (canMode && form.pointCount === "3") {
      try {
        const { settings } = await mod<{ settings: CalSettings }>(`/instruments/${id}/guided-calibration`);
        await mod(`/instruments/${id}/calibration-settings`, send({ reason, settings: { ...settings, pointCount: 3 } }, "PUT"));
      } catch (e) {
        missed.push(`The calibration mode was not set: ${(e as Error).message}`);
      }
    }
    return missed.length ? missed.join(" ") : null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = problem();
    setError(found);
    if (found) return;
    setBusy(true);
    try {
      const reason = form.reason.trim();
      const created = await api<{ id: string }>(
        "/devices",
        send({
          instrumentType: "PH",
          name: form.name.trim(),
          deviceIdentifier: form.deviceIdentifier.trim(),
          manufacturer: form.manufacturer.trim(),
          model: form.model.trim(),
          serialNumber: form.serialNumber.trim(),
          location: form.location.trim(),
          reason,
          signature: { username: principal.username, password: form.password },
        }),
      );
      const warning = await finishSetup(created.id, reason);
      setForm(EMPTY_DEVICE);
      onAdded({ id: created.id, warning });
    } catch (err) {
      setForm((f) => ({ ...f, password: "" }));
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const text = (key: keyof typeof EMPTY_DEVICE, label: string, placeholder?: string) => (
    <label className="text-sm font-semibold">
      {label}
      <input aria-label={label} value={form[key]} placeholder={placeholder} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={field} />
    </label>
  );
  return (
    <Modal open={open} title="Add Device" wide onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {text("name", "Device Name", "e.g. pH meter QC-2")}
          {text("deviceIdentifier", "Device ID (DEVICE_ID)", "e.g. CSPL003")}
          {text("manufacturer", "Manufacturer")}
          {text("model", "Device Model")}
          {text("serialNumber", "Serial Number")}
          {text("location", "Device Location (optional)")}
          {canProbe && text("probeCode", "Probe ID")}
          {canProbe && text("probeType", "Probe Type (optional)")}
          {canProbe && text("temperatureSensorId", "Temperature Sensor ID")}
          {canMode && (
            <label className="text-sm font-semibold">
              Calibration Mode
              <select aria-label="Calibration Mode" value={form.pointCount} onChange={(e) => setForm({ ...form, pointCount: e.target.value })} className={field}>
                <option value="5">5-Point</option>
                <option value="3">3-Point</option>
              </select>
            </label>
          )}
        </div>
        <label className="block text-sm font-semibold">
          Reason
          <textarea aria-label="Reason" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. New pH meter for QC Lab 2" className={field} />
        </label>
        <fieldset className="space-y-2 rounded-xl border border-brand/30 bg-brand-50 p-4">
          <legend className="px-1 text-sm font-semibold text-brand-700">Electronic signature</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold">
              Username
              <input value={principal.username} readOnly className={`${field} bg-canvas`} />
            </label>
            <label className="text-sm font-semibold">
              Password
              <input aria-label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" className={field} />
            </label>
          </div>
        </fieldset>
        {error && <Callout tone="fail">{error}</Callout>}
        <div className="flex justify-end gap-3">
          <button type="button" className={btnGray} disabled={busy} onClick={onClose}>Cancel</button>
          <button className={btnPurple} disabled={busy}>{busy ? "Adding…" : "Sign & Add Device"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Workspace: Dashboard and Devices, laid out like the NxGen Sense dashboard
// ---------------------------------------------------------------------------

interface DashboardCalibration {
  id: string;
  code: string;
  performedAt: string;
  performedBy: string;
  outcome: string;
  state: Workflow["state"];
  slopePercent: number | null;
  offsetMv: number | null;
  pointCount: number;
  guided: boolean;
}
interface DashboardDevice extends DashboardRowLike {
  id: string;
  manufacturer: string;
  status: string;
  readiness: Readiness;
  simulated: boolean;
  lastSeenAt: string | null;
  charging: boolean;
  meterStatus: string | null;
  probeConnected: boolean | null;
  sensorConnected: boolean | null;
  probeType: string | null;
  probeStatus: string | null;
  calibration: DashboardCalibration | null;
}
interface DashboardData {
  generatedAt: string;
  devices: DashboardDevice[];
  summary: DashboardSummary;
  locations: string[];
}
interface DashboardState {
  data: DashboardData | null;
  error: string | null;
  refreshing: boolean;
  fetchedAt: number | null;
  refresh: () => void;
  reload: () => void;
}

/** Polls the dashboard every 5 s; the Refresh button fetches at once and is recorded on the audit trail. */
function useDashboard(web: string): DashboardState {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const load = useCallback(
    async (manual = false) => {
      if (manual) setRefreshing(true);
      try {
        const d = await (manual ? mod<DashboardData>("/dashboard/refresh", send({})) : mod<DashboardData>("/dashboard"));
        setData(d);
        setError(null);
        setFetchedAt(Date.now());
      } catch (e) {
        if ((e as HttpError).status === 401) location.href = `${web}/login/?reason=session`;
        else setError((e as Error).message);
      } finally {
        if (manual) setRefreshing(false);
      }
    },
    [web],
  );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  return { data, error, refreshing, fetchedAt, refresh: () => void load(true), reload: () => void load(false) };
}

const BUCKET_STYLE: Record<CalibrationBucket, { color: string; bg: string }> = {
  VALID: { color: "#15803D", bg: "#E6F5EC" },
  DUE_SOON: { color: "#B45309", bg: "#FFF4E5" },
  DUE: { color: "#B45309", bg: "#FFF4E5" },
  OVERDUE: { color: "#B91C1C", bg: "#FDECEC" },
  FAILED: { color: "#991B1B", bg: "#FDECEC" },
  NOT_CALIBRATED: { color: "#475569", bg: "#EEF1F5" },
  OUT_OF_SERVICE: { color: "#64748B", bg: "#EEF1F5" },
};
const pill = (color: string, bg: string) => ({ color, background: bg });

function ConnectionPill({ online, simulated }: { online: boolean; simulated?: boolean }) {
  return (
    <span className="inline-flex items-center rounded-full px-3 py-0.5 text-xs font-bold" style={online ? pill("#15803D", "#E6F5EC") : pill("#C0392B", "#FBEAEA")}>
      ● {online ? (simulated ? "Online (simulated)" : "Online") : "Offline"}
    </span>
  );
}
function CalibrationPill({ bucket }: { bucket: CalibrationBucket }) {
  const s = BUCKET_STYLE[bucket];
  return (
    <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold" style={pill(s.color, s.bg)}>
      {CALIBRATION_BUCKET_LABEL[bucket]}
    </span>
  );
}
const batteryText = (d: DashboardDevice) => (d.battery === null ? "--" : `${Math.round(d.battery)}%`);
const batteryColor = (d: DashboardDevice) => (d.batteryCondition === "CRITICAL" ? "#DC2626" : d.batteryCondition === "LOW" ? "#D97706" : d.battery === null ? "#64748B" : "#16A34A");
const fmtTime = (v: string | null) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const relativeTime = (v: string | null, now: number) => {
  if (!v) return "No activity yet";
  const s = Math.max(0, Math.round((now - Date.parse(v)) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return fmtTime(v);
};
const daysRemaining = (dueAt: string | null, now: number) => {
  if (!dueAt) return "—";
  const days = Math.ceil((Date.parse(dueAt) - now) / 86_400_000);
  return days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "Due today" : `${days} day${days === 1 ? "" : "s"}`;
};

type WorkspacePage = "dashboard" | "devices" | "connections" | "alerts" | "logs" | "measurements" | "calibrations" | "probes" | "limits";
const WORKSPACE_NAV: { id: WorkspacePage; icon: string; label: string; href: string }[] = [
  { id: "dashboard", icon: "⌂", label: "Dashboard", href: "/modules/ph/" },
  { id: "devices", icon: "⚗", label: "Devices", href: "/modules/ph/?devices=1" },
  { id: "connections", icon: "🔌", label: "Connections", href: "/modules/ph/?connections=1" },
  { id: "alerts", icon: "🔔", label: "Alerts", href: "/modules/ph/?alerts=1" },
];
const RECORDS_NAV: { id: WorkspacePage; label: string; href: string }[] = [
  { id: "measurements", label: "Measurements", href: "/modules/ph/?measurements=1" },
  { id: "calibrations", label: "Calibrations", href: "/modules/ph/?calibrations=1" },
  { id: "probes", label: "Probes", href: "/modules/ph/?probes=1" },
  { id: "limits", label: "Acceptance limits", href: "/modules/ph/?limits=1" },
];

/** The dark workspace shell of the app: sidebar, page header with Live / Refresh / last refreshed. */
function WorkspaceShell({ web, version, principal, page, title, subtitle, status, children }: { web: string; version: string; principal: Principal; page: WorkspacePage; title: string; subtitle?: string; status?: DashboardState; children: React.ReactNode }) {
  const nav = (active: boolean) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${active ? "bg-[#1769E8] text-white" : "text-[#C7D7EE] hover:bg-white/10"}`;
  const fresh = !!status?.fetchedAt && Date.now() - status.fetchedAt < 20_000 && !status.error;
  return (
    <div className="min-h-screen bg-[#F8FAFD] lg:flex">
      <aside className="bg-gradient-to-b from-[#071C3B] to-[#0B2B57] text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[14rem] lg:shrink-0 lg:flex-col lg:overflow-y-auto">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-white" aria-hidden>
            <Logo />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold">NxGen pH</p>
            <p className="text-[8px] font-bold tracking-widest text-[#89A7CE]">LAB MANAGEMENT</p>
          </div>
        </div>
        <div className="mx-4 border-t border-[#24466D]" />
        <div className="px-3 pt-3 pb-1">
          <a href={`${web}/home/`} className="block rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-[#DCEAFF] hover:bg-white/20">
            ‹&nbsp; Back to NxGen
          </a>
        </div>
        <nav aria-label="Main" className="flex flex-wrap gap-1 px-3 pb-2 lg:flex-nowrap lg:flex-col">
          <p className="hidden px-3 pt-2 pb-1 text-[8px] font-bold tracking-widest text-[#7895BA] lg:block">WORKSPACE</p>
          {WORKSPACE_NAV.map((n) => (
            <a key={n.id} href={n.href} aria-current={page === n.id ? "page" : undefined} className={nav(page === n.id)}>
              <span aria-hidden className="w-5 text-center">{n.icon}</span>
              {n.label}
            </a>
          ))}
          <p className="hidden px-3 pt-3 pb-1 text-[8px] font-bold tracking-widest text-[#7895BA] lg:block">RECORDS</p>
          {RECORDS_NAV.map((n) => (
            <a key={n.id} href={n.href} aria-current={page === n.id ? "page" : undefined} className={nav(page === n.id)}>
              <span aria-hidden className="w-5 text-center">·</span>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto space-y-2 p-3">
          <div className="rounded-xl border border-[#28527E] bg-[#16375F] px-3 py-2">
            <p className="text-[8px] font-bold tracking-widest text-[#7895BA]">SIGNED IN</p>
            <p className="truncate text-sm font-bold">{principal.fullName}</p>
            <p className="truncate text-xs text-[#9FC4FF]">{principal.username}</p>
          </div>
          <div className="rounded-xl border border-[#28527E] bg-[#16375F] px-3 py-2 text-xs">
            <p className="text-[#DCEAFF]">
              ◷&nbsp; <SessionTimer className="!text-[#DCEAFF]" />
            </p>
            <div className="my-1.5 border-t border-[#28527E]" />
            <div className="flex items-center justify-between gap-2 text-[10px] font-bold">
              <span className="text-[#5DE58A]">● SYSTEM ONLINE</span>
              <span className="text-[#9FB5D2]">Version {version}</span>
            </div>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <SessionBanner />
        <AlarmWatcher principal={principal} />
        <header className="flex flex-wrap items-center gap-3 border-b border-[#E2E8F0] bg-white px-5 py-3 sm:px-7">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-extrabold text-[#0F1F4B]">{title}</h1>
            {subtitle && <p className="text-xs text-[#475569]">{subtitle}</p>}
          </div>
          {status && (
            <>
              <span className="rounded-xl px-3 py-1.5 text-sm font-bold" style={fresh ? pill("#16A34A", "#EAF2FF") : pill("#B45309", "#FFF4E5")} aria-live="polite">
                ●&nbsp; {fresh ? "Live" : status.error ? "Not updating" : "Loading"}
              </span>
              <button className="rounded-xl border border-[#E6EAF2] bg-white px-3 py-1.5 text-sm font-bold text-[#1266E9] hover:bg-[#F8FAFD] disabled:opacity-50" disabled={status.refreshing} onClick={status.refresh}>
                ↻&nbsp; {status.refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <span className="text-xs text-[#64748B]">Last refreshed: {status.fetchedAt ? new Date(status.fetchedAt).toLocaleTimeString() : "--"}</span>
            </>
          )}
          <span className="grid h-10 w-10 place-items-center rounded-full bg-[#EAF2FF] text-sm font-bold text-[#1266E9]" aria-hidden>
            {initials(principal.fullName) || "?"}
          </span>
        </header>
        <main className="max-w-[90rem] p-4 sm:p-5">{children}</main>
      </div>
    </div>
  );
}

function WelcomeBanner({ name, now }: { name: string; now: number }) {
  const d = new Date(now);
  return (
    <section className="flex flex-wrap items-center gap-4 rounded-2xl bg-gradient-to-r from-[#EEF0FD] via-[#F3F0FF] to-[#E8F1FF] px-6 py-4" aria-label="Welcome">
      <div className="min-w-0 flex-1">
        <p className="text-xl font-extrabold text-[#0B1745]">Welcome back, {name.split(/\s+/)[0]} 👋</p>
        <p className="text-sm text-[#475569]">Here's what's happening with your lab today.</p>
      </div>
      <div className="flex items-center gap-3 rounded-xl bg-white/95 px-4 py-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#EEF0FD] text-[#5B4CD6]" aria-hidden>📅</span>
        <div className="text-xs leading-tight">
          <p className="text-[#64748B]">{d.toLocaleDateString(undefined, { weekday: "long" })}</p>
          <p className="text-sm font-semibold text-[#0F172A]">{d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>
          <p className="text-[#334155]">{d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</p>
        </div>
      </div>
    </section>
  );
}

const METRIC_STYLE = [
  { bg: "#F7FAFF", border: "#E3EAF7", tile: "#E6EEFD", icon: "🖥", color: "#2F6FE4" },
  { bg: "#F3FBF6", border: "#DCEFE3", tile: "#DDF3E6", icon: "📶", color: "#2E9960" },
  { bg: "#F8F9FB", border: "#E6EAF0", tile: "#EEF1F5", icon: "⛔", color: "#64748B" },
  { bg: "#FFF9F2", border: "#F8E6D2", tile: "#FDEBD9", icon: "📅", color: "#E0822A" },
  { bg: "#FFF6F6", border: "#F6DCDC", tile: "#FBE1E1", icon: "⚠", color: "#DC4B4B" },
];

function MetricCards({ summary }: { summary: DashboardSummary }) {
  const cards: [number, string, string][] = [
    [summary.total, "Total Devices", "Across all labs"],
    [summary.online, "Online", "Currently connected"],
    [summary.offline, "Offline", "Needs attention"],
    [summary.calibrationDue, "Calibration Due", "Due soon or overdue"],
    [summary.criticalAlerts, "Critical Alerts", "Requires action"],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Summary">
      {cards.map(([value, label, hint], i) => {
        const s = METRIC_STYLE[i];
        return (
          <div key={label} className="flex items-center gap-3 rounded-2xl border px-3 py-3" style={{ background: s.bg, borderColor: s.border }}>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg" style={{ background: s.tile, color: s.color }} aria-hidden>
              {s.icon}
            </span>
            <div className="min-w-0">
              <p className="text-xl font-bold tabular-nums text-[#0F172A]">{value}</p>
              <p className="truncate text-sm font-semibold text-[#1E293B]">{label}</p>
              <p className="truncate text-[11px] text-[#64748B]">{hint}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ value, label, hint, icon, tint }: { value: React.ReactNode; label: string; hint?: React.ReactNode; icon: string; tint: string }) {
  return (
    <div className={`${panel} flex items-center gap-3 px-4 py-3`}>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg" style={{ background: `${tint}1A`, color: tint }} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-lg font-bold tabular-nums text-[#0F172A]">{value}</p>
        <p className="truncate text-xs text-[#475569]">{label}</p>
        {hint && <p className="truncate text-[11px] font-semibold">{hint}</p>}
      </div>
    </div>
  );
}

const selectCls = "rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm";
const activeFilterCount = (f: DashboardFilter) => (["connection", "calibration", "battery", "alerts", "activity"] as const).filter((k) => f[k] !== "ALL").length + (f.sort !== "NAME" ? 1 : 0) + (f.location ? 1 : 0);

/** The app's "Filter devices" dialog. */
function FiltersDialog({ open, value, locations, onApply, onClose }: { open: boolean; value: DashboardFilter; locations: string[]; onApply: (f: DashboardFilter) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);
  const row = (label: string, node: React.ReactNode) => (
    <label className="block text-[11px] font-bold uppercase tracking-wide text-[#334155]">
      {label}
      <span className="mt-1 block font-normal normal-case tracking-normal">{node}</span>
    </label>
  );
  const sel = <K extends keyof DashboardFilter>(key: K, options: [DashboardFilter[K] & string, string][]) => (
    <select value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className={`${selectCls} w-full`}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
  return (
    <Modal open={open} title="Filter devices" onClose={onClose}>
      <p className="-mt-2 text-xs text-[#64748B]">Choose one or more filters</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {row("Connection status", sel("connection", [["ALL", "All"], ["ONLINE", "Online"], ["OFFLINE", "Offline"]]))}
        {row("Calibration", sel("calibration", [["ALL", "All"], ["ATTENTION", "Needs attention"], ["VALID", "Valid"], ["DUE_SOON", "Due soon"], ["DUE", "Due"], ["OVERDUE", "Overdue"], ["FAILED", "Failed"], ["NOT_CALIBRATED", "Not calibrated"]]))}
        {row("Battery", sel("battery", [["ALL", "All"], ["NORMAL", "Normal"], ["LOW", "Low (10–20 %)"], ["CRITICAL", "Critical (below 10 %)"], ["CHARGING", "Charging"], ["UNKNOWN", "Not reported"]]))}
        {row("Alert severity", sel("alerts", [["ALL", "All"], ["CRITICAL", "Critical open"], ["WARNING", "Warning open"], ["NONE", "No open alerts"]]))}
        {row("Activity history", sel("activity", [["ALL", "All"], ["TODAY", "Active in the last 24 h"], ["WEEK", "Active in the last 7 days"], ["INACTIVE", "Inactive for 7 days or more"]]))}
        {row("Sort by", sel("sort", [["NAME", "Device name"], ["LAST_ACTIVITY", "Last activity"], ["CALIBRATION_DUE", "Calibration due"], ["ALERTS", "Alerts"], ["BATTERY", "Battery"]]))}
        {row(
          "Location",
          <select value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} className={`${selectCls} w-full`}>
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>,
        )}
      </div>
      <div className="flex justify-end gap-3">
        <button className={btnGray} onClick={() => setDraft({ ...DEFAULT_DASHBOARD_FILTER, search: draft.search })}>Clear all</button>
        <button className={`${baseBtn} bg-[#1266E9] text-white hover:bg-[#0F55C4]`} onClick={() => { onApply(draft); onClose(); }}>Apply filters</button>
      </div>
    </Modal>
  );
}

function DeviceStatusTable({ rows, now, onDetails }: { rows: DashboardDevice[]; now: number; onDetails: (d: DashboardDevice) => void }) {
  const tile = ["#EAF1FE", "#F0EDFD"];
  const tint = ["#2F6FE4", "#7059E0"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[60rem] text-left text-sm">
        <thead className="bg-[#F3F5F9] text-xs font-semibold text-[#334155]">
          <tr>
            {["Device ID", "Location", "User", "Connection", "Battery", "Calibration", "Alerts", "Last Activity", "Actions"].map((h) => (
              <th key={h} className={`px-3 py-2 font-semibold ${h === "Alerts" || h === "Actions" ? "text-center" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#EEF1F5]">
          {rows.map((d, i) => (
            <tr key={d.id} className="cursor-pointer hover:bg-[#F8FAFD]" onClick={() => onDetails(d)}>
              <td className="px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: tile[i % 2], color: tint[i % 2] }} aria-hidden>{i % 2 ? "⚗" : "🖥"}</span>
                  <div className="min-w-0">
                    <a href={`/modules/ph/?device=${d.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-semibold text-[#0F172A] hover:underline">{d.deviceIdentifier ?? d.code}</a>
                    <p className="truncate text-[11px] text-[#64748B]">{d.name} · pH Monitor</p>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2 text-[#334155]">{d.location || "--"}</td>
              <td className="px-3 py-2 text-[#334155]">{d.currentUser ?? "--"}</td>
              <td className="px-3 py-2"><ConnectionPill online={d.online} simulated={d.simulated} /></td>
              <td className="px-3 py-2 font-semibold" style={{ color: batteryColor(d) }}>{d.battery !== null && "🔋 "}{batteryText(d)}</td>
              <td className="px-3 py-2">
                <CalibrationPill bucket={d.calibrationBucket} />
                <p className="mt-0.5 text-[11px] text-[#64748B]">Updated: {d.calibration ? fmtTime(d.calibration.performedAt) : "Not available"}</p>
              </td>
              <td className="px-3 py-2 text-center font-semibold" style={{ color: d.openAlerts ? "#DC2626" : "#475569" }}>{d.openAlerts}</td>
              <td className="px-3 py-2 text-[#334155]">{relativeTime(d.lastActivityAt, now)}</td>
              <td className="px-3 py-2 text-center">
                <button className="rounded-lg px-2 py-1 text-lg leading-none text-[#334155] hover:bg-[#EEF1F5]" aria-label={`Details for ${d.name}`} onClick={(e) => { e.stopPropagation(); onDetails(d); }}>⋮</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyDevices({ filtered, onClear, canAdd, onAdd }: { filtered: boolean; onClear: () => void; canAdd: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid h-13 w-13 place-items-center rounded-xl bg-[#EAF2FF] text-2xl font-bold text-[#1266E9]" aria-hidden>⌕</span>
      <p className="font-bold text-[#0B1745]">{filtered ? "No devices found" : "No pH devices yet"}</p>
      <p className="max-w-lg text-xs text-[#64748B]">{filtered ? "Try another search term or clear the applied filters." : canAdd ? "Register your first meter with Add Device." : "Ask an IT Administrator to register a pH meter."}</p>
      {filtered ? (
        <button className="mt-2 rounded-xl bg-[#EAF2FF] px-4 py-2 text-xs font-bold text-[#1266E9]" onClick={onClear}>Clear search &amp; filters</button>
      ) : (
        canAdd && <button className={`${btnPurple} mt-2`} onClick={onAdd}>+&nbsp; Add Device</button>
      )}
    </div>
  );
}

function DashboardPage({ principal, web, dash, onAddDevice }: { principal: Principal; web: string; dash: DashboardState; onAddDevice: () => void }) {
  const [filter, setFilter] = useState<DashboardFilter>(DEFAULT_DASHBOARD_FILTER);
  const [chip, setChip] = useState<"ALL" | "ONLINE" | "OFFLINE">("ALL");
  const [filters, setFilters] = useState(false);
  const [details, setDetails] = useState<DashboardDevice | null>(null);
  const canAdd = principal.permissions.includes("devices.manage");
  const { data, error } = dash;
  if (!data) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  const now = dash.fetchedAt ?? Date.now();
  const effective = { ...filter, connection: chip === "ALL" ? filter.connection : chip };
  const rows = filterDashboardDevices(data.devices, effective, now);
  const filtered = filter.search.trim() !== "" || activeFilterCount(filter) > 0 || chip !== "ALL";
  const clear = () => {
    setFilter(DEFAULT_DASHBOARD_FILTER);
    setChip("ALL");
  };
  const chipCls = (active: boolean) => `rounded-full px-4 py-1.5 text-sm font-semibold ${active ? "bg-[#1266E9] text-white" : "bg-[#F1F5F9] text-[#334155] hover:bg-[#E2E8F0]"}`;
  const s = data.summary;
  return (
    <div className="space-y-3">
      {error && <Callout tone="warn" title="Showing the last data received">{error}</Callout>}
      <WelcomeBanner name={principal.fullName} now={now} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-[16rem] flex-1 items-center gap-2 rounded-xl border border-[#E2E8F0] bg-white px-4 py-2">
          <span aria-hidden className="text-[#94A3B8]">⌕</span>
          <input value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} placeholder="Search device, ID, user or location…" aria-label="Search devices" className="w-full bg-transparent text-sm outline-none" />
        </label>
        {filtered && <button className="rounded-xl border border-[#F2C4C4] bg-[#FFF7F7] px-4 py-2 text-xs font-bold text-[#DC2626]" onClick={clear}>×&nbsp; Clear all</button>}
        <button className="rounded-xl border border-[#C9D7F2] bg-white px-5 py-2 text-sm font-semibold text-[#4B3FC0]" onClick={() => setFilters(true)} aria-haspopup="dialog">
          Filters&nbsp; ▾{activeFilterCount(filter) ? ` (${activeFilterCount(filter)})` : ""}
        </button>
      </div>
      <MetricCards summary={s} />
      <section className={`${panel} overflow-hidden`} aria-label="Device status">
        <div className="flex flex-wrap items-center gap-3 px-4 pt-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-[#0F172A]">Device Status</h2>
            <p className="text-xs text-[#64748B]">Monitor and manage all connected devices</p>
          </div>
          <span className="text-xs text-[#64748B]">{rows.length === data.devices.length ? `${data.devices.length} device${data.devices.length === 1 ? "" : "s"}` : `${rows.length} of ${data.devices.length} devices`}</span>
          <a href="/modules/ph/?devices=1" className="rounded-lg bg-[#F0EDFD] px-4 py-2 text-sm font-semibold text-[#4B3FC0] hover:bg-[#E6E0FB]">View all</a>
        </div>
        <div className="flex flex-wrap gap-2 px-4 py-3" role="group" aria-label="Connection">
          <button className={chipCls(chip === "ALL")} aria-pressed={chip === "ALL"} onClick={() => setChip("ALL")}>All ({s.total})</button>
          <button className={chipCls(chip === "ONLINE")} aria-pressed={chip === "ONLINE"} onClick={() => setChip("ONLINE")}>●&nbsp; Online ({s.online})</button>
          <button className={chipCls(chip === "OFFLINE")} aria-pressed={chip === "OFFLINE"} onClick={() => setChip("OFFLINE")}>●&nbsp; Offline ({s.offline})</button>
        </div>
        {rows.length ? <DeviceStatusTable rows={rows} now={now} onDetails={setDetails} /> : <EmptyDevices filtered={filtered} onClear={clear} canAdd={canAdd} onAdd={onAddDevice} />}
      </section>
      <div className="grid gap-3 lg:grid-cols-2">
        <section className={`${panel} p-4`} aria-label="Calibration summary">
          <h2 className="font-bold text-[#0F172A]">Calibration Summary</h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center sm:grid-cols-6">
            {([["Valid", s.calibration.valid, "#065F46"], ["Due soon", s.calibration.dueSoon, "#B45309"], ["Due", s.calibration.due, "#B45309"], ["Overdue", s.calibration.overdue, "#B91C1C"], ["Failed", s.calibration.failed, "#991B1B"], ["Not calibrated", s.calibration.notCalibrated, "#475569"]] as const).map(([l, v, c]) => (
              <div key={l}>
                <dd className="text-lg font-bold tabular-nums" style={{ color: c }}>{v}</dd>
                <dt className="text-[11px] text-[#6B7280]">{l}</dt>
              </div>
            ))}
          </dl>
        </section>
        <section className={`${panel} p-4`} aria-label="Battery and alerts">
          <h2 className="font-bold text-[#0F172A]">Battery &amp; Alerts</h2>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
            {([["Low battery", s.lowBattery, "#B45309"], ["Critical battery", s.criticalBattery, "#B91C1C"], ["Critical alerts", s.criticalAlerts, "#B91C1C"]] as const).map(([l, v, c]) => (
              <div key={l}>
                <dd className="text-lg font-bold tabular-nums" style={{ color: c }}>{v}</dd>
                <dt className="text-[11px] text-[#6B7280]">{l}</dt>
              </div>
            ))}
          </dl>
          <a href="/modules/ph/?alerts=1" className="mt-3 inline-block text-sm font-semibold text-brand hover:underline">View all alerts ›</a>
        </section>
      </div>
      <FiltersDialog open={filters} value={filter} locations={data.locations} onApply={setFilter} onClose={() => setFilters(false)} />
      <DeviceDetailsDialog device={details} web={web} now={now} principal={principal} onClose={() => setDetails(null)} />
    </div>
  );
}

function DeviceCard({ d, index, now, canManage, web, onDetails }: { d: DashboardDevice; index: number; now: number; canManage: boolean; web: string; onDetails: () => void }) {
  const colors = [["#2F6FE4", "#EAF1FE"], ["#7059E0", "#F0EDFD"], ["#2E9960", "#E8F6EE"], ["#1F8FA8", "#E6F4F7"]][index % 4];
  const cal = BUCKET_STYLE[d.calibrationBucket];
  const info = (label: string, value: React.ReactNode, icon: string) => (
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="text-[#64748B]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] text-[#64748B]">{label}</p>
        <p className="truncate text-sm font-semibold text-[#1E293B]">{value}</p>
      </div>
    </div>
  );
  const menuItem = "block w-full px-3 py-2 text-left text-sm font-semibold text-[#1E293B] hover:bg-[#F8FAFD]";
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-[#E2E8F0] bg-white p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg" style={{ background: colors[1], color: colors[0] }} aria-hidden>🖥</span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-[#0F172A]">{d.name || "pH Meter"}</h3>
          <p className="truncate text-xs text-[#64748B]">{d.deviceIdentifier ?? "No DEVICE_ID set"} · {d.code}</p>
        </div>
        <ConnectionPill online={d.online} simulated={d.simulated} />
        <details className="relative">
          <summary className="grid h-8 w-8 cursor-pointer list-none place-items-center rounded-lg bg-[#F1F5F9] text-lg leading-none text-[#64748B] hover:bg-[#E2E8F0]" aria-label={`Options for ${d.name}`}>⋮</summary>
          <div className="absolute right-0 z-10 mt-1 w-48 overflow-hidden rounded-xl border border-[#E2E8F0] bg-white py-1 shadow-lg">
            <a className={menuItem} href={`/modules/ph/?device=${d.id}`}>Open Device</a>
            <button className={menuItem} onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; onDetails(); }}>Details / History</button>
            <a className={menuItem} href={`/modules/ph/?calibrations=1&device=${d.id}`}>Calibration history</a>
            {canManage && <a className={menuItem} href={`${web}/devices/view/?id=${d.id}`}>Edit Device</a>}
          </div>
        </details>
      </div>
      <div className="grid grid-cols-2 gap-3 border-t border-[#E2E8F0] pt-3">
        {info("User", d.currentUser ?? "--", "👤")}
        {info("Location", d.location || "--", "📍")}
      </div>
      <p className="truncate rounded-lg bg-[#F3F5F9] px-3 py-1.5 text-xs text-[#475569]">
        <span aria-hidden>▣&nbsp; </span>Probe&nbsp; {d.probeCode ?? "--"}&nbsp;&nbsp;|&nbsp;&nbsp;Sensor&nbsp; {d.temperatureSensorId ?? "--"}&nbsp;&nbsp;|&nbsp;&nbsp;Link&nbsp; {d.online ? (d.simulated ? "Simulator" : "USB dongle") : "--"}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <p className="text-[11px] text-[#64748B]">Battery</p>
          <p className="text-sm font-semibold" style={{ color: batteryColor(d) }}>{d.battery !== null && "🔋 "}{batteryText(d)}</p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-[#64748B]">Calibration</p>
          <p className="truncate text-sm font-semibold" style={{ color: cal.color }}>⚗ {CALIBRATION_BUCKET_LABEL[d.calibrationBucket]}</p>
        </div>
        <div>
          <p className="text-[11px] text-[#64748B]">Alerts</p>
          <p className="text-sm font-semibold" style={{ color: d.openAlerts ? "#D92D20" : "#64748B" }}>🔔 {d.openAlerts}</p>
        </div>
      </div>
      <p className="text-[11px] text-[#64748B]">Last activity: {relativeTime(d.lastActivityAt, now)}</p>
      <a href={`/modules/ph/?device=${d.id}`} className="block rounded-lg bg-[#EEF0FE] py-2 text-center text-sm font-semibold text-[#4F46E5] hover:bg-[#E2E5FD]">Open Device&nbsp; ›</a>
    </article>
  );
}

function DevicesPage({ principal, web, dash, adding, onAdd }: { principal: Principal; web: string; dash: DashboardState; adding: boolean; onAdd: () => void }) {
  const [search, setSearch] = useState("");
  const [connection, setConnection] = useState<DashboardFilter["connection"]>("ALL");
  const [location, setLocation] = useState("");
  const [details, setDetails] = useState<DashboardDevice | null>(null);
  const canAdd = principal.permissions.includes("devices.manage");
  const { data, error } = dash;
  if (!data) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  const now = dash.fetchedAt ?? Date.now();
  const rows = filterDashboardDevices(data.devices, { ...DEFAULT_DASHBOARD_FILTER, search, connection, location }, now);
  const filtered = search.trim() !== "" || connection !== "ALL" || location !== "";
  const s = data.summary;
  return (
    <div className="space-y-3">
      {error && <Callout tone="warn" title="Showing the last data received">{error}</Callout>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard value={s.total} label="Total devices" icon="🖥" tint="#2F6FE4" />
        <StatCard value={s.online} label="Connected" icon="📶" tint="#2E9960" hint={<span style={{ color: s.online ? "#16A34A" : "#DC2626" }}>● {s.online ? "Receiving data" : "No data"}</span>} />
        <StatCard value={s.calibrationDue} label="Calibration due" icon="📅" tint="#E0822A" />
        <StatCard value={s.criticalAlerts} label="Critical alerts" icon="⚠" tint="#DC4B4B" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[18rem] flex-1 flex-wrap items-center gap-2 rounded-2xl border border-[#E6EAF2] bg-white p-2">
          <label className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-xl bg-[#F8FAFD] px-3 py-2">
            <span aria-hidden className="text-[#94A3B8]">⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search device, probe, location, user…" aria-label="Search devices" className="w-full bg-transparent text-sm outline-none" />
          </label>
          <select aria-label="Filter by status" value={connection} onChange={(e) => setConnection(e.target.value as DashboardFilter["connection"])} className={selectCls}>
            <option value="ALL">All statuses</option>
            <option value="ONLINE">Online</option>
            <option value="OFFLINE">Offline</option>
          </select>
          <select aria-label="Filter by location" value={location} onChange={(e) => setLocation(e.target.value)} className={selectCls}>
            <option value="">All locations</option>
            {data.locations.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <select aria-label="Filter by device type" value="PH" onChange={() => undefined} className={selectCls}>
            <option value="PH">pH Meter</option>
          </select>
        </div>
        {canAdd && <button className={`${baseBtn} bg-[#5550E6] text-white hover:bg-[#4844CF]`} disabled={adding} onClick={onAdd}>+&nbsp; Add Device</button>}
      </div>
      {rows.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((d, i) => (
            <DeviceCard key={d.id} d={d} index={i} now={now} canManage={canAdd} web={web} onDetails={() => setDetails(d)} />
          ))}
        </div>
      ) : (
        <div className={panel}>
          <EmptyDevices filtered={filtered} onClear={() => { setSearch(""); setConnection("ALL"); setLocation(""); }} canAdd={canAdd} onAdd={onAdd} />
        </div>
      )}
      <DeviceDetailsDialog device={details} web={web} now={now} principal={principal} onClose={() => setDetails(null)} />
    </div>
  );
}

/** The app's device details dialog: sectioned, two columns, Close / Open Device. */
function DeviceDetailsDialog({ device: d, web, now, principal, onClose }: { device: DashboardDevice | null; web: string; now: number; principal: Principal; onClose: () => void }) {
  const canManage = principal.permissions.includes("devices.manage");
  const yesNo = (v: boolean | null, yes: string, no: string) => (v === null ? "Not reported" : v ? yes : no);
  const sections: { title: string; icon: string; left: [string, React.ReactNode][]; right: [string, React.ReactNode][] }[] = d
    ? [
        {
          title: "Device Information",
          icon: "📄",
          left: [["Device ID", d.deviceIdentifier ?? "--"], ["Code", d.code], ["Model", d.model || "--"], ["Serial", d.serialNumber || "--"]],
          right: [["Manufacturer", d.manufacturer || "--"], ["Location", d.location || "--"], ["Link", d.online ? (d.simulated ? "Simulator" : "USB dongle") : "--"], ["Current user", d.currentUser ?? "--"]],
        },
        {
          title: "Hardware",
          icon: "⚙",
          left: [["Probe ID", d.probeCode ?? "--"], ["Temperature Sensor ID", d.temperatureSensorId ?? "--"], ["Battery", `${batteryText(d)} (${BATTERY_CONDITION_LABEL[d.batteryCondition]})`], ["Charging", d.charging ? "Yes" : d.battery === null ? "Not reported" : "No"]],
          right: [["Meter status", d.meterStatus ?? "--"], ["Probe status", yesNo(d.probeConnected, "Connected", "Disconnected")], ["Temperature sensor status", yesNo(d.sensorConnected, "Connected", "Disconnected")], ["Probe register", d.probeStatus ?? "--"]],
        },
        {
          title: "Calibration",
          icon: "⚗",
          left: [["Lifecycle", d.status], ["Calibration", <CalibrationPill key="c" bucket={d.calibrationBucket} />], ["Calibration validity", d.readiness.message], ["Last calibration", d.calibration ? fmtTime(d.calibration.performedAt) : "--"], ["Calibrated by", d.calibration?.performedBy ?? "--"]],
          right: [
            ["Calibration type", d.calibration ? `${d.calibration.pointCount}-point${d.calibration.guided ? " guided" : ""}` : "--"],
            ["Calibration result", d.calibration ? `${d.calibration.outcome} · ${STATE[d.calibration.state]?.label ?? d.calibration.state}` : "--"],
            ["Next due", d.calibrationDueAt ? fmtTime(d.calibrationDueAt) : "--"],
            ["Calibration due", daysRemaining(d.calibrationDueAt, now)],
            ["Slope status", d.calibration?.slopePercent != null ? `${d.calibration.slopePercent.toFixed(1)} %${d.calibration.offsetMv != null ? ` · offset ${d.calibration.offsetMv.toFixed(1)} mV` : ""}` : "--"],
          ],
        },
        {
          title: "Activity & Alerts",
          icon: "🔔",
          left: [["Last activity", d.lastActivityAt ? fmtTime(d.lastActivityAt) : "--"], ["Last reading", d.lastSeenAt ? fmtTime(d.lastSeenAt) : "--"]],
          right: [["Open alerts", `${d.openAlerts}${d.criticalAlerts ? ` (${d.criticalAlerts} critical)` : ""}`], ["Alerts", <a key="a" className="font-semibold text-brand hover:underline" href={`/modules/ph/?alerts=1`}>View alerts</a>]],
        },
      ]
    : [];
  const col = (items: [string, React.ReactNode][]) => (
    <dl className="space-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[11rem_1fr] gap-2">
          <dt className="text-[#64748B]">{k}</dt>
          <dd className="min-w-0 break-words font-semibold text-[#0F172A]">{v}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <Modal open={!!d} title={d ? `${d.name || d.code} Details` : ""} wide onClose={onClose}>
      {d && (
        <>
          <div className="-mt-2 flex flex-wrap items-center gap-2">
            <ConnectionPill online={d.online} simulated={d.simulated} />
            <span className="text-xs text-[#64748B]">{d.deviceIdentifier ?? d.code}</span>
          </div>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {sections.map((sec) => (
              <section key={sec.title} className="rounded-xl border border-[#E6EAF2] p-3">
                <h3 className="mb-2 text-sm font-bold text-[#0F172A]">
                  <span aria-hidden>{sec.icon}&nbsp; </span>{sec.title}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {col(sec.left)}
                  {col(sec.right)}
                </div>
              </section>
            ))}
          </div>
          <div className="flex flex-wrap justify-end gap-3 border-t border-[#E5E7EB] pt-3">
            <button className={btnGray} onClick={onClose}>Close</button>
            <a className={btnGray} href={`/modules/ph/?calibrations=1&device=${d.id}`}>History</a>
            {canManage && <a className={btnGray} href={`${web}/devices/view/?id=${d.id}`}>Edit</a>}
            <a className={btnPurple} href={`/modules/ph/?device=${d.id}`}>Open Device&nbsp; ›</a>
          </div>
        </>
      )}
    </Modal>
  );
}

// --- Overview --------------------------------------------------------------

function MeterStatus({ live }: { live: Live }) {
  const { values, text } = live;
  const faults = [
    values.PROBE_CONNECTED === 0 && "PROBE DISCONNECTED",
    values.TEMP_SENSOR_CONNECTED === 0 && "TEMPERATURE SENSOR DISCONNECTED",
    !!text.DEVICE_STATUS && text.DEVICE_STATUS !== "ONLINE" && `METER REPORTS ${text.DEVICE_STATUS.toUpperCase()}`,
    typeof values.BATTERY === "number" && values.BATTERY < 10 && "LOW BATTERY",
  ].filter(Boolean) as string[];
  if (!faults.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Meter status">
      {faults.map((f) => (
        <Badge key={f} tone="fail">{f}</Badge>
      ))}
    </div>
  );
}

/** How long to wait for the meter to report the new ATC state. */
const ATC_CONFIRM_MS = 8_000;

function AtcRow({ deviceId, reported, online, canChange }: { deviceId: string; reported: number | null; online: boolean; canChange: boolean }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isOn = reported === 1;

  useEffect(() => {
    if (pending === null) return;
    if (reported === (pending ? 1 : 0)) {
      setPending(null);
      return;
    }
    const t = setTimeout(() => {
      setPending(null);
      setMessage("The command was sent, but the meter has not confirmed the change.");
    }, ATC_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [pending, reported]);

  async function toggle() {
    const enabled = !isOn;
    setBusy(true);
    setMessage(null);
    try {
      await mod(`/instruments/${deviceId}/atc`, send({ enabled }));
      setPending(enabled);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-[#E5EAF2] pt-3">
      <div className="min-w-0">
        <p className="text-sm font-bold text-[#101B3D]">ATC</p>
        <p className="text-xs text-[#64748B]" aria-live="polite">
          {pending !== null ? "Waiting for the meter…" : reported === null ? "Auto temperature compensation not reported" : isOn ? "Compensating with the live temperature reading" : "Auto temperature compensation off"}
        </p>
        {message && <p className="text-xs text-fail">{message}</p>}
      </div>
      <button
        role="switch"
        aria-checked={isOn}
        aria-label="Automatic temperature compensation"
        disabled={!canChange || !online || busy || pending !== null}
        title={!canChange ? "You do not have permission to change ATC" : !online ? "The meter is not connected" : undefined}
        onClick={() => void toggle()}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed ${isOn ? "bg-[#C7B9F6]" : "bg-[#E2E8F0]"}`}
      >
        <span className={`absolute top-1/2 left-0 h-7 w-7 -translate-y-1/2 rounded-full shadow transition-transform ${isOn ? "translate-x-5 bg-[#5B35D5]" : "bg-[#94A3B8]"}`} />
      </button>
    </div>
  );
}

/** "17 Oct 2026, 05:23 pm", as the tablet writes it. */
const fmtTabletDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) : "--";
/** "12 Nov 2026 12:24:10", the time of the latest reading. */
const fmtReadingTime = (v: string) => {
  const d = new Date(v);
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} ${d.toLocaleTimeString("en-GB", { hour12: false })}`;
};
const CAL_STATUS: Record<string, string> = { PASS: "Excellent", WARNING: "Warning", FAIL: "Failed" };
const READING_COLOR = { STABLE: "#07913A", UNSTABLE: "#DC2626", NO_READING: "#071847" } as const;

function OverviewTab({ principal, onTab }: { principal: Principal; onTab: (t: Tab) => void }) {
  const { data, error, reload } = useContext(LiveContext);
  const [health, setHealth] = useState<ProbeHealthView | null>(null);
  const [calibration, setCalibration] = useState<CalibrationRow | null | undefined>(undefined);
  const [probes, setProbes] = useState<ProbeRow[]>([]);
  const [form, setForm] = useState<{ probeId: string; temperatureSensorId: string; reason: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const id = data?.device.id ?? null;

  const loadProbe = useCallback(() => {
    if (!id) return;
    mod<ProbeHealthView>(`/instruments/${id}/probe-health`).then(setHealth).catch(() => undefined);
    // The latest calibration that still stands, whatever its review state.
    mod<{ rows: CalibrationRow[] }>(`/calibrations?device=${id}&pageSize=20`)
      .then((r) => setCalibration(r.rows.find((c) => c.state !== "INVALIDATED" && c.state !== "SUPERSEDED") ?? null))
      .catch(() => undefined);
  }, [id]);
  useEffect(() => {
    loadProbe();
    const t = setInterval(loadProbe, 10_000);
    return () => clearInterval(t);
  }, [loadProbe]);

  if (!data) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  const { device: d, live, stabilityRule } = data;
  const canMeasure = principal.permissions.includes("ph.measure") && d.status === "ACTIVE";
  const canManageProbe = principal.permissions.includes("ph.probes");
  const reading = live?.online ? live.stability.state : "NO_READING";
  const badge =
    reading === "STABLE"
      ? { text: "✓ Stable", style: { color: "#087A2A", borderColor: "#A7F3D0", background: "#ECFDF5" } }
      : reading === "UNSTABLE"
        ? { text: "Unstable", style: { color: "#DC2626", borderColor: "#FECACA", background: "#FEF2F2" } }
        : { text: "Waiting", style: { color: "#64748B", borderColor: "#CBD5E1", background: "#F1F5F9" } };
  const calStatus = calibration === undefined ? "--" : calibration === null ? "Not Calibrated" : `${CAL_STATUS[calibration.outcome] ?? calibration.outcome}${calibration.state !== "APPROVED" ? ` · ${STATE[calibration.state]?.label.toLowerCase() ?? calibration.state}` : ""}`;
  const rows: [string, React.ReactNode][] = [
    ["Probe ID", health?.probe?.code ?? "--"],
    ["Temperature Sensor ID", health?.probe?.temperatureSensorId || "--"],
    ["Calibration Status", calStatus],
    ["Last Calibrated", fmtTabletDate(calibration?.performedAt)],
    ["Slope", calibration?.slopePercent != null ? `${calibration.slopePercent.toFixed(2)}%` : "--"],
    ["Next Due", fmtTabletDate(d.readiness.dueAt)],
  ];
  const choices = probes.filter((p) => p.status === "ACTIVE" && (!p.deviceId || p.deviceId === d.id));
  const ready = d.readiness.state === "READY";

  async function openProbe() {
    setFormError(null);
    setProbes(await mod<ProbeRow[]>("/probes"));
    setForm({ probeId: health?.probe?.id ?? "", temperatureSensorId: health?.probe?.temperatureSensorId ?? "", reason: "" });
  }
  async function assign() {
    setFormError(null);
    try {
      await mod(`/instruments/${d.id}/probe`, send(form, "PUT"));
      setForm(null);
      loadProbe();
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <button onClick={() => onTab("calibrate")} className={`block w-full rounded-lg px-4 py-3 text-left text-sm font-bold ${ready ? "bg-[#ECFDF5] text-[#065F46]" : "bg-[#FFF7E7] text-[#6B4B00]"}`}>
        {ready ? "✓" : "⚠"}&nbsp; {d.readiness.message || "Calibration status will be evaluated for this device"}&nbsp;&nbsp;&nbsp; View details&nbsp; ›
      </button>
      {!d.deviceIdentifier && <Callout tone="warn">Set this instrument’s ID (the DEVICE_ID it sends) on its instrument record to receive data.</Callout>}
      {live?.online && <MeterStatus live={live} />}
      <div className="grid gap-3 lg:grid-cols-[1.08fr_1fr]">
        <section className={`${panel} flex min-h-[28rem] flex-col p-5`} aria-label="Primary reading">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={eyebrow}>Primary reading</p>
              <p className="mt-1 text-[13px] font-bold text-[#07913A]">●&nbsp; LIVE MEASUREMENT</p>
            </div>
            <span className="min-w-[4.5rem] rounded-lg border px-3 py-1.5 text-center text-sm font-bold" style={badge.style}>{badge.text}</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center py-4 text-[5.5rem] leading-[1.05] font-extrabold tabular-nums" style={{ color: READING_COLOR[reading] }}>
            <p>{live?.online ? fmt(live.values.PH_VAL) : "--"}</p>
            <p>pH</p>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-[#E5EAF2] pt-3">
            <span />
            <p className="text-center text-sm text-[#566176]">{live?.online ? fmtReadingTime(live.lastSeenAt) : "Waiting for device telemetry"}</p>
            <span className="text-right">{canMeasure && <button className="text-sm font-bold text-[#5D5FEF] hover:underline" onClick={() => setRecording(!recording)}>{recording ? "Close" : "Record measurement"}</button>}</span>
          </div>
        </section>
        <div className="grid gap-3 lg:grid-rows-[0.9fr_1.1fr]">
          <div className="grid gap-3 sm:grid-cols-2">
            <section className={`${panel} flex flex-col gap-1 p-5`} aria-label="Temperature">
              <p className={eyebrow}>Temperature</p>
              <p className="text-sm text-[#33415C]">Live sensor reading</p>
              <p className="flex flex-1 items-center justify-center py-3 text-4xl font-extrabold tabular-nums text-[#071847]">{live?.online ? `${fmt(live.values.TEMP_VAL, 1)} °C` : "-- °C"}</p>
              <AtcRow deviceId={d.id} reported={live?.values.ATC ?? null} online={!!live?.online} canChange={canMeasure} />
            </section>
            <section className={`${panel} flex flex-col gap-1 p-5`} aria-label="Electrode potential">
              <p className={eyebrow}>Electrode potential</p>
              <p className="text-sm text-[#33415C]">Probe signal</p>
              <p className="flex flex-1 items-center justify-center py-3 text-4xl font-extrabold tabular-nums text-[#071847]">{live?.online ? `${fmt(live.values.MV_VAL)} mV` : "-- mV"}</p>
            </section>
          </div>
          <section className={`${panel} p-5`} aria-label="Probe and calibration">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-[#101B3D]">Probe &amp; Calibration</h2>
                <p className="text-sm text-[#64748B]">Current probe configuration and calibration health</p>
              </div>
              {health && <Badge tone={HEALTH[health.health.status].tone}>{HEALTH[health.health.status].label}</Badge>}
            </div>
            <dl className="mt-3 space-y-2 border-t border-[#E5EAF2] pt-3 text-[15px]">
              {rows.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[1fr_1.25fr] gap-4">
                  <dt className="text-[#475569]">{label}</dt>
                  <dd className="min-w-0 truncate text-[#33415C]">{value}</dd>
                </div>
              ))}
            </dl>
            {health && health.health.reasons.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-[#566176]">
                {health.health.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {canManageProbe && (
              <button className="mt-3 text-sm font-bold text-[#5D5FEF] hover:underline" onClick={() => void openProbe()}>
                {health?.probe ? "Change probe" : "Assign probe"} ›
              </button>
            )}
          </section>
        </div>
      </div>
      {recording && <RecordMeasurement device={d} live={live} rule={stabilityRule} onRecorded={reload} />}
      <Modal open={!!form} title={health?.probe ? "Change probe" : "Assign probe"} onClose={() => setForm(null)}>
        {form && (
          <>
            <label className="block text-sm font-semibold">
              Probe
              <select value={form.probeId} onChange={(e) => setForm({ ...form, probeId: e.target.value })} className={field}>
                <option value="">Choose…</option>
                {choices.map((p) => (
                  <option key={p.id} value={p.id}>{[p.code, p.type].filter(Boolean).join(" · ")}</option>
                ))}
              </select>
            </label>
            {choices.length === 0 && <p className="text-sm text-muted">No free probes. <a className="font-semibold text-brand underline" href={`/modules/ph/?probes=1&device=${d.id}`}>Register one</a>.</p>}
            <label className="block text-sm font-semibold">
              Temperature sensor ID
              <input value={form.temperatureSensorId} onChange={(e) => setForm({ ...form, temperatureSensorId: e.target.value })} className={field} />
            </label>
            <label className="block text-sm font-semibold">
              Reason for the change
              <textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={field} />
            </label>
            {formError && <Callout tone="fail">{formError}</Callout>}
            <div className="flex justify-end gap-3">
              <button className={btnGray} onClick={() => setForm(null)}>Cancel</button>
              <button className={btnPurple} disabled={!form.probeId} onClick={() => void assign()}>Save</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

// --- Calibrate -------------------------------------------------------------

/** One buffer as the Calibrate screen shows it: from the run in progress, or from the last saved calibration. */
interface StepView extends RunPoint {
  deviation: number | null;
  deviationOutcome: "PASS" | "FAIL" | null;
}
type StepTone = "pass" | "fail" | "active" | "pending";
const STEP_TONE: Record<StepTone, { node: string; badge: string; text: string; line: string }> = {
  pass: { node: "bg-[#10B981] text-white", badge: "bg-[#ECFDF5] text-[#047857]", text: "text-[#047857]", line: "#10B981" },
  fail: { node: "bg-[#EF4444] text-white", badge: "bg-[#FEF2F2] text-[#DC2626]", text: "text-[#DC2626]", line: "#EF4444" },
  active: { node: "border border-[#C7D2FE] bg-[#EEF0FF] text-[#5D5FEF]", badge: "bg-[#EEF0FF] text-[#5D5FEF]", text: "text-[#5D5FEF]", line: "#A5B4FC" },
  pending: { node: "border border-[#E2E8F0] bg-[#F1F5F9] text-[#64748B]", badge: "bg-[#F1F5F9] text-[#64748B]", text: "text-[#64748B]", line: "#CBD5E1" },
};
/** The tablet's wording and colour for a buffer's state. */
function stepState(p: StepView): { label: string; tone: StepTone; mark: string } {
  if (p.status === "ACCEPTED") {
    if (p.deviationOutcome === "PASS") return { label: "Passed", tone: "pass", mark: "✓" };
    if (p.deviationOutcome === "FAIL") return { label: "Failed", tone: "fail", mark: "✗" };
    return { label: "Captured", tone: "active", mark: "✓" };
  }
  if (p.status === "MEASURING") return { label: "Measuring", tone: "active", mark: "●" };
  if (p.status === "WAITING") return { label: "Captured", tone: "active", mark: "●" };
  if (p.status === "NO_REPLY") return { label: "No reply", tone: "fail", mark: "✗" };
  if (p.status === "UNSTABLE") return { label: "Unstable", tone: "fail", mark: "✗" };
  if (p.status === "FAILED") return { label: "Failed", tone: "fail", mark: "✗" };
  return { label: "Pending", tone: "pending", mark: "" };
}
const captured = (p: StepView) => p.mv !== null;
/** Ideal electrode potential for a buffer, 0 mV at pH 7: at 25 °C, and at the reading's whole-degree temperature. */
const nernstMvPerPh = (celsius: number) => ((Math.LN10 * 8.3144626 * (celsius + 273.15)) / 96485.33) * 1000;
const theoreticalMv = (bufferPh: number, temperatureC: number | null) =>
  temperatureC === null ? { without: null, with: null } : { without: 59.16 * (7 - bufferPh), with: nernstMvPerPh(Math.round(temperatureC)) * (7 - bufferPh) };
const OVERALL: Record<string, { label: string; bg: string; border: string; text: string; icon: string; iconBg: string }> = {
  PASS: { label: "Passed", bg: "#ECFDF5", border: "#A7F3D0", text: "#047857", icon: "✓", iconBg: "#D1FAE5" },
  WARNING: { label: "Passed with warning", bg: "#FFFBEB", border: "#FDE68A", text: "#B45309", icon: "!", iconBg: "#FEF3C7" },
  FAIL: { label: "Failed", bg: "#FEF2F2", border: "#FECACA", text: "#B91C1C", icon: "!", iconBg: "#DCFCE7" },
  IN_PROGRESS: { label: "In Progress", bg: "#FFFBEB", border: "#FDE68A", text: "#B45309", icon: "…", iconBg: "#FEF3C7" },
  NONE: { label: "Not Available", bg: "#F8FAFC", border: "#CBD5E1", text: "#64748B", icon: "–", iconBg: "#E2E8F0" },
};
/** "Oct 17, 2026 05:15 pm", as the tablet writes the last calibration. */
const fmtCalDate = (v: string) => {
  const d = new Date(v);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }).toLowerCase()}`;
};
const EyeIcon = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={`h-5 w-5 fill-current ${className}`}>
    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
  </svg>
);
const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden className="h-7 w-7 fill-[#5D5FEF]">
    <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm7 10c0 4.52-2.98 8.74-7 9.93C7.98 19.74 5 15.52 5 11V6.3l7-3.11 7 3.11V11z" />
  </svg>
);

/** The app's calibration graph: electrode mV against buffer pH, with the fitted line and the ideal (Nernst) line. */
function CalibrationGraph({ points, slopePercent, offsetMv, temperatureC }: { points: { bufferPh: number; mv: number }[]; slopePercent: number | null; offsetMv: number | null; temperatureC: number | null }) {
  const W = 560;
  const H = 300;
  const L = 52;
  const R = 16;
  const T = 16;
  const B = 40;
  const celsius = temperatureC ?? 25;
  const nernst = nernstSlope(celsius);
  const xs = points.map((p) => p.bufferPh);
  const xMin = Math.max(0, Math.floor((xs.length ? Math.min(...xs) : 2) - 1));
  const xMax = Math.min(14, Math.ceil((xs.length ? Math.max(...xs) : 12) + 1));
  const ideal = (ph: number) => -nernst * (ph - 7);
  const fitted = slopePercent !== null && offsetMv !== null ? (ph: number) => offsetMv - (slopePercent / 100) * nernst * (ph - 7) : null;
  const ys = [...points.map((p) => p.mv), ideal(xMin), ideal(xMax), ...(fitted ? [fitted(xMin), fitted(xMax)] : [])];
  const yMin = Math.floor((Math.min(...ys) - 30) / 50) * 50;
  const yMax = Math.ceil((Math.max(...ys) + 30) / 50) * 50;
  const x = (ph: number) => L + ((ph - xMin) / (xMax - xMin)) * (W - L - R);
  const y = (mv: number) => T + ((yMax - mv) / (yMax - yMin)) * (H - T - B);
  const xTicks = Array.from({ length: xMax - xMin + 1 }, (_, i) => xMin + i);
  const yTicks = Array.from({ length: (yMax - yMin) / 50 + 1 }, (_, i) => yMin + i * 50);
  return (
    <figure className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Calibration graph: electrode potential against buffer pH">
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#E2E8F0" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#64748B">{v}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={T} y2={H - B} stroke="#F1F5F9" />
            <text x={x(v)} y={H - B + 14} textAnchor="middle" fontSize="10" fill="#64748B">{v}</text>
          </g>
        ))}
        <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="#334155">Buffer pH</text>
        <text transform={`translate(12 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle" fontSize="11" fill="#334155">mV</text>
        <line x1={x(xMin)} y1={y(ideal(xMin))} x2={x(xMax)} y2={y(ideal(xMax))} stroke="#94A3B8" strokeDasharray="6 4" strokeWidth="1.5" />
        {fitted && <line x1={x(xMin)} y1={y(fitted(xMin))} x2={x(xMax)} y2={y(fitted(xMax))} stroke="#5D5FEF" strokeWidth="2" />}
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(p.bufferPh)} cy={y(p.mv)} r="5" fill="#10B981" stroke="#fff" strokeWidth="2" />
            <text x={x(p.bufferPh) + 8} y={y(p.mv) - 8} fontSize="10" fill="#071847">{p.mv.toFixed(1)}</text>
          </g>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-[#566176]">
        <span><span className="mr-1 inline-block h-0.5 w-5 bg-[#5D5FEF] align-middle" />Fitted line {fitted ? `(slope ${slopePercent!.toFixed(1)} %, offset ${offsetMv!.toFixed(1)} mV)` : "(not available)"}</span>
        <span><span className="mr-1 inline-block w-5 border-t border-dashed border-[#94A3B8] align-middle" />Ideal electrode at {celsius.toFixed(1)} °C ({nernst.toFixed(2)} mV/pH)</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-[#10B981] align-middle" />Measured points</span>
      </figcaption>
    </figure>
  );
}

function CalibrateTab({ principal, web }: { principal: Principal; web: string }) {
  const live = useContext(LiveContext);
  const device = live.data?.device;
  const id = device?.id;
  const [data, setData] = useState<GuidedData | null>(null);
  const [health, setHealth] = useState<ProbeHealthView | null>(null);
  const [last, setLast] = useState<CalibrationRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"checks" | "save" | "settings" | "graph" | "result" | null>(null);
  const [pointShown, setPointShown] = useState<StepView | null>(null);
  const [ack, setAck] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [bufferLot, setBufferLot] = useState("");
  const [bufferExpiry, setBufferExpiry] = useState("");
  const [created, setCreated] = useState<{ calibrationId: string; code: string; outcome: string } | null>(null);
  const [editing, setEditing] = useState<{ pointCount: string; timerSeconds: string; requireStable: boolean; buffers: Record<number, string>; reason: string } | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    mod<GuidedData>(`/instruments/${id}/guided-calibration`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  const loadOnce = useCallback(() => {
    if (!id) return;
    mod<ProbeHealthView>(`/instruments/${id}/probe-health`).then(setHealth).catch(() => undefined);
    mod<{ rows: CalibrationRow[] }>(`/calibrations?device=${id}&pageSize=10`)
      .then((r) => setLast(r.rows[0] ?? null))
      .catch(() => undefined);
  }, [id]);
  useEffect(() => {
    load();
    loadOnce();
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [load, loadOnce]);

  async function act<T>(path: string, body: unknown = {}): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const r = await mod<T>(`/instruments/${id}/guided-calibration${path}`, send(body));
      load();
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!device || !data) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  const { run, settings, checks } = data;
  const canCalibrate = principal.permissions.includes("calibration.perform") && device.status === "ACTIVE";
  const canEditSettings = principal.permissions.includes("ph.limits");
  const failed = checks.some((c) => c.result === "FAIL");
  const warned = checks.some((c) => c.result === "WARN");
  const mine = run?.startedById === principal.userId;
  const blank = (slot: number, bufferPh: number): StepView => ({ slot, bufferPh, status: "PENDING", message: null, secondsLeft: null, measuredPh: null, mv: null, temperatureC: null, stable: null, postPh: null, segmentSlope: null, deviation: null, deviationOutcome: null });

  // With no run in progress the screen shows the last saved calibration, as the tablet does.
  const shownLast = !run && last ? last : null;
  const steps: StepView[] = run
    ? run.points.map((p) => {
        const e = run.evaluation?.points.find((x) => x.slot === p.slot);
        return { ...p, deviation: e?.deviation ?? null, deviationOutcome: e?.deviationOutcome ?? null };
      })
    : shownLast && shownLast.points.length
      ? shownLast.points.map((p) => {
          const e = shownLast.deviations.find((x) => x.slot === p.slot);
          return { ...p, status: p.status ?? "ACCEPTED", deviation: e?.deviation ?? null, deviationOutcome: e?.deviationOutcome ?? null };
        })
      : shownLast && shownLast.readings.length
        ? shownLast.readings.map((r, i) => ({ ...blank(i + 1, r.bufferPh), status: "ACCEPTED" as const, mv: r.mv, temperatureC: shownLast.temperatureC }))
        : (settings.pointCount === 3 ? [2, 3, 4] : [1, 2, 3, 4, 5]).map((slot) => blank(slot, settings.buffers[slot]));
  const busyPoint = run?.points.find((p) => p.status === "MEASURING" || p.status === "WAITING") ?? null;
  const next = run?.points.find((p) => p.status !== "ACCEPTED") ?? null;
  const allDone = !!run && !next;
  const retryPoint = busyPoint ? null : (run?.points.find((p) => ["NO_REPLY", "UNSTABLE", "FAILED"].includes(p.status)) ?? [...(run?.points ?? [])].reverse().find((p) => p.status === "ACCEPTED") ?? null);
  const slope = run ? (run.evaluation?.result.slopePercent ?? run.deviceSlope ?? null) : (shownLast?.slopePercent ?? null);
  const offset = run ? (run.evaluation?.result.offsetMv ?? run.deviceOffset ?? null) : (shownLast?.offsetMv ?? null);
  const outcomeKey = run ? (run.evaluation?.outcome ?? "IN_PROGRESS") : (shownLast?.outcome ?? "NONE");
  const overall = OVERALL[outcomeKey] ?? OVERALL.NONE;
  // What the result dialog explains: the finished run, or the calibration on screen.
  const result = run?.evaluation
    ? { title: "Calibration in progress", outcome: run.evaluation.outcome, slopePercent: run.evaluation.result.slopePercent, slopeOutcome: run.evaluation.result.slopeOutcome as string | null, offsetMv: run.evaluation.result.offsetMv, offsetOutcome: run.evaluation.result.offsetOutcome as string | null, rSquared: run.evaluation.result.rSquared as number | null, limits: run.limits as PhLimits | null, limitsVersion: run.limitsVersion }
    : shownLast
      ? { title: `${shownLast.code} · ${STATE[shownLast.state]?.label ?? shownLast.state}`, outcome: shownLast.outcome, slopePercent: shownLast.slopePercent, slopeOutcome: shownLast.slopeOutcome, offsetMv: shownLast.offsetMv, offsetOutcome: shownLast.offsetOutcome, rSquared: shownLast.rSquared, limits: shownLast.limits, limitsVersion: shownLast.limitsVersion }
      : null;
  const reportOf = created?.calibrationId ?? last?.id ?? null;
  const probeCode = health?.probe?.code ?? "--";
  // The graph plots the run in progress, or else the latest saved calibration.
  const graph = run
    ? { points: run.points.filter((p) => p.mv !== null).map((p) => ({ bufferPh: p.bufferPh, mv: p.mv! })), slope, offset, temperatureC: run.points.find((p) => p.temperatureC !== null)?.temperatureC ?? null, label: "Calibration in progress" }
    : { points: last?.readings ?? [], slope: last?.slopePercent ?? null, offset: last?.offsetMv ?? null, temperatureC: last?.temperatureC ?? null, label: last ? `${last.code} · ${fmtDate(last.performedAt)}` : "No calibration yet" };
  const position = (slot: number) => steps.findIndex((s) => s.slot === slot) + 1;

  const title = !run
    ? "Calibration not started"
    : busyPoint?.status === "MEASURING"
      ? `Current Buffer — pH ${busyPoint.bufferPh.toFixed(2)}`
      : next
        ? `Next Buffer — pH ${next.bufferPh.toFixed(2)}`
        : "Calibration buffers captured";
  const instruction = !run
    ? shownLast
      ? `The last saved calibration, ${shownLast.code} (${(STATE[shownLast.state]?.label ?? shownLast.state).toLowerCase()}), is displayed below. Start a new calibration to replace it.`
      : "Complete each buffer in sequence"
    : busyPoint?.status === "MEASURING"
      ? `Buffer ${position(busyPoint.slot)} of ${steps.length}   •   pH ${busyPoint.bufferPh.toFixed(2)}   •   ${busyPoint.secondsLeft ?? 0}s remaining`
      : busyPoint
        ? "Waiting for the meter to report the captured buffer…"
        : next
          ? `Rinse the probe, immerse it in pH ${next.bufferPh.toFixed(2)}, then start the next ${run.timerSeconds ?? settings.timerSeconds}-second capture.`
          : "All selected buffers were captured. Review the values and save the calibration.";

  async function begin() {
    setDialog(null);
    setCreated(null);
    const started = await act<GuidedRun>("", { acknowledgeWarnings: ack });
    if (started) await act("/measure", { slot: started.points[0].slot });
  }
  async function save() {
    const r = await act<{ calibrationId: string; code: string; outcome: string }>("/save", { remarks, bufferLot, bufferExpiry });
    setDialog(null);
    if (r) {
      setCreated(r);
      setRemarks("");
      setBufferLot("");
      setBufferExpiry("");
      loadOnce();
    }
  }
  async function saveSettings() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const { reason, ...s } = editing;
      await mod(`/instruments/${id}/calibration-settings`, send({ reason, settings: { ...s, pointCount: Number(s.pointCount), timerSeconds: Number(s.timerSeconds) } }, "PUT"));
      setDialog(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openSettings() {
    setEditing({ pointCount: String(settings.pointCount), timerSeconds: String(settings.timerSeconds), requireStable: settings.requireStable, buffers: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, String(settings.buffers[n])])), reason: "" });
    setDialog("settings");
  }
  async function exportReport() {
    if (!reportOf) return;
    setError(null);
    try {
      await downloadFile(`/instruments/${id}/calibrations/${reportOf}/report`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const meta = (label: string, value: React.ReactNode) => (
    <div className="min-w-0 text-right">
      <p className="text-xs text-[#64748B]">{label}</p>
      <p className="truncate text-[15px] font-bold text-[#0F172A]">{value}</p>
    </div>
  );
  const fact = (label: string, value: string) => (
    <div className="min-w-0">
      <p className={eyebrow}>{label}</p>
      <p className="truncate text-sm font-bold text-[#101B3D]">{value}</p>
    </div>
  );
  const cell = "border border-[#D8DEE8] px-2 py-3 text-center";

  return (
    <div className="space-y-3">
      {error && <Callout tone="fail">{error}</Callout>}
      {created && (
        <Callout tone={outcomeTone(created.outcome)} title={`${created.code} saved as a draft (${created.outcome})`}>
          <a className="font-semibold text-brand underline" href={`${web}/devices/view/?calibration=${created.calibrationId}`}>Open it to submit for approval</a>.
        </Callout>
      )}
      <section className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-5" aria-label="Guided calibration">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-[16rem] flex-1">
            <h2 className="text-2xl font-extrabold text-[#0F172A]">{title}</h2>
            <p className="mt-1 text-sm whitespace-pre-wrap text-[#64748B]">{instruction}</p>
          </div>
          {meta("Mode", `${run ? run.points.length : settings.pointCount}-Point`)}
          {meta("Device ID", device.deviceIdentifier ?? "--")}
          {meta("Probe ID", probeCode)}
          {meta("Last Calibrated", last ? <>📅&nbsp; {fmtCalDate(last.performedAt)}</> : "No saved calibration")}
        </div>
        <ol className="mt-4 flex items-start" aria-label="Buffers">
          {steps.map((p, i) => {
            const st = stepState(p);
            const tone = STEP_TONE[st.tone];
            const nextStep = steps[i + 1];
            let line = "#CBD5E1";
            if (nextStep && captured(p) && captured(nextStep)) {
              const a = stepState(p).tone;
              const b = stepState(nextStep).tone;
              line = a === "fail" || b === "fail" ? "#EF4444" : a === "pass" && b === "pass" ? "#10B981" : "#A5B4FC";
            }
            return (
              <li key={p.slot} className="flex flex-1 items-start last:flex-none">
                <div className="flex min-w-[6rem] flex-col items-center text-center">
                  <span className={`grid h-10 min-w-10 place-items-center rounded-lg px-2 text-sm font-extrabold ${tone.node}`}>{st.mark ? `${st.mark} ${i + 1}` : i + 1}</span>
                  <span className="mt-2 text-lg font-extrabold text-[#0F172A]">pH {p.bufferPh.toFixed(2)}</span>
                  <span className="text-xs text-[#64748B]">Buffer {i + 1}</span>
                  <span className={`mt-1.5 rounded-full px-3 py-0.5 text-xs font-bold ${tone.badge}`}>{st.label}{p.status === "MEASURING" && p.secondsLeft !== null ? ` · ${p.secondsLeft} s` : ""}</span>
                </div>
                {nextStep && <span aria-hidden className="mx-2 mt-[3.1rem] h-[3px] flex-1 rounded" style={{ background: line }} />}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-5" aria-label="Calibration quality">
        <div className="flex items-center gap-3">
          <ShieldIcon />
          <h2 className="text-xl font-bold text-[#0F172A]">Calibration Quality</h2>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <div className="flex min-w-[16rem] flex-1 items-center">
            <div className="flex-1 text-center">
              <p className="text-sm text-[#64748B]">Average Slope</p>
              <p className="text-2xl font-extrabold tabular-nums text-[#0F172A]">{slope === null ? "--" : `${slope.toFixed(2)}%`}</p>
            </div>
            <span aria-hidden className="h-10 w-px bg-[#E2E8F0]" />
            <div className="flex-1 text-center">
              <p className="text-sm text-[#64748B]">Offset</p>
              <p className="text-2xl font-extrabold tabular-nums text-[#0F172A]">{offset === null ? "--" : `${offset.toFixed(2)} mV`}</p>
            </div>
          </div>
          <button
            type="button"
            disabled={!result}
            onClick={() => setDialog("result")}
            aria-label="View overall calibration result details"
            className="flex min-w-[17rem] items-center gap-3 rounded-2xl border px-4 py-3 text-left disabled:cursor-default"
            style={{ background: overall.bg, borderColor: overall.border, color: overall.text }}
          >
            <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-lg font-extrabold" style={{ background: overall.iconBg }}>{overall.icon}</span>
            <span className="flex-1">
              <span className="block text-sm">Overall Status</span>
              <span className="block text-xl font-extrabold">{overall.label}</span>
            </span>
            {result && <EyeIcon className="h-7 w-7 text-[#F05A28]" />}
          </button>
        </div>
      </section>

      <section aria-label="Calibration points">
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Calibration actions">
          {canCalibrate && !run && <button className={btnGreen} disabled={busy} onClick={() => { setAck(false); setDialog("checks"); }}>▶&nbsp; Start Calibration</button>}
          {run && mine && next && !busyPoint && next.status === "PENDING" && <button className={btnGreen} disabled={busy} onClick={() => void act("/measure", { slot: next.slot })}>▶&nbsp; Start pH {next.bufferPh.toFixed(2)}</button>}
          {busyPoint && <span className="inline-flex min-h-11 items-center rounded-xl bg-[#EEF0FF] px-4 font-bold text-[#5D5FEF]">{busyPoint.status === "MEASURING" ? `Measuring pH ${busyPoint.bufferPh.toFixed(2)} · ${busyPoint.secondsLeft} s` : "Waiting for the meter…"}</span>}
          {run && mine && retryPoint && <button className={btnGray} disabled={busy} onClick={() => void act("/measure", { slot: retryPoint.slot })}>↻&nbsp; Retry pH {retryPoint.bufferPh.toFixed(2)}</button>}
          <button className={btnRedOutline} disabled={busy || !run || !(mine || canCalibrate)} title={run ? undefined : "No calibration in progress"} onClick={() => { if (confirm("Abandon this calibration? The captured points will be discarded.")) void act("/reset"); }}>Reset</button>
          <button className={btnGray} disabled={!graph.points.length} title={graph.points.length ? undefined : "No calibration points to plot yet"} onClick={() => setDialog("graph")}>Graph</button>
          <a className={btnGray} href={`/modules/ph/?calibrations=1&device=${device.id}`}>History</a>
          <button className={btnGray} disabled={!reportOf} onClick={() => void exportReport()}>Export</button>
          {canEditSettings && !run && <button className={btnGray} onClick={openSettings}>Settings</button>}
          <span className="flex-1" />
          <button className={btnPurple} disabled={busy || !run || !mine || run.saveProblem !== null} title={!run ? "Start a calibration first" : !mine ? `Started by ${run.startedByName}` : (run.saveProblem ?? undefined)} onClick={() => setDialog("save")}>💾&nbsp; Save</button>
        </div>
        {run && !mine && <p className="mt-2 text-xs text-[#566176]">Started by {run.startedByName}.</p>}
        {!run && (failed || warned) && <button onClick={() => { setAck(false); setDialog("checks"); }} className="mt-2 text-left text-xs font-semibold text-[#B45309] underline">Pre-calibration checks need attention</button>}
        <div className="mt-3 overflow-x-auto rounded-2xl border border-[#E2E8F0] bg-white p-1">
          <table className="w-full border-collapse text-[15px]">
            <thead className="bg-[#EEF2F7] text-[#0F172A]">
              <tr>
                {["Buffer", "Probe ID", "Measured (pH)", "Without ATC (mV)", "Temp (°C)", "With ATC (mV)", "mV", "Slope (%)", "Status"].map((h) => (
                  <th key={h} className={`${cell} font-bold whitespace-nowrap`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-[#33415C] tabular-nums">
              {steps.map((p) => {
                const st = stepState(p);
                const ideal = theoreticalMv(p.bufferPh, p.temperatureC);
                const hasResult = st.tone === "pass" || st.tone === "fail" || st.label === "Captured";
                return (
                  <tr key={p.slot}>
                    <td className={cell}>{captured(p) ? "✓" : "○"}&nbsp; {p.bufferPh.toFixed(2)}</td>
                    <td className={cell}>{probeCode}</td>
                    <td className={cell}>{fmt(p.postPh ?? p.measuredPh).replace("—", "--")}</td>
                    <td className={cell}>{fmt(ideal.without).replace("—", "--")}</td>
                    <td className={cell}>{fmt(p.temperatureC).replace("—", "--")}</td>
                    <td className={cell}>{fmt(ideal.with).replace("—", "--")}</td>
                    <td className={cell}>{fmt(p.mv).replace("—", "--")}</td>
                    <td className={cell}>{fmt(p.segmentSlope).replace("—", "--")}</td>
                    <td className={cell}>
                      <span className="inline-flex items-center gap-3">
                        <span className={`font-bold ${STEP_TONE[st.tone].text}`}>{st.label}{p.status === "MEASURING" && p.secondsLeft !== null ? ` · ${p.secondsLeft} s` : ""}</span>
                        {hasResult && (
                          <button type="button" onClick={() => setPointShown(p)} aria-label={`${st.label}. View result details for pH ${p.bufferPh.toFixed(2)}`} className={STEP_TONE[st.tone].text}>
                            <EyeIcon />
                          </button>
                        )}
                      </span>
                      {p.message && <span className="block text-xs text-fail">{p.message}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {run && !allDone && <p className="rounded-lg bg-[#FFF7E7] px-4 py-2 text-center text-xs font-semibold text-[#744A00]">⚠&nbsp; Do not leave this screen while calibration is in progress.</p>}

      <Modal open={dialog === "checks"} title="Pre-calibration checks" onClose={() => setDialog(null)}>
        <ul className="divide-y divide-line rounded-md border border-line text-sm">
          {checks.map((c) => (
            <li key={c.label} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="font-semibold">{c.label}</span>
              <span className="flex items-center gap-2 text-muted">{c.detail} <Badge tone={c.result === "PASS" ? "pass" : c.result === "WARN" ? "warn" : "fail"}>{c.result}</Badge></span>
            </li>
          ))}
        </ul>
        {warned && !failed && (
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed the warnings and want to continue
          </label>
        )}
        <div className="flex justify-end gap-3">
          <button className={btnGray} onClick={() => setDialog(null)}>Cancel</button>
          <button className={btnGreen} disabled={busy || failed || (warned && !ack)} onClick={() => void begin()}>Continue</button>
        </div>
      </Modal>

      <Modal open={dialog === "save"} title="Save calibration" onClose={() => setDialog(null)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-semibold">
            Buffer lot
            <input value={bufferLot} onChange={(e) => setBufferLot(e.target.value)} placeholder="e.g. B-4471" className={field} />
          </label>
          <label className="text-sm font-semibold">
            Buffer expiry
            <input type="date" value={bufferExpiry} onChange={(e) => setBufferExpiry(e.target.value)} className={field} />
          </label>
        </div>
        <label className="block text-sm font-semibold">
          Remarks
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} className={field} />
        </label>
        <div className="flex justify-end gap-3">
          <button className={btnGray} onClick={() => setDialog(null)}>Cancel</button>
          <button className={btnPurple} disabled={busy} onClick={() => void save()}>💾&nbsp; Save</button>
        </div>
      </Modal>

      <Modal open={dialog === "settings"} title="Calibration settings" wide onClose={() => setDialog(null)}>
        {editing && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold">
                Mode
                <select value={editing.pointCount} onChange={(e) => setEditing({ ...editing, pointCount: e.target.value })} className={field}>
                  <option value="3">3-Point (buffers 2, 3, 4)</option>
                  <option value="5">5-Point</option>
                </select>
              </label>
              <label className="text-sm font-semibold">
                Seconds per buffer (5–600)
                <input inputMode="numeric" value={editing.timerSeconds} onChange={(e) => setEditing({ ...editing, timerSeconds: e.target.value })} className={field} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className="text-sm font-semibold">
                  Buffer {n}
                  <input inputMode="decimal" value={editing.buffers[n]} onChange={(e) => setEditing({ ...editing, buffers: { ...editing.buffers, [n]: e.target.value } })} className={`${field} font-mono`} />
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={editing.requireStable} onChange={(e) => setEditing({ ...editing, requireStable: e.target.checked })} /> Require a stable reading before a point is captured
            </label>
            <label className="block text-sm font-semibold">
              Reason for the change
              <textarea rows={2} value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value })} className={field} />
            </label>
            <div className="flex justify-end gap-3">
              <button className={btnGray} onClick={() => setDialog(null)}>Cancel</button>
              <button className={btnPurple} disabled={busy} onClick={() => void saveSettings()}>Save settings</button>
            </div>
            <MeterSettings deviceId={device.id} />
          </>
        )}
      </Modal>

      <Modal open={dialog === "graph"} title="Calibration graph" wide onClose={() => setDialog(null)}>
        <p className="-mt-2 text-sm text-[#566176]">{graph.label}</p>
        <CalibrationGraph points={graph.points} slopePercent={graph.slope} offsetMv={graph.offset} temperatureC={graph.temperatureC} />
        <div className="flex justify-end">
          <button className={btnGray} onClick={() => setDialog(null)}>Close</button>
        </div>
      </Modal>

      <Modal open={dialog === "result"} title="Calibration result" wide onClose={() => setDialog(null)}>
        {result && (
          <>
            <p className="-mt-2 text-sm text-[#566176]">{result.title}</p>
            <div className="grid gap-3 sm:grid-cols-4">
              {fact("Overall", OVERALL[result.outcome]?.label ?? result.outcome)}
              {fact("Slope", result.slopePercent === null ? "--" : `${result.slopePercent.toFixed(2)} %${result.slopeOutcome ? ` · ${result.slopeOutcome}` : ""}`)}
              {fact("Offset", result.offsetMv === null ? "--" : `${result.offsetMv.toFixed(2)} mV${result.offsetOutcome ? ` · ${result.offsetOutcome}` : ""}`)}
              {fact("Linearity (R²)", result.rSquared === null ? "--" : result.rSquared.toFixed(4))}
            </div>
            <div className="overflow-x-auto rounded-xl border border-[#E5EAF2]">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#F3F5F9] text-xs uppercase tracking-wide text-[#566176]">
                  <tr>
                    {["Buffer", "Measured pH", "mV", "°C", "Deviation", "Result"].map((h) => (
                      <th key={h} className="px-3 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF2] font-mono tabular-nums">
                  {steps.map((p) => (
                    <tr key={p.slot}>
                      <td className="px-3 py-2 font-sans font-bold">{p.bufferPh.toFixed(2)}</td>
                      <td className="px-3 py-2">{fmt(p.postPh ?? p.measuredPh)}</td>
                      <td className="px-3 py-2">{fmt(p.mv)}</td>
                      <td className="px-3 py-2">{fmt(p.temperatureC, 1)}</td>
                      <td className="px-3 py-2">{fmt(p.deviation, 3)}</td>
                      <td className="px-3 py-2 font-sans">{p.deviationOutcome ? <Badge tone={p.deviationOutcome === "PASS" ? "pass" : "fail"}>{p.deviationOutcome}</Badge> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.limits && <p className="text-xs text-[#566176]">Judged against {result.limitsVersion === null ? "the built-in acceptance limits" : `acceptance limits version ${result.limitsVersion}`}: {limitsText(result.limits)}.</p>}
            <div className="flex justify-end">
              <button className={btnGray} onClick={() => setDialog(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!pointShown} title={pointShown ? `Buffer ${position(pointShown.slot)} · pH ${pointShown.bufferPh.toFixed(2)}` : ""} onClose={() => setPointShown(null)}>
        {pointShown && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {fact("Result", stepState(pointShown).label)}
              {fact("Probe ID", probeCode)}
              {fact("Measured pH", fmt(pointShown.measuredPh))}
              {fact("Reported pH", fmt(pointShown.postPh))}
              {fact("Electrode mV", fmt(pointShown.mv))}
              {fact("Temperature", pointShown.temperatureC === null ? "—" : `${fmt(pointShown.temperatureC)} °C`)}
              {fact("Ideal mV without ATC", fmt(theoreticalMv(pointShown.bufferPh, pointShown.temperatureC).without))}
              {fact("Ideal mV with ATC", fmt(theoreticalMv(pointShown.bufferPh, pointShown.temperatureC).with))}
              {fact("Segment slope", pointShown.segmentSlope === null ? "—" : `${fmt(pointShown.segmentSlope)} %`)}
              {fact("Deviation", pointShown.deviation === null ? "—" : `${fmt(pointShown.deviation, 3)} pH`)}
              {fact("Stable when captured", pointShown.stable === null ? "—" : pointShown.stable ? "Yes" : "No")}
            </div>
            {pointShown.message && <Callout tone="fail">{pointShown.message}</Callout>}
            {pointShown.deviationOutcome === "FAIL" && <p className="text-sm text-[#566176]">The reading differs from the buffer by more than the allowed deviation{result?.limits ? ` (${result.limits.deviationMaxPh} pH)` : ""}.</p>}
            <div className="flex justify-end">
              <button className={btnGray} onClick={() => setPointShown(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

// --- Logs ------------------------------------------------------------------

const LOG_INTERVALS: [string, string][] = [["5", "5 seconds"], ["10", "10 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["300", "5 minutes"], ["600", "10 minutes"], ["custom", "Custom…"]];
const LOG_MODES: { value: "MANUAL" | LogMode; label: string }[] = [
  { value: "MANUAL", label: "Manual" },
  { value: "STABLE", label: "Log On Stable" },
  { value: "BUTTON", label: "Device Button" },
  { value: "INTERVAL", label: "Log At Interval" },
];
interface LogRunView {
  mode: LogMode;
  intervalSeconds: number | null;
  startedByName: string;
  startedAt: string;
  count: number;
  skipped: number;
  lastProblem: string | null;
}
interface LogEntry {
  id: number;
  deviceCode: string;
  method: LogMethod;
  ph: number;
  mv: number;
  temperatureC: number;
  stable: boolean;
  batch: string;
  arNumber: string;
  product: string;
  dataSource: string;
  loggedBy: string;
  loggedAt: string;
}
interface SampleListRow {
  id: string;
  kind: SampleListKind;
  value: string;
}
const SAMPLE_LIST_PLURAL: Record<SampleListKind, string> = { PRODUCT: "Products", BATCH: "Batches", AR: "AR numbers" };

/** The app's "Add List": saved products, batches and AR numbers offered when a reading is logged. */
function SampleListManager({ open, rows, onClose, onChanged }: { open: boolean; rows: SampleListRow[]; onClose: () => void; onChanged: () => void }) {
  const [kind, setKind] = useState<SampleListKind>("PRODUCT");
  const [value, setValue] = useState("");
  const [removing, setRemoving] = useState<SampleListRow | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await mod("/sample-lists", send({ kind, value }));
      setValue("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await mod(`/sample-lists/${removing.id}/remove`, send({ reason }));
      setRemoving(null);
      setReason("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Product, batch and AR number lists" wide onClose={onClose}>
      <p className="-mt-2 text-sm text-[#566176]">Saved entries are offered when a reading is logged. Removing one hides it from the pickers; readings that used it keep their text.</p>
      <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-2">
        <label className="text-sm font-semibold">
          Add to
          <select value={kind} onChange={(e) => setKind(e.target.value as SampleListKind)} className={field}>
            {SAMPLE_LIST_KINDS.map((k) => (
              <option key={k} value={k}>{SAMPLE_LIST_PLURAL[k]}</option>
            ))}
          </select>
        </label>
        <label className="min-w-[14rem] flex-1 text-sm font-semibold">
          {SAMPLE_LIST_LABEL[kind]}
          <input value={value} onChange={(e) => setValue(e.target.value)} className={field} />
        </label>
        <button className={btnPurple} disabled={busy || !value.trim()}>Add</button>
      </form>
      {error && <Callout tone="fail">{error}</Callout>}
      <div className="grid gap-3 sm:grid-cols-3">
        {SAMPLE_LIST_KINDS.map((k) => {
          const items = rows.filter((r) => r.kind === k);
          return (
            <section key={k} className="rounded-xl border border-[#E5EAF2]" aria-label={SAMPLE_LIST_PLURAL[k]}>
              <h3 className="border-b border-[#E5EAF2] px-3 py-2 text-sm font-bold text-[#101B3D]">{SAMPLE_LIST_PLURAL[k]} ({items.length})</h3>
              <ul className="max-h-56 divide-y divide-[#E5EAF2] overflow-y-auto text-sm">
                {items.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="truncate">{r.value}</span>
                    <button className="shrink-0 text-xs font-semibold text-fail hover:underline" onClick={() => { setRemoving(r); setReason(""); }}>Remove</button>
                  </li>
                ))}
                {items.length === 0 && <li className="px-3 py-3 text-xs text-muted">Nothing saved yet.</li>}
              </ul>
            </section>
          );
        })}
      </div>
      {removing && (
        <section className="space-y-2 rounded-xl border border-fail/30 bg-fail-50 p-3" aria-label="Remove entry">
          <p className="text-sm font-semibold">Remove “{removing.value}” from {SAMPLE_LIST_PLURAL[removing.kind]}?</p>
          <label className="block text-sm font-semibold">
            Reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Product discontinued" className={field} />
          </label>
          <div className="flex justify-end gap-2">
            <button className={btnGray} disabled={busy} onClick={() => setRemoving(null)}>Cancel</button>
            <button className={btnRed} disabled={busy || reason.trim().length < 10} onClick={() => void remove()}>Remove</button>
          </div>
        </section>
      )}
      <div className="flex justify-end">
        <button className={btnGray} onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

const LOG_COLUMNS: { key: string; label: string; mono?: boolean; nowrap?: boolean; render: (r: LogEntry) => React.ReactNode }[] = [
  { key: "time", label: "Date & Time", nowrap: true, render: (r) => fmtDate(r.loggedAt) },
  { key: "device", label: "Device", render: (r) => r.deviceCode },
  { key: "product", label: "Sample", render: (r) => r.product || "—" },
  { key: "batch", label: "Batch", render: (r) => r.batch || "—" },
  { key: "ar", label: "AR", render: (r) => r.arNumber || "—" },
  { key: "ph", label: "pH", mono: true, render: (r) => fmt(r.ph) },
  { key: "temp", label: "Temp", mono: true, render: (r) => fmt(r.temperatureC, 1) },
  { key: "mv", label: "mV", mono: true, render: (r) => fmt(r.mv) },
  { key: "stable", label: "Stable", render: (r) => (r.stable ? "Yes" : "No") },
  { key: "method", label: "Method", render: (r) => LOG_METHOD_LABEL[r.method] },
  { key: "operator", label: "Operator", render: (r) => r.loggedBy },
];

function LogsTab({ device, principal, web }: { device: Device | null; principal: Principal; web: string }) {
  const { data: liveData } = useContext(LiveContext);
  const live = liveData?.live ?? null;
  const [state, setState] = useState<{ run: LogRunView | null; calibrating: boolean } | null>(null);
  const [mode, setMode] = useState<"MANUAL" | LogMode>("MANUAL");
  const [interval, setIntervalChoice] = useState("60");
  const [custom, setCustom] = useState("");
  const [details, setDetails] = useState({ product: "", batch: "", arNumber: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "pass" | "fail"; text: string } | null>(null);

  const [search, setSearch] = useState("");
  const [method, setMethod] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [table, setTable] = useState<{ rows: LogEntry[]; total: number } | null>(null);
  const [today, setToday] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [lists, setLists] = useState<SampleListRow[]>([]);
  const [managing, setManaging] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["stable"]));
  const canLog = !!device && principal.permissions.includes("ph.measure");
  const deviceId = device?.id ?? null;
  const columns = LOG_COLUMNS.filter((c) => !hidden.has(c.key));

  const loadLists = useCallback(() => {
    mod<SampleListRow[]>("/sample-lists").then(setLists).catch(() => undefined);
  }, []);
  useEffect(() => {
    loadLists();
  }, [loadLists]);

  const query = useCallback(() => {
    const q = new URLSearchParams();
    if (deviceId) q.set("device", deviceId);
    if (search.trim()) q.set("search", search.trim());
    if (method) q.set("method", method);
    return q;
  }, [deviceId, search, method]);

  const loadTable = useCallback(() => {
    const q = query();
    q.set("page", String(page));
    q.set("pageSize", String(pageSize));
    mod<{ rows: LogEntry[]; total: number }>(`/logs?${q}`)
      .then(setTable)
      .catch((e: HttpError) => {
        if (e.status === 401) location.href = `${web}/login/?reason=session`;
        else setMessage({ tone: "fail", text: e.message });
      });
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const t = new URLSearchParams({ from: midnight.toISOString(), pageSize: "10" });
    if (deviceId) t.set("device", deviceId);
    mod<{ total: number }>(`/logs?${t}`).then((r) => setToday(r.total)).catch(() => undefined);
  }, [query, page, pageSize, web, deviceId]);

  useEffect(() => {
    loadTable();
    const t = setInterval(loadTable, 3000);
    return () => clearInterval(t);
  }, [loadTable]);

  const loadRun = useCallback(() => {
    if (!deviceId) return;
    mod<{ run: LogRunView | null; calibrating: boolean }>(`/instruments/${deviceId}/logging`).then(setState).catch(() => undefined);
  }, [deviceId]);
  useEffect(() => {
    loadRun();
    const t = setInterval(loadRun, 2000);
    return () => clearInterval(t);
  }, [loadRun]);

  async function act(path: string, body: unknown, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await mod(`/instruments/${deviceId}${path}`, send(body));
      if (done) setMessage({ tone: "pass", text: done });
      loadRun();
      loadTable();
    } catch (e) {
      setMessage({ tone: "fail", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function exportFile(format: "csv" | "pdf") {
    setExporting(true);
    setMessage(null);
    try {
      const q = query();
      q.set("format", format);
      await downloadFile(`/logs/export?${q}`);
    } catch (e) {
      setMessage({ tone: "fail", text: (e as Error).message });
    } finally {
      setExporting(false);
    }
  }

  const run = state?.run ?? null;
  const blocked = !device?.readiness.usable || !!state?.calibrating;
  const seconds = interval === "custom" ? Number(custom) : Number(interval);
  const lastPage = Math.max(1, Math.ceil((table?.total ?? 0) / pageSize));
  const stat = (value: React.ReactNode, label: string) => (
    <div className={`${panel} flex-1 p-4`}>
      <p className="text-2xl font-extrabold tabular-nums text-[#071847]">{value}</p>
      <p className="text-xs text-[#566176]">{label}</p>
    </div>
  );
  const fieldLogs = "rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className={pageTitle}>Measurement Logs</h2>
          <p className="text-sm text-[#566176]">Capture, review and export pH measurements</p>
        </div>
        {canLog && mode === "MANUAL" && !run && <button className={btnGreen} disabled={busy || blocked} onClick={() => void act("/logs", details, "Reading logged.")}>Log Reading</button>}
      </div>
      {message && <Callout tone={message.tone}>{message.text}</Callout>}
      {state?.calibrating && <Callout tone="info">A calibration is in progress on this instrument.</Callout>}
      {canLog && (
        <section className={`${panel} space-y-3 p-4`} aria-label="Logging">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#F3F5F9] px-4 py-3">
            <p className="font-bold text-[#071847] tabular-nums">Live: {live?.online ? `${fmt(live.values.PH_VAL)} pH  •  ${fmt(live.values.TEMP_VAL, 1)} °C  •  ${fmt(live.values.MV_VAL)} mV` : "-- pH  •  -- °C  •  -- mV"}</p>
            {run && <button className={btnRed} disabled={busy} onClick={() => void act("/logging/stop", {}, "Logging stopped.")}>Stop Auto-log</button>}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-semibold">
              <span className="block">Logging Mode</span>
              <select disabled={!!run} value={run?.mode ?? mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={`${fieldLogs} mt-1`}>
                {LOG_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>
            {(run?.mode ?? mode) === "INTERVAL" && !run && (
              <label className="text-sm font-semibold">
                <span className="block">Interval</span>
                <select value={interval} onChange={(e) => setIntervalChoice(e.target.value)} className={`${fieldLogs} mt-1`}>
                  {LOG_INTERVALS.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            )}
            {mode === "INTERVAL" && interval === "custom" && !run && (
              <label className="text-sm font-semibold">
                <span className="block">Seconds</span>
                <input inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value)} className={`${fieldLogs} mt-1 w-28`} />
              </label>
            )}
            {mode !== "MANUAL" && !run && <button className={btnGreen} disabled={busy || blocked} onClick={() => void act("/logging/start", { ...details, mode, intervalSeconds: mode === "INTERVAL" ? seconds : undefined })}>Enable Log Mode</button>}
          </div>
          {run?.lastProblem && <Callout tone="fail">{run.lastProblem}</Callout>}
        </section>
      )}
      <div className="flex flex-wrap gap-3">
        {stat(table?.total ?? 0, "Total Logs")}
        {stat(today, "Today")}
        {stat(run ? `${LOG_MODES.find((m) => m.value === run.mode)!.label} Active` : "Log Mode Inactive", run ? `Started by ${run.startedByName} · ${run.count} logged${run.skipped ? ` · ${run.skipped} skipped` : ""}` : "Automatic logging")}
      </div>
      {canLog && (
        <section className={`${panel} flex flex-wrap items-end gap-3 p-4`} aria-label="Sample details">
          {([["product", "Product", "PRODUCT"], ["batch", "Batch", "BATCH"], ["arNumber", "AR Number", "AR"]] as const).map(([k, l, kind]) => (
            <label key={k} className="min-w-[10rem] flex-1 text-sm font-semibold">
              {l}
              <input list={`ph-list-${kind}`} disabled={!!run} value={details[k]} onChange={(e) => setDetails({ ...details, [k]: e.target.value })} placeholder={lists.some((r) => r.kind === kind) ? "Pick from the list or type" : "Type, or save a list"} className={field} />
              <datalist id={`ph-list-${kind}`}>
                {lists.filter((r) => r.kind === kind).map((r) => (
                  <option key={r.id} value={r.value} />
                ))}
              </datalist>
            </label>
          ))}
          <button className={`${baseBtn} border border-[#C7B9F6] bg-[#F3F0FF] text-[#5B4BD8] hover:bg-[#EBE5FF]`} onClick={() => setManaging(true)}>+&nbsp; Add List</button>
        </section>
      )}
      <section className={`${panel} flex flex-wrap items-center gap-2 p-3`} aria-label="Filters">
        <input value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="Search sample, batch, operator..." className={`${fieldLogs} min-w-[14rem] flex-1`} />
        <select aria-label="Method" value={method} onChange={(e) => { setPage(1); setMethod(e.target.value); }} className={fieldLogs}>
          <option value="">All Methods</option>
          {Object.entries(LOG_METHOD_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <details className="relative">
          <summary className={`${btnGray} cursor-pointer list-none`}>Columns&nbsp; ▾</summary>
          <div className="absolute right-0 z-10 mt-1 w-44 rounded-xl border border-[#E2E8F0] bg-white p-2 shadow-lg">
            {LOG_COLUMNS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 px-1 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={!hidden.has(c.key)}
                  onChange={(e) => {
                    const next = new Set(hidden);
                    if (e.target.checked) next.delete(c.key);
                    else next.add(c.key);
                    setHidden(next);
                  }}
                />
                {c.label}
              </label>
            ))}
          </div>
        </details>
        <button className={`${baseBtn} bg-[#EF4444] text-white`} disabled={exporting || !table?.total} onClick={() => void exportFile("pdf")}>PDF</button>
        <button className={`${baseBtn} bg-[#10B981] text-white`} disabled={exporting || !table?.total} onClick={() => void exportFile("csv")}>CSV</button>
        <button className={`${baseBtn} bg-[#3B5BDB] text-white`} disabled={!table?.total} onClick={printArea}>Print</button>
      </section>
      <section className={`${panel} overflow-x-auto`} aria-label="Logs" data-print-area>
        <table className="w-full text-left text-sm">
          <thead className="bg-[#F3F5F9] text-xs uppercase tracking-wide text-[#566176]">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="px-3 py-2.5 whitespace-nowrap">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5EAF2]">
            {table?.rows.map((r) => (
              <tr key={r.id}>
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2.5 ${c.mono ? "font-mono tabular-nums" : ""} ${c.nowrap ? "whitespace-nowrap" : ""}`}>{c.render(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table?.rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-[#566176]">Logged readings appear here.</p>}
        <div className="flex flex-wrap items-center gap-3 border-t border-[#E5EAF2] px-3 py-2 text-sm">
          <span className="text-[#566176]">Rows per page</span>
          <select aria-label="Rows per page" value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }} className={fieldLogs}>
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="flex-1 text-[#566176]">{table?.total ? `Showing ${(page - 1) * pageSize + 1}–${(page - 1) * pageSize + table.rows.length} of ${table.total}` : "No records"}</span>
          <button className={btnGray} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="rounded-lg bg-[#5D5FEF] px-3 py-1.5 font-bold text-white">{page}</span>
          <button className={btnGray} disabled={page === lastPage} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      </section>
      <SampleListManager open={managing} rows={lists} onClose={() => setManaging(false)} onChanged={loadLists} />
    </div>
  );
}

// --- Trends ----------------------------------------------------------------

interface TrendData {
  now: number;
  points: { at: number; ph: number | null; temperatureC: number | null; mv: number | null }[];
  simulated: boolean;
  alarm: { minPh: number; maxPh: number } | null;
}
const SAMPLE_LABELS: [number, string][] = [[5, "5 sec"], [10, "10 sec"], [30, "30 sec"], [60, "1 min"], [180, "3 min"], [300, "5 min"], [600, "10 min"]];

/** Prints only the section marked data-print-area (the trend charts or the logs table). */
function printArea() {
  document.body.classList.add("print-trends");
  window.addEventListener("afterprint", () => document.body.classList.remove("print-trends"), { once: true });
  window.print();
}

function TrendsTab({ deviceId }: { deviceId: string }) {
  const { data: liveData } = useContext(LiveContext);
  const live = liveData?.live ?? null;
  const [windowMinutes, setWindow] = useState(10);
  const [sampleSeconds, setSample] = useState(5);
  const [mode, setMode] = useState<"LIVE" | "HISTORY">("LIVE");
  const [plotting, setPlotting] = useState(true);
  const [frozen, setFrozen] = useState<TrendData | null>(null);
  const [data, setData] = useState<TrendData | null>(null);
  // History shows everything kept on the server (the last hour); Live follows the chosen duration.
  const minutes = mode === "HISTORY" ? 60 : windowMinutes;

  useEffect(() => {
    const load = () =>
      mod<TrendData>(`/instruments/${deviceId}/trend?windowMinutes=${minutes}&sampleSeconds=${sampleSeconds}`)
        .then(setData)
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [deviceId, minutes, sampleSeconds]);

  if (!data) return <p className="text-muted">Loading…</p>;
  // Stop Plotting freezes the charts on screen; the server keeps collecting, so Start catches up.
  const view = plotting ? data : (frozen ?? data);
  const common = { from: view.now - minutes * 60_000, to: view.now, maxGapMs: Math.max(sampleSeconds * 3000, 20_000) };
  const series = (k: "ph" | "temperatureC" | "mv") => view.points.map((p) => ({ at: p.at, value: p[k] }));
  const phs = view.points.map((p) => p.ph).filter((v): v is number => v !== null);
  const select = "rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-sm";
  const readout = (value: string, label: string) => (
    <div className={`${panel} flex-1 px-4 py-3`}>
      <p className="text-xl font-extrabold tabular-nums text-[#071847]">{value}</p>
      <p className="text-xs text-[#566176]">{label}</p>
    </div>
  );
  const summary: [string, string][] = [
    ["Start", view.points.length ? new Date(view.points[0].at).toLocaleTimeString() : "--"],
    ["Samples", String(view.points.length)],
    ["Min pH", phs.length ? Math.min(...phs).toFixed(2) : "--"],
    ["Max pH", phs.length ? Math.max(...phs).toFixed(2) : "--"],
    ["Average pH", phs.length ? (phs.reduce((a, b) => a + b, 0) / phs.length).toFixed(2) : "--"],
    ["Drift", phs.length > 1 ? `${(phs[phs.length - 1] - phs[0]).toFixed(2)} pH` : "--"],
  ];
  const togglePlotting = () => {
    if (plotting) setFrozen(data);
    setPlotting(!plotting);
  };
  return (
    <div className="space-y-3" data-print-area>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className={pageTitle}>Live Trends</h2>
          <p className="text-sm text-[#566176]">Monitor pH, temperature and electrode potential over time</p>
        </div>
        <button className={`${btnGray} print:hidden`} disabled={!view.points.length} onClick={printArea}>Print</button>
      </div>
      <section className={`${panel} flex flex-wrap items-center gap-3 p-3 print:hidden`} aria-label="Trend options">
        <label className="text-sm font-semibold">
          Mode{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value as "LIVE" | "HISTORY")} className={select}>
            <option value="LIVE">Live</option>
            <option value="HISTORY">History (last hour)</option>
          </select>
        </label>
        <label className="text-sm font-semibold">
          Interval{" "}
          <select value={sampleSeconds} onChange={(e) => setSample(Number(e.target.value))} className={select}>
            {SAMPLE_LABELS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold">
          Duration{" "}
          <select value={minutes} disabled={mode === "HISTORY"} onChange={(e) => setWindow(Number(e.target.value))} className={select}>
            <option value={10}>10 min</option>
            <option value={30}>30 min</option>
            <option value={60}>1 hour</option>
          </select>
        </label>
        <button className={plotting ? btnRedOutline : btnGreen} onClick={togglePlotting} aria-pressed={plotting}>
          {plotting ? "■  Stop Plotting" : "▶  Start Plotting"}
        </button>
        {data.simulated && <Badge tone="warn">SIMULATED</Badge>}
      </section>
      <div className="flex flex-wrap gap-3">
        {readout(live?.online ? `${fmt(live.values.PH_VAL)} pH` : "-- pH", "Current pH")}
        {readout(live?.online ? `${fmt(live.values.TEMP_VAL, 1)} °C` : "-- °C", "Temperature")}
        {readout(live?.online ? `${fmt(live.values.MV_VAL)} mV` : "-- mV", "Potential")}
        {readout(!plotting ? "Stopped" : live?.online ? "Plotting" : "Ready", "Status")}
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_15rem]">
        <section className={`${panel} space-y-4 p-4`} aria-label="Live measurement charts">
          <h3 className="font-bold text-[#101B3D]">Live Measurement Charts</h3>
          <TrendChart title="pH Trend" unit="pH" digits={2} points={series("ph")} minSpan={0.5} thresholds={view.alarm ? [{ value: view.alarm.minPh, label: "Alarm min" }, { value: view.alarm.maxPh, label: "Alarm max" }] : []} {...common} />
          <TrendChart title="Temperature Trend (°C)" unit="°C" digits={1} points={series("temperatureC")} minSpan={2} {...common} />
          <TrendChart title="Electrode Potential Trend (mV)" unit="mV" digits={1} points={series("mv")} minSpan={20} {...common} />
          <details className="text-sm print:hidden">
            <summary className="cursor-pointer font-semibold text-[#5D5FEF]">Show as table</summary>
            <div className="mt-2 max-h-72 overflow-auto">
              <table className="w-full text-left">
                <thead className="text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-1 pr-4">Time</th>
                    <th className="py-1 pr-4">pH</th>
                    <th className="py-1 pr-4">°C</th>
                    <th className="py-1">mV</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {[...view.points].reverse().map((p) => (
                    <tr key={p.at}>
                      <td className="py-0.5 pr-4">{new Date(p.at).toLocaleTimeString()}</td>
                      <td className="py-0.5 pr-4">{fmt(p.ph)}</td>
                      <td className="py-0.5 pr-4">{fmt(p.temperatureC, 1)}</td>
                      <td className="py-0.5">{fmt(p.mv, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
        <section className={`${panel} h-fit p-4`} aria-label="Session summary">
          <h3 className="font-bold text-[#101B3D]">Session Summary</h3>
          <dl className="mt-2 divide-y divide-[#E5EAF2] text-sm">
            {summary.map(([k, v]) => (
              <div key={k} className="flex justify-between py-2">
                <dt className="text-[#566176]">{k}</dt>
                <dd className="font-mono font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <p className="text-xs text-[#566176] print:hidden">ⓘ&nbsp; The graph keeps collecting while you navigate away. The last hour is kept.&nbsp;&nbsp;&nbsp; ✓ Auto-save: On</p>
    </div>
  );
}

// --- Alarms ----------------------------------------------------------------

function AlarmsTab({ deviceId, principal, web }: { deviceId: string; principal: Principal; web: string }) {
  const { data: liveData } = useContext(LiveContext);
  const live = liveData?.live ?? null;
  const ph = live?.values.PH_VAL ?? null;
  const online = !!live?.online;
  const [alarm, setAlarm] = useState<{ minPh: number; maxPh: number; monitoring: boolean; active: boolean } | null | undefined>(undefined);
  const [min, setMin] = useState("6.80");
  const [max, setMax] = useState("7.60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(false);
  const canEdit = principal.permissions.includes("ph.measure");

  const load = useCallback(() => {
    mod<{ alarm: typeof alarm }>(`/instruments/${deviceId}/alarm`)
      .then((r) => {
        setAlarm(r.alarm ?? null);
        if (r.alarm && !seeded.current) {
          seeded.current = true;
          setMin(r.alarm.minPh.toFixed(2));
          setMax(r.alarm.maxPh.toFixed(2));
        }
      })
      .catch(() => undefined);
  }, [deviceId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setError(null);
    try {
      await mod(`/instruments/${deviceId}/alarm/${path}`, send(body));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (alarm === undefined) return <p className="text-muted">Loading…</p>;
  const monitoring = !!alarm?.monitoring;
  const low = Number(min);
  const high = Number(max);
  const valid = min.trim() !== "" && max.trim() !== "" && low >= 0 && high <= 14 && low < high;
  const inRange = ph !== null && valid && ph >= low && ph <= high;
  const status = !monitoring ? { text: "Monitoring is off", color: "#667086" } : !online || ph === null ? { text: "Waiting for reading", color: "#667086" } : alarm!.active ? { text: "⚠  Active pH alarm", color: "#D82020" } : { text: "✓  Within range", color: "#08842F" };
  const summary = (value: string, label: string, big?: boolean) => (
    <div className={big ? "flex-[1.4]" : "flex-1"}>
      <p className="text-3xl font-extrabold tabular-nums text-[#071847]" style={monitoring && big && alarm!.active ? { color: "#D82020" } : undefined}>{value}</p>
      <p className="text-xs text-[#566176]">{label}</p>
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className={pageTitle}>pH Alarms</h2>
          <p className="text-sm text-[#566176]">Live range monitoring</p>
        </div>
        <span className="rounded-full border px-3 py-1 text-sm font-semibold" style={monitoring ? { color: "#087A2A", borderColor: "#A7F3D0", background: "#ECFDF5" } : { color: "#667086", borderColor: "#E2E8F0", background: "#fff" }}>● {monitoring ? "Monitoring" : "Inactive"}</span>
      </div>
      {error && <Callout tone="fail">{error}</Callout>}
      <section className={`${panel} flex flex-wrap gap-6 p-5`} aria-label="Current">
        {summary(online && ph !== null ? `${fmt(ph)} pH` : "-- pH", online && ph !== null ? (inRange ? "Within range" : "Outside range") : "Waiting for reading", true)}
        {summary(valid ? low.toFixed(2) : "--", "Minimum")}
        {summary(valid ? high.toFixed(2) : "--", "Maximum")}
      </section>
      <div className="grid gap-3 lg:grid-cols-[1fr_1.15fr]">
        <section className={`${panel} space-y-3 p-5`} aria-label="Operating range">
          <h3 className="font-bold text-[#101B3D]">Operating Range</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-semibold">
              Minimum pH
              <input inputMode="decimal" disabled={monitoring || !canEdit} value={min} onChange={(e) => setMin(e.target.value)} className={`${field} font-mono text-lg`} />
            </label>
            <label className="text-sm font-semibold">
              Maximum pH
              <input inputMode="decimal" disabled={monitoring || !canEdit} value={max} onChange={(e) => setMax(e.target.value)} className={`${field} font-mono text-lg`} />
            </label>
          </div>
          <p className={`rounded-lg px-3 py-2 text-sm font-semibold ${valid ? "bg-[#ECFDF5] text-[#087A2A]" : "bg-[#FEF2F2] text-[#D82020]"}`}>{valid ? `Valid range · ${(high - low).toFixed(2)} pH span` : "Enter a valid range between 0 and 14 pH"}</p>
          {canEdit &&
            (monitoring ? (
              <button className={`${btnRed} w-full`} disabled={busy} onClick={() => void act("stop")}>■&nbsp; Stop Monitoring</button>
            ) : (
              <button className={`${btnGreen} w-full`} disabled={busy || !valid} onClick={() => void act("start", { minPh: low, maxPh: high })}>▶&nbsp; Start Monitoring</button>
            ))}
        </section>
        <section className={`${panel} flex flex-col p-5`} aria-label="Alarm status">
          <h3 className="font-bold text-[#101B3D]">Alarm Status</h3>
          <p className="flex-1 py-6 text-center text-2xl font-extrabold" style={{ color: status.color }} aria-live="polite">{status.text}</p>
          <p className="text-sm text-[#566176]">{monitoring ? "Live readings are being evaluated continuously, even with this page closed." : "Start monitoring to evaluate live readings."}</p>
        </section>
      </div>
      <h3 className="pt-2 font-bold text-[#101B3D]">Alerts for this device</h3>
      <AlertsPage principal={principal} web={web} deviceId={deviceId} />
    </div>
  );
}

function DeviceConsole({ principal, web, tab, onTab }: { principal: Principal; web: string; tab: Tab; onTab: (t: Tab) => void }) {
  const { data, error } = useContext(LiveContext);
  if (!data) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  if (tab === "calibrate") return <CalibrateTab principal={principal} web={web} />;
  if (tab === "logs") return <LogsTab device={data.device} principal={principal} web={web} />;
  if (tab === "trends") return <TrendsTab deviceId={data.device.id} />;
  if (tab === "alarms") return <AlarmsTab deviceId={data.device.id} principal={principal} web={web} />;
  return <OverviewTab principal={principal} onTab={onTab} />;
}

// --- Connections (serial / UART) --------------------------------------------

interface SerialPortRow {
  path: string;
  aliases: string[];
  kind: "USB_UART" | "USB_SERIAL" | "BLUETOOTH" | "SYSTEM";
  chip: string | null;
  manufacturer: string | null;
  serialNumber: string | null;
  vendorId: string | null;
  productId: string | null;
  usable: boolean;
  attachedSince: string | null;
  configured: boolean;
}
interface GatewayView {
  available: SerialPortRow[];
  portListError?: boolean;
  platform?: string;
  configured: { id: string; portPath: string; label: string; baudRate: number; enabled: boolean; status: "OPEN" | "CLOSED" | "ERROR" | "DISABLED"; error: string | null; packets: number; rejected: number; lastPacketAt: string | null; attached?: boolean | null }[];
  connected: { deviceIdentifier: string; deviceId: string; code: string; portPath: string; transport: string; lastSeenAt: string; online: boolean }[];
  unknownDevices: { deviceIdentifier: string; firstSeenAt: string; lastSeenAt: string; portPath: string; count: number }[];
}
const GATEWAY_BAUD = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const PORT_STATUS: Record<GatewayView["configured"][number]["status"], { label: string; tone: Tone }> = {
  OPEN: { label: "Reading", tone: "pass" },
  CLOSED: { label: "Closed", tone: "warn" },
  ERROR: { label: "Error", tone: "fail" },
  DISABLED: { label: "Disabled", tone: "muted" },
};

/**
 * Serial (UART) detection for the pH meters' USB dongle: what is plugged into this computer,
 * which port NxGen reads, and which meters are sending data over it.
 */
function ConnectionsPage({ principal, web }: { principal: Principal; web: string }) {
  const [o, setO] = useState<GatewayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState<SerialPortRow | null>(null);
  const [baud, setBaud] = useState(115200);
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seenBefore = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const canView = principal.permissions.includes("devices.view");
  const canManage = principal.permissions.includes("devices.manage");

  const load = useCallback(async () => {
    try {
      const v = await api<GatewayView>("/gateway");
      // Note adapters that appear while the page is open, so a plug-in is visible at a glance.
      const usable = v.available.filter((a) => a.usable).map((a) => a.path);
      if (seenBefore.current) {
        const added = usable.filter((p) => !seenBefore.current!.has(p));
        if (added.length) setFresh((f) => [...new Set([...f, ...added])]);
      }
      seenBefore.current = new Set(usable);
      setO(v);
      setError(null);
    } catch (e) {
      const err = e as HttpError;
      if (err.status === 401) window.location.href = `${web}/login/?reason=session`;
      else setError(err.message);
    }
  }, [web]);
  useEffect(() => {
    if (!canView) return;
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load, canView]);

  if (!canView) return <Callout tone="warn">Seeing the instrument connections needs the “devices.view” permission.</Callout>;
  if (!o) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Looking for serial ports…</p>;

  const adapters = o.available.filter((a) => a.usable);
  const others = o.available.filter((a) => !a.usable);
  const configuredFor = (a: SerialPortRow) => o.configured.find((c) => c.portPath === a.path || a.aliases.includes(c.portPath));

  async function addPort() {
    if (!adding) return;
    setBusy(true);
    setFormError(null);
    try {
      await api("/gateway/ports", { method: "POST", body: JSON.stringify({ portPath: adding.path, baudRate: baud, label, reason }) });
      setNotice(`NxGen now reads ${adding.path} at ${baud} baud.`);
      setAdding(null);
      setReason("");
      setLabel("");
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const portLine = (a: SerialPortRow) =>
    [a.manufacturer, a.vendorId && a.productId ? `USB ${a.vendorId.toUpperCase()}:${a.productId.toUpperCase()}` : null, a.serialNumber ? `Serial ${a.serialNumber}` : null, a.attachedSince ? `Plugged in ${new Date(a.attachedSince).toLocaleTimeString()}` : null]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-[#566176]">
        pH meters send their readings by radio to the AICAN USB dongle, which passes them to this computer over a serial (UART) connection. This page checks for the dongle every 2 seconds.
      </p>
      {error && <Callout tone="fail">{error}</Callout>}
      {notice && <Callout tone="pass">{notice}</Callout>}

      <section className={`${panel} p-5`} aria-label="Detected serial adapters" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-[#101B3D]">Serial adapters on this computer</h2>
            <p className="text-sm text-[#566176]">USB-to-UART adapters are recognised by their USB IDs (FTDI, Silicon Labs CP210x, WCH CH340, Prolific PL2303 and others).</p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-[#ECFDF5] px-3 py-1 text-xs font-bold text-[#047857]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#10B981]" /> Scanning
          </span>
        </div>

        {o.portListError ? (
          <div className="mt-4"><Callout tone="fail">This computer’s serial ports could not be listed. Check that NxGen is allowed to use serial devices.</Callout></div>
        ) : adapters.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-5 py-8 text-center">
            <p className="text-3xl" aria-hidden>🔌</p>
            <p className="mt-2 font-bold text-[#101B3D]">No USB-to-UART adapter detected</p>
            <p className="mt-1 text-sm text-[#566176]">Plug the dongle into a USB port of this computer. It appears here within a few seconds.</p>
            {o.platform === "darwin" && <p className="mt-1 text-xs text-[#94A3B8]">CH340 and PL2303 adapters on macOS may need the maker’s driver before they show up.</p>}
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {adapters.map((a) => {
              const c = configuredFor(a);
              return (
                <li key={a.path} className={`rounded-xl border p-4 ${fresh.includes(a.path) ? "border-[#10B981] bg-[#F0FDF4]" : "border-[#E5EAF2] bg-white"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-[#101B3D]">{a.chip ?? "USB serial device"}{fresh.includes(a.path) && <span className="ml-2 text-xs font-bold text-[#047857]">Just connected</span>}</p>
                      <p className="truncate font-mono text-xs text-[#33415C]">{a.path}</p>
                      <p className="mt-1 text-xs text-[#566176]">{portLine(a) || "No USB details reported"}</p>
                    </div>
                    {c ? <Badge tone={PORT_STATUS[c.status].tone}>{PORT_STATUS[c.status].label}</Badge> : <Badge tone="muted">Not in use</Badge>}
                  </div>
                  {c ? (
                    <p className="mt-2 text-xs text-[#566176]">
                      {c.label ? `${c.label} · ` : ""}{c.baudRate} baud · {c.packets} packets received{c.rejected ? `, ${c.rejected} rejected` : ""}{c.lastPacketAt ? ` · last ${new Date(c.lastPacketAt).toLocaleTimeString()}` : " · no data yet"}
                      {c.error && <span className="block text-fail">{c.error}</span>}
                    </p>
                  ) : canManage ? (
                    <button className={`${btnPurple} mt-3`} onClick={() => { setFormError(null); setAdding(a); }}>Use for pH meters…</button>
                  ) : (
                    <p className="mt-2 text-xs text-[#566176]">An administrator with “devices.manage” can start reading this port.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {others.length > 0 && (
          <div className="mt-3">
            <button className="text-xs font-semibold text-[#5D5FEF] hover:underline" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Hide" : "Show"} {others.length} other serial port{others.length === 1 ? "" : "s"} (Bluetooth and built-in, not used for meters)
            </button>
            {showAll && (
              <ul className="mt-2 space-y-1 text-xs text-[#566176]">
                {others.map((a) => (
                  <li key={a.path} className="font-mono">{a.path} <span className="font-sans">· {a.kind === "BLUETOOTH" ? "Bluetooth" : "Built-in"}</span></li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {o.configured.some((c) => c.attached === false && c.enabled) && (
        <Callout tone="warn" title="A configured dongle is not plugged in">
          {o.configured.filter((c) => c.attached === false && c.enabled).map((c) => c.portPath).join(", ")}. NxGen reopens it automatically when it is connected again.
        </Callout>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${panel} p-5`} aria-label="Meters sending data">
          <h2 className="font-bold text-[#101B3D]">Meters sending data</h2>
          <ul className="mt-2 divide-y divide-[#E5EAF2] text-sm">
            {o.connected.map((c) => (
              <li key={c.deviceIdentifier} className="flex items-center justify-between gap-3 py-2">
                <a className="font-semibold text-[#5D5FEF] hover:underline" href={`/modules/ph/?device=${c.deviceId}&tab=overview`}>
                  {c.code} <span className="font-mono text-xs font-normal text-[#566176]">{c.deviceIdentifier}</span>
                </a>
                <span className="flex items-center gap-2 text-xs text-[#566176]">
                  {c.transport === "SIMULATOR" && <Badge tone="warn">SIMULATED</Badge>}
                  {c.online ? <Badge tone="pass">ONLINE</Badge> : `last ${fmtDate(c.lastSeenAt)}`}
                </span>
              </li>
            ))}
            {o.connected.length === 0 && <li className="py-3 text-[#566176]">No meter data received since NxGen started.</li>}
          </ul>
        </section>
        <section className={`${panel} p-5`} aria-label="Unregistered senders">
          <h2 className="font-bold text-[#101B3D]">Unregistered senders</h2>
          <ul className="mt-2 divide-y divide-[#E5EAF2] text-sm">
            {o.unknownDevices.map((u) => (
              <li key={u.deviceIdentifier} className="py-2">
                <p className="font-mono font-semibold">{u.deviceIdentifier}</p>
                <p className="text-xs text-[#566176]">
                  {u.count} packets rejected · last {fmtDate(u.lastSeenAt)} on {u.portPath}.{" "}
                  {principal.permissions.includes("devices.manage") ? <a className="font-semibold text-[#5D5FEF] hover:underline" href="/modules/ph/?devices=1">Add it as a pH device ›</a> : "Register a device with this ID to accept its data."}
                </p>
              </li>
            ))}
            {o.unknownDevices.length === 0 && <li className="py-3 text-[#566176]">None.</li>}
          </ul>
        </section>
      </div>

      <Modal open={!!adding} title="Read pH meters from this port" onClose={() => setAdding(null)}>
        {adding && (
          <>
            <p className="text-sm text-[#566176]">
              {adding.chip ?? "USB serial device"} on <span className="font-mono">{adding.path}</span>. NxGen opens the port now and reopens it automatically after it is unplugged and plugged in again.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-semibold">
                Baud rate
                <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} className={field}>
                  {GATEWAY_BAUD.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-semibold">
                Label
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. QC lab dongle" className={field} />
              </label>
            </div>
            <label className="block text-sm font-semibold">
              Reason for the change
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={field} />
            </label>
            {formError && <Callout tone="fail">{formError}</Callout>}
            <div className="flex justify-end gap-3">
              <button className={btnGray} onClick={() => setAdding(null)}>Cancel</button>
              <button className={btnPurple} disabled={busy || reason.trim().length < 5} onClick={() => void addPort()}>Start reading</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

interface Boot {
  web: string;
  version: string;
  principal: Principal;
}

/** Dashboard and Devices share one polled data set and the Add Device dialog. */
function DashboardArea({ boot, page }: { boot: Boot; page: "dashboard" | "devices" }) {
  const dash = useDashboard(boot.web);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ id: string; warning: string | null } | null>(null);
  return (
    <WorkspaceShell web={boot.web} version={boot.version} principal={boot.principal} page={page} title={page === "devices" ? "Devices" : "Dashboard"} subtitle={page === "devices" ? "All registered pH meters, their link, battery, calibration and alerts" : undefined} status={dash}>
      {added && (
        <div className="mb-3">
          <Callout tone={added.warning ? "warn" : "pass"} title="Device added">
            {added.warning && <span className="block">{added.warning}</span>}
            <a className="font-semibold text-brand underline" href={`/modules/ph/?device=${added.id}`}>Open the device</a> to calibrate it before use.
          </Callout>
        </div>
      )}
      {page === "devices" ? (
        <DevicesPage principal={boot.principal} web={boot.web} dash={dash} adding={adding} onAdd={() => setAdding(true)} />
      ) : (
        <DashboardPage principal={boot.principal} web={boot.web} dash={dash} onAddDevice={() => setAdding(true)} />
      )}
      <AddDevice
        principal={boot.principal}
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(r) => {
          setAdding(false);
          setAdded(r);
          dash.reload();
        }}
      />
    </WorkspaceShell>
  );
}

function App() {
  const initialTab = new URLSearchParams(location.search).get("tab");
  const [tab, setTabState] = useState<Tab>(TABS.some((t) => t.id === initialTab) ? (initialTab as Tab) : "overview");
  const setTab = (t: Tab) => {
    setTabState(t);
    const url = new URL(location.href);
    url.searchParams.set("tab", t);
    history.replaceState(null, "", url);
  };
  const [boot, setBoot] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api<{ webBaseUrl: string; module: { version: string } }>("/modules/ph/context"), api<Principal>("/auth/me")])
      .then(([c, p]) => setBoot({ web: c.webBaseUrl, version: c.module.version, principal: p }))
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
  if (device) {
    return (
      <Shell web={boot.web} principal={boot.principal} deviceId={device} tab={tab} onTab={setTab}>
        <DeviceConsole principal={boot.principal} web={boot.web} tab={tab} onTab={setTab} />
      </Shell>
    );
  }
  const page: WorkspacePage = q.get("connections") ? "connections" : q.get("probes") ? "probes" : q.get("calibrations") ? "calibrations" : q.get("alerts") ? "alerts" : q.get("logs") ? "logs" : q.get("limits") ? "limits" : measurement || q.get("measurements") ? "measurements" : q.get("devices") ? "devices" : "dashboard";
  if (page === "dashboard" || page === "devices") return <DashboardArea boot={boot} page={page} />;
  const titles: Record<WorkspacePage, string> = { dashboard: "Dashboard", devices: "Devices", connections: "Connections", alerts: "Alerts", logs: "Logs", measurements: "Measurements", calibrations: "Calibrations", probes: "Probes", limits: "Acceptance limits" };
  return (
    <WorkspaceShell web={boot.web} version={boot.version} principal={boot.principal} page={page} title={titles[page]}>
      {page === "connections" ? (
        <ConnectionsPage principal={boot.principal} web={boot.web} />
      ) : page === "probes" ? (
        <ProbesPage principal={boot.principal} web={boot.web} />
      ) : page === "calibrations" ? (
        <CalibrationsPage device={q.get("device")} web={boot.web} />
      ) : page === "alerts" ? (
        <AlertsPage principal={boot.principal} web={boot.web} />
      ) : page === "logs" ? (
        <LogsTab device={null} principal={boot.principal} web={boot.web} />
      ) : page === "limits" ? (
        <AcceptanceLimits principal={boot.principal} web={boot.web} />
      ) : measurement ? (
        <MeasurementPage id={measurement} principal={boot.principal} web={boot.web} />
      ) : (
        <MeasurementList principal={boot.principal} />
      )}
    </WorkspaceShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
