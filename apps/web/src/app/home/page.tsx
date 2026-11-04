"use client";

import Link from "next/link";
import { AppShell, usePrincipal } from "@/components/AppShell";
import { Badge, StatusIcon } from "@/components/ui";
import { ROLE_NAMES } from "@/lib/api";

const NEXT_STAGES = [
  { label: "NxGen Activated", done: true },
  { label: "Administrator Setup", done: true },
  { label: "User & Role Management", done: false },
  { label: "Security Configuration", done: false },
  { label: "Module Configuration", done: false },
  { label: "Device Configuration", done: false },
  { label: "Qualification (IQ/OQ/PQ)", done: false },
  { label: "QA Release → Production", done: false },
];

function Home() {
  const p = usePrincipal();
  const can = (perm: string) => p.permissions.includes(perm);
  const cards = [
    { href: "/audit/", title: "Audit Trail", text: "Review every recorded action, with chain-integrity verification.", show: can("audit.view") },
    { href: "/system/", title: "System Information", text: "Platform identity, installation, license and licensed modules.", show: can("system.view") },
    { href: "/change-password/", title: "Change Password", text: "Update your password. Expired passwords must be changed.", show: true },
  ].filter((c) => c.show);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-white p-5">
        <div>
          <p className="text-lg font-semibold">Welcome, {p.fullName}</p>
          <p className="text-sm text-muted">
            Roles: {p.roles.map((r) => ROLE_NAMES[r] ?? r).join(", ")}
            {p.passwordExpiresAt && <> · Password expires {new Date(p.passwordExpiresAt).toLocaleDateString()}</>}
          </p>
        </div>
        <Badge tone="warn">QUALIFICATION REQUIRED</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="rounded-lg border border-line bg-white p-5 hover:border-brand">
            <p className="font-semibold text-ink">{c.title}</p>
            <p className="mt-1 text-sm text-muted">{c.text}</p>
          </Link>
        ))}
      </div>

      <section className="rounded-lg border border-line bg-white p-5">
        <h2 className="font-semibold">Platform lifecycle</h2>
        <p className="mt-1 text-sm text-muted">NxGen is not released for production laboratory use until qualification and QA release are complete.</p>
        <ol className="mt-4 grid gap-2 sm:grid-cols-2">
          {NEXT_STAGES.map((s) => (
            <li key={s.label} className={`flex items-center gap-2 text-sm ${s.done ? "text-ink" : "text-muted"}`}>
              <StatusIcon tone={s.done ? "pass" : "pending"} className="h-4 w-4" />
              {s.label}
              <span className="sr-only">{s.done ? "(complete)" : "(not started)"}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export default function HomePage() {
  return (
    <AppShell title="Home">
      <Home />
    </AppShell>
  );
}
