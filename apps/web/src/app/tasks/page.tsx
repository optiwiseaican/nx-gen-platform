"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDate } from "@/components/admin";
import { AppShell, useAuthRedirect } from "@/components/AppShell";
import { Callout, StatusIcon } from "@/components/ui";
import { WorkflowBadge } from "@/components/workflow";
import { workflowApi, WorkflowTask } from "@/lib/api";

function Tasks() {
  const redirect = useAuthRedirect();
  const [tasks, setTasks] = useState<WorkflowTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    workflowApi
      .tasks()
      .then(setTasks)
      .catch((err) => {
        if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load your tasks.");
      });
  }, [redirect]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!tasks)
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );
  if (tasks.length === 0) return <Callout tone="pass">Nothing is waiting for your review or approval.</Callout>;

  return (
    <ul className="space-y-3">
      {tasks.map((t) => (
        <li key={t.instance.id}>
          <Link
            href={t.link}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-white p-4 hover:border-brand"
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                {t.workflow} · {t.step === "REVIEW" ? "Review" : "Approve"}
              </p>
              <p className="font-semibold text-ink">{t.title}</p>
              <p className="text-sm text-muted">
                Prepared by {t.instance.preparedBy?.name ?? "—"}
                {t.instance.reviewedBy && `, reviewed by ${t.instance.reviewedBy.name}`} · submitted {formatDate(t.instance.submittedAt)}
              </p>
            </div>
            <WorkflowBadge state={t.instance.state} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function TasksPage() {
  return (
    <AppShell title="My Tasks">
      <Tasks />
    </AppShell>
  );
}
