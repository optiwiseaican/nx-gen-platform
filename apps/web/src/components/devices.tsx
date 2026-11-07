"use client";

import { useState } from "react";
import {
  ApiError,
  CalibrationInput,
  CalibrationOutcome,
  CalibrationRecord,
  CheckReading,
  DeviceInput,
  DeviceReadiness,
  INSTRUMENT_LABELS,
  InstrumentType,
  PhReading,
  Readiness,
} from "@/lib/api";
import { PH_LIMITS, previewPh } from "@/lib/calibration";
import { formatDate } from "./admin";
import { TextField } from "./forms";
import { Badge, Button, Callout } from "./ui";
import { WorkflowActions, WorkflowBadge, WorkflowHistory, WorkflowStepper } from "./workflow";

const READINESS_LABEL: Record<Readiness, string> = {
  READY: "Ready",
  DUE_SOON: "Calibration due soon",
  OVERDUE: "Calibration overdue",
  NOT_CALIBRATED: "Not calibrated",
  CALIBRATION_FAILED: "Calibration failed",
  OUT_OF_SERVICE: "Out of service",
  RETIRED: "Retired",
};

export function ReadinessBadge({ r }: { r: DeviceReadiness }) {
  if (r.state === "RETIRED")
    return (
      <span className="inline-flex items-center rounded border border-line bg-canvas px-2 py-0.5 text-xs font-semibold tracking-wide text-muted">
        RETIRED
      </span>
    );
  return (
    <Badge tone={r.state === "READY" ? "pass" : r.state === "DUE_SOON" ? "warn" : "fail"}>
      {READINESS_LABEL[r.state].toUpperCase()}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: CalibrationOutcome }) {
  return <Badge tone={outcome === "PASS" ? "pass" : outcome === "WARNING" ? "warn" : "fail"}>{outcome}</Badge>;
}

const label = "mb-1.5 block text-sm font-semibold text-ink";
const input = "w-full rounded-md border border-line bg-white px-3 py-2";

export interface DeviceFormValues extends Required<Omit<DeviceInput, "installedOn">> {
  installedOn: string;
}

