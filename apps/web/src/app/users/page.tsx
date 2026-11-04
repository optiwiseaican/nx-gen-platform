"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatDate, RoleChips, UserStatusBadges } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { Callout, StatusIcon } from "@/components/ui";
import { UserSummary, usersApi } from "@/lib/api";

function UsersList() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);

  useEffect(() => {
    usersApi
      .list()
      .then(setUsers)
      .catch((err) => {
        if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load users.");
      });
  }, [redirect]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (users ?? []).filter(
      (u) =>
        (showDisabled || u.status === "ACTIVE") &&
        (!q || u.fullName.toLowerCase().includes(q) || u.username.includes(q) || u.roles.some((r) => r.toLowerCase().includes(q))),
    );
  }, [users, filter, showDisabled]);

  const canManage = principal.permissions.includes("users.manage");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search name, username or role"
            aria-label="Search users"
            className="w-72 rounded-md border border-line bg-white px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />
            Show disabled users
          </label>
        </div>
        {canManage && (
          <Link href="/users/new/" className="inline-flex min-h-10 items-center rounded-md bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-700">
            + New User
          </Link>
        )}
      </div>

      {error && <Callout tone="fail">{error}</Callout>}
      {!users && !error && (
        <p className="flex items-center gap-2 text-muted">
          <StatusIcon tone="progress" /> Loading users…
        </p>
      )}

      {users && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Username</th>
                <th className="px-4 py-3">Roles</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Last sign-in</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((u) => (
                <tr key={u.id} className={u.status === "DISABLED" ? "text-muted" : ""}>
                  <td className="px-4 py-3">
                    <Link href={`/users/view/?id=${u.id}`} className="font-semibold text-brand hover:underline">
                      {u.fullName}
                    </Link>
                    {u.id === principal.userId && <span className="ml-2 text-xs text-muted">(you)</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{u.username}</td>
                  <td className="px-4 py-3">
                    <RoleChips roles={u.roles} />
                  </td>
                  <td className="px-4 py-3">
                    <UserStatusBadges user={u} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{formatDate(u.lastLoginAt)}</td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted">
                    No users match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">
        Users are never deleted: disabled accounts and their history are kept, and usernames are never reused.
      </p>
    </div>
  );
}

export default function UsersPage() {
  return (
    <AppShell title="Users">
      <UsersList />
    </AppShell>
  );
}
