"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AppShell, useAuthRedirect } from "@/components/AppShell";
import { Badge, Button, Callout, StatusIcon, Tone } from "@/components/ui";
import { AuditEntry, authApi } from "@/lib/api";

const TONE: Record<AuditEntry["result"], Tone> = { SUCCESS: "pass", FAILURE: "fail", INFO: "info" };

function summary(e: AuditEntry): string {
  if (!e.tableName) return "";
  const id = e.recordId && e.recordId.length > 24 ? `${e.recordId.slice(0, 8)}…` : e.recordId;
  return id ? `${e.tableName} · ${id}` : e.tableName;
}

function AuditTrail() {
  const redirect = useAuthRedirect();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [chain, setChain] = useState<{ valid: boolean; brokenAtSequence?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    async (before?: number) => {
      try {
        const res = await authApi.audit({ before });
        setEntries((prev) => (before ? [...prev, ...res.entries] : res.entries));
        setChain(res.chain);
        setMore(res.entries.length === 50);
      } catch (err) {
        if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load the audit trail.");
      }
    },
    [redirect],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Append-only record of every action. Entries cannot be edited or deleted.</p>
        {chain &&
          (chain.valid ? (
            <Badge tone="pass">CHAIN INTACT</Badge>
          ) : (
            <Badge tone="fail">CHAIN BROKEN AT #{chain.brokenAtSequence}</Badge>
          ))}
      </div>
      {error && <Callout tone="fail">{error}</Callout>}
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Time (local)</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Record</th>
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {entries.map((e) => (
              <Fragment key={e.sequence}>
                <tr className="cursor-pointer hover:bg-canvas/60" onClick={() => setOpen(open === e.sequence ? null : e.sequence)}>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">{e.sequence}</td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {typeof e.details?.journalTimestamp === "string" ? (
                      <>
                        {new Date(e.details.journalTimestamp).toLocaleString()}
                        <span className="block text-xs text-muted">from bootstrap journal</span>
                      </>
                    ) : (
                      new Date(e.occurredAt).toLocaleString()
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    <span className="text-xs text-muted">{e.category} · </span>
                    {e.action}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusIcon tone={TONE[e.result]} className="h-4 w-4" /> {e.result}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{e.actorName ?? e.actor}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{summary(e) || "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{e.reason ?? (e.errorCode ? e.errorCode : "—")}</td>
                </tr>
                {open === e.sequence && (
                  <tr className="bg-canvas/40">
                    <td colSpan={7} className="px-4 py-3">
                      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-ink">
                        {JSON.stringify(
                          { actorId: e.actor, machine: e.machineName, ip: e.ipAddress, old: e.oldValue, new: e.newValue, details: e.details },
                          null,
                          2,
                        )}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {more && entries.length > 0 && (
        <Button variant="secondary" onClick={() => void load(entries[entries.length - 1].sequence)}>
          Load older entries
        </Button>
      )}
    </div>
  );
}

export default function AuditPage() {
  return (
    <AppShell title="Audit Trail">
      <AuditTrail />
    </AppShell>
  );
}
