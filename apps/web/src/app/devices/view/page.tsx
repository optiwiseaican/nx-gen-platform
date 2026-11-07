"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDate, ReasonDialog } from "@/components/admin";
import { AppShell, useAuthRedirect, usePrincipal } from "@/components/AppShell";
import { CalibrationCard, CalibrationForm, DeviceForm, DeviceFormValues, ReadinessBadge } from "@/components/devices";
import { Button, Callout, FieldTable, StatusIcon } from "@/components/ui";
import { DeviceDetail, devicesApi, DeviceStatus, InstrumentTypeInfo, moduleUrl, SignatureInput } from "@/lib/api";

type StatusChange = { to: DeviceStatus; title: string; confirm: string; description: string; destructive?: boolean };

const STATUS_CHANGES: Record<DeviceStatus, StatusChange[]> = {
  ACTIVE: [
    {
      to: "OUT_OF_SERVICE",
      title: "Take out of service",
      confirm: "Take out of service",
      description: "The instrument is blocked from use until it is returned to service.",
    },
    {
      to: "RETIRED",
      title: "Retire instrument",
      confirm: "Retire",
      description: "Retirement is permanent. The instrument and its records stay in NxGen but it can never be used again.",
      destructive: true,
    },
  ],
  OUT_OF_SERVICE: [
    {
      to: "ACTIVE",
      title: "Return to service",
      confirm: "Return to service",
      description: "It can be used again only if its calibration is current; recalibrate after repair if needed.",
    },
    {
      to: "RETIRED",
      title: "Retire instrument",
      confirm: "Retire",
      description: "Retirement is permanent. The instrument and its records stay in NxGen but it can never be used again.",
      destructive: true,
    },
  ],
  RETIRED: [],
};

