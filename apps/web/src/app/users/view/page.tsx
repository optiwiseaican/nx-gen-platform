"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  formatDate,
  ReasonDialog,
  RoleCheckboxes,
  RoleChips,
  SignatureManifest,
  TemporaryPassword,
  UserStatusBadges,
} from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { TextField } from "@/components/forms";
import { Button, Callout, FieldTable, StatusIcon } from "@/components/ui";
import { AuditEntry, RoleSummary, SignatureInput, SignatureRecord, signaturesApi, UserSummary, usersApi } from "@/lib/api";

type Action =
  | { kind: "profile" }
  | { kind: "roles" }
  | { kind: "disable" }
  | { kind: "enable" }
  | { kind: "unlock" }
  | { kind: "reset" };

function describe(e: AuditEntry): string {
  const d = (e.details ?? {}) as Record<string, string>;
  switch (e.action) {
    case "USER_ROLES_CHANGED":
      return `Roles: ${d.from ?? "none"} → ${d.to}`;
    case "USER_CREATED":
      return `Created with roles ${d.roles ?? ""}`;
    case "LOGIN_FAILED":
    case "SESSION_ENDED":
      return e.reason ?? "";
    case "UPDATE":
    case "CREATE":
    case "DELETE":
    case "RESTORE":
      return `${e.tableName} record ${e.action.toLowerCase()}`;
    default:
      return "";
  }
}

