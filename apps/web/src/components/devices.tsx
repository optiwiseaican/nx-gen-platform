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
  InstrumentTypeInfo,
  Readiness,
} from "@/lib/api";
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
  MODULE_UNAVAILABLE: "Module not available",
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
  types,
  typeLocked,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: DeviceFormValues;
  types: InstrumentTypeInfo[];
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
            {types.map((t) => (
              <option key={t.code} value={t.code} disabled={!t.available && !typeLocked}>
                {t.label}
                {!t.available && " (module not installed)"}
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
        <TextField
          id="deviceIdentifier"
          label="Instrument ID in its data (DEVICE_ID)"
          value={v.deviceIdentifier}
          onChange={set("deviceIdentifier")}
          hint="Links data from the USB dongle to this instrument. Leave empty for instruments without a data link."
          spellCheck={false}
        />
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

/** Checklist calibration for instruments without a module (type OTHER). */
export function CalibrationForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: CalibrationRecord;
  submitLabel: string;
  onSubmit: (body: CalibrationInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [checks, setChecks] = useState<CheckReading[]>(
    initial ? (initial.readings as CheckReading[]) : [{ check: "", expected: "", observed: "", pass: true }],
  );
  const [remarks, setRemarks] = useState(initial?.remarks ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit({ readings: checks.filter((c) => c.check.trim() || c.observed.trim()), remarks });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not save the calibration.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5 rounded-lg border border-brand/30 bg-white p-6">
      <p className="text-sm text-muted">Enter each check as performed. Values are stored as entered and marked as manually recorded.</p>
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
      <div>
        <label htmlFor="remarks" className={label}>
          Remarks
        </label>
        <textarea id="remarks" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} className={input} placeholder="e.g. Reference weights W-100, certificate 2026-07" />
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

const SOURCE_LABEL: Record<CalibrationRecord["dataSource"], string> = {
  MANUAL: "Entered manually",
  INSTRUMENT: "From the instrument",
  SIMULATED: "From the device simulator (development only)",
};

/** One calibration: readings, computed result, approval stage, actions and history. */
export function CalibrationCard({
  c,
  open,
  canCorrect,
  canDiscard,
  onToggle,
  onCorrect,
  onDiscard,
  onDone,
}: {
  c: CalibrationRecord;
  open: boolean;
  canCorrect: boolean;
  canDiscard: boolean;
  onToggle: () => void;
  onCorrect: () => void;
  onDiscard: () => void;
  onDone: (message: string) => Promise<void> | void;
}) {
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
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            {c.display.map((x) => (
              <div key={x.label} className="contents">
                <dt className="text-muted">{x.label}</dt>
                <dd className="font-mono tabular-nums">{x.value}</dd>
              </div>
            ))}
            <dt className="text-muted">Data</dt>
            <dd>
              {SOURCE_LABEL[c.dataSource]}
              {c.sourceMessages.length > 0 && <span className="text-muted"> · {c.sourceMessages.length} stored instrument packets</span>}
            </dd>
          </dl>
          {c.readings.length > 0 && "check" in (c.readings[0] as object) ? (
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
          ) : (
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-brand">Readings as recorded</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-canvas p-2 font-mono text-xs">{JSON.stringify(c.readings, null, 2)}</pre>
            </details>
          )}
          {c.remarks && <p className="text-sm text-muted">Remarks: {c.remarks}</p>}
          <WorkflowStepper instance={c.workflow} withReview={false} />
          <div className="flex flex-wrap gap-3">
            {canCorrect && (
              <Button variant="secondary" onClick={onCorrect}>
                Correct readings
              </Button>
            )}
            {canDiscard && (
              <Button variant="secondary" onClick={onDiscard}>
                Discard draft…
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
