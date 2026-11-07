"use client";

import { useState } from "react";
import { ApiError, INSTRUMENT_LABELS, InstrumentType, MethodContentInput, MethodParameter } from "@/lib/api";
import { TextField } from "./forms";
import { Button, Callout } from "./ui";

export interface MethodFormValues {
  instrumentType: InstrumentType;
  name: string;
  purpose: string;
  procedure: string;
  parameters: MethodParameter[];
  changeSummary: string;
}

const area = "w-full rounded-md border border-line bg-white px-3.5 py-2.5 text-[15px]";
const label = "mb-1.5 block text-sm font-semibold text-ink";

/** Method content editor; used to create a method and to edit a draft version. */
export function MethodForm({
  initial,
  instrumentLocked,
  showChangeSummary,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: MethodFormValues;
  instrumentLocked?: boolean;
  showChangeSummary?: boolean;
  submitLabel: string;
  onSubmit: (values: MethodContentInput & { instrumentType: InstrumentType }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<MethodFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const setParam = (i: number, k: keyof MethodParameter, value: string) =>
    setV({ ...v, parameters: v.parameters.map((p, j) => (j === i ? { ...p, [k]: value } : p)) });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parameters = v.parameters.filter((p) => p.name.trim() || p.value.trim() || p.unit.trim());
    const next: Record<string, string> = {};
    if (v.name.trim().length < 3) next.name = "Enter a method name (at least 3 characters).";
    if (parameters.some((p) => !p.name.trim())) next.parameters = "Every parameter needs a name.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await onSubmit({ ...v, parameters });
    } catch (err) {
      const field = err instanceof ApiError ? err.body?.field : undefined;
      setErrors({ [field ?? "form"]: err instanceof Error ? err.message : "Could not save the method." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5 rounded-lg border border-line bg-white p-6">
      <div className="grid gap-5 sm:grid-cols-[14rem_1fr]">
        <div>
          <label htmlFor="instrumentType" className={label}>
            Instrument
          </label>
          <select
            id="instrumentType"
            value={v.instrumentType}
            disabled={instrumentLocked}
            onChange={(e) => setV({ ...v, instrumentType: e.target.value as InstrumentType })}
            className={`${area} disabled:bg-canvas`}
          >
            {(Object.keys(INSTRUMENT_LABELS) as InstrumentType[]).map((t) => (
              <option key={t} value={t}>
                {INSTRUMENT_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <TextField id="name" label="Method name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={errors.name} />
      </div>
      <div>
        <label htmlFor="purpose" className={label}>
          Purpose and scope
        </label>
        <textarea id="purpose" rows={2} value={v.purpose} onChange={(e) => setV({ ...v, purpose: e.target.value })} className={area} />
      </div>
      <div>
        <label htmlFor="procedure" className={label}>
          Procedure
        </label>
        <textarea
          id="procedure"
          rows={6}
          value={v.procedure}
          onChange={(e) => setV({ ...v, procedure: e.target.value })}
          className={area}
          placeholder="Steps, calibration, system suitability and acceptance criteria"
        />
      </div>
      <fieldset>
        <legend className={label}>Parameters</legend>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-1 pr-2">Name</th>
                <th className="pb-1 pr-2">Value</th>
                <th className="pb-1 pr-2">Unit</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {v.parameters.map((p, i) => (
                <tr key={i}>
                  {(["name", "value", "unit"] as const).map((k) => (
                    <td key={k} className="py-1 pr-2">
                      <input
                        aria-label={`Parameter ${i + 1} ${k}`}
                        value={p[k]}
                        onChange={(e) => setParam(i, k, e.target.value)}
                        className="w-full rounded-md border border-line px-2.5 py-1.5"
                      />
                    </td>
                  ))}
                  <td className="py-1">
                    <button
                      type="button"
                      onClick={() => setV({ ...v, parameters: v.parameters.filter((_, j) => j !== i) })}
                      className="text-sm font-semibold text-fail hover:underline"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() => setV({ ...v, parameters: [...v.parameters, { name: "", value: "", unit: "" }] })}
          className="mt-2 text-sm font-semibold text-brand hover:underline"
        >
          + Add parameter
        </button>
        {errors.parameters && <p className="mt-1 text-sm text-fail">{errors.parameters}</p>}
      </fieldset>
      {showChangeSummary && (
        <div>
          <label htmlFor="changeSummary" className={label}>
            What changed in this version
          </label>
          <textarea
            id="changeSummary"
            rows={2}
            value={v.changeSummary}
            onChange={(e) => setV({ ...v, changeSummary: e.target.value })}
            className={area}
          />
        </div>
      )}
      {errors.form && <Callout tone="fail">{errors.form}</Callout>}
      <div className="flex justify-end gap-3">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
