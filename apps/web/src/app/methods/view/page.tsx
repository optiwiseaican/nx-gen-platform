"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDate, ReasonDialog } from "@/components/admin";
import { AppShell, useAuthRedirect } from "@/components/AppShell";
import { MethodForm } from "@/components/MethodForm";
import { Button, Callout, FieldTable, StatusIcon } from "@/components/ui";
import { WorkflowActions, WorkflowBadge, WorkflowHistory, WorkflowStepper } from "@/components/workflow";
import { INSTRUMENT_LABELS, MethodDetail, methodsApi, MethodVersion } from "@/lib/api";

function VersionContent({ v }: { v: MethodVersion }) {
  return (
    <div className="space-y-4 rounded-lg border border-line bg-white p-5">
      <FieldTable
        rows={[
          ["Name", v.name],
          ["Purpose and scope", v.purpose || "—"],
          ["What changed", v.changeSummary || "—"],
          ["Created", `${formatDate(v.createdAt)}${v.createdByName ? ` by ${v.createdByName}` : ""}`],
        ]}
      />
      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink">Procedure</h3>
        <p className="whitespace-pre-wrap text-sm">{v.procedure || <span className="text-muted">—</span>}</p>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink">Parameters</h3>
        {v.parameters.length ? (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {v.parameters.map((p, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-4 text-muted">{p.name}</td>
                  <td className="py-1.5 font-mono tabular-nums">
                    {p.value} {p.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted">None</p>
        )}
      </div>
      {v.workflow.contentHash && (
        <p className="break-all font-mono text-[11px] text-muted">Content SHA-256 at submission {v.workflow.contentHash}</p>
      )}
    </div>
  );
}

function MethodView() {
  const redirect = useAuthRedirect();
  const [id, setId] = useState<string | null>(null);
  const [m, setM] = useState<MethodDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [newVersion, setNewVersion] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setId(new URLSearchParams(window.location.search).get("id")), []);

  const load = useCallback(
    async (select?: string) => {
      if (!id) return;
      try {
        const detail = await methodsApi.get(id);
        setM(detail);
        setSelected((cur) => select ?? (cur && detail.versions.some((v) => v.id === cur) ? cur : detail.versions[0]?.id ?? null));
      } catch (err) {
        if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load the method.");
      }
    },
    [id, redirect],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!m)
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );

  const v = m.versions.find((x) => x.id === selected) ?? m.versions[0];
  const isLatest = v.id === m.versions[0].id;
  const effective = m.versions.find((x) => x.workflow.state === "APPROVED");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-sm text-muted">
            {m.code} · {INSTRUMENT_LABELS[m.instrumentType]}
          </p>
          <h2 className="text-xl font-semibold text-ink">{m.versions[0].name}</h2>
          <p className="text-sm text-muted">
            {effective ? `Effective version: v${effective.versionNumber}` : "No approved version yet; the method cannot be used."}
          </p>
        </div>
        <Link href="/methods/" className="text-sm font-semibold text-brand hover:underline">
          All methods
        </Link>
      </div>

      {notice && <Callout tone="pass">{notice}</Callout>}

      <div role="tablist" aria-label="Versions" className="flex flex-wrap gap-2">
        {m.versions.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={x.id === v.id}
            onClick={() => {
              setSelected(x.id);
              setEditing(false);
            }}
            className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-semibold ${
              x.id === v.id ? "border-brand bg-brand-50 text-brand" : "border-line bg-white text-ink hover:border-brand"
            }`}
          >
            v{x.versionNumber} <WorkflowBadge state={x.workflow.state} />
          </button>
        ))}
      </div>

      <section className="space-y-4" aria-label={`Version ${v.versionNumber}`}>
        <WorkflowStepper instance={v.workflow} />
        {v.workflow.state === "DRAFT" && v.history.some((e) => e.step === "REJECT") && (
          <Callout tone="warn" title="Returned for correction">
            {[...v.history].reverse().find((e) => e.step === "REJECT")?.comment}
          </Callout>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {isLatest && m.canEditDraft && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit draft
            </Button>
          )}
          {!editing && (
            <WorkflowActions
              instance={v.workflow}
              allowed={v.allowedSteps}
              onDone={async (msg) => {
                await load(v.id);
                setNotice(msg);
              }}
            />
          )}
          {isLatest && m.canStartNewVersion && (
            <Button variant="secondary" onClick={() => setNewVersion(true)}>
              Start new version…
            </Button>
          )}
        </div>

        {editing ? (
          <MethodForm
            initial={{ instrumentType: m.instrumentType, ...v }}
            instrumentLocked
            showChangeSummary={v.versionNumber > 1}
            submitLabel="Save draft"
            onSubmit={async (values) => {
              const saved = await methodsApi.update(m.id, v.id, {
                name: values.name,
                purpose: values.purpose,
                procedure: values.procedure,
                parameters: values.parameters,
                changeSummary: values.changeSummary,
              });
              setM(saved);
              setEditing(false);
              setNotice("Draft saved.");
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <VersionContent v={v} />
        )}

        <div>
          <h3 className="mb-2 font-semibold text-ink">History of version {v.versionNumber}</h3>
          <WorkflowHistory events={v.history} />
        </div>
      </section>

      <ReasonDialog
        open={newVersion}
        title="Start a new version"
        description={`Version ${m.versions[0].versionNumber + 1} starts as a draft copy of version ${m.versions[0].versionNumber}. The current version stays in force until the new one is approved.`}
        confirmLabel="Start new version"
        minReason={10}
        reasonLabel="What will change and why"
        reasonPlaceholder="e.g. Add buffer lot traceability per CAPA-2026-019"
        onConfirm={async (reason) => {
          const d = await methodsApi.newVersion(m.id, reason);
          setNewVersion(false);
          setM(d);
          setSelected(d.versions[0].id);
          setEditing(true);
          setNotice(`Version ${d.versions[0].versionNumber} created as a draft.`);
        }}
        onClose={() => setNewVersion(false)}
      />
    </div>
  );
}

export default function MethodViewPage() {
  return (
    <AppShell title="Method">
      <MethodView />
    </AppShell>
  );
}
