/**
 * The analysis stages, laid out as on the TLC Tablet: the image on the left, a side panel on
 * the right, and one primary button per stage that moves on. Picture → Crop → Plate →
 * Evaluation. The browser runs the engine for live preview on the straightened plate the server
 * holds; what is saved is computed by the server as an immutable snapshot (E01, E02, …).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureQc,
  DEFAULT_DENSITOMETRY,
  DEFAULT_DEVELOPMENT,
  DEFAULT_SPOT_DETECTOR,
  Densitometry,
  DensitometrySettings,
  DetectedSpot,
  ImageOps,
  LayoutDetector,
  PLATE_PRESETS,
  PeakLocator,
  PeakWindow,
  PlateGeometry,
  Point,
  PostProcessing,
  Profile,
  QC_CHECK_LABELS,
  RgbImage,
  SavitzkyGolay,
  SpotDetector,
  SpotDetectorSettings,
  polarityOf,
  quadAspect,
  quadFrom,
} from "../engine";
import type { Channel, GrayImage, QcCheck } from "../engine";
import type { EvaluationInput, ImageQc } from "../api/pipeline";
import { CAMERA_LIMITS, CameraDefaults, CameraParametersInput, Evaluation, FrameStats, ILLUMINATIONS, Illumination, RfWindow, TrackRole, autoExposureUs, autoWhiteBalance, evaluateRf } from "../shared/tlc";
import { Badge, CONCLUSION, Callout, ILLUMINATION_LABEL, Tone, card, field, fmtDate, mod, optionBox, panelLabel, panelTitle, primary, request, secondary, send, small, strong, toolToggle } from "./lib";
import { EvaluationFull, FitBox, ImageMeta, PlateMeta, RfTable, clamp, fmt, loadPixels, svgPoint } from "./plate";
import { CHART_MODES, ChartMode, ChartTool, DensitogramPlot, FULL_VIEW, PlotBand, PlotColors, PlotTrack, TRACK_PALETTE, Viewport, normalizeToMax } from "./densitogram";

export type Stage = "PICTURE" | "CROP" | "PLATE" | "EVALUATION" | "SIGNOFF";
export const STAGES: { key: Stage; label: string }[] = [
  { key: "PICTURE", label: "Picture" },
  { key: "CROP", label: "Crop" },
  { key: "PLATE", label: "Plate" },
  { key: "EVALUATION", label: "Evaluation" },
  { key: "SIGNOFF", label: "Sign-off" },
];

const VERDICT: Record<string, { label: string; tone: Tone; color: string }> = {
  READY: { label: "READY", tone: "pass", color: "#13965a" },
  REVIEW: { label: "REVIEW", tone: "warn", color: "#b45f06" },
  RECAPTURE_REQUIRED: { label: "RECAPTURE REQUIRED", tone: "fail", color: "#e0344c" },
};
const STATUS_MARK: Record<string, { mark: string; color: string }> = {
  PASS: { mark: "✓", color: "#13965a" },
  WARN: { mark: "!", color: "#b45f06" },
  FAIL: { mark: "✗", color: "#e0344c" },
  NOT_ASSESSED: { mark: "–", color: "#9aa3b5" },
};

/**
 * The tablet's workflow layout: the image on the left stays in view, the side panel on the right
 * scrolls on its own, and the stage's main action stays pinned at the bottom of that panel.
 * On narrow screens both simply stack and the page scrolls.
 */
const STAGE_GRID = "grid gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[minmax(0,1fr)]";
const SIDE_PANEL = "lg:min-h-0 lg:overflow-y-auto";
const PINNED_ACTION = "sticky bottom-0 z-10 -mx-5 border-t border-line bg-white px-5 pt-3 pb-3";

/**
 * The tablet's step bar on the dark header: a numbered circle and label per stage, joined by
 * short lines; the current step is amber, reachable steps white, the rest dimmed.
 */
