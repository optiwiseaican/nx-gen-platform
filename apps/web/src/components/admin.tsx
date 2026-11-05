"use client";

import { useEffect, useRef, useState } from "react";
import {
  ROLE_NAMES,
  SignatureInput,
  SignatureMeaning,
  SignaturePolicy,
  SignatureRecord,
  signaturesApi,
  UserSummary,
} from "@/lib/api";
import { usePrincipal } from "./AppShell";
import { Badge, Button, Callout } from "./ui";

let policyCache: Promise<{ policies: SignaturePolicy[]; meanings: SignatureMeaning[] }> | null = null;
/** Signature policy, fetched once per page load (it changes rarely and the server re-checks every request). */
export function loadSignaturePolicy(refresh = false) {
  if (!policyCache || refresh) policyCache = signaturesApi.policy();
  policyCache.catch(() => (policyCache = null));
  return policyCache;
}

/**
 * Every administrative change needs a written reason (21 CFR 11.10(e)). When
 * the signature policy requires it for `action`, the same dialog collects the
 * electronic signature: meaning + username + password (11.50, 11.200(a)).
 * The server enforces both regardless of what the UI does.
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  action,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** Signature-policy action code, e.g. USER_ROLES_CHANGE. */
  action?: string;
  onConfirm: (reason: string, signature?: SignatureInput) => Promise<void>;
  onClose: () => void;
}) {
  const principal = usePrincipal();
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<SignaturePolicy | null>(null);
  const [meanings, setMeanings] = useState<SignatureMeaning[]>([]);
  const [optIn, setOptIn] = useState(false);
  const [meaning, setMeaning] = useState("APPROVED");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setReason("");
      setError(null);
      setPassword("");
      setUsername(principal.username);
      setOptIn(false);
      d.showModal();
      if (action) {
        void loadSignaturePolicy().then((p) => {
          const pol = p.policies.find((x) => x.actionCode === action) ?? null;
          setPolicy(pol);
          setMeanings(p.meanings);
          setMeaning(pol?.defaultMeaning ?? "APPROVED");
        });
      }
    } else if (!open && d.open) d.close();
  }, [open, action, principal.username]);

  const signing = !!action && (policy?.required || optIn);
  const statement = meanings.find((m) => m.code === meaning)?.statement;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 5) return setError("Enter a reason for this change (at least 5 characters).");
    if (signing && (!username || !password)) return setError("Enter your username or email, and your password, to sign.");
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim(), signing ? { username, password, meaning } : undefined);
    } catch (err) {
      setPassword("");
      setError(err instanceof Error ? err.message : "The change failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-line p-0 shadow-xl backdrop:bg-navy/40"
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

        {action && policy && !policy.required && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            Add my electronic signature (optional for this action)
          </label>
        )}

        {signing && (
          <fieldset className="space-y-3 rounded-md border border-brand/30 bg-brand-50 p-4">
            <legend className="px-1 text-sm font-semibold text-brand-700">Electronic signature</legend>
            <div>
              <label htmlFor="sig-meaning" className="mb-1 block text-sm font-semibold text-ink">
                Meaning of signature
              </label>
              <select
                id="sig-meaning"
                value={meaning}
                onChange={(e) => setMeaning(e.target.value)}
                className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
              >
                {meanings.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </select>
              {statement && <p className="mt-1 text-xs text-muted">“{statement}”</p>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="sig-username" className="mb-1 block text-sm font-semibold text-ink">
                  Username or email
                </label>
                <input
                  id="sig-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="sig-password" className="mb-1 block text-sm font-semibold text-ink">
                  Password
                </label>
                <input
                  id="sig-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm"
                />
              </div>
            </div>
            <p className="text-xs text-muted">
              By signing, I, <span className="font-semibold text-ink">{principal.fullName}</span>, confirm that this
              electronic signature is the legally binding equivalent of my handwritten signature.
            </p>
          </fieldset>
        )}

        {error && <Callout tone="fail">{error}</Callout>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy} className={destructive ? "!bg-fail hover:!bg-fail/90" : ""}>
            {busy ? "Saving…" : signing ? `Sign & ${confirmLabel}` : confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/** Signature manifestation (21 CFR 11.50): printed name, date/time, meaning — plus integrity. */
export function SignatureManifest({ sig }: { sig: SignatureRecord }) {
  return (
    <div className="rounded-md border border-line bg-white p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-ink">
            {sig.meaningLabel} — {sig.signerFullName}{" "}
            <span className="font-mono text-xs font-normal text-muted">({sig.signerUsername})</span>
          </p>
          <p className="text-muted">
            {new Date(sig.signedAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "long" })}
          </p>
        </div>
        {sig.intact ? <Badge tone="pass">SIGNATURE VERIFIED</Badge> : <Badge tone="fail">SIGNATURE INVALID</Badge>}
      </div>
      <p className="mt-2 text-muted">“{sig.meaningStatement}”</p>
      <p className="mt-1">
        <span className="text-muted">Signed action:</span> <span className="font-mono text-xs">{sig.actionCode}</span>
        {sig.recordVersion !== null && <span className="text-muted"> · record version {sig.recordVersion}</span>}
      </p>
      <p className="mt-1">
        <span className="text-muted">Reason:</span> {sig.reason}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-semibold text-brand">What was signed</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-canvas p-2 font-mono text-xs">
          {JSON.stringify(sig.signedContent, null, 2)}
        </pre>
        <p className="mt-1 font-mono text-[11px] text-muted">SHA-256 {sig.contentHash}</p>
      </details>
    </div>
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
