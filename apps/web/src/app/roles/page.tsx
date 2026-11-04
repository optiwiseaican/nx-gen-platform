"use client";

import { useCallback, useEffect, useState } from "react";
import { ReasonDialog } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { TextField } from "@/components/forms";
import { Badge, Button, Callout, StatusIcon } from "@/components/ui";
import { RoleSummary, SignatureInput, usersApi } from "@/lib/api";

type Permission = { code: string; description: string };

function RolesMatrix() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const [roles, setRoles] = useState<RoleSummary[] | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"edit" | "create" | null>(null);
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ code: "", name: "", description: "" });
  const [newPerms, setNewPerms] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const canEdit = principal.permissions.includes("roles.manage");

  const load = useCallback(async () => {
    try {
      const res = await usersApi.roles();
      setRoles(res.roles);
      setPermissions(res.permissions);
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load roles.");
    }
  }, [redirect]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(reason: string, signature?: SignatureInput) {
    if (confirm === "edit" && editing) {
      await usersApi.setRolePermissions(editing, draft, reason, signature);
      setNotice("Role permissions updated. Users holding this role are affected immediately.");
      setEditing(null);
    } else if (confirm === "create") {
      await usersApi.createRole({ ...newRole, permissions: newPerms, reason, signature });
      setNotice(`Role ${newRole.name} created.`);
      setCreating(false);
      setNewRole({ code: "", name: "", description: "" });
      setNewPerms([]);
    }
    setConfirm(null);
    await load();
  }

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!roles) {
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading roles…
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          What each role may do. Permissions are enforced by the server on every request.
        </p>
        {canEdit && !creating && (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            + New Role
          </Button>
        )}
      </div>
      {notice && <Callout tone="pass">{notice}</Callout>}

      {creating && (
        <section className="space-y-4 rounded-lg border border-line bg-white p-5">
          <h2 className="font-semibold">New role</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField id="r-name" label="Name" value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
            <TextField
              id="r-code"
              label="Code"
              value={newRole.code}
              onChange={(e) => setNewRole({ ...newRole, code: e.target.value.toUpperCase().replace(/[\s-]+/g, "_") })}
              hint="e.g. LAB_SUPERVISOR"
            />
            <TextField
              id="r-desc"
              label="Description"
              value={newRole.description}
              onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            {permissions.map((p) => (
              <label key={p.code} className="flex items-center gap-2 text-sm" title={p.description}>
                <input
                  type="checkbox"
                  checked={newPerms.includes(p.code)}
                  onChange={() => setNewPerms(newPerms.includes(p.code) ? newPerms.filter((x) => x !== p.code) : [...newPerms, p.code])}
                />
                <span className="font-mono text-xs">{p.code}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={() => setConfirm("create")} disabled={!newRole.name || !newRole.code || !newRole.description}>
              Create…
            </Button>
          </div>
        </section>
      )}

      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3 text-center">Active users</th>
              {permissions.map((p) => (
                <th key={p.code} className="px-3 py-3 text-center font-mono normal-case" title={p.description}>
                  {p.code}
                </th>
              ))}
              {canEdit && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {roles.map((r) => {
              const isEditing = editing === r.code;
              const perms = isEditing ? draft : r.permissions;
              const locked = r.code === "SUPER_ADMINISTRATOR";
              return (
                <tr key={r.code} className={isEditing ? "bg-brand-50/50" : ""}>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-ink">
                      {r.name} {!r.isSystem && <Badge tone="warn">CUSTOM</Badge>}
                    </p>
                    <p className="text-xs text-muted">{r.description}</p>
                  </td>
                  <td className="px-4 py-3 text-center">{r.activeUsers}</td>
                  {permissions.map((p) => {
                    const has = perms.includes(p.code);
                    return (
                      <td key={p.code} className="px-3 py-3 text-center">
                        {isEditing ? (
                          <input
                            type="checkbox"
                            aria-label={`${r.name}: ${p.code}`}
                            checked={has}
                            onChange={() => setDraft(has ? draft.filter((x) => x !== p.code) : [...draft, p.code])}
                          />
                        ) : has ? (
                          <span className="inline-flex items-center text-pass">
                            <StatusIcon tone="pass" className="h-4 w-4" />
                            <span className="sr-only">granted</span>
                          </span>
                        ) : (
                          <span className="text-muted" aria-label="not granted">–</span>
                        )}
                      </td>
                    );
                  })}
                  {canEdit && (
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      {locked ? (
                        <span className="text-xs text-muted">Always all</span>
                      ) : isEditing ? (
                        <span className="flex justify-end gap-2">
                          <button className="text-sm font-semibold text-muted" onClick={() => setEditing(null)}>Cancel</button>
                          <button className="text-sm font-semibold text-brand" onClick={() => setConfirm("edit")}>Save…</button>
                        </span>
                      ) : (
                        <button
                          className="text-sm font-semibold text-brand hover:underline"
                          onClick={() => {
                            setEditing(r.code);
                            setDraft(r.permissions);
                          }}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="grid gap-1 text-xs text-muted sm:grid-cols-2">
        {permissions.map((p) => (
          <li key={p.code}>
            <span className="font-mono text-ink">{p.code}</span> — {p.description}
          </li>
        ))}
      </ul>

      <ReasonDialog
        open={!!confirm}
        title={confirm === "create" ? "Create role" : "Change role permissions"}
        description={
          confirm === "create"
            ? `Create ${newRole.name || "the role"} with: ${newPerms.join(", ") || "no permissions"}.`
            : `${roles.find((r) => r.code === editing)?.name}: ${draft.join(", ") || "no permissions"}.`
        }
        confirmLabel={confirm === "create" ? "Create Role" : "Save Permissions"}
        action={confirm === "create" ? "ROLE_CREATE" : "ROLE_PERMISSIONS_CHANGE"}
        onConfirm={save}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

export default function RolesPage() {
  return (
    <AppShell title="Roles & Permissions">
      <RolesMatrix />
    </AppShell>
  );
}
