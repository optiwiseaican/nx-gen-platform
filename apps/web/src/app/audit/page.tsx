"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AppShell, useAuthRedirect } from "@/components/AppShell";
import { Badge, Button, Callout, StatusIcon, Tone } from "@/components/ui";
import { AuditEntry, AuditFilters, authApi } from "@/lib/api";

const CATEGORIES = ["DATA", "SECURITY", "USER_MANAGEMENT", "LICENSING", "PLATFORM", "SYSTEM"];
const EMPTY = { action: "", actor: "", category: "", result: "", from: "", to: "" };
const PAGE_SIZE = 50;

/** First, last and the current page's neighbours, with a gap wherever pages are skipped. */
function pageList(current: number, last: number): (number | "gap")[] {
  const pages = [...new Set([1, current - 1, current, current + 1, last])]
    .filter((p) => p >= 1 && p <= last)
    .sort((a, b) => a - b);
  return pages.flatMap((p, i) => (i > 0 && p - pages[i - 1] > 1 ? (["gap", p] as const) : [p]));
}

/** Local date inputs → ISO bounds (the "to" date is inclusive of that whole day). */
function toQuery(f: typeof EMPTY): AuditFilters {
  const day = (d: string, add = 0) => {
    if (!d) return undefined;
    const t = new Date(`${d}T00:00:00`);
    t.setDate(t.getDate() + add);
    return t.toISOString();
  };
  return {
    action: f.action.trim().toUpperCase() || undefined,
    actor: f.actor || undefined,
    category: f.category || undefined,
    result: f.result || undefined,
    from: day(f.from),
    to: day(f.to, 1),
  };
}

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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const latestLoad = useRef(0);

  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [exported, setExported] = useState<{ filename: string; sha256: string } | null>(null);

  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    try {
      const res = await authApi.audit({ ...toQuery(applied), limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      if (id !== latestLoad.current) return; // a newer page was requested meanwhile
      setEntries(res.entries);
      setTotal(res.total);
      setChain(res.chain);
      setError(null);
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load the audit trail.");
    }
  }, [redirect, applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function goToPage(p: number) {
    setOpen(null);
    setPage(p);
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function exportTrail(format: "csv" | "pdf") {
    setExporting(format);
    setError(null);
    try {
      const { blob, filename, sha256 } = await authApi.auditExport(toQuery(applied), format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExported({ filename, sha256 });
      await load(); // the export itself is now the newest entry
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "The export failed.");
    } finally {
      setExporting(null);
    }
  }

  const field = (k: keyof typeof EMPTY) => ({
    id: `audit-${k}`,
    value: draft[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value }),
    className: "w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-sm",
  });
  const label = "mb-1 block text-xs font-semibold uppercase tracking-wide text-muted";
  const filtered = Object.values(applied).some(Boolean);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOpen(null);
          setPage(1);
          setApplied({ ...draft });
        }}
        className="grid gap-3 rounded-lg border border-line bg-white p-4 sm:grid-cols-3 lg:grid-cols-7"
        aria-label="Filter the audit trail"
      >
        <div className="lg:col-span-2">
          <label htmlFor="audit-action" className={label}>Action</label>
          <input {...field("action")} placeholder="e.g. LOGIN_FAILED" spellCheck={false} />
        </div>
        <div>
          <label htmlFor="audit-actor" className={label}>User</label>
          <input {...field("actor")} placeholder="Full name" />
        </div>
        <div>
          <label htmlFor="audit-category" className={label}>Category</label>
          <select {...field("category")}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c.replace("_", " ")}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-result" className={label}>Result</label>
          <select {...field("result")}>
            <option value="">All</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
            <option value="INFO">Info</option>
          </select>
        </div>
        <div>
          <label htmlFor="audit-from" className={label}>From</label>
          <input type="date" {...field("from")} />
        </div>
        <div>
          <label htmlFor="audit-to" className={label}>To</label>
          <input type="date" {...field("to")} />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3 lg:col-span-7">
          <Button type="submit">Apply filters</Button>
          {filtered && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(null);
                setPage(1);
                setDraft(EMPTY);
                setApplied(EMPTY);
              }}
            >
              Clear
            </Button>
          )}
          <span className="flex-1" />
          {(["csv", "pdf"] as const).map((format) => (
            <Button key={format} type="button" variant="secondary" onClick={() => void exportTrail(format)} disabled={exporting !== null}>
              {exporting === format
                ? "Exporting…"
                : `${filtered ? "Export filtered" : "Export all"} (${format.toUpperCase()})`}
            </Button>
          ))}
        </div>
      </form>
      {exported && (
        <Callout tone="pass" title="Export saved and recorded in the audit trail">
          <span className="font-mono text-xs">{exported.filename}</span>
          <span className="mt-1 block break-all font-mono text-xs">SHA-256 {exported.sha256}</span>
          <span className="mt-1 block text-xs">Keep the SHA-256 with the file. It proves the copy has not been altered.</span>
        </Callout>
      )}
      {error && <Callout tone="fail">{error}</Callout>}
      <div ref={tableRef} className="scroll-mt-24 overflow-x-auto rounded-lg border border-line bg-white">
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
        {entries.length === 0 && !error && (
          <p className="px-4 py-6 text-center text-sm text-muted">No entries match these filters.</p>
        )}
      </div>
      {entries.length > 0 && (
        <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Audit trail pages">
          <p className="text-sm text-muted">
            Showing {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + entries.length} of {total}
          </p>
          {lastPage > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" disabled={page === 1} onClick={() => goToPage(page - 1)}>
                Previous
              </Button>
              {pageList(page, lastPage).map((p, i) =>
                p === "gap" ? (
                  <span key={`gap-${i}`} className="px-1 text-muted" aria-hidden="true">…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? "primary" : "secondary"}
                    aria-label={`Page ${p}`}
                    aria-current={p === page ? "page" : undefined}
                    onClick={() => goToPage(p)}
                  >
                    {p}
                  </Button>
                ),
              )}
              <Button variant="secondary" disabled={page === lastPage} onClick={() => goToPage(page + 1)}>
                Next
              </Button>
            </div>
          )}
        </nav>
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
