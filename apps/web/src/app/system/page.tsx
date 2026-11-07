"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandHeader, useAuthRedirect } from "@/components/AppShell";
import { Badge, Callout, FieldTable, StatusIcon } from "@/components/ui";
import { licensingApi, SERVICE_UNAVAILABLE, SystemInformation } from "@/lib/api";

const MODULE_NAMES: Record<string, string> = {
  ph: "pH Meter",
  tlc: "TLC Scanner",
  hptlc: "HPTLC",
};

function date(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 className="font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      <div className="px-5 py-2">{children}</div>
    </section>
  );
}

/** System Information (License PRD §7): identity and license details for administrators and support. */
export default function SystemInformationPage() {
  const [info, setInfo] = useState<SystemInformation | null>(null);
  const [failed, setFailed] = useState(false);

  const redirect = useAuthRedirect();
  useEffect(() => {
    licensingApi
      .systemInformation()
      .then(setInfo)
      .catch((err) => {
        if (!redirect(err)) setFailed(true);
      });
  }, [redirect]);

  const lic = info?.license;
  const active = lic?.state === "ACTIVE";
  const details = lic?.details;

  return (
    <div className="min-h-screen">
      <BrandHeader title="System Information" />

      <main className="mx-auto max-w-4xl space-y-5 px-4 py-8 sm:px-6">
        {failed && (
          <Callout tone="fail" title={SERVICE_UNAVAILABLE.title}>
            {SERVICE_UNAVAILABLE.message}
          </Callout>
        )}
        {!info && !failed && (
          <p className="flex items-center gap-2 text-muted">
            <StatusIcon tone="progress" /> Loading system information…
          </p>
        )}

        {info && lic && (
          <>
            {lic.error && (
              <Callout tone={lic.state === "ACTIVATION_ERROR" ? "fail" : "warn"} title={lic.error.title}>
                <span className="font-mono text-xs">{lic.errorCode}</span> — {lic.error.message} {lic.error.action}
              </Callout>
            )}

            <Section title="Platform">
              <FieldTable
                rows={[
                  ["Platform", info.platform.name],
                  ["Platform Version", info.platform.version],
                  [
                    "Platform Instance ID",
                    <span key="id" className="font-mono">
                      {info.platform.instanceId ?? "—"}
                    </span>,
                  ],
                ]}
              />
            </Section>

            <Section
              title="Installation"
              aside={
                <div className="flex gap-2">
                  {info.installation.simulated && <Badge tone="warn">SIMULATED</Badge>}
                  {info.installation.verification.startsWith("PASS") ? (
                    <Badge tone="pass">VERIFIED</Badge>
                  ) : (
                    <Badge tone="fail">NOT VERIFIED</Badge>
                  )}
                </div>
              }
            >
              <FieldTable
                rows={[
                  ["Installation ID", <span key="i" className="font-mono">{info.installation.installationId ?? "—"}</span>],
                  ["Verification", info.installation.verification],
                  ["Verified At", date(info.installation.verifiedAt)],
                  ["System Status", <span key="q" className="font-semibold">QUALIFICATION REQUIRED</span>],
                ]}
              />
            </Section>

            <Section
              title="License"
              aside={active ? <Badge tone="pass">ACTIVE</Badge> : <Badge tone={lic.restricted ? "warn" : "fail"}>{lic.state.replace(/_/g, " ")}</Badge>}
            >
              {details ? (
                <FieldTable
                  rows={[
                    ["Customer", `${details.customer.name} (${details.customer.id})`],
                    ["Site", details.customer.site ?? "—"],
                    ["License Type", details.licenseType],
                    ["Version Scope", details.versionScope],
                    ["Activation Code", <span key="c" className="font-mono">{details.activationCode}</span>],
                    ["License ID", <span key="l" className="font-mono text-xs">{details.licenseId}</span>],
                    ["Issued", date(details.issuedAt)],
                    ["Valid From", date(details.validFrom)],
                    ["Expires", details.expiresAt ? date(details.expiresAt) : "Never (perpetual)"],
                    ["User Limit", details.limits.users ?? "Unlimited"],
                    ["Device Limit", details.limits.devices ?? "Unlimited"],
                    ["Signing Key", <span key="k" className="font-mono text-xs">{details.signingKeyId ?? "—"}</span>],
                    [
                      "Hardware Binding",
                      lic.hardwareBinding
                        ? `Verified — ${lic.hardwareBinding.score}% match (${lic.hardwareBinding.matched} identifiers matched, ${lic.hardwareBinding.changed} changed)`
                        : "—",
                    ],
                  ]}
                />
              ) : (
                <p className="py-3 text-sm text-muted">
                  No active license.{" "}
                  <Link href="/" className="font-semibold text-brand hover:underline">
                    Activate NxGen
                  </Link>
                </p>
              )}
            </Section>

            <Section title="Licensed Modules">
              {info.entitlements.length ? (
                <ul className="divide-y divide-line text-sm">
                  {info.entitlements.map((m) => (
                    <li key={m.id} className="flex items-center justify-between py-2.5">
                      <span className="flex items-center gap-2 font-medium">
                        <StatusIcon tone="pass" className="h-4 w-4" />
                        {MODULE_NAMES[m.id] ?? m.id.toUpperCase()}
                        <span className="font-mono text-xs text-muted">{m.id}</span>
                      </span>
                      <span className="text-muted">{m.expiresAt ? `Until ${date(m.expiresAt)}` : "No expiry"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-3 text-sm text-muted">No module entitlements.</p>
              )}
              <p className="border-t border-line py-2.5 text-xs text-muted">
                Licensed means commercially authorized only. Modules are installed and qualified separately.
              </p>
            </Section>

            <Section
              title="Audit Trail (system events)"
              aside={info.audit.chain === "INTACT" ? <Badge tone="pass">CHAIN INTACT</Badge> : <Badge tone="fail">CHAIN BROKEN</Badge>}
            >
              <FieldTable rows={[["Recorded Events", info.audit.events]]} />
            </Section>
          </>
        )}

        <div className="flex gap-6 pt-2 text-sm font-semibold">
          <Link href="/" className="text-brand hover:underline">
            ← Activation
          </Link>
          <Link href="/setup/" className="text-brand hover:underline">
            Setup
          </Link>
        </div>
      </main>
    </div>
  );
}