export function StageBar({ stage, reachable, onStage }: { stage: Stage; reachable: (s: Stage) => boolean; onStage: (s: Stage) => void }) {
  return (
    <ol className="flex flex-wrap items-center" aria-label="Analysis stages">
      {STAGES.map((s, i) => {
        const current = s.key === stage;
        const can = reachable(s.key);
        const fg = current ? "text-accent" : can ? "text-white" : "text-white/40";
        return (
          <li key={s.key} className="flex items-center">
            <button type="button" disabled={!can} aria-current={current ? "step" : undefined} onClick={() => onStage(s.key)} className={`flex items-center gap-2 rounded-lg px-2 py-1 text-sm font-semibold ${fg} ${can && !current ? "hover:bg-white/10" : ""}`}>
              <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold text-navy ${current ? "bg-accent" : can ? "bg-white" : "bg-white/40"}`}>{i + 1}</span>
              {s.label}
            </button>
            {i < STAGES.length - 1 && <span className="mx-0.5 h-0.5 w-5 bg-white/50" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// 1. Picture — image set, upload, capture review (quality gate)
// ---------------------------------------------------------------------------

export function PictureStage({
  analysisId,
  images,
  selectedId,
  editable,
  onSelect,
  onUploaded,
  onUse,
}: {
  analysisId: string;
  images: ImageMeta[];
  selectedId: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onUploaded: (message: string, id: string) => Promise<void>;
  /** "Use this image": go to Crop with this image and, for a failed gate, the reason given. */
  onUse: (image: ImageMeta, overrideReason: string) => void;
}) {
  const [illumination, setIllumination] = useState<Illumination>("UV254");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState("");
  const [overriding, setOverriding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const image = images.find((i) => i.id === selectedId) ?? images[images.length - 1] ?? null;
  const qc = image?.qc ?? null;
  const verdict = qc ? VERDICT[qc.verdict] : null;

  // The lamp box camera, through the server (browsers cannot see USB3 Vision cameras).
  const [camera, setCamera] = useState<CameraOverview | null>(null);
  const [live, setLive] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const loadCamera = useCallback(async () => {
    try {
      setCamera(await mod<CameraOverview>(`/camera?analysis=${analysisId}`));
    } catch (e) {
      setCamera({ status: { mode: "OFF", helper: "FAILED", simulated: false, error: (e as Error).message }, cameras: [], settings: null, problems: [], preferredSerial: null });
    }
  }, [analysisId]);
  useEffect(() => {
    if (editable) void loadCamera();
  }, [editable, loadCamera]);
  const cam = camera?.cameras.find((c) => c.serial === camera.preferredSerial) ?? (camera?.cameras.length === 1 ? camera.cameras[0] : null);
  const camSettings = camera?.settings ?? null;
  const locked = camSettings?.fromMethod ?? { exposure: !!camSettings?.fixed, gain: false, whiteBalance: false };

  // Exposure, gain and white balance in use: the method's where it sets them, else the analyst's
  // (remembered per camera on this computer), else the defaults.
  const [values, setValues] = useState<CameraValues | null>(null);
  const [adjusted, setAdjusted] = useState(false);
  useEffect(() => {
    if (!cam || !camSettings) return;
    const mine = rememberedCamera(cam.serial);
    setValues({
      exposureUs: !locked.exposure && typeof mine.exposureUs === "number" ? mine.exposureUs : camSettings.exposureUs,
      gain: !locked.gain && typeof mine.gain === "number" ? mine.gain : camSettings.gain,
      whiteBalance: !locked.whiteBalance && Array.isArray(mine.whiteBalance) && mine.whiteBalance.length === 3 ? (mine.whiteBalance as [number, number, number]) : camSettings.whiteBalance,
    });
    setAdjusted(Object.keys(mine).length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam?.serial, camSettings?.exposureUs, camSettings?.gain, camSettings?.whiteBalance.join("/")]);
  // Advanced parameters (digital gain, black level, frame rate): the saved defaults, changed here
  // for this session; applied to the live view and recorded with the capture.
  const [parameters, setParameters] = useState<CameraParametersInput>({});
  useEffect(() => {
    if (camera?.parameters) setParameters(camera.parameters);
  }, [camera?.parameters]);
  // The running live view takes new settings in place (PUT /api/cameras/<serial>/preview): no
  // reconnection. Changes are sent a moment after the last one.
  const liveImg = useRef<HTMLImageElement | null>(null);
  const liveSerial = useRef<string | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An NxGen service older than 2.0 (camera helper 1.1) has no in-place change: the stream is
  // reopened with the new settings instead (a short reconnection), and a note says why.
  const [legacyService, setLegacyService] = useState(false);
  const [reopenKey, setReopenKey] = useState(0);
  function pushLive(v: CameraValues | null, p: CameraParametersInput) {
    const serial = liveSerial.current;
    if (!serial || !v) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      if (legacyService) return setReopenKey((k) => k + 1);
      void request(`/cameras/${encodeURIComponent(serial)}/preview`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...v, parameters: p }) }).catch((e: Error & { status?: number }) => {
        if (e.status === 404 || /Cannot PUT/.test(e.message)) {
          setLegacyService(true);
          setReopenKey((k) => k + 1);
        } else setError(e.message);
      });
    }, 150);
  }
  function change(v: CameraValues) {
    setValues(v);
    setAdjusted(true);
    pushLive(v, parameters);
    if (cam)
      try {
        localStorage.setItem(CAMERA_STORE(cam.serial), JSON.stringify(v));
      } catch {
        /* storage unavailable: the values still apply to this session */
      }
  }
  function changeParameters(p: CameraParametersInput) {
    setParameters(p);
    pushLive(values, p);
  }
  const [autoBusy, setAutoBusy] = useState(false);
  /** Exposure or white balance found once: on the camera where it can, else on the host from raw frames. */
  async function autoAdjust(kind: "exposure" | "whiteBalance") {
    if (!cam || !values) return;
    setAutoBusy(true);
    setError(null);
    try {
      const r = await request(`/cameras/${encodeURIComponent(cam.serial)}/auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: [kind], ...values, target: camera?.defaults?.autoTarget ?? 0.45 }),
      });
      const out = (await r.json()) as { exposureUs: number; gain: number; whiteBalance: [number, number, number]; by: string };
      const v: CameraValues = kind === "exposure" ? { ...values, exposureUs: Math.round(out.exposureUs), gain: out.gain } : { ...values, whiteBalance: out.whiteBalance };
      setValues(v);
      setAdjusted(true);
      if (cam)
        try {
          localStorage.setItem(CAMERA_STORE(cam.serial), JSON.stringify(v));
        } catch {
          /* ignore */
        }
    } catch (e) {
      // The server could not do it: fall back to the live image in the browser.
      const stats = frameStats(liveImg.current);
      if (!stats) return setError((e as Error).message);
      change(kind === "exposure" ? { ...values, exposureUs: autoExposureUs(stats, values.exposureUs) } : { ...values, whiteBalance: autoWhiteBalance(stats, values.whiteBalance) });
    } finally {
      setAutoBusy(false);
    }
  }
  function resetCamera() {
    if (!camSettings) return;
    if (cam)
      try {
        localStorage.removeItem(CAMERA_STORE(cam.serial));
      } catch {
        /* ignore */
      }
    setValues({ exposureUs: camSettings.exposureUs, gain: camSettings.gain, whiteBalance: camSettings.whiteBalance });
    setAdjusted(false);
  }

  async function capture() {
    if (!cam) return;
    setCapturing(true);
    setError(null);
    try {
      const out = await mod<{ id: string; sha256: string; qc: ImageQc | null; camera: { exposureUs: number; attempts: unknown[] } }>(`/analyses/${analysisId}/capture`, send({ illumination, serial: cam.serial, settings: adjusted && values ? values : undefined, parameters }));
      setLive(false);
      const retakes = out.camera.attempts.length - 1;
      await onUploaded(
        `${ILLUMINATION_LABEL[illumination]} image captured (${cam.simulated ? "simulated camera" : cam.serial}, ${fmtExposure(out.camera.exposureUs)}${retakes > 0 ? `, exposure corrected in ${retakes} retake${retakes === 1 ? "" : "s"}` : ""}) · SHA-256 ${out.sha256.slice(0, 16)}… · quality gate: ${out.qc ? VERDICT[out.qc.verdict].label : "not judged"}`,
        out.id,
      );
    } catch (e) {
      setError((e as Error).message);
      void loadCamera();
    } finally {
      setCapturing(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const r = await request(`/modules/tlc/api/analyses/${analysisId}/images?illumination=${illumination}&name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      const out = (await r.json()) as { id: string; sha256: string; qc: ImageQc | null };
      await onUploaded(`${ILLUMINATION_LABEL[illumination]} image stored · SHA-256 ${out.sha256.slice(0, 16)}… · quality gate: ${out.qc ? VERDICT[out.qc.verdict].label : "not judged"}`, out.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const blocked = qc?.verdict === "RECAPTURE_REQUIRED";
  return (
    <div className={STAGE_GRID}>
      <div className="relative min-h-[18rem] overflow-hidden rounded-2xl bg-black lg:min-h-0">
        {live && cam && (values ?? camSettings) ? (
          <LivePreview
            serial={cam.serial}
            simulated={cam.simulated}
            exposureUs={(values ?? camSettings)!.exposureUs}
            gain={(values ?? camSettings)!.gain}
            whiteBalance={(values ?? camSettings)!.whiteBalance}
            illumination={illumination}
            imgRef={liveImg}
            reopenKey={reopenKey}
            onOpen={(serial) => {
              liveSerial.current = serial;
              // The stream opened with the values of that moment; send the current ones in case they moved.
              pushLive(values, parameters);
            }}
            onClose={() => (liveSerial.current = null)}
          />
        ) : image ? (
          <>
            <img src={`/api/modules/tlc/api/images/${image.id}`} alt={`${ILLUMINATION_LABEL[image.illumination]} plate image`} className="max-h-[42rem] w-full object-contain lg:absolute lg:inset-0 lg:h-full lg:max-h-none" />
            {verdict && (
              <span className="absolute top-3 left-3 rounded-lg px-3 py-1.5 text-sm font-extrabold tracking-wide text-white" style={{ background: verdict.color }}>
                {verdict.label}
              </span>
            )}
            <span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 font-mono text-[11px] text-white">
              {image.source === "CAMERA" && image.camera
                ? `CAMERA${image.camera.simulated ? " (SIMULATED)" : ""} · ${image.camera.serial} · ${fmtExposure(image.camera.exposureUs)} · gain ${fmt(image.camera.gain, 1)}`
                : `RAW · ${image.fileName}`}{" "}
              · {ILLUMINATION_LABEL[image.illumination]}
            </span>
          </>
        ) : (
          <p className="p-8 text-center text-sm text-white/70">No plate image yet. Capture the plate with the camera, or upload a photo taken under the lamp you need.</p>
        )}
      </div>

      <aside className={`${card} ${SIDE_PANEL} space-y-4`}>
        <div>
          <h3 className={panelTitle}>Plate image</h3>
          <p className="text-sm text-muted">Images are stored unchanged, with their SHA-256, and checked by the capture quality gate.</p>
        </div>
        <div className="rounded-xl border border-line p-3 text-sm">
          <p className="font-semibold">
            Image set · {images.length} raw image{images.length === 1 ? "" : "s"} stored
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {ILLUMINATIONS.map((il) => {
              const got = images.filter((i) => i.illumination === il);
              const tone = got.length ? "text-pass border-pass/40" : il === illumination ? "text-warn border-warn/40" : "text-muted border-line";
              return (
                <button
                  key={il}
                  type="button"
                  className={`rounded-lg border px-2 py-1.5 text-xs font-semibold ${tone}`}
                  onClick={() => (got.length ? onSelect(got[got.length - 1].id) : setIllumination(il))}
                >
                  {ILLUMINATION_LABEL[il]} {got.length ? "✓" : il === illumination ? "required" : ""}
                </button>
              );
            })}
          </div>
          {images.length > 1 && (
            <select aria-label="Stored image" value={image?.id ?? ""} onChange={(e) => onSelect(e.target.value)} className={`${field} text-sm`}>
              {images.map((i) => (
                <option key={i.id} value={i.id}>
                  {ILLUMINATION_LABEL[i.illumination]} · {i.fileName}
                  {i.qc ? ` · ${VERDICT[i.qc.verdict].label}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
        {editable && (
          <>
            <label className="block text-sm font-semibold">
              Photographed under
              <select value={illumination} onChange={(e) => setIllumination(e.target.value as Illumination)} className={field}>
                {ILLUMINATIONS.map((i) => (
                  <option key={i} value={i}>
                    {ILLUMINATION_LABEL[i]}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-2 rounded-xl border border-line p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">Camera</p>
                <button type="button" className="text-xs font-semibold text-brand hover:underline" onClick={() => void loadCamera()}>
                  Refresh
                </button>
              </div>
              {!camera ? (
                <p className="text-muted">Looking for the camera…</p>
              ) : cam ? (
                <>
                  <p>
                    {cam.model} · <span className="font-mono">{cam.serial}</span>
                    {cam.simulated && <Badge tone="warn">Simulated</Badge>}
                  </p>
                  {values && (
                    <p className="text-xs text-muted">
                      Exposure {fmtExposure(values.exposureUs)} · gain {fmt(values.gain, 2)} · white balance {values.whiteBalance.map((v) => fmt(v, 2)).join("/")} ·{" "}
                      {locked.exposure ? "exposure set by the method" : adjusted ? "as set here (recorded with the image)" : "exposure corrected automatically when capturing"}
                    </p>
                  )}
                  {values && (
                    <CameraControls
                      values={values}
                      locked={locked}
                      live={live}
                      busy={autoBusy}
                      legacy={legacyService}
                      onChange={change}
                      onAutoExposure={() => void autoAdjust("exposure")}
                      onAutoWhiteBalance={() => void autoAdjust("whiteBalance")}
                      onReset={resetCamera}
                      parameters={parameters}
                      capabilities={camera?.capabilities ?? null}
                      onParameters={changeParameters}
                    />
                  )}
                  {camera.problems.length > 0 && <Callout tone="fail">{camera.problems.join(" ")}</Callout>}
                  {cam.simulated && <p className="text-xs text-warn">Development server: the simulated camera photographs a stored plate. Real captures need the lab PC with the IDS camera.</p>}
                </>
              ) : (
                <p className="text-muted">
                  {camera.status.mode === "OFF" ? "Cameras are switched off on this server." : camera.cameras.length > 1 ? "Several cameras are connected; set the instrument's serial number to the camera's serial." : "No camera connected to this computer. Check the USB 3 cable."}
                  {camera.status.error && <span className="block text-xs text-fail">{camera.status.error}</span>}
                </p>
              )}
              {cam && (
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className={secondary} onClick={() => setLive(!live)} disabled={capturing}>
                    {live ? "Stop live view" : "Live view"}
                  </button>
                  <button type="button" className={primary} onClick={() => void capture()} disabled={capturing || busy || (camera?.problems.length ?? 0) > 0}>
                    {capturing ? "Capturing…" : "Capture"}
                  </button>
                </div>
              )}
              {cam && error && (
                <p role="alert" className="text-sm font-semibold text-fail">
                  {error}
                </p>
              )}
            </div>
            <input ref={fileRef} id="plate-image" type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <button className={`${cam ? secondary : strong} w-full`} onClick={() => fileRef.current?.click()} disabled={busy || capturing}>
              {busy ? "Checking the image…" : "Upload plate image"}
            </button>
          </>
        )}
        {error && <Callout tone="fail">{error}</Callout>}

        {image && (
          <div className="space-y-3 border-t border-line pt-4">
            <div>
              <h4 className={panelTitle}>Capture review</h4>
              <p className="text-sm text-muted">{editable ? `${image.source === "CAMERA" ? "Captured" : "Uploaded"} image checked. Use it or choose another.` : "How the image passed the capture quality gate."}</p>
            </div>
            <p className="text-sm font-semibold">Quality checks</p>
            {qc ? (
              <ul className="space-y-1.5 text-sm">
                {qc.items.map((i) => (
                  <li key={i.check} className="flex items-start gap-2">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white" style={{ background: STATUS_MARK[i.status].color }} aria-label={i.status}>
                      {STATUS_MARK[i.status].mark}
                    </span>
                    <span>
                      <b>{QC_CHECK_LABELS[i.check as QcCheck] ?? i.check}</b> <span className="text-muted">{i.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">The image is too small for the quality gate.</p>
            )}
            {editable && (
              <>
                {blocked && (
                  <>
                    <p className="text-sm font-semibold text-fail">This image would give wrong results. Upload a better one, or give a reason to use it anyway.</p>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={overriding} onChange={(e) => setOverriding(e.target.checked)} />
                      Use anyway (override with a reason)
                    </label>
                    {overriding && (
                      <label className="block text-sm font-semibold">
                        Reason (recorded with the plate and in the audit trail)
                        <textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} className={field} />
                      </label>
                    )}
                  </>
                )}
                <button className={`${primary} w-full`} disabled={blocked && (!overriding || override.trim().length < 10)} onClick={() => onUse(image, blocked ? override.trim() : "")}>
                  {blocked ? (overriding ? "Use anyway (override)" : "Recapture required") : "Use this image"}
                </button>
              </>
            )}
            <p className="font-mono text-[11px] text-muted">
              Raw image {image.id.slice(0, 8)} · {(image.sizeBytes / 1024).toFixed(0)} KB · SHA-256 {image.sha256.slice(0, 12)}… · {image.uploadedBy} · {fmtDate(image.uploadedAt)}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

interface CameraOverview {
  status: { mode: "OFF" | "SIMULATOR" | "IDS"; helper: string; simulated: boolean; error: string | null };
  cameras: { serial: string; model: string; vendor?: string; openable: boolean; simulated: boolean }[];
  settings: {
    exposureUs: number;
    gain: number;
    whiteBalance: [number, number, number];
    fixed: boolean;
    fromMethod?: { exposure: boolean; gain: boolean; whiteBalance: boolean };
  } | null;
  problems: string[];
  preferredSerial: string | null;
  /** The saved Advanced settings for the preferred camera, and what it can do. */
  defaults?: CameraDefaults;
  parameters?: CameraParametersInput;
  capabilities?: {
    autoOnCamera: ("exposure" | "gain" | "whiteBalance")[];
    autoOnHost: ("exposure" | "gain" | "whiteBalance")[];
    parameters: { frameRate: [number, number] | null; digitalGain: [number, number] | null; blackLevelAuto: string[] | null; blackLevel: [number, number] | null; throughputLimit: [number, number] | null };
  } | null;
}

interface CameraValues {
  exposureUs: number;
  gain: number;
  whiteBalance: [number, number, number];
}

const CAMERA_STORE = (serial: string) => `nxgen.tlc.camera.${serial}`;

/** The analyst's last camera settings for this camera on this computer (a convenience; captures record what was used). */
function rememberedCamera(serial: string): Partial<CameraValues> {
  try {
    const v = JSON.parse(localStorage.getItem(CAMERA_STORE(serial)) ?? "null") as Partial<CameraValues> | null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Channel means of the live frame (central 60 %), from the <img> showing the stream. */
function frameStats(img: HTMLImageElement | null): FrameStats | null {
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  const scale = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!g2d) return null;
  g2d.drawImage(img, 0, 0, w, h);
  const x0 = Math.floor(w * 0.2);
  const y0 = Math.floor(h * 0.2);
  const d = g2d.getImageData(x0, y0, Math.max(1, Math.floor(w * 0.6)), Math.max(1, Math.floor(h * 0.6))).data;
  let r = 0, g = 0, b = 0, n = 0, saturated = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (Math.max(d[i], d[i + 1], d[i + 2]) >= 250) {
      saturated++;
      continue;
    }
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  const total = d.length / 4;
  if (!n) return { r: 255, g: 255, b: 255, luma: 255, saturated: 1 };
  return { r: r / n, g: g / n, b: b / n, luma: (0.299 * r + 0.587 * g + 0.114 * b) / n, saturated: saturated / total };
}

/**
 * Exposure, gain and white balance for the live view and the capture, as in IDS peak Cockpit, with
 * "Auto exposure" and "Auto white balance" taken once from the live frame. Settings the method fixes are
 * shown but locked.
 */
function CameraControls({
  values,
  locked,
  live,
  busy,
  legacy,
  onChange,
  onAutoExposure,
  onAutoWhiteBalance,
  onReset,
  parameters,
  capabilities,
  onParameters,
}: {
  values: CameraValues;
  locked: { exposure: boolean; gain: boolean; whiteBalance: boolean };
  live: boolean;
  busy?: boolean;
  legacy?: boolean;
  onChange: (v: CameraValues) => void;
  onAutoExposure: () => void;
  onAutoWhiteBalance: () => void;
  onReset: () => void;
  parameters: CameraParametersInput;
  capabilities: CameraOverview["capabilities"];
  onParameters: (p: CameraParametersInput) => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const caps = capabilities?.parameters;
  const autoWhere = (f: "exposure" | "whiteBalance") => (capabilities?.autoOnCamera.includes(f) ? "on the camera" : "on the host");
  const ms = values.exposureUs / 1000;
  // Exposure on a log slider: 0.1 ms – 2 s.
  const toSlider = (v: number) => Math.round(Math.log10(Math.max(0.1, v)) * 100);
  const fromSlider = (x: number) => Math.round(10 ** (x / 100) * 1000);
  const wbNames = ["Red", "Green", "Blue"];
  const lockNote = <span className="text-[11px] font-normal text-muted"> · set by the method</span>;
  return (
    <div className="space-y-2.5 rounded-lg bg-canvas p-2.5">
      <label className="block text-xs font-semibold">
        Exposure (ms){locked.exposure && lockNote}
        <span className="mt-1 flex items-center gap-2">
          <input type="range" min={-100} max={330} value={toSlider(ms)} disabled={locked.exposure} onChange={(e) => onChange({ ...values, exposureUs: fromSlider(Number(e.target.value)) })} className="flex-1" />
          <input
            type="number"
            min={0.031}
            max={2000}
            step={0.1}
            value={Math.round(ms * 100) / 100}
            disabled={locked.exposure}
            onChange={(e) => Number(e.target.value) > 0 && onChange({ ...values, exposureUs: Math.round(Math.min(CAMERA_LIMITS.exposureUs[1], Math.max(CAMERA_LIMITS.exposureUs[0], Number(e.target.value) * 1000))) })}
            className="w-20 rounded-md border border-line bg-white px-1.5 py-1 text-right font-mono text-xs"
          />
        </span>
      </label>
      <label className="block text-xs font-semibold">
        Gain{locked.gain && lockNote}
        <span className="mt-1 flex items-center gap-2">
          <input type="range" min={1} max={16} step={0.01} value={values.gain} disabled={locked.gain} onChange={(e) => onChange({ ...values, gain: Number(e.target.value) })} className="flex-1" />
          <input
            type="number"
            min={1}
            max={16}
            step={0.1}
            value={values.gain}
            disabled={locked.gain}
            onChange={(e) => Number(e.target.value) >= 1 && onChange({ ...values, gain: Math.min(16, Number(e.target.value)) })}
            className="w-20 rounded-md border border-line bg-white px-1.5 py-1 text-right font-mono text-xs"
          />
        </span>
      </label>
      <fieldset className="text-xs font-semibold">
        <legend>White balance{locked.whiteBalance && lockNote}</legend>
        <div className="mt-1 grid grid-cols-3 gap-1.5">
          {values.whiteBalance.map((v, i) => (
            <label key={i} className="block text-[11px] font-normal text-muted">
              {wbNames[i]}
              <input
                type="number"
                min={0.1}
                max={8}
                step={0.01}
                value={v}
                disabled={locked.whiteBalance}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!(n >= 0.1 && n <= 8)) return;
                  const wb = [...values.whiteBalance] as [number, number, number];
                  wb[i] = n;
                  onChange({ ...values, whiteBalance: wb });
                }}
                className="mt-0.5 w-full rounded-md border border-line bg-white px-1.5 py-1 text-right font-mono text-xs text-ink"
              />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-3 gap-1.5">
        <button type="button" className={`${small} h-auto min-h-9 px-1.5 py-1 text-xs leading-tight`} onClick={onAutoExposure} disabled={busy || locked.exposure} title={`Finds the exposure once (${autoWhere("exposure")})`}>
          {busy ? "…" : "Auto exposure"}
        </button>
        <button type="button" className={`${small} h-auto min-h-9 px-1.5 py-1 text-xs leading-tight`} onClick={onAutoWhiteBalance} disabled={busy || locked.whiteBalance} title={`Finds the white balance once (${autoWhere("whiteBalance")}); use a white card under white light`}>
          {busy ? "…" : "Auto white balance"}
        </button>
        <button type="button" className={`${small} h-auto min-h-9 px-1.5 py-1 text-xs leading-tight`} onClick={onReset}>
          Reset
        </button>
      </div>
      {live ? (
        <p className="text-[11px] text-muted">{legacy ? "This NxGen service reopens the live image for each change; update NxGen for changes without reconnecting." : "Changes apply to the live image at once."}</p>
      ) : (
        <p className="text-[11px] text-muted">Start the live view to see the effect of the settings.</p>
      )}
      <button type="button" className="text-xs font-semibold text-brand hover:underline" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {advanced ? "Hide advanced" : "Advanced…"}
      </button>
      {advanced && (
        <div className="space-y-2 border-t border-line pt-2">
          <label className="block text-xs font-semibold">
            Digital gain {caps && !caps.digitalGain && <span className="font-normal text-muted">· not on this camera</span>}
            <input
              type="number"
              min={caps?.digitalGain?.[0] ?? 1}
              max={caps?.digitalGain?.[1] ?? 8}
              step={0.1}
              value={parameters.digitalGain ?? ""}
              placeholder="1"
              disabled={!!caps && !caps.digitalGain}
              onChange={(e) => onParameters({ ...parameters, digitalGain: e.target.value === "" ? undefined : Number(e.target.value) })}
              className="mt-1 w-full rounded-md border border-line bg-white px-1.5 py-1 font-mono text-xs"
            />
          </label>
          <div className="text-xs font-semibold">
            Black level {caps && !caps.blackLevel && <span className="font-normal text-muted">· not on this camera</span>}
            <div className="mt-1 flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] font-normal">
                <input type="checkbox" checked={(parameters.blackLevelAuto ?? "Continuous") === "Continuous"} disabled={!!caps && !caps.blackLevelAuto} onChange={(e) => onParameters({ ...parameters, blackLevelAuto: e.target.checked ? "Continuous" : "Off", ...(e.target.checked ? { blackLevel: undefined } : {}) })} />
                Automatic
              </label>
              <input
                type="number"
                min={caps?.blackLevel?.[0] ?? 0}
                max={caps?.blackLevel?.[1] ?? 4095}
                step={1}
                value={parameters.blackLevel ?? ""}
                placeholder="0"
                disabled={(parameters.blackLevelAuto ?? "Continuous") === "Continuous" || (!!caps && !caps.blackLevel)}
                onChange={(e) => onParameters({ ...parameters, blackLevel: e.target.value === "" ? undefined : Number(e.target.value) })}
                className="w-24 rounded-md border border-line bg-white px-1.5 py-1 font-mono text-xs"
              />
            </div>
          </div>
          <label className="block text-xs font-semibold">
            Frame rate limit (fps) {caps && !caps.frameRate && <span className="font-normal text-muted">· not on this camera</span>}
            <input
              type="number"
              min={caps?.frameRate?.[0] ?? 0.1}
              max={caps?.frameRate?.[1] ?? 60}
              step={0.1}
              value={parameters.frameRate ?? ""}
              placeholder="camera maximum"
              disabled={!!caps && !caps.frameRate}
              onChange={(e) => onParameters({ ...parameters, frameRate: e.target.value === "" ? undefined : Number(e.target.value) })}
              className="mt-1 w-full rounded-md border border-line bg-white px-1.5 py-1 font-mono text-xs"
            />
          </label>
          <p className="text-[11px] text-muted">The exposure always caps the frame rate. Defaults for these live under Camera settings.</p>
        </div>
      )}
    </div>
  );
}

const fmtExposure = (us: number) => (us >= 1_000_000 ? `${fmt(us / 1e6, 2)} s` : us >= 1000 ? `${fmt(us / 1000, us >= 10_000 ? 0 : 1)} ms` : `${Math.round(us)} µs`);

/**
 * The camera's live image, streamed by the server (GET /api/cameras/<serial>/preview), with the
 * plate guide: the plate should sit inside the dashed frame with its bottom (baseline) towards the
 * red edge. Removing the component closes the stream, which stops the preview on the server.
 */
function LivePreview({
  serial,
  simulated,
  exposureUs,
  gain,
  whiteBalance,
  illumination,
  imgRef,
  onOpen,
  onClose,
  reopenKey = 0,
}: {
  serial: string;
  simulated: boolean;
  exposureUs: number;
  gain: number;
  whiteBalance: [number, number, number];
  illumination: Illumination;
  /** Receives the <img> showing the stream, for Auto exposure / Auto white balance. */
  imgRef?: React.MutableRefObject<HTMLImageElement | null>;
  /** The stream is open (or reconnected): later setting changes go through PUT …/preview, not a new stream. */
  onOpen?: (serial: string) => void;
  onClose?: () => void;
  /** Bumped to reopen the stream with the current settings (services without in-place changes). */
  reopenKey?: number;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The stream URL carries the settings of the moment it opens; it is not rebuilt when they change.
  const latest = useRef({ exposureUs, gain, whiteBalance });
  latest.current = { exposureUs, gain, whiteBalance };
  const src = useMemo(() => {
    const s = latest.current;
    return `/api/cameras/${encodeURIComponent(serial)}/preview?exposureUs=${s.exposureUs}&gain=${s.gain}&wb=${s.whiteBalance.join(",")}&n=${attempt}-${reopenKey}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, attempt, reopenKey]);
  useEffect(() => {
    onOpen?.(serial);
    return () => onClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  /** An <img> cannot read an error answer: ask the server once more, without keeping the stream. */
  const onFailed = () => {
    setFailed(true);
    setReason(null);
    const ctrl = new AbortController();
    fetch(`${src}&probe=1`, { credentials: "include", signal: ctrl.signal })
      .then(async (res) => {
        if (res.ok) {
          ctrl.abort(); // it streams now: the earlier break was momentary
          setReason("The stream was interrupted. Reconnect to continue.");
        } else {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          setReason(body?.message ?? `The server answered ${res.status}.`);
        }
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    const img = ref.current;
    return () => {
      // Drop the connection now rather than when the image is garbage collected.
      if (img) img.src = "";
    };
  }, [src]);
  return (
    <div className="flex h-full min-h-[18rem] items-center justify-center lg:absolute lg:inset-0">
      <div className="relative">
        {!failed ? (
          <img
            ref={(el) => {
              ref.current = el;
              if (imgRef) imgRef.current = el;
            }}
            src={src} alt="Live camera image" className="block h-auto w-full max-w-full lg:h-[calc(100vh-11rem)] lg:w-auto" onError={onFailed} />
        ) : (
          <div className="p-8 text-center text-sm text-white/80">
            The live image stopped.
            <button type="button" className="ml-2 font-semibold text-white underline" onClick={() => (setFailed(false), setReason(null), setAttempt(attempt + 1))}>
              Reconnect
            </button>
            {reason && <span className="mt-3 block max-w-xl text-xs text-red-200">{reason}</span>}
          </div>
        )}
        {!failed && (
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <rect x={10} y={8} width={80} height={84} fill="none" stroke="#FFC107" strokeWidth={0.5} strokeDasharray="2 1.5" vectorEffect="non-scaling-stroke" />
            <line x1={10} x2={90} y1={92} y2={92} stroke="#e0344c" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
      <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1 text-xs font-bold tracking-wide text-white">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> LIVE · {simulated ? "SIMULATED CAMERA" : serial} · {ILLUMINATION_LABEL[illumination]}
      </span>
      <span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 text-[11px] text-white">Place the plate inside the dashed frame, sample line (bottom) towards the red edge.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Crop — plate outline and straightening
// ---------------------------------------------------------------------------

/**
 * The tablet's PlateSize.matching: the photo only shows proportions, so keep the previous size if
 * it fits (plates are usually photographed in a row), else the first preset that fits within
 * ±12 %, else a custom size with the outline's proportions and the previous height.
 */
function matchingSize(aspect: number, previous: { widthMm: number; heightMm: number }): { widthMm: number; heightMm: number } {
  const fits = (s: { widthMm: number; heightMm: number }) => s.widthMm > 0 && s.heightMm > 0 && Math.abs(s.widthMm / s.heightMm / aspect - 1) <= 0.12;
  if (fits(previous)) return previous;
  const preset = PLATE_PRESETS.find(fits);
  if (preset) return { widthMm: preset.widthMm, heightMm: preset.heightMm };
  const heightMm = previous.heightMm > 0 ? previous.heightMm : 100;
  return { widthMm: Math.round(aspect * heightMm), heightMm };
}

export function CropStage({
  analysisId,
  image,
  plate,
  overrideReason,
  editable,
  onStraightened,
}: {
  analysisId: string;
  image: ImageMeta;
  plate: PlateMeta | null;
  overrideReason: string;
  editable: boolean;
  onStraightened: (message: string) => Promise<void>;
}) {
  const sameImage = plate?.imageId === image.id;
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [corners, setCorners] = useState<Point[] | null>(sameImage && plate ? plate.corners : null);
  const [source, setSource] = useState<"AUTO" | "MANUAL">(sameImage && plate ? plate.outlineSource : "MANUAL");
  const [chosen, setChosen] = useState(!!(sameImage && plate));
  const [widthMm, setWidthMm] = useState(String(plate?.widthMm ?? 50));
  const [heightMm, setHeightMm] = useState(String(plate?.heightMm ?? 100));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);

  const whole = useCallback((w: number, h: number): Point[] => [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }], []);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setSize({ w: img.naturalWidth, h: img.naturalHeight });
      if (!(sameImage && plate)) {
        // Start from the outline the quality gate found, as the tablet does.
        if (image.qc?.outline) {
          setCorners(image.qc.outline);
          setSource("AUTO");
          const s = matchingSize(quadAspect(quadFrom(image.qc.outline)), { widthMm: Number(widthMm), heightMm: Number(heightMm) });
          setWidthMm(String(s.widthMm));
          setHeightMm(String(s.heightMm));
        } else {
          setCorners(whole(img.naturalWidth, img.naturalHeight));
          setSource("MANUAL");
        }
      }
    };
    img.src = `/api/modules/tlc/api/images/${image.id}`;
  }, [image, sameImage, plate, whole]);

  async function autoDetect() {
    setBusy("Finding the plate…");
    setError(null);
    try {
      const r = await mod<{ outline: { corners: Point[]; preset: { label: string; widthMm: number; heightMm: number } | null } | null }>(`/analyses/${analysisId}/outline?imageId=${image.id}`);
      if (!r.outline) {
        setError("No clean plate outline was found; drag the four corners onto the plate corners.");
        return;
      }
      setCorners(r.outline.corners);
      setSource("AUTO");
      if (!chosen) {
        const s = matchingSize(quadAspect(quadFrom(r.outline.corners)), { widthMm: Number(widthMm), heightMm: Number(heightMm) });
        setWidthMm(String(s.widthMm));
        setHeightMm(String(s.heightMm));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const rotate = (dir: 1 | -1) => {
    if (!corners) return;
    setCorners(dir === 1 ? [corners[3], corners[0], corners[1], corners[2]] : [corners[1], corners[2], corners[3], corners[0]]);
    setSource("MANUAL");
  };
  async function straighten() {
    if (!corners) return;
    setBusy("Straightening…");
    setError(null);
    try {
      await mod(`/analyses/${analysisId}/plate`, send({ imageId: image.id, corners, widthMm: Number(widthMm), heightMm: Number(heightMm), outlineSource: source, qcOverrideReason: overrideReason }));
      await onStraightened("Plate straightened to its real size. Lay out the baseline, front and tracks.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current === null || !svgRef.current || !corners || !size) return;
    const p = svgPoint(svgRef.current, e);
    setCorners(corners.map((c, j) => (j === drag.current ? { x: clamp(Math.round(p.x), 0, size.w - 1), y: clamp(Math.round(p.y), 0, size.h - 1) } : c)));
    setSource("MANUAL");
  };

  const aspect = corners ? quadAspect(quadFrom(corners)) : null;
  const nominal = Number(widthMm) / Number(heightMm);
  const aspectOff = aspect !== null && Number.isFinite(nominal) && Math.abs(aspect / nominal - 1) > 0.2;
  const preset = PLATE_PRESETS.find((p) => String(p.widthMm) === widthMm && String(p.heightMm) === heightMm) ?? null;
  const stroke = size ? Math.max(2, size.w / 400) : 2;

  return (
    <div className={STAGE_GRID}>
      <div className="flex min-h-[18rem] overflow-hidden rounded-2xl border border-line bg-backdrop p-2 lg:min-h-0">
        {/* The outline layer covers exactly the image's own box, so a corner sits on the pixel it names. */}
        <FitBox width={size?.w ?? 3} height={size?.h ?? 4} className="flex-1 lg:h-full">
          <img src={`/api/modules/tlc/api/images/${image.id}`} alt="" className="block h-full w-full" draggable={false} />
        {size && corners && (
          <svg ref={svgRef} viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full touch-none" onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)} aria-label="Plate outline; drag the corners">
            <polygon points={corners.map((c) => `${c.x},${c.y}`).join(" ")} fill="rgb(255 193 7 / 0.12)" stroke="#FFC107" strokeWidth={stroke} />
            <line x1={corners[3].x} y1={corners[3].y} x2={corners[2].x} y2={corners[2].y} stroke="#e0344c" strokeWidth={stroke * 2.5} />
            {corners.map((c, i) => (
              <g key={i}>
                <circle cx={c.x} cy={c.y} r={Math.max(14, size.w / 50)} fill="rgb(255 193 7 / 0.25)" />
                <circle cx={c.x} cy={c.y} r={Math.max(9, size.w / 80)} fill="#FFC107" stroke="#fff" strokeWidth={stroke} className={editable ? "cursor-move" : ""} onPointerDown={(e) => editable && ((drag.current = i), (e.target as Element).setPointerCapture(e.pointerId))} />
              </g>
            ))}
          </svg>
        )}
        </FitBox>
      </div>

      <aside className={`${card} ${SIDE_PANEL} space-y-4 pb-0`}>
        <div>
          <h3 className={panelTitle}>Plate outline</h3>
          <p className="text-sm text-muted">{source === "AUTO" ? "Plate found automatically. Drag a corner to adjust." : "Drag the four corners onto the plate corners."} The red edge is the bottom, where the samples were applied.</p>
        </div>
        {editable && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={secondary} onClick={() => rotate(-1)} disabled={!corners}>
                Rotate left
              </button>
              <button type="button" className={secondary} onClick={() => rotate(1)} disabled={!corners}>
                Rotate right
              </button>
              <button type="button" className={secondary} onClick={() => void autoDetect()} disabled={!!busy}>
                Auto-detect
              </button>
              <button type="button" className={secondary} onClick={() => size && (setCorners(whole(size.w, size.h)), setSource("MANUAL"))} disabled={!size}>
                Whole image
              </button>
            </div>
            <div>
              <p className="text-sm font-semibold">Plate size (width × height)</p>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {PLATE_PRESETS.map((p) => (
                  <button key={p.label} type="button" className={optionBox(preset?.label === p.label)} onClick={() => (setWidthMm(String(p.widthMm)), setHeightMm(String(p.heightMm)), setChosen(true))}>
                    {p.label}
                  </button>
                ))}
              </div>
              {!chosen && <p className="mt-1 text-xs text-muted">Chosen from the outline’s shape. Tap the real size if it differs.</p>}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-sm font-semibold">
                  Width mm
                  <input inputMode="decimal" value={widthMm} onChange={(e) => (setWidthMm(e.target.value), setChosen(true))} className={`${field} font-mono`} />
                </label>
                <label className="text-sm font-semibold">
                  Height mm
                  <input inputMode="decimal" value={heightMm} onChange={(e) => (setHeightMm(e.target.value), setChosen(true))} className={`${field} font-mono`} />
                </label>
              </div>
              {!preset && <p className="mt-1 text-xs text-muted">Custom size.</p>}
            </div>
            {aspectOff && aspect && (
              <Callout tone="warn">
                The outline is {aspect.toFixed(2)} wide per unit of height, but a {widthMm} × {heightMm} mm plate is {nominal.toFixed(2)}.{" "}
                <button type="button" className="font-semibold text-brand underline" onClick={() => (setWidthMm(String(Math.round(aspect * Number(heightMm)))), setChosen(true))}>
                  Set width from outline (height {Math.round(Number(heightMm))} mm)
                </button>
              </Callout>
            )}
          </>
        )}
        <p className="text-sm">
          <span className="text-muted">Illumination</span> {ILLUMINATION_LABEL[image.illumination]}
          {image.qc && (
            <>
              {" "}
              · <span className="text-muted">QC</span> {VERDICT[image.qc.verdict].label}
              {overrideReason && <span className="text-warn"> · override</span>}
            </>
          )}
        </p>
        {error && <Callout tone="fail">{error}</Callout>}
        <div className={PINNED_ACTION}>
          {editable ? (
            <button className={`${primary} w-full`} onClick={() => void straighten()} disabled={!!busy || !corners}>
              {busy ?? "Straighten plate & continue"}
            </button>
          ) : (
            plate && <p className="text-sm text-muted">Straightened by {plate.createdBy} · {fmtDate(plate.createdAt)}</p>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared workbench state for the Plate and Evaluation stages
// ---------------------------------------------------------------------------

export interface Layout {
  baselineMm: number;
  solventFrontMm: number;
  trackWidthMm: number;
  baselineSource: "DETECTED" | "MANUAL";
  frontSource: "DETECTED" | "MANUAL";
}
export type EvalTrack = EvaluationInput["tracks"][number];
export interface ImageSettings {
  channel: Channel;
  postProcessing: PostProcessing;
}
export interface Workbench {
  plate: PlateMeta;
  rgb: RgbImage | null;
  gray: ReturnType<RgbImage["channel"]> | null;
  geometry: PlateGeometry;
  layout: Layout;
  tracks: EvalTrack[];
  image: ImageSettings;
  settings: { densitometry: DensitometrySettings; spotDetector: SpotDetectorSettings };
  manualSpots: Record<string, PeakWindow[]>;
  selected: number | null;
  previews: TrackPreview[];
  preview: Evaluation | null;
  saturation: number;
  layoutOk: boolean;
  detected: string | null;
  setLayout: (l: Layout) => void;
  setTracks: (t: EvalTrack[]) => void;
  setImage: (i: ImageSettings) => void;
  setSettings: (s: Workbench["settings"]) => void;
  setManualSpots: (m: Record<string, PeakWindow[]>) => void;
  setSelected: (id: number | null) => void;
  autoDetect: () => void;
  detectLines: () => void;
  detectTracks: () => void;
}
export interface TrackPreview {
  track: EvalTrack;
  raw: Profile;
  processed: Profile;
  spots: DetectedSpot[];
  noise: number;
  manual: boolean;
}

const assignCompound = (rf: number, windows: RfWindow[]): string => windows.find((w) => rf >= w.min && rf <= w.max)?.compound ?? "";

export function useWorkbench(plate: PlateMeta, windows: RfWindow[], current: EvaluationFull | null, editable: boolean): Workbench {
  const [rgb, setRgb] = useState<RgbImage | null>(null);
  const [layout, setLayout] = useState<Layout>(() => (current ? current.input.layout : { ...DEFAULT_DEVELOPMENT, baselineSource: "MANUAL", frontSource: "MANUAL" }));
  const [tracks, setTracks] = useState<EvalTrack[]>(current?.input.tracks ?? []);
  const [image, setImage] = useState<ImageSettings>(current?.input.image ?? { channel: plate.channel, postProcessing: plate.postProcessing });
  // New work starts as the tablet's session does (SessionState: subtractBackground = true), i.e.
  // Baseline "Auto": background removed and each peak measured above its chord.
  const [settings, setSettings] = useState<Workbench["settings"]>(current?.input.settings ?? { densitometry: { ...DEFAULT_DENSITOMETRY, subtractBackground: true }, spotDetector: DEFAULT_SPOT_DETECTOR });
  const [manualSpots, setManualSpots] = useState<Record<string, PeakWindow[]>>(current?.input.manualSpots ?? {});
  const [selected, setSelected] = useState<number | null>(null);
  const [detected, setDetected] = useState<string | null>(null);

  useEffect(() => {
    loadPixels(`/api/modules/tlc/api/plates/${plate.id}/image`)
      .then(setRgb)
      .catch(() => setRgb(null));
  }, [plate.id]);

  const gray = useMemo(() => (rgb ? ImageOps.apply(rgb, image.postProcessing).channel(image.channel) : null), [rgb, image]);
  const geometry = useMemo(() => new PlateGeometry(plate.widthPx, plate.heightPx, plate.widthMm, plate.heightMm), [plate]);
  const polarity = polarityOf(plate.illumination);
  const dev = { baselineMm: layout.baselineMm, solventFrontMm: layout.solventFrontMm, trackWidthMm: layout.trackWidthMm };
  const layoutOk = layout.solventFrontMm - layout.baselineMm >= 5 && layout.trackWidthMm >= 1;

  const detectLines = useCallback(() => {
    if (!gray) return;
    const l = LayoutDetector.findLines(gray, geometry);
    setLayout((x) => ({
      ...x,
      baselineMm: l.baselineMm === null ? x.baselineMm : Math.round(l.baselineMm * 100) / 100,
      solventFrontMm: l.frontMm === null ? x.solventFrontMm : Math.round(l.frontMm * 100) / 100,
      baselineSource: l.baselineMm === null ? x.baselineSource : "DETECTED",
      frontSource: l.frontMm === null ? x.frontSource : "DETECTED",
    }));
    setDetected(`baseline ${l.baselineMm === null ? "not found (kept)" : "found"} · front ${l.frontMm === null ? "not found (kept)" : "found"}`);
  }, [gray, geometry]);

  const detectTracks = useCallback(() => {
    if (!gray) return;
    const l = LayoutDetector.detect(gray, geometry, { ...DEFAULT_DEVELOPMENT, baselineMm: layout.baselineMm, solventFrontMm: layout.solventFrontMm });
    setLayout((x) => ({ ...x, trackWidthMm: l.development.trackWidthMm }));
    setTracks(
      l.trackCentersMm.map((c, i) => ({
        id: i + 1,
        name: `T${i + 1}`,
        role: "SAMPLE" as TrackRole,
        centerMm: Math.round(c * 100) / 100,
        sampleVolumeUl: null,
        concentration: null,
        dilutionFactor: null,
        sampleId: "",
        source: "DETECTED",
      })),
    );
    setManualSpots({});
    setSelected(null);
    setDetected(`${l.trackCentersMm.length} track${l.trackCentersMm.length === 1 ? "" : "s"} found · track width ${l.development.trackWidthMm} mm`);
  }, [gray, geometry, layout.baselineMm, layout.solventFrontMm]);

  const autoDetect = useCallback(() => {
    if (!gray) return;
    const l = LayoutDetector.detect(gray, geometry, DEFAULT_DEVELOPMENT);
    setLayout({
      baselineMm: Math.round(l.development.baselineMm * 100) / 100,
      solventFrontMm: Math.round(l.development.solventFrontMm * 100) / 100,
      trackWidthMm: l.development.trackWidthMm,
      baselineSource: l.baselineFound ? "DETECTED" : "MANUAL",
      frontSource: l.frontFound ? "DETECTED" : "MANUAL",
    });
    setTracks(
      l.trackCentersMm.map((c, i) => ({ id: i + 1, name: `T${i + 1}`, role: "SAMPLE" as TrackRole, centerMm: Math.round(c * 100) / 100, sampleVolumeUl: null, concentration: null, dilutionFactor: null, sampleId: "", source: "DETECTED" })),
    );
    setManualSpots({});
    setSelected(null);
    setDetected(`${l.trackCentersMm.length} track${l.trackCentersMm.length === 1 ? "" : "s"} found · baseline ${l.baselineFound ? "found" : "not found (default used)"} · front ${l.frontFound ? "found" : "not found (default used)"}`);
  }, [gray, geometry]);

  const seeded = useRef(false);
  useEffect(() => {
    if (gray && !current && tracks.length === 0 && editable && !seeded.current) {
      seeded.current = true;
      autoDetect();
    }
  }, [gray, current, tracks.length, editable, autoDetect]);

  // The profiles of a track (≈0.4 s each on a full-size plate) depend only on the image, the
  // track's position, the development and the settings, so they are kept per track and reused:
  // editing one track's peaks, renaming a track or selecting one no longer recomputes all of them.
  const profileCache = useRef<{ gray: GrayImage | null; entries: Map<string, { dp: ReturnType<typeof SpotDetector.detectionProfile>; processed: Profile; raw: Profile }> }>({ gray: null, entries: new Map() });
  const previews: TrackPreview[] = useMemo(() => {
    if (!gray || !layoutOk) return [];
    const cache = profileCache.current;
    if (cache.gray !== gray) {
      cache.gray = gray;
      cache.entries.clear();
    }
    const used = new Set<string>();
    const result = tracks.map((t) => {
      const track = { id: t.id, name: t.name, centerMm: t.centerMm };
      try {
        const key = JSON.stringify([t.id, t.centerMm, dev, polarity, settings.densitometry, settings.spotDetector]);
        used.add(key);
        let base = cache.entries.get(key);
        if (!base) {
          base = {
            dp: SpotDetector.detectionProfile(gray, geometry, track, dev, polarity, settings.densitometry.aggregation, settings.spotDetector),
            processed: Densitometry.profile(gray, geometry, track, dev, polarity, settings.densitometry),
            raw: Densitometry.profile(gray, geometry, track, dev, polarity, { ...settings.densitometry, smoothing: false, subtractBackground: false }),
          };
          cache.entries.set(key, base);
        }
        const { dp, processed, raw } = base;
        const manual = manualSpots[String(t.id)];
        const spots = manual ? SpotDetector.measure(dp, t.id, manual) : SpotDetector.detectOn(dp, t.id, settings.spotDetector);
        return { track: t, raw, processed, spots, noise: dp.noise, manual: !!manual };
      } catch {
        const empty = new Profile([0, 100], [0, 0], 1);
        return { track: t, raw: empty, processed: empty, spots: [], noise: 0, manual: false };
      }
    });
    // Forget tracks that are gone or have moved (keeps memory bounded while dragging).
    for (const k of [...cache.entries.keys()]) if (!used.has(k)) cache.entries.delete(k);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gray, geometry, layout, tracks, settings, manualSpots, polarity]);

  const preview = useMemo(() => {
    if (!previews.length) return null;
    return evaluateRf(
      layout.solventFrontMm,
      previews.map((p) => ({
        label: p.track.name,
        role: p.track.role,
        spots: p.spots.map((s) => {
          const rf = Math.round((s.peak.maxHrf / 100) * 1000) / 1000;
          return { rf, compound: assignCompound(rf, windows), distanceMm: null };
        }),
      })),
      windows,
    );
  }, [previews, layout.solventFrontMm, windows]);
  const saturation = useMemo(
    () => (rgb && layoutOk && tracks.length ? CaptureQc.analyticalSaturation(rgb, geometry, dev, tracks.map((t) => ({ id: t.id, name: t.name, centerMm: t.centerMm }))) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rgb, geometry, layout, tracks],
  );

  return { plate, rgb, gray, geometry, layout, tracks, image, settings, manualSpots, selected, previews, preview, saturation, layoutOk, detected, setLayout, setTracks, setImage, setSettings, setManualSpots, setSelected, autoDetect, detectLines, detectTracks };
}

// ---------------------------------------------------------------------------
// 3. Plate — image, processing, development, spots, tracks
// ---------------------------------------------------------------------------

type PlateTool = "SELECT" | "ADD_TRACK" | "ADD_SPOT";

/** The tablet's CardSection: bold teal title with a chevron, a divider under the header while open. */
function Section({ title, open: initial = true, children }: { title: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={initial} className="section border-t border-line first:border-t-0">
      <summary className="cursor-pointer py-3 text-[18px] font-semibold text-navy">{title}</summary>
      <div className="space-y-3 border-t border-line pt-3 pb-3.5">{children}</div>
    </details>
  );
}

function Stepper({ label, value, step, min, max, unit, onChange, disabled }: { label: string; value: number; step: number; min: number; max: number; unit?: string; onChange: (v: number) => void; disabled?: boolean }) {
  const set = (v: number) => onChange(clamp(Math.round(v * 100) / 100, min, max));
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="font-semibold">{label}</span>
      <span className="flex items-center gap-1">
        <button type="button" className={small} aria-label={`${label} minus`} onClick={() => set(value - step)} disabled={disabled}>
          −
        </button>
        <input inputMode="decimal" aria-label={label} value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} className="w-16 rounded-lg border border-line px-2 py-1 text-center font-mono" />
        <button type="button" className={small} aria-label={`${label} plus`} onClick={() => set(value + step)} disabled={disabled}>
          +
        </button>
        {unit && <span className="min-w-6 text-xs text-muted">{unit}</span>}
      </span>
    </label>
  );
}

export interface PlateInfo {
  plateType: string;
  plateLot: string;
  stationaryPhase: string;
  mobilePhase: string;
  staining: string;
  remarks: string;
}

/** The tablet's "Plate info" section: plate type, stationary phase, mobile phase, staining, notes. */
function PlateInfoSection({ info, editable, onSave }: { info: PlateInfo; editable: boolean; onSave: (patch: Record<string, string>) => Promise<void> }) {
  const [f, setF] = useState<PlateInfo>(info);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setF(info), [info]);
  const dirty = (Object.keys(f) as (keyof PlateInfo)[]).some((k) => f[k] !== info[k]);
  const fieldClass = "mt-0.5 w-full rounded-[10px] border border-outline bg-white px-2.5 py-1.5 text-sm disabled:bg-canvas disabled:text-muted";
  const rows: [keyof PlateInfo, string, string][] = [
    ["plateType", "Plate type", "e.g. Silica gel 60 F254 (glass)"],
    ["plateLot", "Plate lot", "e.g. HX38412"],
    ["stationaryPhase", "Stationary phase", "e.g. Silica gel 60"],
    ["mobilePhase", "Mobile phase / solvent", "e.g. Toluene : ethyl acetate (9:1)"],
    ["staining", "Staining / derivatization", "e.g. Anisaldehyde, 105 °C"],
  ];
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, string> = {};
      for (const k of Object.keys(f) as (keyof PlateInfo)[]) if (f[k] !== info[k]) patch[k] = f[k];
      await onSave(patch);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Plate info" open={false}>
      {rows.map(([k, label, placeholder]) => (
        <label key={k} className="block text-xs font-semibold">
          {label}
          <input value={f[k]} disabled={!editable} placeholder={placeholder} onChange={(e) => setF({ ...f, [k]: e.target.value })} className={fieldClass} />
        </label>
      ))}
      <label className="block text-xs font-semibold">
        Notes
        <textarea rows={2} value={f.remarks} disabled={!editable} onChange={(e) => setF({ ...f, remarks: e.target.value })} className={fieldClass} />
      </label>
      {error && <Callout tone="fail">{error}</Callout>}
      {editable && (
        <button type="button" className={`${secondary} w-full`} disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "Saving…" : dirty ? "Save plate info" : "Saved"}
        </button>
      )}
    </Section>
  );
}

export function PlateStage({
  wb,
  analysis,
  editable,
  onContinue,
  onDetails,
}: {
  wb: Workbench;
  analysis: PlateInfo;
  editable: boolean;
  onContinue: () => void;
  onDetails: (patch: Record<string, string>) => Promise<void>;
}) {
  const { plate, geometry, layout, tracks, image, settings, selected, previews } = wb;
  // The colour photo by default; Analytical shows the grey image the calculations use.
  const [view, setView] = useState<"RAW" | "ANALYTICAL">("RAW");
  const [showTracks, setShowTracks] = useState(true);
  const [showScale, setShowScale] = useState(false);
  const [showSpots, setShowSpots] = useState(true);
  const [tool, setTool] = useState<PlateTool>("SELECT");
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "baseline" | "front" | "track"; id?: number } | null>(null);

  const setTrack = (id: number, patch: Partial<EvalTrack>) => wb.setTracks(tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const addTrackAt = (xMm: number) => {
    const id = tracks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    wb.setTracks([...tracks, { id, name: `T${id}`, role: "SAMPLE", centerMm: Math.round(clamp(xMm, 0, plate.widthMm) * 10) / 10, sampleVolumeUl: null, concentration: null, dilutionFactor: null, sampleId: "", source: "MANUAL" }]);
    wb.setSelected(id);
    setTool("SELECT");
  };
  const removeTrack = (id: number) => {
    wb.setTracks(tracks.filter((t) => t.id !== id));
    const { [String(id)]: _, ...rest } = wb.manualSpots;
    wb.setManualSpots(rest);
    if (selected === id) wb.setSelected(null);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svgRef.current || !editable) return;
    const p = svgPoint(svgRef.current, e);
    const yMm = Math.round(geometry.yPxToMm(p.y) * 10) / 10;
    const xMm = Math.round(geometry.xPxToMm(p.x) * 10) / 10;
    if (drag.current.kind === "baseline") wb.setLayout({ ...layout, baselineMm: clamp(yMm, 0, layout.solventFrontMm - 5), baselineSource: "MANUAL" });
    else if (drag.current.kind === "front") wb.setLayout({ ...layout, solventFrontMm: clamp(yMm, layout.baselineMm + 5, plate.heightMm), frontSource: "MANUAL" });
    else setTrack(drag.current.id!, { centerMm: clamp(xMm, 0, plate.widthMm), source: "MANUAL" });
  };
  const startDrag = (kind: "baseline" | "front" | "track", id?: number) => (e: React.PointerEvent) => {
    if (!editable || tool !== "SELECT") return;
    e.stopPropagation();
    drag.current = { kind, id };
    if (kind === "track") wb.setSelected(id!);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPlateClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!editable || !svgRef.current) return;
    const p = svgPoint(svgRef.current, e);
    if (tool === "ADD_TRACK") addTrackAt(geometry.xPxToMm(p.x));
    else if (tool === "ADD_SPOT") {
      const xMm = geometry.xPxToMm(p.x);
      const lane = previews.find((pv) => Math.abs(pv.track.centerMm - xMm) <= layout.trackWidthMm / 2);
      if (!lane) return;
      const hRf = ((geometry.yPxToMm(p.y) - layout.baselineMm) / (layout.solventFrontMm - layout.baselineMm)) * 100;
      const w = PeakLocator.windowAround(lane.processed, hRf);
      wb.setManualSpots({ ...wb.manualSpots, [String(lane.track.id)]: [...lane.spots.map((s) => s.window), { startHrf: Math.round(w.startHrf * 10) / 10, endHrf: Math.round(w.endHrf * 10) / 10 }] });
      wb.setSelected(lane.track.id);
    }
  };

  const pp = image.postProcessing;
  const stroke = Math.max(1.5, plate.widthPx / 500);
  const fontSize = Math.max(11, plate.widthPx / 45);
  const hint = tool === "ADD_TRACK" ? "Add Track: tap the plate where the new track goes." : tool === "ADD_SPOT" ? "Add Spot: tap a lane where the spot is." : "Select: drag the baseline, the front or a track.";
  const totalSpots = previews.reduce((n, p) => n + p.spots.length, 0);
  const viewUrl = view === "RAW" ? `/api/modules/tlc/api/plates/${plate.id}/image` : `/api/modules/tlc/api/plates/${plate.id}/image?view=analytical&channel=${image.channel}&black=${pp.blackPoint}&white=${pp.whitePoint}&denoise=${pp.denoise ? 1 : 0}`;

  return (
    <div className={STAGE_GRID}>
      <div className={`${card} flex flex-col gap-3 lg:min-h-0`}>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showTracks} onChange={(e) => setShowTracks(e.target.checked)} /> Show tracks
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showScale} onChange={(e) => setShowScale(e.target.checked)} /> mm scale
          </label>
          <a className="ml-auto font-semibold text-brand hover:underline" href={viewUrl} download={`plate-${view.toLowerCase()}.png`}>
            Download image
          </a>
        </div>
        {wb.saturation > 0.001 && (
          <Callout tone={wb.saturation > 0.01 ? "fail" : "warn"}>
            {(wb.saturation * 100).toFixed(2)} % of the pixels inside the tracks are saturated{wb.saturation > 0.01 ? "; heights and areas there are wrong and the evaluation cannot conclude." : "."}
          </Callout>
        )}
        <div className="flex gap-3 lg:min-h-0 lg:flex-1">
          {editable && (
            <div className="flex w-24 shrink-0 flex-col gap-1.5">
              {(
                [
                  ["SELECT", "Select"],
                  ["ADD_TRACK", "Add Track"],
                  ["ADD_SPOT", "Add Spot"],
                ] as [PlateTool, string][]
              ).map(([k, label]) => (
                <button key={k} type="button" className={toolToggle(tool === k)} onClick={() => setTool(k)}>
                  {label}
                </button>
              ))}
              <button type="button" className="rounded-lg border border-fail/40 px-2.5 py-1.5 text-sm font-semibold text-fail disabled:opacity-40" disabled={selected === null} onClick={() => selected !== null && removeTrack(selected)}>
                Delete
              </button>
            </div>
          )}
          <FitBox width={plate.widthPx} height={plate.heightPx} className="flex-1 lg:h-full">
            <img src={viewUrl} alt={`Straightened plate, ${view.toLowerCase()} view`} className="block h-full w-full bg-canvas" draggable={false} />
            <span className="absolute top-2 right-2 rounded-md bg-black/55 px-2 py-0.5 font-mono text-[11px] text-white">{view === "RAW" ? "RAW · original, straightened" : "ANALYTICAL · image used by the calculations"}</span>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${plate.widthPx} ${plate.heightPx}`}
              preserveAspectRatio="none"
              className={`absolute inset-0 h-full w-full touch-none ${tool !== "SELECT" ? "cursor-crosshair" : ""}`}
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
              onClick={onPlateClick}
              aria-label="Plate layout overlay"
            >
              {showScale &&
                Array.from({ length: Math.floor(plate.heightMm / 10) + 1 }, (_, i) => i * 10).map((mm) => (
                  <g key={mm}>
                    <line x1={0} x2={geometry.xMmToPx(2)} y1={geometry.yMmToPx(mm)} y2={geometry.yMmToPx(mm)} stroke="#fff" strokeWidth={stroke} />
                    <text x={geometry.xMmToPx(2.5)} y={geometry.yMmToPx(mm) + fontSize / 3} fontSize={fontSize * 0.8} fill="#fff" stroke="#000" strokeWidth={0.3}>
                      {mm}
                    </text>
                  </g>
                ))}
              {showTracks &&
                tracks.map((t) => {
                  const x = geometry.xMmToPx(t.centerMm - layout.trackWidthMm / 2);
                  const w = geometry.xMmToPx(layout.trackWidthMm);
                  const y1 = geometry.yMmToPx(layout.solventFrontMm);
                  const y0 = geometry.yMmToPx(layout.baselineMm);
                  const active = t.id === selected;
                  const color = t.role === "STANDARD" ? "#13965a" : "#2563eb";
                  return (
                    <g key={t.id} onPointerDown={startDrag("track", t.id)} className={editable && tool === "SELECT" ? "cursor-ew-resize" : ""}>
                      <rect x={x} y={y1} width={w} height={y0 - y1} fill={active ? "rgb(37 99 235 / 0.22)" : `${color}22`} stroke={active ? "#2563eb" : color} strokeWidth={stroke} strokeDasharray={active ? undefined : `${stroke * 3} ${stroke * 2}`} />
                      <text x={x + w / 2} y={y0 + fontSize * 1.3} textAnchor="middle" fontSize={fontSize} fontWeight={700} fill={color} pointerEvents="none">
                        {t.name}
                      </text>
                      {showSpots &&
                        previews
                          .find((p) => p.track.id === t.id)
                          ?.spots.map((s) => {
                            const ys = geometry.yMmToPx(layout.baselineMm + (s.window.startHrf / 100) * (layout.solventFrontMm - layout.baselineMm));
                            const ye = geometry.yMmToPx(layout.baselineMm + (s.window.endHrf / 100) * (layout.solventFrontMm - layout.baselineMm));
                            return <rect key={s.number} x={x} y={ye} width={w} height={ys - ye} fill="none" stroke="#e0344c" strokeWidth={stroke} pointerEvents="none" />;
                          })}
                    </g>
                  );
                })}
              {(["baseline", "front"] as const).map((k) => {
                const y = geometry.yMmToPx(k === "baseline" ? layout.baselineMm : layout.solventFrontMm);
                return (
                  <g key={k} onPointerDown={startDrag(k)} className={editable && tool === "SELECT" ? "cursor-ns-resize" : ""}>
                    <line x1={0} x2={plate.widthPx} y1={y} y2={y} stroke="#b45f06" strokeWidth={stroke * 1.5} />
                    <line x1={0} x2={plate.widthPx} y1={y} y2={y} stroke="transparent" strokeWidth={stroke * 8} />
                    <text x={fontSize / 2} y={y - fontSize / 3} fontSize={fontSize} fill="#b45f06" fontWeight={700} pointerEvents="none">
                      {k} {fmt(k === "baseline" ? layout.baselineMm : layout.solventFrontMm)} mm
                    </text>
                  </g>
                );
              })}
            </svg>
          </FitBox>
        </div>
        {editable && <p className="text-xs text-muted">{hint}</p>}
        {!wb.rgb && <p className="text-sm text-muted">Processing image…</p>}
      </div>

      <aside className={`${card} ${SIDE_PANEL} py-1`}>
        <Section title="Image">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">View</p>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <button type="button" className={optionBox(view === "RAW")} onClick={() => setView("RAW")}>
                Raw
              </button>
              <button type="button" className={optionBox(view === "ANALYTICAL")} onClick={() => setView("ANALYTICAL")}>
                Analytical
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">{view === "RAW" ? "Original photo, straightened." : "Image used by the calculations."}</p>
          </div>
          <p className="text-sm">
            Analysing {ILLUMINATION_LABEL[plate.illumination]} · {plate.widthMm} × {plate.heightMm} mm · {(plate.widthPx / plate.widthMm).toFixed(1)} px/mm
          </p>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Analysis channel</p>
            <div className="mt-1 grid grid-cols-4 gap-1.5">
              {(["INTENSITY", "RED", "GREEN", "BLUE"] as Channel[]).map((c) => (
                <button key={c} type="button" className={optionBox(image.channel === c, !editable)} disabled={!editable} onClick={() => wb.setImage({ ...image, channel: c })}>
                  {c === "INTENSITY" ? "Intensity" : c.charAt(0) + c.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>
        </Section>
        <Section title="Analytical processing" open={false}>
          <p className="text-sm">
            Contrast: black {pp.blackPoint} – white {pp.whitePoint}
          </p>
          <input type="range" aria-label="Black point" min={0} max={254} value={pp.blackPoint} disabled={!editable} onChange={(e) => wb.setImage({ ...image, postProcessing: { ...pp, blackPoint: Math.min(Number(e.target.value), pp.whitePoint - 1) } })} className="w-full" />
          <input type="range" aria-label="White point" min={1} max={255} value={pp.whitePoint} disabled={!editable} onChange={(e) => wb.setImage({ ...image, postProcessing: { ...pp, whitePoint: Math.max(Number(e.target.value), pp.blackPoint + 1) } })} className="w-full" />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pp.denoise} disabled={!editable} onChange={(e) => wb.setImage({ ...image, postProcessing: { ...pp, denoise: e.target.checked } })} /> Denoise (median 3×3)
            </label>
            {editable && (
              <button type="button" className={small} onClick={() => wb.setImage({ ...image, postProcessing: { blackPoint: 0, whitePoint: 255, denoise: false } })}>
                Reset
              </button>
            )}
          </div>
          <p className="text-xs text-muted">Analytical processing changes the measurements and is listed in the snapshot. See it with View → Analytical.</p>
        </Section>
        <PlateInfoSection
          info={{ plateType: analysis.plateType, plateLot: analysis.plateLot, stationaryPhase: analysis.stationaryPhase, mobilePhase: analysis.mobilePhase, staining: analysis.staining, remarks: analysis.remarks }}
          editable={editable}
          onSave={onDetails}
        />
        <Section title="Development">
          {editable && (
            <button type="button" className={`${secondary} w-full`} onClick={wb.detectLines} disabled={!wb.gray}>
              Detect baseline & front
            </button>
          )}
          <Stepper label="Baseline" value={layout.baselineMm} step={0.5} min={0} max={plate.heightMm} unit="mm" disabled={!editable} onChange={(v) => wb.setLayout({ ...layout, baselineMm: v, baselineSource: "MANUAL" })} />
          <Stepper label="Solvent front" value={layout.solventFrontMm} step={0.5} min={0} max={plate.heightMm} unit="mm" disabled={!editable} onChange={(v) => wb.setLayout({ ...layout, solventFrontMm: v, frontSource: "MANUAL" })} />
          <Stepper label="Track width" value={layout.trackWidthMm} step={0.5} min={1} max={60} unit="mm" disabled={!editable} onChange={(v) => wb.setLayout({ ...layout, trackWidthMm: v })} />
          {!wb.layoutOk && <p className="text-xs text-fail">The solvent front must be at least 5 mm above the baseline.</p>}
          {wb.detected && <p className="text-xs text-muted">{wb.detected}</p>}
        </Section>
        <Section title={`Spots (${totalSpots})`}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showSpots} onChange={(e) => setShowSpots(e.target.checked)} /> Show detected spots
          </label>
          <Stepper label="Sensitivity" value={settings.spotDetector.sensitivity} step={0.1} min={0.5} max={3} disabled={!editable} onChange={(v) => wb.setSettings({ ...settings, spotDetector: { ...settings.spotDetector, sensitivity: v } })} />
          {totalSpots === 0 ? (
            <p className="text-sm text-muted">No spots detected.</p>
          ) : (
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-left uppercase tracking-wide text-muted">
                  <tr>
                    <th>Track</th>
                    <th>Spot</th>
                    <th>hRF</th>
                    <th>Height</th>
                    <th>Area</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line font-mono">
                  {previews.flatMap((p) =>
                    p.spots.map((s) => (
                      <tr key={`${p.track.id}-${s.number}`} className={p.track.id === selected ? "bg-brand-50/60" : ""} onClick={() => wb.setSelected(p.track.id)}>
                        <td className="py-0.5 font-sans">{p.track.name}</td>
                        <td>{s.number}</td>
                        <td>{fmt(s.peak.maxHrf)}</td>
                        <td>{fmt(s.peak.height)}</td>
                        <td>{fmt(s.peak.area, 0)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title={`Tracks (${tracks.length})`}>
          {editable && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={secondary} onClick={wb.detectTracks} disabled={!wb.gray}>
                Auto-detect
              </button>
              <button type="button" className={secondary} onClick={() => setTool("ADD_TRACK")}>
                Add track
              </button>
            </div>
          )}
          <div className="space-y-1.5">
            {tracks.map((t) => {
              const active = t.id === selected;
              const needsConc = t.role === "STANDARD" && (t.concentration === null || t.sampleVolumeUl === null);
              return (
                <div key={t.id} className={`rounded-lg border p-2 ${active ? "border-brand bg-brand-50/40" : "border-line"}`} onClick={() => wb.setSelected(t.id)}>
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-xs text-muted">{t.id}</span>
                    <input aria-label={`Track ${t.id} name`} value={t.name} disabled={!editable} onChange={(e) => setTrack(t.id, { name: e.target.value })} className="w-20 rounded-lg border border-line px-2 py-1 text-sm font-semibold" />
                    <span className="flex-1 truncate text-xs text-muted">
                      {fmt(t.centerMm)} mm{t.sampleVolumeUl != null ? ` · ${t.sampleVolumeUl} µl` : ""}
                      {t.concentration != null ? ` · ${t.concentration}` : ""}
                      {t.role === "STANDARD" ? " · reference" : t.dilutionFactor != null ? ` · ${t.dilutionFactor}×` : ""}
                    </span>
                    {editable && (
                      <button type="button" aria-label={`Remove track ${t.id}`} className="text-xs font-semibold text-fail hover:underline" onClick={(e) => (e.stopPropagation(), removeTrack(t.id))}>
                        Remove
                      </button>
                    )}
                  </div>
                  {active && (
                    <div className="mt-2 space-y-2 text-xs">
                      <Stepper label="Center" value={t.centerMm} step={0.5} min={0} max={plate.widthMm} unit="mm" disabled={!editable} onChange={(v) => setTrack(t.id, { centerMm: v, source: "MANUAL" })} />
                      <label className="block">
                        Sample ID / lot
                        <input value={t.sampleId} disabled={!editable} onChange={(e) => setTrack(t.id, { sampleId: e.target.value })} className="mt-0.5 w-full rounded-lg border border-line px-2 py-1" />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <label>
                          Volume µl
                          <input inputMode="decimal" value={t.sampleVolumeUl ?? ""} disabled={!editable} onChange={(e) => setTrack(t.id, { sampleVolumeUl: e.target.value === "" ? null : Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-line px-2 py-1 font-mono" />
                        </label>
                        {t.role === "STANDARD" ? (
                          <label>
                            Conc.
                            <input inputMode="decimal" value={t.concentration ?? ""} disabled={!editable} onChange={(e) => setTrack(t.id, { concentration: e.target.value === "" ? null : Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-line px-2 py-1 font-mono" />
                          </label>
                        ) : (
                          <label>
                            Dilution ×
                            <input inputMode="decimal" value={t.dilutionFactor ?? ""} disabled={!editable} onChange={(e) => setTrack(t.id, { dilutionFactor: e.target.value === "" ? null : Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-line px-2 py-1 font-mono" />
                          </label>
                        )}
                      </div>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" aria-label={`Track ${t.id} reference`} checked={t.role === "STANDARD"} disabled={!editable} onChange={(e) => setTrack(t.id, { role: e.target.checked ? "STANDARD" : "SAMPLE" })} /> Reference / standard
                      </label>
                      {needsConc && <p className="text-fail">A reference needs its volume and concentration for quantification (identification works without).</p>}
                      <p className="text-muted">
                        Spots at hRF {previews.find((p) => p.track.id === t.id)?.spots.map((s) => fmt(s.peak.maxHrf)).join(", ") || "—"} · position {t.source === "DETECTED" ? "found automatically" : t.source === "METHOD" ? "from the method" : "set by the analyst"}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
        <div className={PINNED_ACTION}>
          <button className={`${primary} w-full`} disabled={tracks.length === 0 || !wb.layoutOk} onClick={onContinue}>
            Continue to evaluation →
          </button>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Evaluation — densitogram, peaks, inspector, save snapshot
// ---------------------------------------------------------------------------

export function EvaluationStage({
  wb,
  windows,
  analysisId,
  current,
  editable,
  onSaved,
}: {
  wb: Workbench;
  windows: RfWindow[];
  analysisId: string;
  current: EvaluationFull | null;
  editable: boolean;
  onSaved: (message: string) => Promise<void>;
}) {
  const { plate, geometry, layout, tracks, settings, previews, selected } = wb;
  const [signalView, setSignalView] = useState<"RAW" | "PROCESSED">("PROCESSED");
  const [showRaw, setShowRaw] = useState(false);
  const [labels, setLabels] = useState(true);
  const [derivative, setDerivative] = useState<0 | 1 | 2>(0);
  const [addSpot, setAddSpot] = useState(false);
  const [editing, setEditing] = useState(false);
  // The selected peak belongs to a track: changing track shows no peak, unless one of that
  // track's peaks was picked (e.g. by tapping its spot on the plate strip).
  const [peakSel, setPeakSel] = useState<{ trackId: number | null; n: number } | null>(null);
  const peak = peakSel && peakSel.trackId === selected ? peakSel.n : null;
  const setPeak = (n: number | null) => setPeakSel(n === null ? null : { trackId: selected, n });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The tablet's chart controls.
  const [mode, setMode] = useState<ChartMode>("SINGLE");
  const [tool, setTool] = useState<ChartTool>("NONE");
  const [viewport, setViewport] = useState<Viewport>(FULL_VIEW);
  const [showBaseline, setShowBaseline] = useState(true);
  const [showArea, setShowArea] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showTracks, setShowTracks] = useState(true);
  const [normalized, setNormalized] = useState(false);
  const [referenceId, setReferenceId] = useState<number | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const toggleTool = (t: ChartTool) => setTool(tool === t ? "NONE" : t);

  const index = Math.max(0, tracks.findIndex((t) => t.id === selected));
  const track = tracks[index] ?? null;
  const pv = previews[index] ?? null;
  useEffect(() => {
    if (selected === null && tracks.length) wb.setSelected(tracks[0].id);
  }, [selected, tracks, wb]);
  const pickSpot = (trackId: number, n: number) => {
    setPeakSel({ trackId, n });
    if (trackId !== selected) wb.setSelected(trackId);
  };
  const cycle = (d: 1 | -1) => tracks.length && wb.setSelected(tracks[(index + d + tracks.length) % tracks.length].id);

  const processedView = signalView === "PROCESSED";
  const deriv = useMemo(() => {
    if (!pv || !derivative) return null;
    const samplesPerHrf = pv.processed.size / 100;
    const sg = SavitzkyGolay.forRegion(3, samplesPerHrf, 3);
    return pv.processed.withSignal(sg.derivative(pv.processed.signal, derivative, 1 / samplesPerHrf));
  }, [pv, derivative]);
  const plotTracks: PlotTrack[] = useMemo(
    () =>
      previews.map((p, i) => {
        const prof = processedView ? p.processed : p.raw;
        return { id: p.track.id, label: `${p.track.id}: ${p.track.name}`, profile: normalized ? normalizeToMax(prof) : prof, color: TRACK_PALETTE[i % TRACK_PALETTE.length], reference: p.track.id === referenceId };
      }),
    [previews, processedView, normalized, referenceId],
  );
  const bands: PlotBand[] = windows.map((w) => ({ startHrf: w.min * 100, endHrf: w.max * 100, label: w.compound, color: "#0F9BA8" }));
  const onBoundary = (n: number, start: boolean, h: number) => {
    if (!pv) return;
    const list = windowsOf(pv);
    const i = pv.spots.findIndex((sp) => sp.number === n);
    if (i < 0) return;
    const w = list[i];
    const v = Math.round(h * 10) / 10;
    list[i] = start ? { startHrf: Math.min(v, w.endHrf - 0.5), endHrf: w.endHrf } : { startHrf: w.startHrf, endHrf: Math.max(v, w.startHrf + 0.5) };
    setWindows(list);
  };
  const baselineLabel = settings.densitometry.subtractBackground && settings.densitometry.subtractPeakBaseline ? "AUTO" : settings.densitometry.subtractPeakBaseline ? "CHORD" : settings.densitometry.subtractBackground ? "BACKGROUND" : "NONE";
  const setBaseline = (v: string) =>
    wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, subtractBackground: v === "AUTO", subtractPeakBaseline: v === "AUTO" || v === "CHORD" } });

  const windowsOf = (p: TrackPreview) => p.spots.map((s) => ({ startHrf: Math.round(s.window.startHrf * 10) / 10, endHrf: Math.round(s.window.endHrf * 10) / 10 }));
  const setWindows = (list: PeakWindow[]) => track && wb.setManualSpots({ ...wb.manualSpots, [String(track.id)]: list });
  const toManual = () => pv && !pv.manual && setWindows(windowsOf(pv));
  const resetAuto = () => {
    if (!track) return;
    const { [String(track.id)]: _, ...rest } = wb.manualSpots;
    wb.setManualSpots(rest);
    setEditing(false);
    setPeak(null);
  };

  /** A tap on the curve away from any peak: with Add spot, mark a peak there. */
  const onTapHrf = (h: number) => {
    if (!addSpot || !editable || !pv) return;
    const w = PeakLocator.windowAround(pv.processed, h);
    setWindows([...windowsOf(pv), { startHrf: Math.round(w.startHrf * 10) / 10, endHrf: Math.round(w.endHrf * 10) / 10 }]);
    setAddSpot(false);
  };

  async function save() {
    setBusy("Evaluating on the server…");
    setError(null);
    try {
      const e = await mod<EvaluationFull>(`/analyses/${analysisId}/evaluations`, send({ layout, tracks, image: wb.image, settings, manualSpots: wb.manualSpots }));
      await onSaved(`Evaluation ${e.code} saved: ${CONCLUSION[e.conclusion].label.toLowerCase()}. Continue to Sign-off to submit it for review.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const totalArea = pv ? pv.spots.reduce((s, sp) => s + sp.peak.area, 0) : 0;
  const selectedSpot = pv?.spots.find((s) => s.number === peak) ?? null;
  const nextCode = `E${String((current?.number ?? 0) + 1).padStart(2, "0")}`;

  return (
    // Below the fixed header, the densitogram, peak table, preview and save scroll together as one
    // column; the Peak Inspector stays beside them.
    <div className="grid gap-5 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        <div className={`${card} space-y-3`}>
          <div className="grid gap-3 md:grid-cols-[13rem_minmax(0,1fr)]">
            {/* Plate strip (colour photo), with the track arrows below it — as on the tablet. */}
            <div className="flex flex-col gap-2 self-start">
              <div className="relative overflow-hidden rounded-lg bg-backdrop">
                <img src={`/api/modules/tlc/api/plates/${plate.id}/image`} alt="Plate strip" className="block w-full" draggable={false} />
                {showTracks && (
                  <svg viewBox={`0 0 ${plate.widthPx} ${plate.heightPx}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-label="Tracks on the plate; tap one to select it">
                    {tracks.map((t) => {
                      const xx = geometry.xMmToPx(t.centerMm - layout.trackWidthMm / 2);
                      const w = geometry.xMmToPx(layout.trackWidthMm);
                      const active = t.id === track?.id;
                      const stroke = Math.max(1.5, plate.widthPx / 300);
                      const hrfToY = (h: number) => geometry.yMmToPx(layout.baselineMm + (h / 100) * (layout.solventFrontMm - layout.baselineMm));
                      return (
                        <g key={t.id}>
                          <rect x={xx} y={geometry.yMmToPx(layout.solventFrontMm)} width={w} height={geometry.yMmToPx(layout.baselineMm) - geometry.yMmToPx(layout.solventFrontMm)} fill={active ? "rgb(30 79 216 / 0.06)" : "rgb(255 255 255 / 0.06)"} stroke={active ? "#1E4FD8" : "rgb(255 255 255 / 0.7)"} strokeWidth={active ? stroke * 1.4 : stroke} strokeDasharray={active ? `${stroke * 4} ${stroke * 2}` : undefined} className="cursor-pointer" onClick={() => wb.setSelected(t.id)} />
                          {/* Detected (or manual) spots, as on the Plate stage; the selected track's in its peak colours. */}
                          {previews
                            .find((p) => p.track.id === t.id)
                            ?.spots.map((s) => {
                              const color = active ? PlotColors.Peaks[(s.number - 1) % PlotColors.Peaks.length] : "#e0344c";
                              const chosen = active && s.number === peak;
                              const ys = hrfToY(s.window.startHrf);
                              const ye = hrfToY(s.window.endHrf);
                              return (
                                <rect
                                  key={s.number}
                                  x={xx}
                                  y={ye}
                                  width={w}
                                  height={Math.max(1, ys - ye)}
                                  fill={chosen ? `${color}40` : `${color}14`}
                                  stroke={color}
                                  strokeWidth={chosen ? stroke * 3 : stroke * 1.8}
                                  className="cursor-pointer"
                                  onClick={() => pickSpot(t.id, s.number)}
                                >
                                  <title>{`Track ${t.id} · peak ${s.number} · hRF ${fmt(s.peak.maxHrf)}`}</title>
                                </rect>
                              );
                            })}
                        </g>
                      );
                    })}
                  </svg>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-line bg-white text-navy disabled:opacity-40" aria-label="Previous track" onClick={() => cycle(-1)} disabled={tracks.length < 2}>
                  ‹
                </button>
                <span className="flex-1 text-center text-sm font-semibold text-navy">{track ? `Track ${track.id}` : "No track"}</span>
                <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-line bg-white text-navy disabled:opacity-40" aria-label="Next track" onClick={() => cycle(1)} disabled={tracks.length < 2}>
                  ›
                </button>
              </div>
            </div>

            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {editable && (
                  <button type="button" className={toolToggle(addSpot)} onClick={() => (setAddSpot(!addSpot), setMode("SINGLE"))}>
                    + {addSpot ? "Tap the curve" : "Add spot"}
                  </button>
                )}
                <button type="button" className={toolToggle(showTracks)} onClick={() => setShowTracks(!showTracks)}>
                  Show tracks
                </button>
                <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-line">
                  {CHART_MODES.map((m) => (
                    <button key={m.mode} type="button" onClick={() => setMode(m.mode)} className={`px-3 py-1.5 text-sm font-semibold ${mode === m.mode ? "bg-brand-50 text-navy" : "bg-white text-muted hover:text-ink"}`}>
                      {m.label}
                    </button>
                  ))}
                </span>
                <button type="button" className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-white text-navy" onClick={() => setSettingsOpen(true)} aria-label="Densitogram settings" title="Densitogram settings">
                  ⚙
                </button>
              </div>

              <div className="rounded-xl border border-line bg-white px-3 py-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-1.5 text-sm">
                  <span className="flex">
                    <span className="border-b-2 border-brand px-2 py-1 font-semibold text-navy">Densitogram</span>
                    <span className="px-2 py-1 text-muted/60" title="Calibration comes with quantification (phase 4).">
                      Calibration
                    </span>
                    <span className="px-2 py-1 text-muted/60" title="Spectra need a scanning densitometer; NxGen works from plate photographs.">
                      Spectrum
                    </span>
                  </span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <span className="inline-flex overflow-hidden rounded-lg border border-line">
                      {(["RAW", "PROCESSED"] as const).map((v) => (
                        <button key={v} type="button" onClick={() => setSignalView(v)} className={`px-2.5 py-1 font-semibold ${signalView === v ? "bg-brand-50 text-navy" : "bg-white text-muted"}`}>
                          {v === "RAW" ? "Raw" : "Processed"}
                        </button>
                      ))}
                    </span>
                    <label className="flex items-center gap-1">
                      <span className="text-muted">Baseline</span>
                      <select value={baselineLabel} disabled={!editable} onChange={(e) => setBaseline(e.target.value)} className="rounded-lg border border-line bg-white px-1.5 py-1">
                        <option value="AUTO">Auto</option>
                        <option value="CHORD">Chord</option>
                        <option value="NONE">None</option>
                        {baselineLabel === "BACKGROUND" && <option value="BACKGROUND">Background</option>}
                      </select>
                    </label>
                    <label className="flex items-center gap-1">
                      <span className="text-muted">Peaks</span>
                      <select value={pv?.manual ? "MANUAL" : "AUTO"} disabled={!editable || !pv} onChange={(e) => (e.target.value === "MANUAL" ? (toManual(), setEditing(true)) : resetAuto())} className="rounded-lg border border-line bg-white px-1.5 py-1">
                        <option value="AUTO">Auto</option>
                        <option value="MANUAL">Manual</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1">
                      <span className="text-muted">Smoothing</span>
                      <select value={settings.densitometry.smoothing ? "SG" : "NONE"} disabled={!editable} onChange={(e) => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, smoothing: e.target.value === "SG" } })} className="rounded-lg border border-line bg-white px-1.5 py-1">
                        <option value="SG">S–G</option>
                        <option value="NONE">None</option>
                      </select>
                    </label>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                  <button type="button" className={toolToggle(tool === "ZOOM")} onClick={() => toggleTool("ZOOM")} title="Drag sideways to zoom hRF, up or down to zoom intensity, or drag a box to zoom both. Ctrl/⌘ + scroll also zooms.">
                    Zoom
                  </button>
                  <button type="button" className={toolToggle(tool === "PAN")} onClick={() => toggleTool("PAN")}>
                    Pan
                  </button>
                  <button type="button" className={toolToggle(false)} onClick={() => (setViewport(FULL_VIEW), setTool("NONE"))}>
                    Reset
                  </button>
                  <button type="button" className={toolToggle(false)} onClick={() => setViewport({ ...viewport, yRange: null })}>
                    Auto Scale
                  </button>
                  <button type="button" className={toolToggle(tool === "CURSOR")} onClick={() => (toggleTool("CURSOR"), tool === "CURSOR" && setViewport({ ...viewport, cursor: null }))}>
                    Cursor
                  </button>
                  <span className="mx-1 h-6 w-px bg-line" />
                  {mode === "SINGLE" ? (
                    <>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={showRaw} disabled={!processedView} onChange={(e) => setShowRaw(e.target.checked)} /> Raw signal
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} /> Baseline
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Labels
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={showArea} onChange={(e) => setShowArea(e.target.checked)} /> Area
                      </label>
                      <label className="flex items-center gap-1">
                        <span className="text-muted">Derivative</span>
                        <select value={derivative} onChange={(e) => setDerivative(Number(e.target.value) as 0 | 1 | 2)} className="rounded-lg border border-line bg-white px-1.5 py-1">
                          <option value={0}>Off</option>
                          <option value={1}>D1</option>
                          <option value={2}>D2</option>
                        </select>
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="flex items-center gap-1">
                        <span className="text-muted">Response</span>
                        <select value={normalized ? "N" : "A"} onChange={(e) => setNormalized(e.target.value === "N")} className="rounded-lg border border-line bg-white px-1.5 py-1">
                          <option value="A">Absolute</option>
                          <option value="N">Normalized</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-1">
                        <span className="text-muted">Reference</span>
                        <select value={referenceId ?? ""} onChange={(e) => setReferenceId(e.target.value === "" ? null : Number(e.target.value))} className="rounded-lg border border-line bg-white px-1.5 py-1">
                          <option value="">None</option>
                          {tracks.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.id}: {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                  <span className="relative ml-auto">
                    <button type="button" className={toolToggle(moreOpen)} onClick={() => setMoreOpen(!moreOpen)} aria-label="More chart options">
                      ⋯
                    </button>
                    {moreOpen && (
                      <span className="absolute right-0 z-20 mt-1 flex w-56 flex-col rounded-xl border border-line bg-white py-1 shadow-lg">
                        {[
                          [showLegend ? "Hide legend" : "Show legend", () => setShowLegend(!showLegend)],
                          [showGrid ? "Hide grid" : "Show grid", () => setShowGrid(!showGrid)],
                          ["Densitogram settings…", () => setSettingsOpen(true)],
                        ].map(([label, fn]) => (
                          <button key={label as string} type="button" className="px-3 py-2 text-left hover:bg-brand-50" onClick={() => ((fn as () => void)(), setMoreOpen(false))}>
                            {label as string}
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                </div>

                {pv ? (
                  <>
                    <DensitogramPlot
                      mode={mode}
                      viewport={viewport}
                      onViewport={setViewport}
                      height={deriv && mode === "SINGLE" ? 300 : 380}
                      processed={pv.processed}
                      raw={showRaw || !processedView ? pv.raw : null}
                      showProcessed={processedView}
                      peakBaselines={settings.densitometry.subtractPeakBaseline}
                      peaks={processedView ? pv.spots.map((s) => ({ number: s.number, startHrf: s.window.startHrf, endHrf: s.window.endHrf, apexHrf: s.peak.maxHrf, selected: s.number === peak })) : []}
                      tracks={plotTracks}
                      selectedTrackId={track?.id ?? null}
                      showLabels={labels}
                      showBaseline={showBaseline}
                      showArea={showArea}
                      showLegend={showLegend}
                      showGrid={showGrid}
                      yLabel={mode !== "SINGLE" && normalized ? "Normalized response (%)" : "Intensity (AU)"}
                      xTitle={!(deriv && mode === "SINGLE")}
                      bands={mode === "SINGLE" ? bands : []}
                      tool={tool}
                      editBoundaries={editing && editable}
                      crosshair={addSpot}
                      ariaLabel={`Densitogram of ${pv.track.name}`}
                      onSelectPeak={setPeak}
                      onSelectTrack={(id) => wb.setSelected(id)}
                      onTapHrf={onTapHrf}
                      onBoundary={onBoundary}
                    />
                    {deriv && mode === "SINGLE" && (
                      <div className="relative">
                        <DensitogramPlot
                          mode="SINGLE"
                          viewport={viewport}
                          onViewport={setViewport}
                          height={190}
                          processed={deriv}
                          showBaseline={false}
                          showArea={false}
                          showLabels={false}
                          showLegend={showLegend}
                          showGrid={showGrid}
                          yLabel={`D${derivative}`}
                          seriesLabel={derivative === 1 ? "D1 · first derivative of the processed signal" : "D2 · each minimum = one component"}
                          seriesColor={PlotColors.Derivative}
                          zeroLine
                          fitInterior
                          compact
                          tool={tool}
                          ariaLabel={`D${derivative} of ${pv.track.name}`}
                        />
                        <button type="button" className="absolute top-1 right-2 rounded-lg border border-line bg-white px-2.5 py-1 text-xs font-semibold text-navy" onClick={() => setDerivative(0)}>
                          ✕ Close D{derivative}
                        </button>
                      </div>
                    )}
                    <p className="pb-1 text-xs text-muted">
                      {addSpot
                        ? "Tap the curve where the spot is."
                        : editing && editable
                          ? "Edit boundaries: drag the coloured start or end line of the selected peak."
                          : tool === "ZOOM"
                            ? "Drag sideways to zoom hRF, up or down to zoom intensity, or drag a box to zoom both."
                            : tool === "CURSOR"
                              ? "Tap or drag to read values."
                              : mode === "STACKED"
                                ? "Tap a curve to select its track."
                                : "Tap inside a peak to select it. Ctrl/⌘ + scroll zooms."}{" "}
                      Noise σ {fmt(pv.noise, 2)}.
                    </p>
                  </>
                ) : (
                  <p className="p-8 text-center text-sm text-muted">Select a track to see its densitogram.</p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={panelLabel}>Peaks in {track ? `Track ${track.id}: ${track.name}` : "—"}</h3>
            {editable && pv?.manual && (
              <button type="button" className={small} onClick={resetAuto}>
                Reset to detected peaks
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-xs">
              <thead className="text-left uppercase tracking-wide text-muted">
                <tr>
                  <th className="pb-1">Peak</th>
                  <th className="pb-1">Start hRF</th>
                  <th className="pb-1">Max hRF</th>
                  <th className="pb-1">End hRF</th>
                  <th className="pb-1">Rf</th>
                  <th className="pb-1">Height (AU)</th>
                  <th className="pb-1">Area (AU·px)</th>
                  <th className="pb-1">Area %</th>
                  <th className="pb-1">Assigned compound</th>
                  <th className="pb-1">Status</th>
                  {editable && <th className="pb-1">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono">
                {pv?.spots.map((s, i) => {
                  const rf = Math.round((s.peak.maxHrf / 100) * 1000) / 1000;
                  return (
                    <tr key={s.number} className={s.number === peak ? "bg-brand-50/60" : ""} onClick={() => setPeak(s.number)}>
                      <td className="py-1">{s.number}</td>
                      <td>{fmt(s.window.startHrf)}</td>
                      <td>{fmt(s.peak.maxHrf)}</td>
                      <td>{fmt(s.window.endHrf)}</td>
                      <td className="font-semibold">{rf.toFixed(3)}</td>
                      <td>{fmt(s.peak.height)}</td>
                      <td>{fmt(s.peak.area, 0)}</td>
                      <td>{totalArea > 0 ? fmt((100 * s.peak.area) / totalArea) : "—"}</td>
                      <td className="font-sans">{assignCompound(rf, windows) || <span className="text-muted">—</span>}</td>
                      <td className="font-sans">
                        <Badge tone={pv.manual ? "info" : "pass"}>{pv.manual ? "Manual" : "Detected"}</Badge>
                      </td>
                      {editable && (
                        <td className="font-sans">
                          <button
                            type="button"
                            className="text-fail hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              const list = windowsOf(pv).filter((_, j) => j !== i);
                              wb.setManualSpots({ ...wb.manualSpots, [String(pv.track.id)]: list });
                              if (peak === s.number) setPeak(null);
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {pv && pv.spots.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-2 font-sans text-muted">
                      No peaks above the noise. Use “Add spot” to mark one by hand.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {wb.preview && <div className={card}><RfTable evaluation={wb.preview} title={editable ? "Preview" : "Result"} /></div>}
        {editable && (
          <div className={`${card} space-y-3`}>
            {wb.saturation > 0.01 && <Callout tone="fail">The lanes are saturated ({(wb.saturation * 100).toFixed(2)} %); the evaluation will be recorded as not concluded.</Callout>}
            {error && <Callout tone="fail">{error}</Callout>}
            <div className="flex flex-wrap items-center gap-3">
              <button className={primary} onClick={() => void save()} disabled={!!busy || !wb.layoutOk || tracks.length === 0}>
                {busy ?? `Save evaluation ${nextCode}`}
              </button>
              <span className="text-xs text-muted">NxGen recomputes everything from the straightened plate and stores it as an unchangeable snapshot.</span>
            </div>
          </div>
        )}
      </div>

      <aside className={`${card} space-y-3 self-start lg:max-h-full lg:overflow-y-auto`}>
        <h3 className={panelTitle}>Peak Inspector</h3>
        {selectedSpot && pv ? (
          <>
            <p className="text-sm">
              <b>Peak {selectedSpot.number}</b> of {pv.spots.length} · {pv.track.name}
            </p>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
              <dt className="text-muted">Max hRF</dt>
              <dd className="font-mono">{fmt(selectedSpot.peak.maxHrf)}</dd>
              <dt className="text-muted">Rf</dt>
              <dd className="font-mono">{(selectedSpot.peak.maxHrf / 100).toFixed(3)}</dd>
              <dt className="text-muted">Window</dt>
              <dd className="font-mono">
                {fmt(selectedSpot.window.startHrf)} – {fmt(selectedSpot.window.endHrf)} hRF
              </dd>
              <dt className="text-muted">Height</dt>
              <dd className="font-mono">{fmt(selectedSpot.peak.height)} AU</dd>
              <dt className="text-muted">Area</dt>
              <dd className="font-mono">{fmt(selectedSpot.peak.area, 0)} AU·px</dd>
              <dt className="text-muted">Prominence</dt>
              <dd className="font-mono">{fmt(selectedSpot.prominence)}</dd>
              <dt className="text-muted">Compound</dt>
              <dd>{assignCompound(Math.round((selectedSpot.peak.maxHrf / 100) * 1000) / 1000, windows) || "—"}</dd>
            </dl>
            {editable && (
              <>
                {editing ? (
                  <div className="space-y-2 rounded-xl border border-line p-3">
                    <p className="text-xs text-muted">Drag the coloured lines on the densitogram, or set them here.</p>
                    <Stepper label="Start" unit="hRF" value={selectedSpot.window.startHrf} step={0.5} min={0} max={100} onChange={(v) => setWindows(windowsOf(pv).map((w, i) => (pv.spots[i].number === peak ? { startHrf: Math.min(v, w.endHrf - 0.5), endHrf: w.endHrf } : w)))} />
                    <Stepper label="End" unit="hRF" value={selectedSpot.window.endHrf} step={0.5} min={0} max={100} onChange={(v) => setWindows(windowsOf(pv).map((w, i) => (pv.spots[i].number === peak ? { startHrf: w.startHrf, endHrf: Math.max(v, w.startHrf + 0.5) } : w)))} />
                  </div>
                ) : null}
                <button type="button" className={`${secondary} w-full`} onClick={() => (editing ? setEditing(false) : (toManual(), setEditing(true)))}>
                  {editing ? "Done editing" : "Edit boundaries"}
                </button>
              </>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">Tap a peak in the densitogram or the table to inspect it.</p>
        )}
        <p className="text-xs text-muted">Peaks come from the detector unless the track is set to Manual; a manual track keeps the windows you set.</p>
      </aside>

      {settingsOpen && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-navy/35 p-4" role="dialog" aria-label="Densitogram settings">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6">
            <h3 className={panelTitle}>Densitogram settings</h3>
            <div>
              <p className="text-sm font-semibold">Across track width</p>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(["AVERAGE", "MEDIAN"] as const).map((a) => (
                  <button key={a} type="button" className={optionBox(settings.densitometry.aggregation === a, !editable)} disabled={!editable} onClick={() => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, aggregation: a } })}>
                    {a === "AVERAGE" ? "Average" : "Median"}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between text-sm font-semibold">
              Savitzky–Golay smoothing
              <input type="checkbox" checked={settings.densitometry.smoothing} disabled={!editable} onChange={(e) => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, smoothing: e.target.checked } })} />
            </label>
            <Stepper label="Smoothing window" value={settings.densitometry.smoothingMm} step={0.5} min={0.5} max={6} unit="mm" disabled={!editable} onChange={(v) => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, smoothingMm: v } })} />
            <label className="flex items-center justify-between text-sm font-semibold">
              Subtract plate background
              <input type="checkbox" checked={settings.densitometry.subtractBackground} disabled={!editable} onChange={(e) => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, subtractBackground: e.target.checked } })} />
            </label>
            <Stepper label="Background window" value={settings.densitometry.backgroundWindowMm} step={1} min={5} max={40} unit="mm" disabled={!editable} onChange={(v) => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, backgroundWindowMm: v } })} />
            <label className="flex items-center justify-between text-sm font-semibold">
              Subtract baseline under peak
              <input type="checkbox" checked={settings.densitometry.subtractPeakBaseline} disabled={!editable} onChange={(e) => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, subtractPeakBaseline: e.target.checked } })} />
            </label>
            <Stepper label="Peak detection sensitivity" value={settings.spotDetector.sensitivity} step={0.1} min={0.5} max={3} disabled={!editable} onChange={(v) => wb.setSettings({ ...settings, spotDetector: { ...settings.spotDetector, sensitivity: v } })} />
            <p className="text-xs text-muted">Higher sensitivity finds fainter peaks; lower it if noise is detected as peaks.</p>
            <div className="flex justify-end">
              <button className={primary} onClick={() => setSettingsOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
