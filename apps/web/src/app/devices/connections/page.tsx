"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDate, ReasonDialog } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { Badge, Button, Callout, StatusIcon } from "@/components/ui";
import { gatewayApi, GatewayOverview } from "@/lib/api";

const BAUD = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const STATUS_TONE = { OPEN: "pass", CLOSED: "warn", ERROR: "fail", DISABLED: "warn" } as const;

function Connections() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const canManage = principal.permissions.includes("devices.manage");
  const [o, setO] = useState<GatewayOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portPath, setPortPath] = useState("");
  const [baud, setBaud] = useState(115200);
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [toggle, setToggle] = useState<GatewayOverview["configured"][number] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setO(await gatewayApi.overview());
      setError(null);
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load connections.");
    }
  }, [redirect]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000); // passive: does not keep the session alive
    return () => clearInterval(t);
  }, [load]);

  if (error && !o) return <Callout tone="fail">{error}</Callout>;
  if (!o)
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );

  const unused = o.available.filter((a) => !o.configured.some((c) => c.portPath === a.path));
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">
        Instruments send their data by radio to an AICAN USB dongle, which passes it to NxGen over a serial (UART) connection. NxGen accepts
        data only from registered instruments, by the DEVICE_ID in each packet.
      </p>
      {notice && <Callout tone="pass">{notice}</Callout>}

      <section className="rounded-lg border border-line bg-white">
        <h2 className="border-b border-line px-5 py-3 font-semibold">USB dongles (serial ports)</h2>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-5 py-2">Port</th>
              <th className="px-5 py-2">Status</th>
              <th className="px-5 py-2">Packets</th>
              <th className="px-5 py-2">Last packet</th>
              <th className="px-5 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {o.configured.map((c) => (
              <tr key={c.id}>
                <td className="px-5 py-2">
                  <p className="font-mono text-xs">{c.portPath}</p>
                  <p className="text-xs text-muted">
                    {c.label || "—"} · {c.baudRate} baud
                  </p>
                </td>
                <td className="px-5 py-2">
                  <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
                  {c.error && <p className="mt-1 text-xs text-fail">{c.error}</p>}
                </td>
                <td className="px-5 py-2 tabular-nums">
                  {c.packets} received · {c.rejected} rejected
                </td>
                <td className="px-5 py-2">{c.lastPacketAt ? formatDate(c.lastPacketAt) : "—"}</td>
                <td className="px-5 py-2 text-right">
                  {canManage && (
                    <Button variant="secondary" onClick={() => setToggle(c)}>
                      {c.enabled ? "Disable…" : "Enable…"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {o.simulator && (
              <tr className="bg-warn-50">
                <td className="px-5 py-2">
                  <p className="font-mono text-xs">SIMULATOR</p>
                  <p className="text-xs text-muted">Development only · not available in production</p>
                </td>
                <td className="px-5 py-2">
                  <Badge tone="warn">DEVELOPMENT</Badge>
                </td>
                <td className="px-5 py-2 tabular-nums">
                  {o.simulator.packets} received · {o.simulator.rejected} rejected
                </td>
                <td className="px-5 py-2">{o.simulator.lastPacketAt ? formatDate(o.simulator.lastPacketAt) : "—"}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
        {o.configured.length === 0 && <p className="px-5 py-4 text-sm text-muted">No dongle configured yet.</p>}

        {canManage && (
          <div className="flex flex-wrap items-end gap-3 border-t border-line px-5 py-4">
            <label className="text-sm font-semibold">
              Serial port
              <select value={portPath} onChange={(e) => setPortPath(e.target.value)} className="mt-1 block w-72 rounded-md border border-line bg-white px-3 py-2 font-normal">
                <option value="">Choose a port…</option>
                {unused.map((a) => (
                  <option key={a.path} value={a.path}>
                    {a.path}
                    {a.manufacturer ? ` · ${a.manufacturer}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold">
              Baud rate
              <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} className="mt-1 block rounded-md border border-line bg-white px-3 py-2 font-normal">
                {BAUD.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold">
              Label
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. QC lab dongle" className="mt-1 block rounded-md border border-line px-3 py-2 font-normal" />
            </label>
            <Button onClick={() => setAdding(true)} disabled={!portPath}>
              Add dongle…
            </Button>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-white">
          <h2 className="border-b border-line px-5 py-3 font-semibold">Instruments sending data</h2>
          <ul className="divide-y divide-line text-sm">
            {o.connected.map((c) => (
              <li key={c.deviceIdentifier} className="flex items-center justify-between px-5 py-2">
                <Link href={`/devices/view/?id=${c.deviceId}`} className="font-semibold text-brand hover:underline">
                  {c.code} <span className="font-mono text-xs font-normal text-muted">{c.deviceIdentifier}</span>
                </Link>
                <span className="flex items-center gap-2">
                  {c.transport === "SIMULATOR" && <Badge tone="warn">SIMULATED</Badge>}
                  {c.online ? <Badge tone="pass">ONLINE</Badge> : <span className="text-xs text-muted">last {formatDate(c.lastSeenAt)}</span>}
                </span>
              </li>
            ))}
            {o.connected.length === 0 && <li className="px-5 py-4 text-muted">No instrument data received since NxGen started.</li>}
          </ul>
        </section>
        <section className="rounded-lg border border-line bg-white">
          <h2 className="border-b border-line px-5 py-3 font-semibold">Unregistered senders</h2>
          <ul className="divide-y divide-line text-sm">
            {o.unknownDevices.map((u) => (
              <li key={u.deviceIdentifier} className="px-5 py-2">
                <p className="font-mono">{u.deviceIdentifier}</p>
                <p className="text-xs text-muted">
                  {u.count} packets rejected · last {formatDate(u.lastSeenAt)} on {u.portPath}. Register the instrument with this ID to accept
                  its data.
                </p>
              </li>
            ))}
            {o.unknownDevices.length === 0 && <li className="px-5 py-4 text-muted">None.</li>}
          </ul>
        </section>
      </div>

      <ReasonDialog
        open={adding}
        title="Add USB dongle"
        description={`${portPath} at ${baud} baud. NxGen opens the port now and reopens it automatically after a disconnection.`}
        confirmLabel="Add"
        onConfirm={async (reason) => {
          await gatewayApi.addPort({ portPath, baudRate: baud, label, reason });
          setAdding(false);
          setPortPath("");
          setLabel("");
          setNotice("Dongle added.");
          await load();
        }}
        onClose={() => setAdding(false)}
      />
      <ReasonDialog
        open={!!toggle}
        title={toggle ? `${toggle.enabled ? "Disable" : "Enable"} ${toggle.portPath}` : ""}
        description={toggle?.enabled ? "NxGen stops reading this port." : "NxGen starts reading this port."}
        confirmLabel={toggle?.enabled ? "Disable" : "Enable"}
        onConfirm={async (reason) => {
          await gatewayApi.updatePort(toggle!.id, { enabled: !toggle!.enabled, reason });
          setToggle(null);
          await load();
        }}
        onClose={() => setToggle(null)}
      />
    </div>
  );
}

export default function ConnectionsPage() {
  return (
    <AppShell title="Instrument Connections">
      <Connections />
    </AppShell>
  );
}
