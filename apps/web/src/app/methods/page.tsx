"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { Callout, StatusIcon } from "@/components/ui";
import { WorkflowBadge } from "@/components/workflow";
import { INSTRUMENT_LABELS, methodsApi, MethodSummary } from "@/lib/api";

function Methods() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const [methods, setMethods] = useState<MethodSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    methodsApi
      .list()
      .then(setMethods)
      .catch((err) => {
        if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load methods.");
      });
  }, [redirect]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!methods)
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Only the approved version of a method is effective. Each change is a new version that is reviewed and approved with
          electronic signatures.
        </p>
        {principal.permissions.includes("methods.edit") && (
          <Link
            href="/methods/new/"
            className="inline-flex min-h-11 items-center rounded-md bg-brand px-5 font-semibold text-white hover:bg-brand-700"
          >
            New method
          </Link>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Instrument</th>
              <th className="px-4 py-3">Effective version</th>
              <th className="px-4 py-3">Latest version</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {methods.map((m) => (
              <tr key={m.id} className="hover:bg-canvas/60">
                <td className="px-4 py-3 font-mono text-xs">
                  <Link href={`/methods/view/?id=${m.id}`} className="font-semibold text-brand hover:underline">
                    {m.code}
                  </Link>
                </td>
                <td className="px-4 py-3 font-medium">{m.name}</td>
                <td className="px-4 py-3">{INSTRUMENT_LABELS[m.instrumentType]}</td>
                <td className="px-4 py-3">{m.effectiveVersion ? `v${m.effectiveVersion}` : <span className="text-muted">None yet</span>}</td>
                <td className="px-4 py-3">
                  <span className="mr-2">v{m.latestVersion}</span>
                  <WorkflowBadge state={m.latestState} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {methods.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No methods yet.</p>}
      </div>
    </div>
  );
}

export default function MethodsPage() {
  return (
    <AppShell title="Methods">
      <Methods />
    </AppShell>
  );
}
