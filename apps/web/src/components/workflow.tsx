"use client";

import { useState } from "react";
import {
  SignatureInput,
  WorkflowEvent,
  WorkflowInstance,
  WorkflowState,
  WorkflowStep,
  workflowApi,
} from "@/lib/api";
import { formatDate, ReasonDialog, SignatureManifest } from "./admin";
import { Badge, Button } from "./ui";

export const STATE_LABEL: Record<WorkflowState, string> = {
  DRAFT: "Draft",
  IN_REVIEW: "In review",
  REVIEWED: "Reviewed",
  APPROVED: "Approved",
  INVALIDATED: "Invalidated",
  SUPERSEDED: "Superseded",
};

export function WorkflowBadge({ state }: { state: WorkflowState }) {
  const tone = state === "APPROVED" ? "pass" : state === "INVALIDATED" ? "fail" : "warn";
  if (state === "SUPERSEDED" || state === "DRAFT")
    return (
      <span className="inline-flex items-center rounded border border-line bg-canvas px-2 py-0.5 text-xs font-semibold tracking-wide text-muted">
        {STATE_LABEL[state].toUpperCase()}
      </span>
    );
  return <Badge tone={tone}>{STATE_LABEL[state].toUpperCase()}</Badge>;
}

const STAGES: { state: WorkflowState; label: string; who: (i: WorkflowInstance) => string | null; when: (i: WorkflowInstance) => string | null }[] = [
  { state: "DRAFT", label: "Prepared", who: (i) => i.preparedBy?.name ?? null, when: (i) => i.submittedAt },
  { state: "IN_REVIEW", label: "Reviewed", who: (i) => i.reviewedBy?.name ?? null, when: () => null },
  { state: "REVIEWED", label: "Approved", who: (i) => i.approvedBy?.name ?? null, when: (i) => i.approvedAt },
];
const ORDER: WorkflowState[] = ["DRAFT", "IN_REVIEW", "REVIEWED", "APPROVED"];

/** Prepared → (Reviewed →) Approved, showing who signed each stage. */
export function WorkflowStepper({ instance, withReview = true }: { instance: WorkflowInstance; withReview?: boolean }) {
  const state = instance.state === "INVALIDATED" || instance.state === "SUPERSEDED" ? "APPROVED" : instance.state;
  // Without a review stage, IN_REVIEW means "waiting for approval".
  const stages = withReview ? STAGES : [STAGES[0], STAGES[2]];
  const order: WorkflowState[] = withReview ? ORDER : ["DRAFT", "IN_REVIEW", "APPROVED"];
  const reached = order.indexOf(state);
  return (
    <ol className={`grid gap-2 ${withReview ? "sm:grid-cols-3" : "sm:grid-cols-2"}`} aria-label="Approval progress">
      {stages.map((s, idx) => {
        const done = reached > idx;
        const current = reached === idx;
        return (
          <li
            key={s.state}
            aria-current={current ? "step" : undefined}
            className={`rounded-md border px-3 py-2 text-sm ${
              done ? "border-pass/40 bg-pass-50" : current ? "border-brand/40 bg-brand-50" : "border-line bg-white"
            }`}
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              {idx + 1}. {s.label}
            </p>
            <p className="font-medium text-ink">{done ? s.who(instance) ?? "—" : current ? "Waiting" : "Not yet"}</p>
            {done && s.when(instance) && <p className="text-xs text-muted">{formatDate(s.when(instance))}</p>}
          </li>
        );
      })}
    </ol>
  );
}

interface StepUi {
  label: string;
  title: string;
  confirm: string;
  description: string;
  meaning?: string;
  minReason: number;
  reasonLabel: string;
  placeholder: string;
  destructive?: boolean;
  variant: "primary" | "secondary";
}

const STEP_UI: Record<WorkflowStep, StepUi> = {
  SUBMIT: {
    label: "Submit for review…",
    title: "Submit for review",
    confirm: "Submit",
    description: "The version is locked from now on. Its content is fingerprinted, and reviewers will sign against exactly this content.",
    meaning: "AUTHORED",
    minReason: 0,
    reasonLabel: "Comment",
    placeholder: "e.g. Ready for QA review",
    variant: "primary",
  },
  WITHDRAW: {
    label: "Withdraw…",
    title: "Withdraw from review",
    confirm: "Withdraw",
    description: "The version returns to draft so you can change it. Reviewers will no longer see it.",
    minReason: 10,
    reasonLabel: "Reason",
    placeholder: "e.g. Need to correct the buffer list",
    variant: "secondary",
  },
  REVIEW: {
    label: "Review…",
    title: "Sign as reviewed",
    confirm: "Review",
    description: "Confirm you have checked this version. An approver will then make the final decision.",
    meaning: "REVIEWED",
    minReason: 0,
    reasonLabel: "Review comment",
    placeholder: "e.g. Checked against SOP-QC-012",
    variant: "primary",
  },
  APPROVE: {
    label: "Approve…",
    title: "Approve this version",
    confirm: "Approve",
    description: "This version becomes the effective version. Any previously approved version is superseded.",
    meaning: "APPROVED",
    minReason: 0,
    reasonLabel: "Approval comment",
    placeholder: "e.g. Approved for routine use",
    variant: "primary",
  },
  REJECT: {
    label: "Reject…",
    title: "Reject this version",
    confirm: "Reject",
    description: "Explain what must be corrected. The reason is shown to the preparer and kept in the history.",
    meaning: "REJECTED",
    minReason: 10,
    reasonLabel: "Reason for rejection",
    placeholder: "e.g. Tolerance conflicts with USP <791>",
    destructive: true,
    variant: "secondary",
  },
  INVALIDATE: {
    label: "Invalidate…",
    title: "Invalidate the approved version",
    confirm: "Invalidate",
    description: "The version will no longer be effective. A new version can then be prepared.",
    meaning: "INVALIDATED",
    minReason: 10,
    reasonLabel: "Reason",
    placeholder: "e.g. Pharmacopoeia revision withdraws this procedure",
    destructive: true,
    variant: "secondary",
  },
};

