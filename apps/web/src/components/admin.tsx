"use client";

import { useEffect, useRef, useState } from "react";
import { ROLE_NAMES, UserSummary } from "@/lib/api";
import { Badge, Button, Callout } from "./ui";

/**
 * Every administrative change needs a written reason (21 CFR 11.10(e)); this
 * dialog collects it before the change is sent. The server enforces it too.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setReason("");
      setError(null);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 5) return setError("Enter a reason for this change (at least 5 characters).");
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The change failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line p-0 shadow-xl backdrop:bg-navy/40"
    >
      <form onSubmit={submit} className="space-y-4 p-6">
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        <div className="text-sm text-muted">{description}</div>
        <div>
          <label htmlFor="change-reason" className="mb-1.5 block text-sm font-semibold text-ink">
            Reason for change
          </label>
          <textarea
            id="change-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            autoFocus
            placeholder="e.g. Approved access request AR-2026-014"
            className="w-full rounded-md border border-line px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted">Recorded permanently in the audit trail with your name and the time.</p>
        </div>
        {error && <Callout tone="fail">{error}</Callout>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy} className={destructive ? "!bg-fail hover:!bg-fail/90" : ""}>
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/** Shows a generated temporary password exactly once. */
export function TemporaryPassword({ username, password }: { username: string; password: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Callout tone="warn" title="Temporary password — shown only once">
      <p>
        Give this password to <span className="font-mono font-semibold text-ink">{username}</span> through a secure channel.
        They must change it at first sign-in. NxGen does not store it in readable form.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <code className="rounded border border-line bg-white px-3 py-2 font-mono text-lg tracking-wider text-ink">{password}</code>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(password).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </Callout>
  );
}

export function UserStatusBadges({ user }: { user: UserSummary }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {user.status === "ACTIVE" ? <Badge tone="pass">ACTIVE</Badge> : <Badge tone="fail">DISABLED</Badge>}
      {user.locked && <Badge tone="fail">LOCKED</Badge>}
      {user.mustChangePassword && user.status === "ACTIVE" && <Badge tone="warn">PASSWORD CHANGE</Badge>}
    </span>
  );
}

export function RoleChips({ roles }: { roles: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {roles.map((r) => (
        <span key={r} className="rounded bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
          {ROLE_NAMES[r] ?? r}
        </span>
      ))}
    </span>
  );
}

export function RoleCheckboxes({
  roles,
  selected,
  onChange,
  disabledCodes = [],
}: {
  roles: { code: string; name: string; description: string }[];
  selected: string[];
  onChange: (codes: string[]) => void;
  disabledCodes?: string[];
}) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-semibold text-ink">Roles</legend>
      {roles.map((r) => {
        const checked = selected.includes(r.code);
        const disabled = disabledCodes.includes(r.code);
        return (
          <label
            key={r.code}
            className={`flex gap-3 rounded-md border p-3 text-sm ${checked ? "border-brand bg-brand-50" : "border-line bg-white"} ${
              disabled ? "opacity-50" : "cursor-pointer"
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(checked ? selected.filter((c) => c !== r.code) : [...selected, r.code])}
            />
            <span>
              <span className="block font-semibold text-ink">{r.name}</span>
              <span className="text-muted">{r.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export const formatDate = (v: string | null) =>
  v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