/** Instrument identity and calibration schedule. */
export function DeviceForm({
  initial,
  typeLocked,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: DeviceFormValues;
  typeLocked?: boolean;
  submitLabel: string;
  onSubmit: (values: DeviceFormValues) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof DeviceFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV({ ...v, [k]: e.target.value });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (v.name.trim().length < 2) next.name = "Enter the instrument name.";
    if (!v.manufacturer.trim()) next.manufacturer = "Enter the manufacturer.";
    if (!v.model.trim()) next.model = "Enter the model.";
    if (!v.serialNumber.trim()) next.serialNumber = "Enter the serial number from the instrument label.";
    if (!(v.calibrationIntervalDays >= 1 && v.calibrationIntervalDays <= 730)) next.calibrationIntervalDays = "1 to 730 days.";
    if (!(v.calibrationWarningDays >= 0 && v.calibrationWarningDays <= 60)) next.calibrationWarningDays = "0 to 60 days.";
    setErrors(next);
    if (!Object.keys(next).length) onSubmit(v);
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5 rounded-lg border border-line bg-white p-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="instrumentType" className={label}>
            Instrument type
          </label>
          <select id="instrumentType" value={v.instrumentType} onChange={set("instrumentType")} disabled={typeLocked} className={`${input} disabled:bg-canvas`}>
            {(Object.keys(INSTRUMENT_LABELS) as InstrumentType[]).map((t) => (
              <option key={t} value={t}>
                {INSTRUMENT_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <TextField id="name" label="Instrument name" value={v.name} onChange={set("name")} error={errors.name} placeholder="e.g. pH meter QC-2" />
        <TextField id="manufacturer" label="Manufacturer" value={v.manufacturer} onChange={set("manufacturer")} error={errors.manufacturer} />
        <TextField id="model" label="Model" value={v.model} onChange={set("model")} error={errors.model} />
        <TextField id="serialNumber" label="Serial number" value={v.serialNumber} onChange={set("serialNumber")} error={errors.serialNumber} spellCheck={false} />
        <TextField id="assetTag" label="Asset tag (optional)" value={v.assetTag} onChange={set("assetTag")} spellCheck={false} />
        <TextField id="location" label="Location" value={v.location} onChange={set("location")} placeholder="e.g. QC Lab 2, bench 3" />
        <TextField id="firmwareVersion" label="Firmware version" value={v.firmwareVersion} onChange={set("firmwareVersion")} />
        <TextField id="installedOn" label="Installed on" type="date" value={v.installedOn} onChange={set("installedOn")} />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            id="calibrationIntervalDays"
            label="Calibrate every (days)"
            type="number"
            min={1}
            max={730}
            value={String(v.calibrationIntervalDays)}
            onChange={(e) => setV({ ...v, calibrationIntervalDays: Number(e.target.value) })}
            error={errors.calibrationIntervalDays}
          />
          <TextField
            id="calibrationWarningDays"
            label="Warn before due (days)"
            type="number"
            min={0}
            max={60}
            value={String(v.calibrationWarningDays)}
            onChange={(e) => setV({ ...v, calibrationWarningDays: Number(e.target.value) })}
            error={errors.calibrationWarningDays}
          />
        </div>
      </div>
      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const DEFAULT_BUFFERS = ["4.01", "7.00", "10.01"];

/** Calibration entry: pH buffers with a live result, or a checklist for other instruments. */
export function CalibrationForm({
  type,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  type: InstrumentType;
  initial?: CalibrationRecord;
  submitLabel: string;
  onSubmit: (body: CalibrationInput) => Promise<void>;
  onCancel: () => void;
}) {
  const isPh = type === "PH";
  const [temperature, setTemperature] = useState(initial?.temperatureC != null ? String(initial.temperatureC) : "25.0");
  const [buffers, setBuffers] = useState<{ bufferPh: string; mv: string }[]>(
    isPh && initial
      ? (initial.readings as PhReading[]).map((r) => ({ bufferPh: String(r.bufferPh), mv: String(r.mv) }))
      : DEFAULT_BUFFERS.map((b) => ({ bufferPh: b, mv: "" })),
  );
  const [checks, setChecks] = useState<{ check: string; expected: string; observed: string; pass: boolean }[]>(
    !isPh && initial ? (initial.readings as CheckReading[]) : [{ check: "", expected: "", observed: "", pass: true }],
  );
  const [remarks, setRemarks] = useState(initial?.remarks ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const phReadings = buffers
    .filter((b) => b.bufferPh.trim() !== "" && b.mv.trim() !== "")
    .map((b) => ({ bufferPh: Number(b.bufferPh), mv: Number(b.mv) }));
  const t = Number(temperature);
  const preview = isPh && phReadings.length >= 2 && Number.isFinite(t) ? previewPh(phReadings, t) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isPh && phReadings.some((r) => !Number.isFinite(r.bufferPh) || !Number.isFinite(r.mv)))
      return setError("Buffer pH and potential must be numbers.");
    setBusy(true);
    try {
      await onSubmit(
        isPh
          ? { temperatureC: t, readings: phReadings, remarks }
          : { readings: checks.filter((c) => c.check.trim() || c.observed.trim()), remarks },
      );
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not save the calibration.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5 rounded-lg border border-brand/30 bg-white p-6">
      <p className="text-sm text-muted">
        Enter the readings exactly as shown by the instrument. They are stored as entered and marked as manually recorded.
      </p>
      {isPh ? (
        <>
          <div className="max-w-xs">
            <TextField id="temperature" label="Buffer temperature (°C)" inputMode="decimal" value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </div>
          <fieldset>
            <legend className={label}>Buffer readings</legend>
            <table className="w-full max-w-lg text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-1 pr-2">Buffer (pH)</th>
                  <th className="pb-1 pr-2">Potential (mV)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {buffers.map((b, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`Buffer ${i + 1} pH`}
                        inputMode="decimal"
                        value={b.bufferPh}
                        onChange={(e) => setBuffers(buffers.map((x, j) => (j === i ? { ...x, bufferPh: e.target.value } : x)))}
                        className={`${input} font-mono tabular-nums`}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        aria-label={`Buffer ${i + 1} mV`}
                        inputMode="decimal"
                        value={b.mv}
                        onChange={(e) => setBuffers(buffers.map((x, j) => (j === i ? { ...x, mv: e.target.value } : x)))}
                        className={`${input} font-mono tabular-nums`}
                      />
                    </td>
                    <td className="py-1">
                      {buffers.length > 2 && (
                        <button type="button" onClick={() => setBuffers(buffers.filter((_, j) => j !== i))} className="text-sm font-semibold text-fail hover:underline">
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {buffers.length < 5 && (
              <button type="button" onClick={() => setBuffers([...buffers, { bufferPh: "", mv: "" }])} className="mt-2 text-sm font-semibold text-brand hover:underline">
                + Add buffer
              </button>
            )}
          </fieldset>
          <div className="rounded-md border border-line bg-canvas p-4 text-sm" aria-live="polite">
            {preview ? (
              <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
                <span>
                  Slope <span className="font-mono font-semibold tabular-nums">{fmt(preview.slopePercent)} %</span>{" "}
                  <span className="text-muted">({fmt(preview.slopeMvPerPh, 2)} mV/pH)</span> <OutcomeBadge outcome={preview.slopeOutcome} />
                </span>
                <span>
                  Offset <span className="font-mono font-semibold tabular-nums">{fmt(preview.offsetMv)} mV</span> <OutcomeBadge outcome={preview.offsetOutcome} />
                </span>
                <span className="font-semibold">
                  Result <OutcomeBadge outcome={preview.outcome} />
                </span>
              </div>
            ) : (
              <span className="text-muted">Enter at least two buffers to see the slope and offset.</span>
            )}
            <p className="mt-2 text-xs text-muted">
              Limits: slope {PH_LIMITS.slopePassMin}–{PH_LIMITS.slopePassMax} % (warning {PH_LIMITS.slopeWarnMin}–{PH_LIMITS.slopeWarnMax} %),
              offset within ±{PH_LIMITS.offsetPassMaxAbs} mV (warning ±{PH_LIMITS.offsetWarnMaxAbs} mV).
            </p>
          </div>
        </>
      ) : (
        <fieldset>
          <legend className={label}>Calibration checks</legend>
          <div className="space-y-2">
            {checks.map((c, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto_auto] sm:items-center">
                <input aria-label={`Check ${i + 1}`} placeholder="Check" value={c.check} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, check: e.target.value } : x)))} className={input} />
                <input aria-label={`Check ${i + 1} expected`} placeholder="Expected" value={c.expected} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)))} className={input} />
                <input aria-label={`Check ${i + 1} observed`} placeholder="Observed" value={c.observed} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, observed: e.target.value } : x)))} className={input} />
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={c.pass} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, pass: e.target.checked } : x)))} />
                  Pass
                </label>
                {checks.length > 1 && (
                  <button type="button" onClick={() => setChecks(checks.filter((_, j) => j !== i))} className="text-sm font-semibold text-fail hover:underline">
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setChecks([...checks, { check: "", expected: "", observed: "", pass: true }])} className="mt-2 text-sm font-semibold text-brand hover:underline">
            + Add check
          </button>
        </fieldset>
      )}
      <div>
        <label htmlFor="remarks" className={label}>
          Remarks
        </label>
        <textarea id="remarks" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} className={input} placeholder="e.g. Buffer lots B-4471, B-7012, B-1003" />
      </div>
      {error && <Callout tone="fail">{error}</Callout>}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** One calibration: readings, computed result, approval stage, actions and history. */
