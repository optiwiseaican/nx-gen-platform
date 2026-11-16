import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { evaluate, Evaluation, RfWindow, TrackInput, validatePlate } from "../shared/tlc";
import { Badge, CONCLUSION, Callout, HttpError, ILLUMINATION_LABEL, Tone, api, card, field, fmtDate, mod, primary, request, secondary, send, session } from "./lib";
import { EvaluationFull, EvaluationSnapshot, EvaluationSummary, ImageMeta, PlateMeta, RfTable } from "./plate";
import { CropStage, EvaluationStage, PictureStage, PlateStage, Stage, StageBar, useWorkbench } from "./stages";
import "./styles.css";

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
  location: string;
  status: string;
  readiness: Readiness;
}
interface Method {
  methodId: string;
  code: string;
  versionId: string;
  versionNumber: number;
  name: string;
  windows: RfWindow[];
  problems: string[];
}
interface Workflow {
  id: string;
  state: "DRAFT" | "IN_REVIEW" | "REVIEWED" | "APPROVED" | "INVALIDATED" | "SUPERSEDED";
  preparedBy: { name: string } | null;
  reviewedBy: { name: string } | null;
  approvedBy: { name: string } | null;
}
interface Analysis {
  id: string;
  code: string;
  deviceId: string;
  deviceCode?: string;
  method: { code: string; version: number; name: string; rfWindows: RfWindow[] };
  sampleId: string;
  batch: string;
  plateType: string;
  plateLot: string;
  mobilePhase: string;
  solventFrontMm: number | null;
  tracks: TrackInput[];
  results: Partial<Evaluation>;
  conclusion: string;
  remarks: string;
  analyzedBy: { id: string; name: string };
  currentPlateId: string | null;
  currentEvaluationId: string | null;
  createdAt: string;
  workflow: Workflow | null;
}
interface AnalysisDetail extends Analysis {
  images: ImageMeta[];
  device: Device | null;
  plate: PlateMeta | null;
  evaluations: EvaluationSummary[];
}
interface Signature {
  meaningLabel: string;
  signerFullName: string;
  signerUsername: string;
  signedAt: string;
  reason: string;
  contentHash: string;
  intact: boolean;
}
interface WorkflowDetail {
  instance: Workflow;
  allowedSteps: Step[];
  history: { id: string; step: string; toState: string; actorName: string | null; comment: string | null; occurredAt: string; signature: Signature | null }[];
}
type Step = "SUBMIT" | "WITHDRAW" | "REVIEW" | "APPROVE" | "REJECT" | "INVALIDATE";

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const STATE: Record<Workflow["state"], { label: string; tone: Tone }> = {
  DRAFT: { label: "DRAFT", tone: "muted" },
  IN_REVIEW: { label: "IN REVIEW", tone: "warn" },
  REVIEWED: { label: "REVIEWED", tone: "warn" },
  APPROVED: { label: "APPROVED", tone: "pass" },
  INVALIDATED: { label: "INVALIDATED", tone: "fail" },
  SUPERSEDED: { label: "SUPERSEDED", tone: "muted" },
};

function useSessionTick() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    session.listeners.add(f);
    const t = setInterval(f, 1000);
    return () => {
      session.listeners.delete(f);
      clearInterval(t);
    };
  }, []);
}

function SessionTimer({ className = "" }: { className?: string }) {
  useSessionTick();
  if (!session.maxExpiresAt) return null;
  const s = Math.max(0, Math.ceil((session.maxExpiresAt - Date.now()) / 1000));
  const seconds = String(s % 60).padStart(2, "0");
  const text = s < 3600 ? `${Math.floor(s / 60)}:${seconds}` : `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${seconds}`;
  return (
    <span role="timer" aria-label="Time until the session ends" className={`text-muted ${className}`}>
      Session ends in <span className="font-mono font-semibold tabular-nums">{text}</span>
    </span>
  );
}

