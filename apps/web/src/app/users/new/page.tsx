"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ReasonDialog, RoleCheckboxes, TemporaryPassword } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { TextField } from "@/components/forms";
import { Button, Callout } from "@/components/ui";
import { ApiError, RoleSummary, SignatureInput, usersApi } from "@/lib/api";

function NewUserForm() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [form, setForm] = useState({ fullName: "", username: "", email: "" });
  const [confirming, setConfirming] = useState(false);
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

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!form.fullName.trim()) next.fullName = "Enter the person's full name.";
    if (!form.username.trim()) next.username = "Choose a username.";
    if (selected.length === 0) next.roles = "Assign at least one role.";
    setErrors(next);
    if (!Object.keys(next).length) setConfirming(true);
  }

  async function create(reason: string, signature?: SignatureInput) {
    setBusy(true);
    try {
      const res = await usersApi.create({
        fullName: form.fullName,
        username: form.username,
        email: form.email || undefined,
        roles: selected,
        reason,
        signature,
      });
      setConfirming(false);
      setCreated({ id: res.user.id, username: res.user.username, password: res.temporaryPassword });
    } catch (err) {
      if (redirect(err)) return;
      const field = err instanceof ApiError ? err.body?.field : undefined;
      // Field problems are shown on the form; signature/other problems inside the dialog.
      if (field && ["username", "fullName", "email", "roles"].includes(field)) {
        setConfirming(false);
        setErrors({ [field]: err instanceof Error ? err.message : "Invalid value." });
        return;
      }
      throw err;
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
    <>
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
      {errors.form && <Callout tone="fail">{errors.form}</Callout>}
      <p className="text-sm text-muted">
        NxGen generates a temporary password. The user must replace it at first sign-in.
      </p>
      <div className="flex justify-end gap-3">
        <Link href="/users/" className="inline-flex min-h-11 items-center rounded-md border border-line px-5 font-semibold">
          Cancel
        </Link>
        <Button type="submit" disabled={busy}>
          Create User…
        </Button>
      </div>
    </form>
    <ReasonDialog
      open={confirming}
      title="Create user account"
      description={`Create ${form.fullName || "the account"} (${form.username}) with roles: ${selected.join(", ")}.`}
      confirmLabel="Create User"
      action="USER_CREATE"
      onConfirm={create}
      onClose={() => setConfirming(false)}
    />
    </>
  );
}

export default function NewUserPage() {
  return (
    <AppShell title="New User">
      <NewUserForm />
    </AppShell>
  );
}