function UserDetail() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const canSeeSignatures = principal.permissions.includes("audit.view");
  const [id, setId] = useState<string | null>(null);
  const [user, setUser] = useState<UserSummary | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [signatures, setSignatures] = useState<SignatureRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [profile, setProfile] = useState({ fullName: "", email: "" });
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [editing, setEditing] = useState<"profile" | "roles" | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (userId: string) => {
      try {
        const [u, h, r] = await Promise.all([usersApi.get(userId), usersApi.history(userId), usersApi.roles()]);
        setUser(u);
        setHistory(h);
        setRoles(r.roles);
        setProfile({ fullName: u.fullName, email: u.email ?? "" });
        setSelectedRoles(u.roles);
        if (canSeeSignatures) setSignatures(await signaturesApi.list({ table: "users", record: userId }));
      } catch (err) {
        if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load the user.");
      }
    },
    [redirect, canSeeSignatures],
  );

  useEffect(() => {
    const userId = new URLSearchParams(window.location.search).get("id");
    setId(userId);
    if (userId) void load(userId);
    else setError("No user selected.");
  }, [load]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!user || !id) {
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );
  }

  const isSelf = user.id === principal.userId;
  const actorIsSuper = principal.roles.includes("SUPER_ADMINISTRATOR");
  const targetIsSuper = user.roles.includes("SUPER_ADMINISTRATOR");
  const canManage = principal.permissions.includes("users.manage") && (!targetIsSuper || actorIsSuper);

  async function run(reason: string, signature?: SignatureInput) {
    if (!action || !user) return;
    const uid = user.id;
    let message = "";
    switch (action.kind) {
      case "profile":
        await usersApi.updateProfile(uid, { ...profile, reason, signature });
        message = "Profile updated.";
        break;
      case "roles":
        await usersApi.setRoles(uid, selectedRoles, reason, signature);
        message = "Roles updated. The change applies to the user's next request.";
        break;
      case "disable":
        await usersApi.disable(uid, reason, signature);
        message = "Account disabled. The user has been signed out everywhere.";
        break;
      case "enable":
        await usersApi.enable(uid, reason, signature);
        message = "Account enabled.";
        break;
      case "unlock":
        await usersApi.unlock(uid, reason, signature);
        message = "Account unlocked.";
        break;
      case "reset": {
        const res = await usersApi.resetPassword(uid, reason, signature);
        setTempPassword(res.temporaryPassword);
        message = "Password reset. The user has been signed out and must choose a new password.";
        break;
      }
    }
    setAction(null);
    setEditing(null);
    setNotice(message);
    await load(uid);
  }

  const dialog: Record<Action["kind"], { title: string; description: string; confirm: string; destructive?: boolean; action: string }> = {
    profile: { title: "Save profile changes", description: `Update the name or email of ${user.fullName}.`, confirm: "Save", action: "USER_PROFILE_UPDATE" },
    roles: {
      title: "Change roles",
      description: `New roles for ${user.fullName}: ${selectedRoles.join(", ") || "none"}. Permissions change immediately.`,
      confirm: "Change Roles",
      action: "USER_ROLES_CHANGE",
    },
    disable: {
      title: "Disable account",
      description: `${user.fullName} will be signed out and unable to sign in. The account and its history are kept.`,
      confirm: "Disable",
      destructive: true,
      action: "USER_DISABLE",
    },
    enable: { title: "Enable account", description: `${user.fullName} will be able to sign in again.`, confirm: "Enable", action: "USER_ENABLE" },
    unlock: { title: "Unlock account", description: `Clear the failed sign-in lock on ${user.fullName}.`, confirm: "Unlock", action: "USER_UNLOCK" },
    reset: {
      title: "Reset password",
      description: `A new temporary password will be generated. ${user.fullName} is signed out and must change it at next sign-in.`,
      confirm: "Reset Password",
      destructive: true,
      action: "USER_PASSWORD_RESET",
    },
  };
  const d = action ? dialog[action.kind] : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xl font-semibold">{user.fullName}</p>
          <p className="font-mono text-sm text-muted">{user.username}</p>
        </div>
        <UserStatusBadges user={user} />
      </div>

      {notice && <Callout tone="pass">{notice}</Callout>}
      {tempPassword && <TemporaryPassword username={user.username} password={tempPassword} />}
      {targetIsSuper && !actorIsSuper && (
        <Callout tone="info">Only a Super Administrator can change a Super Administrator account.</Callout>
      )}
      {isSelf && (
        <Callout tone="info">
          This is your own account. Another administrator must change your roles or status;{" "}
          <Link href="/change-password/" className="font-semibold text-brand hover:underline">change your password here</Link>.
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-semibold">Profile</h2>
            {canManage && editing !== "profile" && (
              <button className="text-sm font-semibold text-brand hover:underline" onClick={() => setEditing("profile")}>
                Edit
              </button>
            )}
          </div>
          <div className="px-5 py-3">
            {editing === "profile" ? (
              <div className="space-y-4 py-2">
                <TextField id="p-name" label="Full name" value={profile.fullName} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} />
                <TextField id="p-email" label="Email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
                <div className="flex justify-end gap-3">
                  <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button onClick={() => setAction({ kind: "profile" })}>Save…</Button>
                </div>
              </div>
            ) : (
              <FieldTable
                rows={[
                  ["Email", user.email ?? "—"],
                  ["Created", `${formatDate(user.createdAt)} by ${user.createdByName ?? user.createdBy}`],
                  ["Last sign-in", formatDate(user.lastLoginAt)],
                  ["Password changed", formatDate(user.passwordChangedAt)],
                  ["Failed sign-ins", user.failedLoginCount],
                  ["Record version", user.versionNo],
                ]}
              />
            )}
          </div>
        </section>

        <section className="rounded-lg border border-line bg-white">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-semibold">Roles</h2>
            {canManage && !isSelf && editing !== "roles" && (
              <button className="text-sm font-semibold text-brand hover:underline" onClick={() => setEditing("roles")}>
                Change
              </button>
            )}
          </div>
          <div className="px-5 py-4">
            {editing === "roles" ? (
              <div className="space-y-4">
                <RoleCheckboxes
                  roles={roles}
                  selected={selectedRoles}
                  onChange={setSelectedRoles}
                  disabledCodes={actorIsSuper ? [] : ["SUPER_ADMINISTRATOR"]}
                />
                <div className="flex justify-end gap-3">
                  <Button variant="secondary" onClick={() => { setEditing(null); setSelectedRoles(user.roles); }}>Cancel</Button>
                  <Button onClick={() => setAction({ kind: "roles" })} disabled={selectedRoles.length === 0}>Save…</Button>
                </div>
              </div>
            ) : (
              <RoleChips roles={user.roles} />
            )}
          </div>
        </section>
      </div>

      {canManage && !isSelf && (
        <section className="rounded-lg border border-line bg-white p-5">
          <h2 className="font-semibold">Account actions</h2>
          <div className="mt-3 flex flex-wrap gap-3">
            {user.status === "ACTIVE" ? (
              <Button variant="secondary" onClick={() => setAction({ kind: "disable" })}>Disable account…</Button>
            ) : (
              <Button variant="secondary" onClick={() => setAction({ kind: "enable" })}>Enable account…</Button>
            )}
            {(user.locked || user.failedLoginCount > 0) && (
              <Button variant="secondary" onClick={() => setAction({ kind: "unlock" })}>Unlock…</Button>
            )}
            <Button variant="secondary" onClick={() => setAction({ kind: "reset" })}>Reset password…</Button>
          </div>
        </section>
      )}

      {canSeeSignatures && (
        <section className="rounded-lg border border-line bg-white">
          <h2 className="border-b border-line px-5 py-3 font-semibold">Electronic signatures</h2>
          <div className="space-y-3 p-5">
            {signatures.map((sig) => (
              <SignatureManifest key={sig.id} sig={sig} />
            ))}
            {signatures.length === 0 && <p className="text-sm text-muted">No signed changes for this account.</p>}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-line bg-white">
        <h2 className="border-b border-line px-5 py-3 font-semibold">History</h2>
        <ul className="divide-y divide-line text-sm">
          {history.map((e) => (
            <li key={e.sequence} className="grid gap-1 px-5 py-2.5 sm:grid-cols-[11rem_1fr_12rem]">
              <span className="text-muted">{formatDate(e.occurredAt)}</span>
              <span>
                <span className="font-medium">{e.action}</span>
                {describe(e) && <span className="text-muted"> — {describe(e)}</span>}
                {e.reason && !["LOGIN_FAILED", "SESSION_ENDED"].includes(e.action) && (
                  <span className="block text-xs text-muted">Reason: {e.reason}</span>
                )}
              </span>
              <span className="text-muted sm:text-right">{e.actorName ?? e.actor}</span>
            </li>
          ))}
          {history.length === 0 && <li className="px-5 py-4 text-muted">No recorded events.</li>}
        </ul>
      </section>

      {d && (
        <ReasonDialog
          open={!!action}
          title={d.title}
          description={d.description}
          confirmLabel={d.confirm}
          destructive={d.destructive}
          action={d.action}
          onConfirm={run}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}

export default function UserDetailPage() {
  return (
    <AppShell title="User">
      <div className="mb-4">
        <Link href="/users/" className="text-sm font-semibold text-brand hover:underline">← Users</Link>
      </div>
      <UserDetail />
    </AppShell>
  );
}
