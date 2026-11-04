"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell, usePrincipal } from "@/components/AppShell";
import { PasswordRules, TextField } from "@/components/forms";
import { Button, Callout } from "@/components/ui";
import { ApiError, authApi } from "@/lib/api";

function ChangePasswordForm() {
  const principal = usePrincipal();
  const router = useRouter();
  const [required, setRequired] = useState(false);
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => setRequired(new URLSearchParams(window.location.search).has("required")), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.next !== form.confirm) return setErrors({ confirm: "The passwords do not match." });
    setBusy(true);
    setErrors({});
    try {
      await authApi.changePassword(form.current, form.next);
      setDone(true);
      setTimeout(() => router.replace("/home/"), 1200);
    } catch (err) {
      const field = err instanceof ApiError ? err.body?.field : undefined;
      const key = field === "currentPassword" ? "current" : field === "newPassword" || field === "password" ? "next" : "form";
      setErrors({ [key]: err instanceof Error ? err.message : "Password change failed." });
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <form onSubmit={submit} noValidate className="max-w-xl space-y-5 rounded-lg border border-line bg-white p-6 sm:p-8">
      {(required || principal.mustChangePassword) && (
        <Callout tone="warn" title="Password change required">
          Your password has expired or was set by an administrator. Choose a new password to continue.
        </Callout>
      )}
      {done && <Callout tone="pass" title="Password changed">Your other sessions have been signed out.</Callout>}
      <TextField id="current" label="Current password" type="password" value={form.current} onChange={set("current")} error={errors.current} autoComplete="current-password" />
      <div>
        <TextField id="next" label="New password" type="password" value={form.next} onChange={set("next")} error={errors.next} autoComplete="new-password" />
        <PasswordRules password={form.next} minLength={12} username={principal.username} fullName={principal.fullName} />
      </div>
      <TextField id="confirm" label="Confirm new password" type="password" value={form.confirm} onChange={set("confirm")} error={errors.confirm} autoComplete="new-password" />
      {errors.form && <Callout tone="fail">{errors.form}</Callout>}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || done}>{busy ? "Saving…" : "Change Password"}</Button>
      </div>
    </form>
  );
}

export default function ChangePasswordPage() {
  return (
    <AppShell title="Change Password">
      <ChangePasswordForm />
    </AppShell>
  );
}