/** Buttons for the steps the signed-in user may take now; each opens a signed dialog. */
export function WorkflowActions({
  instance,
  allowed,
  onDone,
  labels,
  messages,
}: {
  instance: WorkflowInstance;
  allowed: WorkflowStep[];
  onDone: (message: string) => Promise<void> | void;
  /** Per record type wording, e.g. calibrations are submitted "for approval". */
  labels?: Partial<Record<WorkflowStep, Partial<Pick<StepUi, "label" | "title" | "description">>>>;
  messages?: Partial<Record<WorkflowStep, string>>;
}) {
  const [step, setStep] = useState<WorkflowStep | null>(null);
  const [returnTo, setReturnTo] = useState<WorkflowState>("DRAFT");
  const stepUi = (s: WorkflowStep): StepUi => ({ ...STEP_UI[s], ...labels?.[s] });
  if (!allowed.length) return null;
  const ui = step ? stepUi(step) : null;

  async function confirm(reason: string, signature?: SignatureInput) {
    await workflowApi.act(instance.id, step!, { reason, signature, returnTo: step === "REJECT" ? returnTo : undefined });
    const done = step!;
    setStep(null);
    await onDone(
      messages?.[done] ??
      {
        SUBMIT: "Submitted for review and locked.",
        WITHDRAW: "Withdrawn. The version is a draft again.",
        REVIEW: "Signed as reviewed.",
        APPROVE: "Approved. This is now the effective version.",
        REJECT: returnTo === "IN_REVIEW" ? "Rejected and returned for review." : "Rejected and returned to the preparer as a draft.",
        INVALIDATE: "Invalidated. This version is no longer effective.",
      }[done],
    );
  }

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {allowed.map((s) => (
          <Button
            key={s}
            variant={stepUi(s).variant}
            onClick={() => {
              setReturnTo("DRAFT");
              setStep(s);
            }}
          >
            {stepUi(s).label}
          </Button>
        ))}
      </div>
      <ReasonDialog
        open={!!step}
        title={ui?.title ?? ""}
        description={ui?.description ?? ""}
        confirmLabel={ui?.confirm ?? ""}
        destructive={ui?.destructive}
        action={step && step !== "WITHDRAW" ? `WORKFLOW_${step}` : undefined}
        fixedMeaning={ui?.meaning}
        minReason={ui?.minReason}
        reasonLabel={ui?.reasonLabel}
        reasonPlaceholder={ui?.placeholder}
        onConfirm={confirm}
        onClose={() => setStep(null)}
      >
        {step === "REJECT" && instance.state === "REVIEWED" && (
          <fieldset className="space-y-1.5 text-sm">
            <legend className="mb-1 font-semibold text-ink">Send it back to</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="returnTo" checked={returnTo === "DRAFT"} onChange={() => setReturnTo("DRAFT")} />
              The preparer, as a draft to correct
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="returnTo" checked={returnTo === "IN_REVIEW"} onChange={() => setReturnTo("IN_REVIEW")} />
              Review again (content unchanged)
            </label>
          </fieldset>
        )}
      </ReasonDialog>
    </>
  );
}

const STEP_TEXT: Record<string, string> = {
  CREATE: "Created draft",
  SUBMIT: "Submitted for review",
  WITHDRAW: "Withdrawn to draft",
  REVIEW: "Reviewed",
  APPROVE: "Approved",
  REJECT: "Rejected",
  INVALIDATE: "Invalidated",
  SUPERSEDE: "Superseded",
};

/** Every step with who, when, why and the signature manifestation. */
export function WorkflowHistory({ events }: { events: WorkflowEvent[] }) {
  return (
    <ol className="space-y-3">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="rounded-md border border-line bg-white p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-ink">
              {STEP_TEXT[e.step] ?? e.step}
              {e.step === "REJECT" && e.toState === "IN_REVIEW" && " (back to review)"}
              <span className="font-normal text-muted"> · {e.actorName ?? e.actorId}</span>
            </p>
            <p className="text-xs text-muted">{formatDate(e.occurredAt)}</p>
          </div>
          {e.comment && <p className="mt-1 text-muted">“{e.comment}”</p>}
          {e.signature && (
            <div className="mt-2">
              <SignatureManifest sig={e.signature} />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
