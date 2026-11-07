"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDate } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { ReadinessBadge } from "@/components/devices";
import { Callout, StatusIcon } from "@/components/ui";
import { DeviceSummary, devicesApi, InstrumentTypeInfo } from "@/lib/api";

function Devices() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [types, setTypes] = useState<InstrumentTypeInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    devicesApi.types().then(setTypes).catch(() => undefined);
    devicesApi
      .list()
      .then(setDevices)
      .catch((err) => {
        if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load instruments.");
      });
  }, [redirect]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!devices)
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );

  const blocked = devices.filter((d) => d.status !== "RETIRED" && !d.readiness.usable).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          An instrument can be used only when it is in service and its latest approved calibration passed and is not overdue.
        </p>
        {principal.permissions.includes("devices.manage") && (
          <Link href="/devices/connections/" className="inline-flex min-h-11 items-center rounded-md border border-line bg-white px-5 font-semibold hover:border-brand">
            Connections
          </Link>
        )}
        {principal.permissions.includes("devices.manage") && (
          <Link href="/devices/new/" className="inline-flex min-h-11 items-center rounded-md bg-brand px-5 font-semibold text-white hover:bg-brand-700">
            Register instrument
          </Link>
        )}
      </div>
      {blocked > 0 && (
        <Callout tone="warn">
          {blocked} instrument{blocked === 1 ? " is" : "s are"} blocked from use. Open {blocked === 1 ? "it" : "them"} to see why.
        </Callout>
      )}
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Instrument</th>
              <th className="px-4 py-3">Serial number</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Calibration due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {devices.map((d) => (
              <tr key={d.id} className="hover:bg-canvas/60">
                <td className="px-4 py-3 font-mono text-xs">
                  <Link href={`/devices/view/?id=${d.id}`} className="font-semibold text-brand hover:underline">
                    {d.code}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium">{d.name}</p>
                  <p className="text-xs text-muted">
                    {types.find((t) => t.code === d.instrumentType)?.label ?? d.instrumentType} · {d.manufacturer} {d.model}
                  </p>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{d.serialNumber}</td>
                <td className="px-4 py-3">{d.location || "—"}</td>
                <td className="px-4 py-3">
                  <ReadinessBadge r={d.readiness} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">{d.readiness.dueAt ? formatDate(d.readiness.dueAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {devices.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">No instruments registered yet.</p>}
      </div>
    </div>
  );
}

export default function DevicesPage() {
  return (
    <AppShell title="Instruments">
      <Devices />
    </AppShell>
  );
}