export function CalibrationCard({
  c,
  type,
  open,
  canCorrect,
  onToggle,
  onCorrect,
  onDone,
}: {
  c: CalibrationRecord;
  type: InstrumentType;
  open: boolean;
  canCorrect: boolean;
  onToggle: () => void;
  onCorrect: () => void;
  onDone: (message: string) => Promise<void> | void;
}) {
  const r = c.results as Record<string, number>;
  return (
    <article id={`cal-${c.id}`} className="rounded-lg border border-line bg-white">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3 text-left">
        <span>
          <span className="font-mono text-sm font-semibold text-ink">{c.code}</span>
          <span className="ml-3 text-sm text-muted">
            {formatDate(c.performedAt)} · {c.performedBy.name}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <OutcomeBadge outcome={c.outcome} />
          <WorkflowBadge state={c.workflow.state} />
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-5 py-4">
          {type === "PH" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <table className="text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="pb-1 pr-6">Buffer</th>
                    <th className="pb-1">Potential</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {(c.readings as PhReading[]).map((x, i) => (
                    <tr key={i}>
                      <td className="pr-6">pH {x.bufferPh.toFixed(2)}</td>
                      <td>{x.mv.toFixed(1)} mV</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Temperature</dt>
                <dd className="font-mono tabular-nums">{c.temperatureC} °C</dd>
                <dt className="text-muted">Slope</dt>
                <dd className="font-mono tabular-nums">
                  {fmt(r.slopePercent, 2)} % ({fmt(r.slopeMvPerPh, 2)} of {fmt(r.nernstMvPerPh, 2)} mV/pH)
                </dd>
                <dt className="text-muted">Offset at pH 7</dt>
                <dd className="font-mono tabular-nums">{fmt(r.offsetMv, 2)} mV</dd>
                <dt className="text-muted">Fit r²</dt>
                <dd className="font-mono tabular-nums">{fmt(r.rSquared, 5)}</dd>
                <dt className="text-muted">Data</dt>
                <dd>{c.dataSource === "MANUAL" ? "Entered manually" : "From the instrument"}</dd>
              </dl>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-1">Check</th>
                  <th className="pb-1">Expected</th>
                  <th className="pb-1">Observed</th>
                  <th className="pb-1">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(c.readings as CheckReading[]).map((x, i) => (
                  <tr key={i}>
                    <td className="py-1.5">{x.check}</td>
                    <td>{x.expected || "—"}</td>
                    <td>{x.observed}</td>
                    <td>{x.pass ? <Badge tone="pass">PASS</Badge> : <Badge tone="fail">FAIL</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {c.remarks && <p className="text-sm text-muted">Remarks: {c.remarks}</p>}
          <WorkflowStepper instance={c.workflow} withReview={false} />
          <div className="flex flex-wrap gap-3">
            {canCorrect && (
              <Button variant="secondary" onClick={onCorrect}>
                Correct readings
              </Button>
            )}
            <WorkflowActions
              instance={c.workflow}
              allowed={c.allowedSteps}
              onDone={onDone}
              labels={{
                SUBMIT: {
                  label: "Submit for approval…",
                  title: "Submit calibration for approval",
                  description: "The readings are locked from now on. A QA approver will sign against exactly these readings and results.",
                },
                APPROVE: {
                  title: "Approve calibration",
                  description: "The result becomes the instrument's current calibration. A failed result blocks the instrument.",
                },
                INVALIDATE: { description: "The calibration will no longer count. The instrument may become blocked until it is recalibrated." },
              }}
              messages={{
                SUBMIT: "Submitted for approval and locked.",
                APPROVE: "Calibration approved. The instrument's status has been updated.",
                REJECT: "Rejected and returned to the person who performed it.",
                INVALIDATE: "Calibration invalidated.",
              }}
            />
          </div>
          <WorkflowHistory events={c.history} />
        </div>
      )}
    </article>
  );
}
