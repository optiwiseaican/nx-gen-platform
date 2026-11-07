"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDate, ReasonDialog } from "@/components/admin";
import { AppShell, useAuthRedirect } from "@/components/AppShell";
import { Badge, Button, Callout, FieldTable, StatusIcon } from "@/components/ui";
import { InstalledModule, moduleUrl, modulesApi, SignatureInput, StagedModule } from "@/lib/api";

const RUNTIME: Record<InstalledModule["runtime"]["state"], { label: string; tone: "pass" | "warn" | "fail" }> = {
  RUNNING: { label: "RUNNING", tone: "pass" },
  DISABLED: { label: "DISABLED", tone: "warn" },
  LICENSE_MISSING: { label: "NOT LICENSED", tone: "fail" },
  INTEGRITY_FAILED: { label: "INTEGRITY FAILED", tone: "fail" },
  INCOMPATIBLE: { label: "INCOMPATIBLE", tone: "fail" },
  LOAD_FAILED: { label: "FAILED TO START", tone: "fail" },
};

function Modules() {
  const redirect = useAuthRedirect();
  const fileRef = useRef<HTMLInputElement>(null);
  const [modules, setModules] = useState<InstalledModule[] | null>(null);
  const [staged, setStaged] = useState<StagedModule | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [toggle, setToggle] = useState<InstalledModule | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setModules(await modulesApi.installed());
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load modules.");
    }
  }, [redirect]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    setNotice(null);
    setStaged(null);
    try {
      setStaged(await modulesApi.upload(file));
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "The package could not be verified.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function install(reason: string, signature?: SignatureInput) {
    const r = await modulesApi.install(staged!.stagingId!, reason, signature);
    setConfirming(false);
    setStaged(null);
    setNotice(
      r.loaded
        ? `${r.module.name} ${r.module.version} is installed and running.`
        : `${r.module.name} ${r.module.version} was installed but did not start: ${r.module.runtime.message ?? "see the audit trail"}.`,
    );
    await load();
  }

  async function setEnabled(reason: string, signature?: SignatureInput) {
    const m = toggle!;
    const enable = m.status === "DISABLED";
    await modulesApi.setEnabled(m.id, enable, reason, signature);
    setToggle(null);
    setNotice(`${m.name} ${enable ? "enabled" : "disabled"}. ${enable ? "" : "Its data is kept; its screens and instruments are unavailable until it is enabled."}`);
    await load();
  }

  if (error && !modules) return <Callout tone="fail">{error}</Callout>;
  if (!modules)
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );

  const s = staged?.module;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">
        Modules add instruments and functions to NxGen. Each module is a package signed by AICAN. NxGen checks the signature, every file,
        your licence and version compatibility before anything is installed, and checks the files again every time it starts.
      </p>
      {notice && <Callout tone="pass">{notice}</Callout>}
      {error && <Callout tone="fail">{error}</Callout>}

      <section className="space-y-3 rounded-lg border border-line bg-white p-5">
        <h2 className="font-semibold">Install or upgrade a module</h2>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            id="module-file"
            type="file"
            accept=".nxmod"
            className="sr-only"
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? "Verifying…" : "Choose .nxmod package…"}
          </Button>
          <span className="text-sm text-muted">Nothing changes until you review the package and sign.</span>
        </div>

        {staged && s && (
          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">
                {s.name} {s.version}
              </h3>
              {staged.problems.length ? <Badge tone="fail">CANNOT INSTALL</Badge> : <Badge tone="pass">SIGNATURE AND FILES VERIFIED</Badge>}
            </div>
            {s.description && <p className="text-sm text-muted">{s.description}</p>}
            {staged.problems.length > 0 && (
              <Callout tone="fail" title="This package cannot be installed">
                <ul className="list-disc pl-5">
                  {staged.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <FieldTable
              rows={[
                ["Action", s.installedVersion ? `Upgrade from ${s.installedVersion} to ${s.version}` : "New installation"],
                ["Instrument types", s.instrumentTypes.map((t) => `${t.label} (${t.code})`).join(", ") || "—"],
                ["Permissions added", s.permissions.map((p) => p.code).join(", ") || "—"],
                ["Database changes", s.migrations.map((m) => `${m.name}${m.applied ? " (already applied)" : ""}`).join(", ") || "—"],
                ["Files", `${s.files}, each checked against its signed SHA-256`],
                ["Signed by key", <span key="k" className="font-mono">{s.signingKeyId}</span>],
                ["Package SHA-256", <span key="h" className="break-all font-mono text-xs">{s.packageSha256}</span>],
              ]}
            />
            <Callout tone="warn">
              No automatic database backup is taken before installation, because backup and restore is not built yet. Take a backup by your
              site procedure first.
            </Callout>
            <div className="flex gap-3">
              <Button onClick={() => setConfirming(true)} disabled={!staged.stagingId}>
                Install…
              </Button>
              <Button variant="secondary" onClick={() => setStaged(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Installed modules</h2>
        {modules.length === 0 && <p className="text-sm text-muted">No modules installed yet.</p>}
        {modules.map((m) => (
          <article key={m.id} className="rounded-lg border border-line bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">
                  {m.name} <span className="font-mono text-sm font-normal text-muted">{m.version}</span>
                </h3>
                <Badge tone={RUNTIME[m.runtime.state].tone}>{RUNTIME[m.runtime.state].label}</Badge>
              </div>
              <div className="flex gap-2">
                {m.ui && m.runtime.state === "RUNNING" && (
                  <a href={moduleUrl(m.ui)} className="inline-flex min-h-11 items-center rounded-md border border-line px-4 font-semibold hover:border-brand">
                    Open
                  </a>
                )}
                <Button variant="secondary" onClick={() => setToggle(m)}>
                  {m.status === "DISABLED" ? "Enable…" : "Disable…"}
                </Button>
              </div>
            </div>
            <div className="px-5 py-2">
              {m.runtime.message && <Callout tone="fail">{m.runtime.message}</Callout>}
              <FieldTable
                rows={[
                  ["Description", m.description || "—"],
                  ["Instrument types", m.instrumentTypes.map((t) => t.label).join(", ") || "—"],
                  ["Licence", m.entitled ? "Included in the active licence" : "Not included in the active licence"],
                  ["Installed", `${formatDate(m.installedAt)}${m.updatedAt ? ` · updated ${formatDate(m.updatedAt)}` : ""}`],
                  ["Previous version", m.previousVersion ?? "—"],
                  ["Signed by key", <span key="k" className="font-mono">{m.signingKeyId}</span>],
                ]}
              />
            </div>
          </article>
        ))}
      </section>

      <ReasonDialog
        open={confirming}
        title={s ? `Install ${s.name} ${s.version}` : "Install module"}
        description="Installing runs the module's database changes and makes it available to permitted users."
        confirmLabel="Install"
        action="MODULE_INSTALL"
        minReason={10}
        reasonPlaceholder="e.g. Install pH module per change request CC-2026-031"
        onConfirm={install}
        onClose={() => setConfirming(false)}
      />
      <ReasonDialog
        open={!!toggle}
        title={toggle ? `${toggle.status === "DISABLED" ? "Enable" : "Disable"} ${toggle.name}` : ""}
        description={
          toggle?.status === "DISABLED"
            ? "The module starts again after its files are re-verified."
            : "Its screens close and its instruments are blocked from use. No data is deleted."
        }
        confirmLabel={toggle?.status === "DISABLED" ? "Enable" : "Disable"}
        destructive={toggle?.status !== "DISABLED"}
        action={toggle?.status === "DISABLED" ? "MODULE_ENABLE" : "MODULE_DISABLE"}
        minReason={10}
        onConfirm={setEnabled}
        onClose={() => setToggle(null)}
      />
    </div>
  );
}

export default function ModulesPage() {
  return (
    <AppShell title="Modules">
      <Modules />
    </AppShell>
  );
}
