"use client";

import Link from "next/link";
import { useState } from "react";
import { BrandHeader } from "@/components/AppShell";
import { TextField } from "@/components/forms";
import { ArrowRight, Button, Callout } from "@/components/ui";
import { ApiError, recoveryApi } from "@/lib/api";

type Step = "request" | "code" | "respond" | "done";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/**
 * Support-assisted Super Administrator recovery. Nothing on the system changes
 * until a response code signed by AICAN is entered.
 */
function Recovery() {
  const [step, setStep] = useState<Step>("request");
  const [username, setUsername] = useState("");
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState<{ requestCode: string; expiresAt: string; platformInstanceId: string } | null>(null);
  const [response, setResponse] = useState("");
  const [result, setResult] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function createRequest(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!username.trim()) next.username = "Enter the Super Administrator username or email.";
    if (reason.trim().length < 10) next.reason = "Say who is requesting recovery and why (at least 10 characters).";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      setRequest(await recoveryApi.request(username, reason));
      setStep("code");
    } catch (err) {
      const field = err instanceof ApiError ? err.body?.field : undefined;
      setErrors({ [field === "username" || field === "reason" ? field : "form"]: message(err, "The request could not be created.") });
    } finally {
      setBusy(false);
    }
  }

  async function complete(e: React.FormEvent) {
    e.preventDefault();
    if (!response.trim()) return setErrors({ response: "Paste the recovery response code from AICAN support." });
    setBusy(true);
    setErrors({});
    try {
      setResult(await recoveryApi.complete(response));
      setStep("done");
    } catch (err) {
      setErrors({ response: message(err, "The recovery response was not accepted.") });
    } finally {
      setBusy(false);
    }
  }

  const card = "space-y-5 rounded-lg border border-line bg-white p-8";

  return (
    <main className="mx-auto max-w-xl px-4 py-14">
      {step === "request" && (
        <form onSubmit={createRequest} noValidate className={card}>
          <div>
            <h2 className="text-2xl font-semibold text-ink">Administrator recovery</h2>
            <p className="mt-1 text-muted">
              Use this only when no Super Administrator can sign in. Other users are helped by an administrator from the Users page.
            </p>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Create a recovery request here.</li>
            <li>Send the request code to AICAN support. They verify who you are.</li>
            <li>Enter the response code they send back to receive a one-time password.</li>
          </ol>
          <TextField
            id="username"
            label="Super Administrator username or email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={errors.username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
          />
          <div>
            <label htmlFor="reason" className="mb-1.5 block text-sm font-semibold text-ink">
              Who is requesting, and why
            </label>
            <textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={!!errors.reason}
              placeholder="e.g. QA Head J. Rao: the only administrator account is locked; ticket SUP-2026-0042"
              className={`w-full rounded-md border bg-white px-3.5 py-2.5 text-[15px] ${errors.reason ? "border-fail" : "border-line"}`}
            />
            {errors.reason && <p className="mt-1.5 text-sm text-fail">{errors.reason}</p>}
          </div>
          {errors.form && <Callout tone="fail">{errors.form}</Callout>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Creating…" : "Create recovery request"} <ArrowRight />
          </Button>
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <Link href="/login/" className="font-semibold text-brand hover:underline">
              Back to sign in
            </Link>
            <button type="button" onClick={() => setStep("respond")} className="font-semibold text-brand hover:underline">
              I already have a response code
            </button>
          </div>
          <p className="text-xs text-muted">Every recovery step is recorded in the audit trail.</p>
        </form>
      )}

      {step === "code" && request && (
        <div className={card}>
          <h2 className="text-2xl font-semibold text-ink">Send this code to AICAN support</h2>
          <p className="text-muted">
            The code identifies this installation and request. It contains no password and is safe to email. It is valid until{" "}
            <span className="font-semibold text-ink">{new Date(request.expiresAt).toLocaleString()}</span>.
          </p>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Recovery request · platform {request.platformInstanceId}
            </p>
            <textarea
              readOnly
              rows={5}
              value={request.requestCode}
              aria-label="Recovery request code"
              onFocus={(e) => e.currentTarget.select()}
              className="w-full break-all rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink"
            />
            <CopyButton text={request.requestCode} />
          </div>
          <Callout tone="info">
            Keep this page open, or come back later and choose &ldquo;I already have a response code&rdquo;. Creating a new request
            cancels this one.
          </Callout>
          <Button className="w-full" onClick={() => setStep("respond")}>
            Enter the response code <ArrowRight />
          </Button>
        </div>
      )}

      {step === "respond" && (
        <form onSubmit={complete} noValidate className={card}>
          <div>
            <h2 className="text-2xl font-semibold text-ink">Enter the recovery response</h2>
            <p className="mt-1 text-muted">Paste the response code from AICAN support exactly as received.</p>
          </div>
          <div>
            <label htmlFor="response" className="mb-1.5 block text-sm font-semibold text-ink">
              Recovery response code
            </label>
            <textarea
              id="response"
              rows={6}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              aria-invalid={!!errors.response}
              spellCheck={false}
              placeholder="NXRS1.…"
              className={`w-full rounded-md border bg-white px-3 py-2 font-mono text-xs ${errors.response ? "border-fail" : "border-line"}`}
              autoFocus
            />
            {errors.response && <Callout tone="fail">{errors.response}</Callout>}
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Verifying…" : "Recover administrator access"} <ArrowRight />
          </Button>
          <button type="button" onClick={() => setStep(request ? "code" : "request")} className="text-sm font-semibold text-brand hover:underline">
            Back
          </button>
        </form>
      )}

      {step === "done" && result && (
        <div className={card}>
          <Callout tone="pass" title="Administrator access recovered">
            The account <span className="font-mono font-semibold">{result.username}</span> has a one-time password. Its other sessions
            were ended and any lockout was cleared.
          </Callout>
          <Callout tone="warn" title="One-time password — shown only once">
            <p>Sign in with it now. You must choose a new password straight away.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <code className="rounded border border-line bg-white px-3 py-2 font-mono text-lg tracking-wider text-ink">
                {result.temporaryPassword}
              </code>
              <CopyButton text={result.temporaryPassword} />
            </div>
          </Callout>
          <Link
            href="/login/"
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand px-5 font-semibold text-white"
          >
            Go to sign in <ArrowRight />
          </Link>
        </div>
      )}
    </main>
  );
}

export default function RecoveryPage() {
  return (
    <div className="min-h-screen">
      <BrandHeader title="NxGen Compliance Platform" />
      <Recovery />
    </div>
  );
}