function DeviceView() {
  const principal = usePrincipal();
  const redirect = useAuthRedirect();
  const [d, setD] = useState<DeviceDetail | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [openCal, setOpenCal] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<DeviceFormValues | null>(null);
  const [statusChange, setStatusChange] = useState<StatusChange | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [types, setTypes] = useState<InstrumentTypeInfo[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ?id=<device> or ?calibration=<calibration> (links from My Tasks).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const cal = q.get("calibration");
    if (cal) {
      setOpenCal(cal);
      devicesApi
        .ofCalibration(cal)
        .then((r) => setId(r.deviceId))
        .catch((err) => {
          if (!redirect(err)) setError(err instanceof Error ? err.message : "Calibration not found.");
        });
    } else setId(q.get("id"));
  }, [redirect]);

  useEffect(() => {
    devicesApi.types().then(setTypes).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setD(await devicesApi.get(id));
    } catch (err) {
      if (!redirect(err)) setError(err instanceof Error ? err.message : "Could not load the instrument.");
    }
  }, [id, redirect]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Callout tone="fail">{error}</Callout>;
  if (!d)
    return (
      <p className="flex items-center gap-2 text-muted">
        <StatusIcon tone="progress" /> Loading…
      </p>
    );

  const r = d.readiness;
  const tone = r.state === "READY" ? "pass" : r.state === "DUE_SOON" ? "warn" : r.state === "RETIRED" ? "info" : "fail";

  async function saveEdit(reason: string, signature?: SignatureInput) {
    const updated = await devicesApi.update(d!.id, { ...editValues!, installedOn: editValues!.installedOn || null, reason, signature });
    setD(updated);
    setEditValues(null);
    setEditing(false);
    setNotice("Instrument details updated.");
  }

  async function changeStatus(reason: string, signature?: SignatureInput) {
    const updated = await devicesApi.setStatus(d!.id, statusChange!.to, reason, signature);
    setD(updated);
    setNotice(`${statusChange!.title}: done.`);
    setStatusChange(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-sm text-muted">
            {d.code} · {d.instrumentTypeLabel}{d.deviceIdentifier && ` · ID ${d.deviceIdentifier}`}
          </p>
          <h2 className="text-xl font-semibold text-ink">{d.name}</h2>
        </div>
        <Link href="/devices/" className="text-sm font-semibold text-brand hover:underline">
          All instruments
        </Link>
      </div>

      <Callout tone={tone} title={r.usable ? "Can be used" : "Blocked from use"}>
        <span className="flex flex-wrap items-center gap-2">
          <ReadinessBadge r={r} /> {r.message}
        </span>
        {r.dueAt && <span className="mt-1 block text-sm">Calibration due {formatDate(r.dueAt)}.</span>}
      </Callout>

      {notice && <Callout tone="pass">{notice}</Callout>}

      {editing ? (
        <DeviceForm
          initial={{
            instrumentType: d.instrumentType,
            name: d.name,
            manufacturer: d.manufacturer,
            model: d.model,
            serialNumber: d.serialNumber,
            assetTag: d.assetTag ?? "",
            location: d.location,
            firmwareVersion: d.firmwareVersion,
            deviceIdentifier: d.deviceIdentifier ?? "",
            installedOn: d.installedOn ?? "",
            calibrationIntervalDays: d.calibrationIntervalDays,
            calibrationWarningDays: d.calibrationWarningDays,
          }}
          types={types.length ? types : [{ code: d.instrumentType, label: d.instrumentTypeLabel, moduleId: null, available: true, moduleName: null, moduleUi: null }]}
          typeLocked
          submitLabel="Save…"
          onSubmit={setEditValues}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <section className="rounded-lg border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
            <h3 className="font-semibold">Instrument details</h3>
            {d.canManage && d.status !== "RETIRED" && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                {STATUS_CHANGES[d.status].map((s) => (
                  <Button key={s.to} variant="secondary" onClick={() => setStatusChange(s)}>
                    {s.title}…
                  </Button>
                ))}
              </div>
            )}
          </div>
          <div className="px-5 py-2">
            <FieldTable
              rows={[
                ["Manufacturer / model", `${d.manufacturer} ${d.model}`],
                ["Serial number", <span key="s" className="font-mono">{d.serialNumber}</span>],
                ["Asset tag", d.assetTag ?? "—"],
                ["Location", d.location || "—"],
                ["Firmware", d.firmwareVersion || "—"],
                ["Instrument ID (DEVICE_ID)", d.deviceIdentifier ? <span key="i" className="font-mono">{d.deviceIdentifier}</span> : "— (no data link)"],
                ["Installed", d.installedOn ?? "—"],
                ["Calibration interval", `Every ${d.calibrationIntervalDays} days, warning ${d.calibrationWarningDays} days before`],
                ["Registered", formatDate(d.createdAt)],
              ]}
            />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">Calibrations</h3>
          {d.module?.ui && (
            <a
              href={moduleUrl(d.module.ui)}
              className="inline-flex min-h-11 items-center rounded-md bg-brand px-5 font-semibold text-white hover:bg-brand-700"
            >
              Live readings and calibration in the {d.module.name} module
            </a>
          )}
          {d.canCalibrate && !calibrating && (
            <Button onClick={() => setCalibrating(true)}>Record calibration</Button>
          )}
        </div>
        {calibrating && (
          <CalibrationForm
            submitLabel="Save as draft"
            onSubmit={async (body) => {
              const res = await devicesApi.recordCalibration(d.id, body);
              setD(res.device);
              setCalibrating(false);
              setOpenCal(res.calibrationId);
              setNotice("Calibration saved as a draft. Check it, then submit it for approval.");
            }}
            onCancel={() => setCalibrating(false)}
          />
        )}
        {d.calibrations.map((c) =>
          correcting === c.id ? (
            <CalibrationForm
              key={c.id}
              initial={c}
              submitLabel="Save corrections"
              onSubmit={async (body) => {
                setD(await devicesApi.correctCalibration(d.id, c.id, body));
                setCorrecting(null);
                setNotice("Calibration corrected.");
              }}
              onCancel={() => setCorrecting(null)}
            />
          ) : (
            <CalibrationCard
              key={c.id}
              c={c}
              open={openCal === c.id}
              canCorrect={c.workflow.state === "DRAFT" && c.performedBy.id === principal.userId && c.dataSource === "MANUAL" && !d.module}
              canDiscard={c.workflow.state === "DRAFT" && c.performedBy.id === principal.userId}
              onToggle={() => setOpenCal(openCal === c.id ? null : c.id)}
              onCorrect={() => setCorrecting(c.id)}
              onDiscard={() => setDiscarding(c.id)}
              onDone={async (msg) => {
                await load();
                setNotice(msg);
              }}
            />
          ),
        )}
        {d.calibrations.length === 0 && !calibrating && <p className="text-sm text-muted">No calibrations recorded yet.</p>}
      </section>

      <section>
        <h3 className="mb-2 font-semibold">Change history</h3>
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-left text-sm">
            <tbody className="divide-y divide-line">
              {d.history.map((e) => (
                <tr key={e.sequence}>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{formatDate(e.occurredAt)}</td>
                  <td className="px-4 py-2 font-medium">{e.action.replaceAll("_", " ").toLowerCase()}</td>
                  <td className="px-4 py-2">{e.actorName ?? e.actor}</td>
                  <td className="px-4 py-2 text-muted">{e.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ReasonDialog
        open={!!discarding}
        title="Discard draft calibration"
        description="The draft is withdrawn and kept in the audit trail. Record a new calibration afterwards."
        confirmLabel="Discard"
        destructive
        minReason={10}
        reasonPlaceholder="e.g. Wrong buffer used; recalibrating"
        onConfirm={async (reason) => {
          setD(await devicesApi.discardCalibration(d.id, discarding!, reason));
          setDiscarding(null);
          setNotice("Draft calibration discarded.");
        }}
        onClose={() => setDiscarding(null)}
      />
      <ReasonDialog
        open={!!editValues}
        title="Save instrument details"
        description="The previous values are kept in the audit trail."
        confirmLabel="Save"
        action="DEVICE_UPDATE"
        onConfirm={saveEdit}
        onClose={() => setEditValues(null)}
      />
      <ReasonDialog
        open={!!statusChange}
        title={statusChange?.title ?? ""}
        description={statusChange?.description ?? ""}
        confirmLabel={statusChange?.confirm ?? ""}
        destructive={statusChange?.destructive}
        action="DEVICE_STATUS_CHANGE"
        minReason={10}
        reasonPlaceholder="e.g. Electrode cracked, maintenance ticket MNT-2026-77"
        onConfirm={changeStatus}
        onClose={() => setStatusChange(null)}
      />
    </div>
  );
}

export default function DeviceViewPage() {
  return (
    <AppShell title="Instrument">
      <DeviceView />
    </AppShell>
  );
}
