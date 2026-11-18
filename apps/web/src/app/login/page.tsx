"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { BrandHeader } from "@/components/AppShell";
import { TextField } from "@/components/forms";
import { ArrowRight, Button, Callout } from "@/components/ui";
import { ApiError, authApi } from "@/lib/api";

const REASONS: Record<string, string> = {
  session: "Your session has ended. Sign in again to continue.",
  "signed-out": "You have been signed out.",
  "password-changed": "Your password was changed. Sign in with the new password.",
};

/** 29:59, or 1:02:03 for locks over an hour. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function LoginForm() {
  const router = useRouter();
  const [params, setParams] = useState<URLSearchParams | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noAdmin, setNoAdmin] = useState(false);
  /** When a locked account unlocks (this computer's clock), for the countdown. */
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!lockedUntil) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) {
        setLockedUntil(null);
        setError(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  useEffect(() => {
    setParams(new URLSearchParams(window.location.search));
    authApi.setupStatus().then((s) => setNoAdmin(!s.administratorExists)).catch(() => undefined);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return setError("Enter your username or email, and your password.");
    setBusy(true);
    setError(null);
    try {
      const principal = await authApi.login(username, password);
      const next = params?.get("next");
      router.replace(principal.mustChangePassword ? "/change-password/?required=1" : next?.startsWith("/") ? next : "/home/");
    } catch (err) {
      setPassword("");
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      const wait = err instanceof ApiError && err.body?.code === "NX-AUTH-LOCKED" ? err.body.retryAfterSeconds : undefined;
      setLockedUntil(wait ? Date.now() + wait * 1000 : null);
      setNow(Date.now());
    } finally {
      setBusy(false);
    }
  }

  const reason = params?.get("reason");
  return (
    <main className="mx-auto max-w-md px-4 py-14">
      <form onSubmit={submit} noValidate className="space-y-5 rounded-lg border border-line bg-white p-8">
        <div>
          <h2 className="text-2xl font-semibold text-ink">Sign in</h2>
          <p className="mt-1 text-muted">Use your personal NxGen account. Never share your credentials.</p>
        </div>
        {reason && REASONS[reason] && <Callout tone="info">{REASONS[reason]}</Callout>}
        {noAdmin && (
          <Callout tone="warn" title="No administrator yet">
            Complete <Link href="/setup/" className="font-semibold text-brand hover:underline">Administrator Setup</Link> first.
          </Callout>
        )}
        <TextField id="username" label="Username or email" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus spellCheck={false} />
        <TextField id="password" label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {error && (
          <Callout tone="fail">
            {error}
            {lockedUntil && (
              <p className="mt-2 font-semibold text-ink" aria-live="polite">
                Unlocks in <span className="font-mono">{formatRemaining(lockedUntil - now)}</span>
              </p>
            )}
          </Callout>
        )}
        <Button type="submit" className="w-full" disabled={busy || !!lockedUntil}>
          {busy ? "Signing in…" : "Sign in"} <ArrowRight />
        </Button>
        <p className="text-xs text-muted">Sign-in attempts are recorded in the audit trail.</p>
        <p className="border-t border-line pt-4 text-sm text-muted">
          Forgot your password? Ask an administrator to reset it. If no administrator can sign in, use{" "}
          <Link href="/recovery/" className="font-semibold text-brand hover:underline">
            administrator recovery
          </Link>
          .
        </p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen">
      <BrandHeader title="NxGen Compliance Platform" />
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