function SessionBanner() {
  useSessionTick();
  if (!session.idleExpiresAt) return null;
  const left = session.idleExpiresAt - Date.now();
  if (left > 120_000 || left <= 0) return null;
  const s = Math.ceil(left / 1000);
  return (
    <div className="border-b border-warn/30 bg-warn-50 px-4 py-2 text-center text-sm" role="alert">
      You will be signed out in {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} because of inactivity.{" "}
      <button className="font-semibold text-brand underline" onClick={() => void request("/auth/session/extend", send({}))}>
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
const ICON = {
  plate: "M5 3.5h14v17H5zM9 16.5v.01M12 16.5v.01M15 16.5v.01M9 11a1.5 1.5 0 1 0 0-.01M15 8a1.5 1.5 0 1 0 0-.01M5 18.5h14",
  home: "M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19z",
  list: "M9 6.5h11M9 12h11M9 17.5h11M4 6.5h.01M4 12h.01M4 17.5h.01",
  tasks: "M9 6.5h11M9 12h11M9 17.5h11M4 6.5l1 1 2-2M4 12l1 1 2-2M4 17.5l1 1 2-2",
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
      className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[15px] font-semibold ${active ? "bg-brand-50 text-brand" : "text-ink/75 hover:bg-canvas hover:text-ink"}`}
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
          <span className="inline-grid h-11 w-11 place-items-center rounded-[30%] bg-gradient-to-br from-[#3b82f6] via-brand to-[#1e40af] text-white shadow-[var(--shadow-brand)]" aria-hidden>
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 3.5h5M10.5 3.5v5.5L6 17a2.2 2.2 0 0 0 1.9 3.3h8.2A2.2 2.2 0 0 0 18 17l-4.5-8V3.5" />
              <path d="m9.5 15 1.8 1.8 3.3-3.3" />
            </svg>
          </span>
          <span className="leading-tight">
            <span className="block text-lg font-extrabold tracking-tight">
              Nx<span className="text-brand">Gen</span>
            </span>
            <span className="block text-[13px] font-semibold text-muted">TLC module</span>
          </span>
        </a>
        <nav aria-label="Main" className="flex flex-wrap gap-1 px-3 pb-3 lg:flex-1 lg:flex-col lg:flex-nowrap lg:space-y-1">
          <p className="hidden px-3.5 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted/70 lg:block">TLC</p>
          {item("/modules/tlc/", "Plate analyses", ICON.plate, true)}
          <p className="hidden px-3.5 pt-4 pb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted/70 lg:block">NxGen</p>
          {item(`${web}/home/`, "Home", ICON.home)}
          {item(`${web}/tasks/`, "My Tasks", ICON.tasks)}
          {item(`${web}/methods/`, "Methods", ICON.list)}
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
            <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-muted">TLC module</p>
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
        <main className="max-w-[84rem] space-y-6 px-4 py-6 sm:px-8">{children}</main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function Home({ principal }: { principal: Principal }) {
  const [rows, setRows] = useState<Analysis[] | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mod<Analysis[]>("/analyses").then(setRows).catch((e: Error) => setError(e.message));
    mod<{ devices: Device[] }>("/setup").then((s) => setDevices(s.devices)).catch(() => undefined);
  }, []);
  if (error) return <Callout tone="fail">{error}</Callout>;
  const canAnalyze = principal.permissions.includes("tlc.analyze");
  const canCalibrate = principal.permissions.includes("calibration.perform");
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted">
          Each plate analysis uses an approved TLC method and a usable instrument. Plate images are kept as original records with their SHA-256; the plate
          is straightened and scanned by densitometry, Rf values are calculated by NxGen, and the analysis is reviewed and approved with electronic signatures.
        </p>
        {canAnalyze && (
          <a href="/modules/tlc/?new=1" className={primary}>
            New analysis
          </a>
        )}
      </div>
      <section className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-[#f7f9fd] text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Analysis</th>
              <th className="px-4 py-3">Sample</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(rows ?? []).map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-3">
                  <a href={`/modules/tlc/?analysis=${a.id}`} className="font-semibold text-brand hover:underline">
                    {a.code}
                  </a>
                  <p className="text-xs text-muted">
                    {a.deviceCode} · {fmtDate(a.createdAt)}
                  </p>
                </td>
                <td className="px-4 py-3">
                  {a.sampleId}
                  {a.batch && <span className="text-muted"> · {a.batch}</span>}
                </td>
                <td className="px-4 py-3">
                  {a.method.code} v{a.method.version}
                </td>
                <td className="px-4 py-3">
                  <Badge tone={CONCLUSION[a.conclusion].tone}>{CONCLUSION[a.conclusion].label}</Badge>
                </td>
                <td className="px-4 py-3">{a.workflow && <Badge tone={STATE[a.workflow.state].tone}>{STATE[a.workflow.state].label}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No TLC analyses yet.</p>}
        {!rows && <p className="px-4 py-6 text-center text-sm text-muted">Loading…</p>}
      </section>
      <section className={card}>
        <h2 className="font-bold">TLC instruments</h2>
        <ul className="mt-3 divide-y divide-line text-sm">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <span>
                <span className="font-semibold">{d.code}</span> · {d.name} <span className="text-muted">· {d.location || "—"}</span>
              </span>
              <span className="flex items-center gap-3">
                <Badge tone={d.readiness.usable ? (d.readiness.state === "DUE_SOON" ? "warn" : "pass") : "fail"}>{d.readiness.state.replace(/_/g, " ")}</Badge>
                {canCalibrate && d.status === "ACTIVE" && (
                  <a href={`/modules/tlc/?device=${d.id}`} className="font-semibold text-brand hover:underline">
                    Instrument check
                  </a>
                )}
              </span>
            </li>
          ))}
          {devices.length === 0 && <li className="py-2.5 text-muted">No TLC instruments registered. Register one under NxGen → Instruments.</li>}
        </ul>
      </section>
    </>
  );
}

function NewAnalysis() {
  const [setup, setSetup] = useState<{ devices: Device[]; methods: Method[] } | null>(null);
  const [f, setF] = useState({ deviceId: "", methodVersionId: "", sampleId: "", batch: "", plateType: "Silica gel 60 F254 (glass)", plateLot: "", mobilePhase: "", remarks: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mod<{ devices: Device[]; methods: Method[] }>("/setup")
      .then((s) => {
        setSetup(s);
        setF((x) => ({ ...x, deviceId: s.devices.find((d) => d.readiness.usable)?.id ?? "", methodVersionId: s.methods.find((m) => m.windows.length)?.versionId ?? "" }));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  if (!setup) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const method = setup.methods.find((m) => m.versionId === f.methodVersionId);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await mod<Analysis>("/analyses", send(f));
      location.href = `/modules/tlc/?analysis=${a.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className={`${card} max-w-4xl space-y-5`}>
      {!setup.methods.length && (
        <Callout tone="warn" title="No approved TLC method">
          Create a method for a TLC scanner under NxGen → Methods, with a parameter per compound whose unit is “Rf” (e.g. Paracetamol, 0.40–0.50,
          Rf), and have it reviewed and approved.
        </Callout>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="text-sm font-semibold">
          Instrument
          <select value={f.deviceId} onChange={set("deviceId")} className={field}>
            <option value="">Choose…</option>
            {setup.devices.map((d) => (
              <option key={d.id} value={d.id} disabled={!d.readiness.usable}>
                {d.code} · {d.name}
                {!d.readiness.usable && ` (${d.readiness.state.replace(/_/g, " ").toLowerCase()})`}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold">
          Approved method
          <select value={f.methodVersionId} onChange={set("methodVersionId")} className={field}>
            <option value="">Choose…</option>
            {setup.methods.map((m) => (
              <option key={m.versionId} value={m.versionId}>
                {m.code} v{m.versionNumber} · {m.name}
              </option>
            ))}
          </select>
          {method && (
            <span className="mt-1 block text-xs font-normal text-muted">
              {method.windows.length
                ? `Rf windows: ${method.windows.map((w) => `${w.compound} ${w.min}–${w.max}`).join(", ")}`
                : "This method has no Rf windows (parameters with unit Rf)."}
            </span>
          )}
        </label>
        <label className="text-sm font-semibold">
          Sample ID
          <input value={f.sampleId} onChange={set("sampleId")} className={field} placeholder="e.g. SMP-2026-1187" required />
        </label>
        <label className="text-sm font-semibold">
          Batch
          <input value={f.batch} onChange={set("batch")} className={field} placeholder="e.g. B-24-0311" />
        </label>
        <label className="text-sm font-semibold">
          Plate type
          <input value={f.plateType} onChange={set("plateType")} className={field} />
        </label>
        <label className="text-sm font-semibold">
          Plate lot
          <input value={f.plateLot} onChange={set("plateLot")} className={field} placeholder="e.g. HX38412" />
        </label>
      </div>
      <label className="block text-sm font-semibold">
        Mobile phase
        <input value={f.mobilePhase} onChange={set("mobilePhase")} className={field} placeholder="e.g. Toluene : ethyl acetate : formic acid (5:4:1)" />
      </label>
      <label className="block text-sm font-semibold">
        Remarks
        <textarea rows={2} value={f.remarks} onChange={set("remarks")} className={field} />
      </label>
      {error && <Callout tone="fail">{error}</Callout>}
      <div className="flex justify-end gap-3">
        <a href="/modules/tlc/" className={secondary}>
          Cancel
        </a>
        <button className={primary} disabled={busy}>
          {busy ? "Creating…" : "Create analysis"}
        </button>
      </div>
    </form>
  );
}

const STEP_UI: Record<Step, { label: string; title: string; meaning?: string; minReason: number; tone: "primary" | "secondary" }> = {
  SUBMIT: { label: "Submit for review…", title: "Submit for review", meaning: "Authored", minReason: 0, tone: "primary" },
  WITHDRAW: { label: "Withdraw…", title: "Withdraw to draft", minReason: 10, tone: "secondary" },
  REVIEW: { label: "Review…", title: "Sign as reviewed", meaning: "Reviewed", minReason: 0, tone: "primary" },
  APPROVE: { label: "Approve…", title: "Approve the analysis", meaning: "Approved", minReason: 0, tone: "primary" },
  REJECT: { label: "Reject…", title: "Reject the analysis", meaning: "Rejected", minReason: 10, tone: "secondary" },
  INVALIDATE: { label: "Invalidate…", title: "Invalidate the approved analysis", meaning: "Invalidated", minReason: 10, tone: "secondary" },
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

/** The manual path: spot distances typed in, for a plate without a usable image. */
function ManualEvaluation({ a, editable, onSaved }: { a: AnalysisDetail; editable: boolean; onSaved: (message: string) => Promise<void> }) {
  const [front, setFront] = useState(a.solventFrontMm === null ? "" : String(a.solventFrontMm));
  const [tracks, setTracks] = useState<TrackInput[]>(
    a.tracks.length
      ? a.tracks
      : [
          { label: "S1", role: "STANDARD", spots: [] },
          { label: "T1", role: "SAMPLE", spots: [] },
        ],
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const frontMm = front.trim() ? Number(front) : null;
  const problems = validatePlate(frontMm, tracks);
  const preview: Evaluation | null = !problems.length && frontMm ? evaluate(frontMm, tracks, a.method.rfWindows) : null;
  const compounds = a.method.rfWindows.map((w) => w.compound);
  const setTrack = (i: number, t: Partial<TrackInput>) => setTracks(tracks.map((x, j) => (j === i ? { ...x, ...t } : x)));

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await mod(`/analyses/${a.id}/evaluation`, send({ solventFrontMm: frontMm, tracks }, "PUT"));
      await onSaved("Manual evaluation saved. NxGen recalculated the Rf values and the conclusion.");
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!editable) {
    const shown = a.results as Evaluation;
    return shown?.tracks ? <RfTable evaluation={shown} title="Result (distances entered by hand)" /> : <p className="text-sm text-muted">Not evaluated.</p>;
  }
  return (
    <div className="space-y-4">
      <label className="block max-w-xs text-sm font-semibold">
        Solvent front from origin (mm)
        <input inputMode="decimal" value={front} onChange={(e) => setFront(e.target.value)} className={`${field} font-mono`} />
      </label>
      <div className="space-y-3">
        {tracks.map((t, i) => (
          <div key={i} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm font-semibold">
                Track
                <input aria-label={`Manual track ${i + 1} label`} value={t.label} onChange={(e) => setTrack(i, { label: e.target.value })} className={`${field} w-24`} />
              </label>
              <label className="text-sm font-semibold">
                Applied
                <select aria-label={`Manual track ${i + 1} role`} value={t.role} onChange={(e) => setTrack(i, { role: e.target.value as TrackInput["role"] })} className={field}>
                  <option value="STANDARD">Reference standard</option>
                  <option value="SAMPLE">Sample</option>
                </select>
              </label>
              <button type="button" className="pb-2 text-sm font-semibold text-fail hover:underline" onClick={() => setTracks(tracks.filter((_, j) => j !== i))}>
                Remove track
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {t.spots.map((s, k) => (
                <div key={k} className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    aria-label={`Manual track ${i + 1} spot ${k + 1} distance`}
                    inputMode="decimal"
                    placeholder="mm"
                    value={Number.isNaN(s.distanceMm) ? "" : s.distanceMm || ""}
                    onChange={(e) => setTrack(i, { spots: t.spots.map((x, m) => (m === k ? { ...x, distanceMm: e.target.value === "" ? NaN : Number(e.target.value) } : x)) })}
                    className="w-24 rounded-xl border border-line px-3 py-1.5 font-mono"
                  />
                  <select
                    aria-label={`Manual track ${i + 1} spot ${k + 1} compound`}
                    value={s.compound}
                    onChange={(e) => setTrack(i, { spots: t.spots.map((x, m) => (m === k ? { ...x, compound: e.target.value } : x)) })}
                    className="rounded-xl border border-line bg-white px-3 py-1.5"
                  >
                    <option value="">Unassigned spot</option>
                    {compounds.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  {frontMm && Number.isFinite(s.distanceMm) && s.distanceMm > 0 && <span className="font-mono text-muted">Rf {(s.distanceMm / frontMm).toFixed(3)}</span>}
                  <button type="button" className="text-fail hover:underline" onClick={() => setTrack(i, { spots: t.spots.filter((_, m) => m !== k) })}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="text-sm font-semibold text-brand hover:underline" onClick={() => setTrack(i, { spots: [...t.spots, { distanceMm: NaN, compound: "" }] })}>
                + Add spot
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="text-sm font-semibold text-brand hover:underline" onClick={() => setTracks([...tracks, { label: `T${tracks.length}`, role: "SAMPLE", spots: [] }])}>
          + Add track
        </button>
      </div>
      {problems.length > 0 && <p className="text-sm text-muted">{problems.join(" ")}</p>}
      {preview && <RfTable evaluation={preview} title="Preview" />}
      {saveError && <Callout tone="fail">{saveError}</Callout>}
      <button className={primary} onClick={() => void save()} disabled={saving || problems.length > 0}>
        {saving ? "Saving…" : "Save manual evaluation"}
      </button>
    </div>
  );
}

/** The Plate and Evaluation stages share one workbench (decoded plate, layout, tracks, settings). */
function WorkbenchStages({
  stage,
  a,
  current,
  editable,
  onContinue,
  onSaved,
}: {
  stage: Stage;
  a: AnalysisDetail;
  current: EvaluationFull | null;
  editable: boolean;
  onContinue: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const wb = useWorkbench(a.plate!, a.method.rfWindows, current, editable);
  if (stage === "PLATE") return <PlateStage wb={wb} analysis={a} editable={editable} onContinue={onContinue} />;
  return <EvaluationStage wb={wb} windows={a.method.rfWindows} analysisId={a.id} current={current} editable={editable} onSaved={onSaved} />;
}

function AnalysisPage({ id, principal, web }: { id: string; principal: Principal; web: string }) {
  const [a, setA] = useState<AnalysisDetail | null>(null);
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [current, setCurrent] = useState<EvaluationFull | null>(null);
  const [snapshot, setSnapshot] = useState<EvaluationFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [pictureId, setPictureId] = useState<string | null>(null);
  const [crop, setCrop] = useState<{ imageId: string; override: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const x = await mod<AnalysisDetail>(`/analyses/${id}`);
      setA(x);
      setCurrent(x.currentEvaluationId ? await mod<EvaluationFull>(`/evaluations/${x.currentEvaluationId}`) : null);
      if (x.workflow) setWf(await api<WorkflowDetail>(`/workflow/instances/${x.workflow.id}`));
      return x;
    } catch (e) {
      if ((e as HttpError).status === 401) location.href = `${web}/login/?reason=session`;
      else setError((e as Error).message);
      return null;
    }
  }, [id, web]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!a || !wf) return <p className="text-muted">Loading…</p>;

  const editable = wf.instance.state === "DRAFT" && a.analyzedBy.id === principal.userId && principal.permissions.includes("tlc.analyze");
  const currentOnPlate = current && a.plate && current.plateId === a.plate.id ? current : null;
  // Where the analyst left off, as the tablet reopens a project at its last stage.
  const resumeStage: Stage = !editable ? "SIGNOFF" : !a.plate ? "PICTURE" : currentOnPlate ? "EVALUATION" : "PLATE";
  const shown: Stage = stage ?? resumeStage;
  const cropImage = crop ? a.images.find((i) => i.id === crop.imageId) : a.plate ? a.images.find((i) => i.id === a.plate!.imageId) : null;
  const reachable = (s: Stage) => (s === "PICTURE" || s === "SIGNOFF" ? true : s === "CROP" ? !!(cropImage ?? a.images[0]) : !!a.plate);

  const saved = async (message: string) => {
    await load();
    setNotice(message);
    setSaveError(null);
  };
  async function sign(comment: string, password: string) {
    const ui = STEP_UI[step!];
    await api(`/workflow/instances/${wf!.instance.id}/${step!.toLowerCase()}`, send({ reason: comment, signature: ui.meaning ? { username: principal.username, password } : undefined }));
    const done = step!;
    await load(); // show the new (locked) state before announcing it
    setStep(null);
    setStage("SIGNOFF");
    setNotice(
      { SUBMIT: "Submitted for review and locked.", WITHDRAW: "Withdrawn to draft.", REVIEW: "Signed as reviewed.", APPROVE: "Approved.", REJECT: "Rejected.", INVALIDATE: "Invalidated." }[done],
    );
  }
  async function openSnapshot(e: EvaluationSummary) {
    try {
      setSnapshot(await mod<EvaluationFull>(`/evaluations/${e.id}`));
    } catch (err) {
      setSaveError((err as Error).message);
    }
  }

  const stages = [
    { label: "Prepared", who: wf.instance.preparedBy?.name, done: wf.instance.state !== "DRAFT" },
    { label: "Reviewed", who: wf.instance.reviewedBy?.name, done: ["REVIEWED", "APPROVED", "INVALIDATED", "SUPERSEDED"].includes(wf.instance.state) },
    { label: "Approved", who: wf.instance.approvedBy?.name, done: ["APPROVED", "INVALIDATED", "SUPERSEDED"].includes(wf.instance.state) },
  ];
  const usesImages = !!a.plate || (!a.tracks.length && a.images.length > 0);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm text-muted">
            {a.code} · {a.device?.code} {a.device?.name} · {a.method.code} v{a.method.version}
          </p>
          <h2 className="text-xl font-bold">
            {a.sampleId}
            {a.batch && <span className="font-normal text-muted"> · batch {a.batch}</span>}
          </h2>
        </div>
        <span className="flex gap-2">
          <Badge tone={STATE[wf.instance.state].tone}>{STATE[wf.instance.state].label}</Badge>
          <Badge tone={CONCLUSION[a.conclusion].tone}>{CONCLUSION[a.conclusion].label}</Badge>
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white px-3 py-2 shadow-[var(--shadow-card)]">
        <StageBar stage={shown} reachable={reachable} onStage={(s) => (setStage(s), setNotice(null))} />
        <span className="text-xs text-muted">
          Rf windows: {a.method.rfWindows.map((w) => `${w.compound} ${w.min}–${w.max}`).join(", ") || "none"}
        </span>
      </div>
      {notice && <Callout tone="pass">{notice}</Callout>}
      {saveError && <Callout tone="fail">{saveError}</Callout>}

      {shown === "PICTURE" && (
        <PictureStage
          analysisId={a.id}
          images={a.images}
          selectedId={pictureId}
          editable={editable}
          onSelect={setPictureId}
          onUploaded={async (message, imageId) => {
            await saved(message);
            setPictureId(imageId);
          }}
          onUse={(img, override) => (setCrop({ imageId: img.id, override }), setStage("CROP"), setNotice(null))}
        />
      )}
      {shown === "CROP" &&
        (cropImage ?? a.images[0] ? (
          <CropStage
            key={(cropImage ?? a.images[0]).id}
            analysisId={a.id}
            image={cropImage ?? a.images[0]}
            plate={a.plate}
            overrideReason={crop?.override ?? a.plate?.qcOverrideReason ?? ""}
            editable={editable}
            onStraightened={async (message) => {
              await saved(message);
              setStage("PLATE");
            }}
          />
        ) : (
          <Callout tone="warn">Upload a plate image first.</Callout>
        ))}
      {(shown === "PLATE" || shown === "EVALUATION") &&
        (a.plate ? (
          <WorkbenchStages key={a.plate.id} stage={shown} a={a} current={currentOnPlate} editable={editable} onContinue={() => setStage("EVALUATION")} onSaved={saved} />
        ) : (
          <Callout tone="warn">Straighten the plate first (Picture → Crop).</Callout>
        ))}

      {shown === "SIGNOFF" && (
        <>
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
          {wf.allowedSteps.length > 0 && (
            <div className="flex flex-wrap gap-3">
              {wf.allowedSteps.map((s) => (
                <button key={s} className={STEP_UI[s].tone === "primary" ? primary : secondary} onClick={() => setStep(s)}>
                  {STEP_UI[s].label}
                </button>
              ))}
            </div>
          )}
          {a.plate && current && !currentOnPlate && editable && (
            <Callout tone="warn" title="The plate was straightened again">
              The last evaluation ({current.code}) belongs to the earlier plate. Evaluate the current plate before submitting.
            </Callout>
          )}
          <section className={card}>
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              {[
                ["Method", `${a.method.code} v${a.method.version} · ${a.method.name}`],
                ["Rf windows", a.method.rfWindows.map((w) => `${w.compound} ${w.min}–${w.max}`).join(", ") || "—"],
                ["Plate", `${a.plateType}${a.plateLot ? ` · lot ${a.plateLot}` : ""}`],
                ["Mobile phase", a.mobilePhase || "—"],
                ["Analyst", a.analyzedBy.name],
                ["Created", fmtDate(a.createdAt)],
                ["Images", a.images.map((i) => `${ILLUMINATION_LABEL[i.illumination]} (${i.qc ? i.qc.verdict.replace(/_/g, " ").toLowerCase() : "not judged"})`).join(", ") || "none"],
                ["Straightened plate", a.plate ? `${a.plate.widthMm} × ${a.plate.heightMm} mm · SHA-256 ${a.plate.pixelsSha256.slice(0, 16)}…${a.plate.qcOverrideReason ? " · quality gate overridden" : ""}` : "—"],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-[9rem_1fr] gap-3">
                  <dt className="text-muted">{k}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          {a.plate?.qcOverrideReason && (
            <Callout tone="warn" title="Capture quality gate overridden">
              {a.plate.qcOverrideReason}
            </Callout>
          )}

          {a.evaluations.length > 0 && (
            <section className={`${card} space-y-3`}>
              <h3 className="font-bold">Evaluation snapshots</h3>
              <p className="text-sm text-muted">Every evaluation is kept unchanged with a hash over its inputs and results. The latest one on the current plate is the analysis result.</p>
              <ul className="divide-y divide-line text-sm">
                {a.evaluations.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <b>{e.code}</b> · {e.createdBy} · {fmtDate(e.createdAt)} · {e.tracks} track{e.tracks === 1 ? "" : "s"}, {e.spots} spot{e.spots === 1 ? "" : "s"}
                      {a.plate && e.plateId !== a.plate.id && <span className="text-muted"> · earlier plate</span>}
                    </span>
                    <span className="flex items-center gap-3">
                      <Badge tone={CONCLUSION[e.conclusion].tone}>{CONCLUSION[e.conclusion].label}</Badge>
                      {e.id === a.currentEvaluationId && <Badge tone="info">CURRENT</Badge>}
                      <button className="font-semibold text-brand hover:underline" onClick={() => void openSnapshot(e)}>
                        {snapshot?.id === e.id ? "Shown below" : "Show"}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              {snapshot && (
                <div className="rounded-xl border border-line p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h4 className="font-semibold">Snapshot {snapshot.code}</h4>
                    <button className="text-sm font-semibold text-brand hover:underline" onClick={() => setSnapshot(null)}>
                      Hide
                    </button>
                  </div>
                  <EvaluationSnapshot evaluation={snapshot} plate={a.plate} />
                </div>
              )}
            </section>
          )}
          {a.evaluations.length === 0 && !usesImages && (
            <section className={`${card} space-y-4`}>
              <h3 className="font-bold">Evaluation</h3>
              <ManualEvaluation a={a} editable={false} onSaved={saved} />
            </section>
          )}
          {editable && (
            <section className={`${card} space-y-4`}>
              <details open={!a.plate && a.tracks.length > 0}>
                <summary className="cursor-pointer font-bold">Enter spot distances by hand instead</summary>
                <p className="mt-1 mb-3 text-sm text-muted">For a plate read with a ruler. A manual evaluation replaces the densitometry result as the analysis conclusion.</p>
                <ManualEvaluation a={a} editable onSaved={saved} />
              </details>
            </section>
          )}

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
        </>
      )}
      <StepDialog step={step} principal={principal} onClose={() => setStep(null)} onSign={sign} />
    </>
  );
}

const DEFAULT_CHECKS = [
  { check: "Camera focus on reference plate", expected: "Sharp edges, no blur", observed: "", pass: true },
  { check: "White light uniformity", expected: "Even illumination", observed: "", pass: true },
  { check: "UV 254 nm lamp", expected: "On, fluorescence visible", observed: "", pass: true },
  { check: "UV 366 nm lamp", expected: "On, fluorescence visible", observed: "", pass: true },
];

function InstrumentCheck({ deviceId, web }: { deviceId: string; web: string }) {
  const [device, setDevice] = useState<Device | null>(null);
  const [checks, setChecks] = useState(DEFAULT_CHECKS);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ calibrationId: string; code: string } | null>(null);
  useEffect(() => {
    mod<{ devices: Device[] }>("/setup")
      .then((s) => setDevice(s.devices.find((d) => d.id === deviceId) ?? null))
      .catch((e: Error) => setError(e.message));
  }, [deviceId]);
  async function record(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setDone(await mod<{ calibrationId: string; code: string }>(`/instruments/${deviceId}/calibrations`, send({ readings: checks, remarks })));
    } catch (err) {
      setError((err as Error).message);
    }
  }
  if (!device) return error ? <Callout tone="fail">{error}</Callout> : <p className="text-muted">Loading…</p>;
  return (
    <form onSubmit={record} className={`${card} max-w-4xl space-y-4`}>
      <h2 className="text-lg font-bold">
        {device.code} · {device.name}
      </h2>
      <p className="text-sm text-muted">Record the instrument check. It is saved as a draft calibration that you submit and a QA approver signs in NxGen.</p>
      {done ? (
        <Callout tone="pass" title={`${done.code} saved as a draft`}>
          <a className="font-semibold text-brand underline" href={`${web}/devices/view/?calibration=${done.calibrationId}`}>
            Open it to submit for approval
          </a>
          .
        </Callout>
      ) : (
        <>
          {checks.map((c, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1.4fr_1.4fr_auto] sm:items-center">
              <span className="text-sm font-semibold">{c.check}</span>
              <span className="text-sm text-muted">{c.expected}</span>
              <input
                aria-label={`${c.check} observed`}
                placeholder="Observed"
                value={c.observed}
                onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, observed: e.target.value } : x)))}
                className="rounded-xl border border-line px-3 py-2 text-sm"
              />
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={c.pass} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, pass: e.target.checked } : x)))} />
                Pass
              </label>
            </div>
          ))}
          <label className="block text-sm font-semibold">
            Remarks
            <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} className={field} />
          </label>
          {error && <Callout tone="fail">{error}</Callout>}
          <button className={primary}>Save instrument check as draft</button>
        </>
      )}
    </form>
  );
}

function App() {
  const [boot, setBoot] = useState<{ web: string; principal: Principal } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api<{ webBaseUrl: string }>("/modules/tlc/context"), api<Principal>("/auth/me")])
      .then(([c, p]) => setBoot({ web: c.webBaseUrl, principal: p }))
      .catch((e: HttpError) => {
        if (e.status === 401 || e.status === 403) location.href = `${location.port === "4000" ? "http://localhost:3000" : ""}/login/?reason=session`;
        else setError(e.message);
      });
  }, []);
  if (error)
    return (
      <div className="p-8">
        <Callout tone="fail">{error}</Callout>
      </div>
    );
  if (!boot) return <p className="p-8 text-muted">Loading…</p>;
  const q = new URLSearchParams(location.search);
  const analysis = q.get("analysis");
  const device = q.get("device");
  const title = analysis ? "Plate analysis" : q.get("new") ? "New plate analysis" : device ? "Instrument check" : "Plate analyses";
  return (
    <Shell web={boot.web} principal={boot.principal} title={title}>
      {analysis ? (
        <AnalysisPage id={analysis} principal={boot.principal} web={boot.web} />
      ) : q.get("new") ? (
        <NewAnalysis />
      ) : device ? (
        <InstrumentCheck deviceId={device} web={boot.web} />
      ) : (
        <Home principal={boot.principal} />
      )}
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
