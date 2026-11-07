"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell, usePrincipal } from "@/components/AppShell";
import { Icon, IconName } from "@/components/icons";
import { Badge, StatusIcon } from "@/components/ui";
import { devicesApi, ROLE_NAMES, workflowApi } from "@/lib/api";

const LIFECYCLE = [
  { label: "NxGen activated", done: true },
  { label: "Administrator setup", done: true },
  { label: "Users, roles and e-signatures", done: true },
  { label: "Security configuration", done: true },
  { label: "Modules and instruments", done: false },
  { label: "Qualification (IQ/OQ/PQ)", done: false },
  { label: "QA release to production", done: false },
];

function Stat({ value, label, tone }: { value: string; label: string; tone: "pass" | "warn" | "fail" | "brand" }) {
  const dot = { pass: "bg-pass", warn: "bg-warn", fail: "bg-fail", brand: "bg-brand" }[tone];
  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
      <span>
        <span className="block text-2xl font-extrabold tabular-nums text-ink">{value}</span>
        <span className="text-sm text-muted">{label}</span>
      </span>
    </div>
  );
}

function Home() {
  const p = usePrincipal();
  const can = (perm: string) => p.permissions.includes(perm);
  const [tasks, setTasks] = useState<number | null>(null);
  const [instruments, setInstruments] = useState<{ total: number; usable: number } | null>(null);

  useEffect(() => {
    if (can("methods.review") || can("methods.approve") || can("calibration.approve"))
      workflowApi
        .tasks()
        .then((t) => setTasks(t.length))
        .catch(() => undefined);
    if (can("devices.view"))
      devicesApi
        .list()
        .then((d) => {
          const active = d.filter((x) => x.status !== "RETIRED");
          setInstruments({ total: active.length, usable: active.filter((x) => x.readiness.usable).length });
        })
        .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all: { href: string; title: string; text: string; icon: IconName; show: boolean }[] = [
    { href: "/tasks/", title: "My Tasks", icon: "tasks", text: "Methods and calibrations waiting for your review or approval signature.", show: can("methods.review") || can("methods.approve") || can("calibration.approve") },
    { href: "/devices/", title: "Instruments", icon: "instrument", text: "Registered instruments, calibration status and whether they may be used.", show: can("devices.view") },
    { href: "/methods/", title: "Methods", icon: "method", text: "Controlled analytical methods: draft, review, approval and versions.", show: can("methods.view") },
    { href: "/users/", title: "Users", icon: "users", text: "Create accounts, assign roles, disable, unlock and reset passwords.", show: can("users.view") },
    { href: "/roles/", title: "Roles & Permissions", icon: "roles", text: "What each role may do; Super Administrators can adjust it.", show: can("users.view") },
    { href: "/audit/", title: "Audit Trail", icon: "audit", text: "Every recorded action, with chain-integrity verification and export.", show: can("audit.view") },
    { href: "/settings/modules/", title: "Modules", icon: "modules", text: "Install, enable and disable signed NxGen modules such as pH.", show: can("modules.manage") },
    { href: "/security/", title: "Security", icon: "security", text: "Signature requirements, password, lockout and session rules.", show: can("audit.view") },
    { href: "/system/", title: "System Information", icon: "system", text: "Platform identity, installation, licence and licensed modules.", show: can("system.view") },
  ];
  const cards = all.filter((c) => c.show);

  const done = LIFECYCLE.filter((s) => s.done).length;
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-lg border border-line bg-white">
        <div className="flex flex-wrap items-start justify-between gap-4 p-6">
          <div>
            <p className="text-2xl font-extrabold tracking-tight">Welcome back, {p.fullName.split(" ")[0]}</p>
            <p className="mt-1 text-muted">
              {p.roles.map((r) => ROLE_NAMES[r] ?? r).join(", ")}
              {p.passwordExpiresAt && <> · password expires {new Date(p.passwordExpiresAt).toLocaleDateString()}</>}
            </p>
          </div>
          <Badge tone="warn">QUALIFICATION REQUIRED</Badge>
        </div>
        <div className="grid divide-y divide-line border-t border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Stat value={tasks === null ? "—" : String(tasks)} label="Waiting for your signature" tone={tasks ? "warn" : "brand"} />
          <Stat
            value={instruments ? `${instruments.usable}/${instruments.total}` : "—"}
            label="Instruments ready for use"
            tone={!instruments || instruments.usable === instruments.total ? "pass" : "fail"}
          />
          <Stat value={`${done}/${LIFECYCLE.length}`} label="Platform lifecycle steps complete" tone="brand" />
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="group flex gap-4 rounded-lg border border-line bg-white p-5 transition-shadow">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand transition-colors group-hover:bg-brand group-hover:text-white">
              <Icon name={c.icon} />
            </span>
            <span>
              <span className="block font-bold text-ink">{c.title}</span>
              <span className="mt-0.5 block text-sm text-muted">{c.text}</span>
            </span>
          </Link>
        ))}
      </div>

      <section className="rounded-lg border border-line bg-white p-6">
        <h2 className="font-bold">Platform lifecycle</h2>
        <p className="mt-1 text-sm text-muted">NxGen is not released for production laboratory use until qualification and QA release are complete.</p>
        <ol className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {LIFECYCLE.map((s) => (
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
    <AppShell title="Overview">
      <Home />
    </AppShell>
  );
}
