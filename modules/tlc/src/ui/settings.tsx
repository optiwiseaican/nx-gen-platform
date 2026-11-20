"use client";

/**
 * TLC "Camera settings" (the module's Advanced settings): the starting exposure, gain and white
 * balance for the lamp box camera and its advanced parameters, per camera serial, with one row
 * ('*') for any camera without its own. An approved method still overrides exposure / gain / white
 * balance; every capture records the values actually used. Changes need `tlc.settings` and a reason.
 */
import { useCallback, useEffect, useState } from "react";
import { CAMERA_LIMITS, CameraDefaults, DEFAULT_CAMERA_DEFAULTS } from "../shared/tlc";
import { Badge, Callout, card, field, fmtDate, mod, panelTitle, primary, request, secondary, send } from "./lib";

interface Principal {
  permissions: string[];
}
interface CameraRow {
  serial: string;
  model: string;
  simulated: boolean;
}
interface Capabilities {
  autoOnCamera: string[];
  autoOnHost: string[];
  parameters: { frameRate: [number, number] | null; digitalGain: [number, number] | null; blackLevelAuto: string[] | null; blackLevel: [number, number] | null };
}
type Saved = CameraDefaults & { changedAt: string; changedBy: string };

const ANY = "*";

export function CameraSettingsPage({ principal }: { principal: Principal }) {
  const canEdit = principal.permissions.includes("tlc.settings");
  const [cameras, setCameras] = useState<CameraRow[] | null>(null);
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(ANY);
  const [caps, setCaps] = useState<Record<string, Capabilities | null>>({});

  const load = useCallback(async () => {
    try {
      const [cam, s] = await Promise.all([
        mod<{ cameras: CameraRow[]; status: { error: string | null } }>("/camera"),
        mod<{ settings: Saved[] }>("/camera-settings"),
      ]);
      setCameras(cam.cameras);
      setSaved(s.settings);
      setError(cam.status.error);
      for (const c of cam.cameras) {
        request(`/api/cameras/${encodeURIComponent(c.serial)}`)
          .then((r) => r.json())
          .then((info: { capabilities?: Capabilities | null }) => setCaps((x) => ({ ...x, [c.serial]: info.capabilities ?? null })))
          .catch(() => setCaps((x) => ({ ...x, [c.serial]: null })));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const rows: { serial: string; label: string; simulated: boolean }[] = [
    { serial: ANY, label: "Any camera (default)", simulated: false },
    ...(cameras ?? []).map((c) => ({ serial: c.serial, label: `${c.model} · ${c.serial}`, simulated: c.simulated })),
    ...(saved ?? []).filter((s) => s.cameraSerial !== ANY && !(cameras ?? []).some((c) => c.serial === s.cameraSerial)).map((s) => ({ serial: s.cameraSerial, label: `${s.cameraSerial} (not connected)`, simulated: false })),
  ];
  const current = saved?.find((s) => s.cameraSerial === selected) ?? null;
  const fallback = selected === ANY ? null : (saved?.find((s) => s.cameraSerial === ANY) ?? null);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Camera settings</h1>
        <p className="mt-1 text-sm text-muted">
          Advanced settings for the lamp box camera: the exposure, gain and white balance the Picture stage starts with, and the camera&apos;s advanced parameters. An
          approved method still sets exposure, gain or white balance where it names them; every capture records the values used.
        </p>
      </div>
      {error && <Callout tone="warn">{error}</Callout>}
      {!canEdit && <Callout tone="info">You can view these settings; changing them needs the permission “Change the TLC camera settings”.</Callout>}
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav className={`${card} space-y-1`} aria-label="Cameras">
          <h2 className={panelTitle}>Cameras</h2>
          {rows.map((r) => {
            const has = saved?.some((s) => s.cameraSerial === r.serial);
            return (
              <button
                key={r.serial}
                type="button"
                aria-current={selected === r.serial ? "page" : undefined}
                onClick={() => setSelected(r.serial)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${selected === r.serial ? "bg-brand-50 font-semibold text-brand-text" : "hover:bg-canvas"}`}
              >
                <span className="truncate">{r.label}</span>
                <span className="ml-2 flex shrink-0 gap-1">
                  {r.simulated && <Badge tone="warn">Simulated</Badge>}
                  {has ? <Badge tone="pass">Saved</Badge> : <Badge tone="info">Built-in</Badge>}
                </span>
              </button>
            );
          })}
          {cameras && cameras.length === 0 && <p className="px-3 py-2 text-xs text-muted">No camera is connected to this computer.</p>}
        </nav>
        <SettingsForm
          key={selected}
          serial={selected}
          saved={current}
          fallback={fallback}
          capabilities={selected === ANY ? null : (caps[selected] ?? null)}
          canEdit={canEdit}
          onSaved={load}
        />
      </div>
    </main>
  );
}

function SettingsForm({
  serial,
  saved,
  fallback,
  capabilities,
  canEdit,
  onSaved,
}: {
  serial: string;
  saved: Saved | null;
  fallback: Saved | null;
  capabilities: Capabilities | null;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const start: Omit<CameraDefaults, "cameraSerial"> = saved ?? fallback ?? DEFAULT_CAMERA_DEFAULTS;
  const [f, setF] = useState({
    exposureMs: String(start.exposureUs / 1000),
    gain: String(start.gain),
    wb: start.whiteBalance.map(String) as [string, string, string],
    digitalGain: start.digitalGain === null ? "" : String(start.digitalGain),
    blackLevelAuto: start.blackLevelAuto,
    blackLevel: start.blackLevel === null ? "" : String(start.blackLevel),
    frameRate: start.frameRate === null ? "" : String(start.frameRate),
    autoTarget: String(Math.round(start.autoTarget * 100)),
    note: start.note,
    reason: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const caps = capabilities?.parameters;
  const unsupported = (k: keyof NonNullable<typeof caps>) => !!caps && !caps[k];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await mod(
        `/camera-settings/${encodeURIComponent(serial)}`,
        send(
          {
            exposureUs: Number(f.exposureMs) * 1000,
            gain: Number(f.gain),
            whiteBalance: f.wb.map(Number),
            digitalGain: f.digitalGain === "" ? null : Number(f.digitalGain),
            blackLevelAuto: f.blackLevelAuto,
            blackLevel: f.blackLevel === "" ? null : Number(f.blackLevel),
            frameRate: f.frameRate === "" ? null : Number(f.frameRate),
            autoTarget: Number(f.autoTarget) / 100,
            note: f.note,
            reason: f.reason,
          },
          "PUT",
        ),
      );
      setF({ ...f, reason: "" });
      setDone("Saved. The Picture stage starts from these values from now on.");
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const num = (label: string, key: keyof typeof f, min: number, max: number, step: number, hint?: string, disabled = false) => (
    <label className="block text-sm font-semibold">
      {label}
      <input type="number" min={min} max={max} step={step} value={String(f[key])} onChange={set(key)} disabled={!canEdit || disabled} className={`${field} font-mono`} />
      {hint && <span className="mt-0.5 block text-xs font-normal text-muted">{hint}</span>}
    </label>
  );

  return (
    <form onSubmit={save} className={`${card} space-y-5`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className={panelTitle}>{serial === ANY ? "Any camera (default)" : `Camera ${serial}`}</h2>
          <p className="text-xs text-muted">
            {saved ? `Saved ${fmtDate(saved.changedAt)}` : fallback ? "Not saved for this camera: the default row applies." : "Not saved: the built-in values apply."}
            {capabilities && ` · Auto features on the camera: ${capabilities.autoOnCamera.length ? capabilities.autoOnCamera.join(", ") : "none (done on the host)"}`}
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-navy">Starting values for the Picture stage</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {num("Exposure (ms)", "exposureMs", CAMERA_LIMITS.exposureUs[0] / 1000, CAMERA_LIMITS.exposureUs[1] / 1000, 0.1, "31 µs to 2 s. Without an exposure in the method, the capture still corrects it automatically from this start.")}
          {num("Analog gain", "gain", CAMERA_LIMITS.gain[0], CAMERA_LIMITS.gain[1], 0.01)}
        </div>
        <fieldset>
          <legend className="text-sm font-semibold">White balance (red / green / blue)</legend>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {(["Red", "Green", "Blue"] as const).map((name, i) => (
              <label key={name} className="text-xs text-muted">
                {name}
                <input
                  type="number"
                  min={CAMERA_LIMITS.whiteBalance[0]}
                  max={CAMERA_LIMITS.whiteBalance[1]}
                  step={0.01}
                  value={f.wb[i]}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const wb = [...f.wb] as [string, string, string];
                    wb[i] = e.target.value;
                    setF({ ...f, wb });
                  }}
                  className={`${field} font-mono`}
                />
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">Find them with “Auto white balance” on the Picture stage under white light, then copy them here.</p>
        </fieldset>
        {num("Auto brightness target (%)", "autoTarget", 10, 80, 1, "Mean brightness the automatic exposure aims at (IDS peak “Target”). 45 % suits most plates.")}
      </section>

      <section className="space-y-3 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-navy">Advanced camera parameters</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {num("Digital gain", "digitalGain", caps?.digitalGain?.[0] ?? 1, caps?.digitalGain?.[1] ?? 64, 0.1, unsupported("digitalGain") ? "This camera has no digital gain." : "Empty = 1 (off). Prefer analog gain; digital gain only scales the values.", unsupported("digitalGain"))}
          {num("Frame rate limit (fps)", "frameRate", caps?.frameRate?.[0] ?? 0.1, caps?.frameRate?.[1] ?? 1000, 0.1, unsupported("frameRate") ? "This camera has no frame rate limit." : "Empty = the camera's maximum. The exposure always caps it.", unsupported("frameRate"))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={f.blackLevelAuto} disabled={!canEdit || unsupported("blackLevelAuto")} onChange={(e) => setF({ ...f, blackLevelAuto: e.target.checked })} />
            Automatic black level
            {unsupported("blackLevelAuto") && <span className="text-xs font-normal text-muted">· not on this camera</span>}
          </label>
          {num("Black level", "blackLevel", caps?.blackLevel?.[0] ?? 0, caps?.blackLevel?.[1] ?? 4095, 1, unsupported("blackLevel") ? "This camera has no black level." : "Used when the automatic black level is off.", f.blackLevelAuto || unsupported("blackLevel"))}
        </div>
      </section>

      <section className="space-y-3 border-t border-line pt-4">
        <label className="block text-sm font-semibold">
          Note
          <textarea rows={2} value={f.note} onChange={set("note")} disabled={!canEdit} className={`${field} h-auto py-2`} placeholder="e.g. Lamp box LB-2, white LED, values found on 18 Nov 2026" />
        </label>
        {canEdit && (
          <label className="block text-sm font-semibold">
            Reason for the change
            <input value={f.reason} onChange={set("reason")} className={field} placeholder="Recorded in the audit trail" />
          </label>
        )}
        {error && <Callout tone="fail">{error}</Callout>}
        {done && <Callout tone="pass">{done}</Callout>}
        {canEdit && (
          <div className="flex justify-end gap-3">
            <button type="button" className={secondary} onClick={() => location.reload()} disabled={busy}>
              Discard
            </button>
            <button className={primary} disabled={busy || f.reason.trim().length < 5}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </section>
    </form>
  );
}
