"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandHeader } from "@/components/AppShell";
import { PasswordRules, TextField } from "@/components/forms";
import { ArrowRight, Button, Callout, StatusIcon } from "@/components/ui";
import { ApiError, authApi, SetupStatus } from "@/lib/api";

/**
 * Administrator Setup — the stage after activation (License PRD §30).
 * Creates the first Super Administrator; closed for good once any user exists.
 */
export default function AdministratorSetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState({ username: "", fullName: "", email: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    authApi.setupStatus().then(setStatus).catch(() => setLoadFailed(true));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setErrors({ ...errors, [k]: "", form: "" });
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.username.trim()) next.username = "Choose a username.";
    if (!form.fullName.trim()) next.fullName = "Enter the administrator's full name.";
    if (!form.password) next.password = "Choose a password.";
    if (form.password !== form.confirm) next.confirm = "The passwords do not match.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    try {
      const res = await authApi.createAdministrator({
        username: form.username,
        fullName: form.fullName,
        email: form.email || undefined,
        password: form.password,
      });
      setCreated(res.username);
    } catch (err) {
      if (err instanceof ApiError && err.body?.field) setErrors({ [err.body.field]: err.message });
      else setErrors({ form: err instanceof Error ? err.message : "Setup failed." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen">
      <BrandHeader title="Administrator Setup" />
      <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        {loadFailed && <Callout tone="fail" title="NxGen services unavailable">Restart NxGen and try again.</Callout>}
        {!status && !loadFailed && (
          <p className="flex items-center gap-2 text-muted">
            <StatusIcon tone="progress" /> Loading…
          </p>
        )}

        {status && !status.databaseConfigured && (
          <Callout tone="fail" title="Database not configured">
            The NxGen database is required before the administrator can be created.
          </Callout>
        )}

        {status && status.databaseConfigured && !status.licenseActive && (
          <Callout tone="warn" title="Activation required">
            NxGen must be activated before the administrator can be created.{" "}
            <Link href="/" className="font-semibold text-brand hover:underline">
              Activate NxGen
            </Link>
          </Callout>
        )}

        {status?.administratorExists && !created && (
          <div className="space-y-4">
            <Callout tone="info" title="Initial setup is complete">
              An administrator account already exists. Sign in to continue.
            </Callout>
            <Link href="/login/" className="inline-flex min-h-11 items-center gap-2 rounded-md bg-brand px-5 font-semibold text-white">
              Sign in <ArrowRight />
            </Link>
          </div>
        )}

        {created && (
          <div className="space-y-5 rounded-lg border border-line bg-white p-8 text-center">
            <StatusIcon tone="pass" className="mx-auto h-16 w-16" />
            <h2 className="text-xl font-semibold">Administrator account created</h2>
            <p className="text-muted">
              <span className="font-mono font-medium text-ink">{created}</span> is the Super Administrator. Initial setup is
              now closed — further accounts are created by an administrator after signing in.
            </p>
            <Link href="/login/" className="inline-flex min-h-11 items-center gap-2 rounded-md bg-brand px-5 font-semibold text-white">
              Sign in <ArrowRight />
            </Link>
          </div>
        )}

        {status?.databaseConfigured && status.licenseActive && !status.administratorExists && !created && (
          <form onSubmit={submit} noValidate className="space-y-6 rounded-lg border border-line bg-white p-6 sm:p-8">
            <div>
              <p className="text-sm font-semibold uppercase tracking-widest text-brand">Step 1 of setup</p>
              <h2 className="mt-1 text-2xl font-semibold text-ink">Create the Super Administrator</h2>
              <p className="mt-2 text-muted">
                This account administers NxGen: users, roles, security settings and licensing. It must belong to one named
                person — shared accounts are not permitted.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <TextField id="fullName" label="Full name" value={form.fullName} onChange={set("fullName")} error={errors.fullName} autoComplete="name" autoFocus />
              <TextField
                id="username"
                label="Username"
                value={form.username}
                onChange={set("username")}
                error={errors.username}
                hint="Lowercase letters, digits, . _ -"
                autoComplete="username"
                spellCheck={false}
              />
            </div>
            <TextField id="email" label="Email (optional)" type="email" value={form.email} onChange={set("email")} error={errors.email} autoComplete="email" />
            <div>
              <TextField id="password" label="Password" type="password" value={form.password} onChange={set("password")} error={errors.password} autoComplete="new-password" />
              <PasswordRules password={form.password} minLength={status.passwordPolicy.minLength} username={form.username} fullName={form.fullName} />
            </div>
            <TextField id="confirm" label="Confirm password" type="password" value={form.confirm} onChange={set("confirm")} error={errors.confirm} autoComplete="new-password" />

            {errors.form && <Callout tone="fail" title="Could not create the administrator">{errors.form}</Callout>}

            <p className="text-sm text-muted">
              Passwords expire every {status.passwordPolicy.maxAgeDays} days and cannot repeat the last{" "}
              {status.passwordPolicy.history}. This action is recorded in the audit trail.
            </p>
            <div className="flex justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create Administrator"} <ArrowRight />
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
