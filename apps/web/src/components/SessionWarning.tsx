"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authApi, sessionClock, SessionTiming } from "@/lib/api";
import { Button } from "./ui";

/** Warn this long before the session ends. The shortest allowed inactivity limit is 5 minutes. */
const WARN_MS = 2 * 60_000;

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Inactivity and maximum-session warning (21 CFR 11.300; Annex 11 §12).
 * Timing comes from the server on every API response; this component never
 * contacts the server on its own, so it cannot keep an idle session alive.
 * Only an explicit "Stay signed in" does, and that is audited.
 */
export function SessionWarning() {
  const router = useRouter();
  const pathname = usePathname();
  const ref = useRef<HTMLDialogElement>(null);
  const [timing, setTiming] = useState<SessionTiming | null>(sessionClock.get());
  const [now, setNow] = useState(() => Date.now());
  const [dismissedMax, setDismissedMax] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => sessionClock.subscribe(setTiming), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const idleLeft = timing ? timing.idleExpiresAt - now : Infinity;
  const maxLeft = timing ? timing.expiresAt - now : Infinity;
  const endsByMax = maxLeft <= idleLeft;
  const left = Math.min(idleLeft, maxLeft);
  const warn = !!timing && left <= WARN_MS && !(endsByMax && dismissedMax);

  useEffect(() => {
    if (!timing || left > 0) return;
    sessionClock.clear();
    router.replace(`/login/?next=${encodeURIComponent(pathname)}&reason=session`);
  }, [timing, left, router, pathname]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (warn && !d.open) d.showModal();
    if (!warn && d.open) d.close();
  }, [warn]);

  async function stay() {
    setBusy(true);
    setError(null);
    try {
      await authApi.extendSession();
    } catch {
      setError("Your session could not be extended. Save your work and sign in again.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await authApi.logout().catch(() => undefined);
    sessionClock.clear();
    router.replace("/login/?reason=signed-out");
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="session-warning-title"
      onCancel={(e) => {
        e.preventDefault();
        if (endsByMax) setDismissedMax(true);
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-white p-0 text-ink shadow-xl backdrop:bg-navy/40"
    >
      <div className="space-y-4 p-6">
        <h2 id="session-warning-title" className="text-lg font-semibold">
          {endsByMax ? "Your session is about to reach its time limit" : "You will be signed out soon"}
        </h2>
        <p className="text-sm text-muted">
          {endsByMax
            ? "Sessions have a maximum length and cannot be extended. Finish or save your work; you will need to sign in again."
            : "You have been inactive. To protect the records, NxGen signs you out after a period of inactivity."}
        </p>
        <p className="text-center font-mono text-4xl font-semibold tabular-nums text-ink" aria-live="polite">
          {mmss(left)}
        </p>
        {error && <p className="text-sm text-fail">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out now
          </Button>
          {endsByMax ? (
            <Button onClick={() => setDismissedMax(true)}>OK</Button>
          ) : (
            <Button onClick={() => void stay()} disabled={busy} autoFocus>
              {busy ? "Extending…" : "Stay signed in"}
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
