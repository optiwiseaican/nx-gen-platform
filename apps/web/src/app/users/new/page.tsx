"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RoleCheckboxes, TemporaryPassword } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { TextField } from "@/components/forms";
import { Button, Callout } from "@/components/ui";
import { ApiError, RoleSummary, usersApi } from "@/lib/api";

function NewUserForm() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [form, setForm] = useState({ fullName: "", username: "", email: "", reason: "" });
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; username: string; password: string } | null>(null);

  useEffect(() => {
    usersApi
      .roles()
      .then((r) => setRoles(r.roles))
      .catch((err) => redirect(err));
  }, [redirect]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.fullName.trim()) next.fullName = "Enter the person's full name.";
    if (!form.username.trim()) next.username = "Choose a username.";
    if (selected.length === 0) next.roles = "Assign at least one role.";
    if (form.reason.trim().length < 5) next.reason = "Enter a reason for creating this account (at least 5 characters).";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      const res = await usersApi.create({
        fullName: form.fullName,
        username: form.username,
        email: form.email || undefined,
        roles: selected,
        reason: form.reason,
      });
      setCreated({ id: res.user.id, username: res.user.username, password: res.temporaryPassword });
    } catch (err) {
      if (redirect(err)) return;
      const field = err instanceof ApiError ? err.body?.field : undefined;
      setErrors({ [field ?? "form"]: err instanceof Error ? err.message : "Could not create the user." });
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="max-w-2xl space-y-5">
        <Callout tone="pass" title="User created">
          <span className="font-mono">{created.username}</span> can now sign in with the temporary password below.
        </Callout>
        <TemporaryPassword username={created.username} password={created.password} />
        <div className="flex gap-4 text-sm font-semibold">
          <Link href={`/users/view/?id=${created.id}`} className="text-brand hover:underline">
            Open user
          </Link>
          <Link href="/users/" className="text-brand hover:underline">
            Back to users
          </Link>
        </div>
      </div>
    );
  }

  const isSuper = principal.roles.includes("SUPER_ADMINISTRATOR");
  return (
    <form onSubmit={submit} noValidate className="max-w-3xl space-y-6 rounded-lg border border-line bg-white p-6 sm:p-8">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField id="fullName" label="Full name" value={form.fullName} onChange={set("fullName")} error={errors.fullName} autoFocus />
        <TextField
          id="username"
          label="Username"
          value={form.username}
          onChange={set("username")}
          error={errors.username}
          hint="Lowercase letters, digits, . _ - · never reused"
          spellCheck={false}
        />
      </div>
      <TextField id="email" label="Email (optional)" type="email" value={form.email} onChange={set("email")} error={errors.email} />
      <div>
        <RoleCheckboxes
          roles={roles}
          selected={selected}
          onChange={setSelected}
          disabledCodes={isSuper ? [] : ["SUPER_ADMINISTRATOR"]}
        />
        {errors.roles && <p className="mt-1.5 text-sm text-fail">{errors.roles}</p>}
      </div>
      <div>
        <label htmlFor="reason" className="mb-1.5 block text-sm font-semibold text-ink">
          Reason for creating this account
        </label>
        <textarea
          id="reason"
          rows={2}
          value={form.reason}
          onChange={set("reason")}
          placeholder="e.g. New QC analyst, access request AR-2026-014"
          className={`w-full rounded-md border px-3 py-2 text-sm ${errors.reason ? "border-fail" : "border-line"}`}
        />
        {errors.reason && <p className="mt-1.5 text-sm text-fail">{errors.reason}</p>}
      </div>
      {errors.form && <Callout tone="fail">{errors.form}</Callout>}
      <p className="text-sm text-muted">
        NxGen generates a temporary password. The user must replace it at first sign-in.
      </p>
      <div className="flex justify-end gap-3">
        <Link href="/users/" className="inline-flex min-h-11 items-center rounded-md border border-line px-5 font-semibold">
          Cancel
        </Link>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create User"}
        </Button>
      </div>
    </form>
  );
}

export default function NewUserPage() {
  return (
    <AppShell title="New User">
      <NewUserForm />
    </AppShell>
  );
}
