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
import type { Channel, QcCheck } from "../engine";
import type { EvaluationInput, ImageQc } from "../api/pipeline";
import { Evaluation, ILLUMINATIONS, Illumination, RfWindow, TrackRole, evaluateRf } from "../shared/tlc";
import { Badge, CONCLUSION, Callout, ILLUMINATION_LABEL, Tone, card, field, fmtDate, mod, optionBox, panelLabel, panelTitle, primary, request, secondary, send, small, strong, toolToggle } from "./lib";
import { EvaluationFull, ImageMeta, PlateMeta, RfTable, clamp, fmt, loadPixels, svgPoint } from "./plate";

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
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="relative min-h-[18rem] overflow-hidden rounded-2xl bg-black">
        {image ? (
          <>
            <img src={`/api/modules/tlc/api/images/${image.id}`} alt={`${ILLUMINATION_LABEL[image.illumination]} plate image`} className="max-h-[42rem] w-full object-contain" />
            {verdict && (
              <span className="absolute top-3 left-3 rounded-lg px-3 py-1.5 text-sm font-extrabold tracking-wide text-white" style={{ background: verdict.color }}>
                {verdict.label}
              </span>
            )}
            <span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 font-mono text-[11px] text-white">
              RAW · {image.fileName} · {ILLUMINATION_LABEL[image.illumination]}
            </span>
          </>
        ) : (
          <p className="p-8 text-center text-sm text-white/70">No plate image yet. Upload the plate photographed under the lamp you need.</p>
        )}
      </div>

      <aside className={`${card} space-y-4`}>
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
            <input ref={fileRef} id="plate-image" type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <button className={`${strong} w-full`} onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? "Checking the image…" : "Upload plate image"}
            </button>
            <p className="text-xs text-muted">Camera capture through the instrument link comes with the hardware phase; until then, upload the photo.</p>
          </>
        )}
        {error && <Callout tone="fail">{error}</Callout>}

        {image && (
          <div className="space-y-3 border-t border-line pt-4">
            <div>
              <h4 className={panelTitle}>Capture review</h4>
              <p className="text-sm text-muted">{editable ? "Uploaded image checked. Use it or choose another." : "How the image passed the capture quality gate."}</p>
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

// ---------------------------------------------------------------------------
// 2. Crop — plate outline and straightening
// ---------------------------------------------------------------------------

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
          const p = PLATE_PRESETS.find((x) => Math.abs(quadAspect(quadFrom(image.qc!.outline!)) / (x.widthMm / x.heightMm) - 1) <= 0.12);
          if (p) {
            setWidthMm(String(p.widthMm));
            setHeightMm(String(p.heightMm));
          }
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
      if (r.outline.preset && !chosen) {
        setWidthMm(String(r.outline.preset.widthMm));
        setHeightMm(String(r.outline.preset.heightMm));
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
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-backdrop">
        <img src={`/api/modules/tlc/api/images/${image.id}`} alt="" className="max-h-[42rem] w-full object-contain" draggable={false} />
        {size && corners && (
          <svg ref={svgRef} viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full touch-none" onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)} aria-label="Plate outline; drag the corners">
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
      </div>

      <aside className={`${card} space-y-4`}>
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
        {editable ? (
          <button className={`${primary} w-full`} onClick={() => void straighten()} disabled={!!busy || !corners}>
            {busy ?? "Straighten plate & continue"}
          </button>
        ) : (
          plate && <p className="text-sm text-muted">Straightened by {plate.createdBy} · {fmtDate(plate.createdAt)}</p>
        )}
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
  const [settings, setSettings] = useState<Workbench["settings"]>(current?.input.settings ?? { densitometry: DEFAULT_DENSITOMETRY, spotDetector: DEFAULT_SPOT_DETECTOR });
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

  const previews: TrackPreview[] = useMemo(() => {
    if (!gray || !layoutOk) return [];
    return tracks.map((t) => {
      const track = { id: t.id, name: t.name, centerMm: t.centerMm };
      try {
        const dp = SpotDetector.detectionProfile(gray, geometry, track, dev, polarity, settings.densitometry.aggregation, settings.spotDetector);
        const manual = manualSpots[String(t.id)];
        const spots = manual ? SpotDetector.measure(dp, t.id, manual) : SpotDetector.detectOn(dp, t.id, settings.spotDetector);
        const processed = Densitometry.profile(gray, geometry, track, dev, polarity, settings.densitometry);
        const raw = Densitometry.profile(gray, geometry, track, dev, polarity, { ...settings.densitometry, smoothing: false, subtractBackground: false });
        return { track: t, raw, processed, spots, noise: dp.noise, manual: !!manual };
      } catch {
        const empty = new Profile([0, 100], [0, 0], 1);
        return { track: t, raw: empty, processed: empty, spots: [], noise: 0, manual: false };
      }
    });
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
        {unit && <span className="w-6 text-xs text-muted">{unit}</span>}
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
  const [view, setView] = useState<"RAW" | "ANALYTICAL">("ANALYTICAL");
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
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className={`${card} space-y-3`}>
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
        <div className="flex gap-3">
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
          <div className="relative min-w-0 flex-1">
            <img src={viewUrl} alt={`Straightened plate, ${view.toLowerCase()} view`} className="w-full rounded-xl border border-line bg-canvas" draggable={false} />
            <span className="absolute top-2 right-2 rounded-md bg-black/55 px-2 py-0.5 font-mono text-[11px] text-white">{view === "RAW" ? "RAW · original, straightened" : "ANALYTICAL · image used by the calculations"}</span>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${plate.widthPx} ${plate.heightPx}`}
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
          </div>
        </div>
        {editable && <p className="text-xs text-muted">{hint}</p>}
        {!wb.rgb && <p className="text-sm text-muted">Processing image…</p>}
      </div>

      <aside className={`${card} space-y-0 py-1`}>
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
        <div className="border-t border-line pt-3 pb-2">
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
  const [peak, setPeak] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<"start" | "end" | null>(null);

  const index = Math.max(0, tracks.findIndex((t) => t.id === selected));
  const track = tracks[index] ?? null;
  const pv = previews[index] ?? null;
  useEffect(() => {
    if (selected === null && tracks.length) wb.setSelected(tracks[0].id);
  }, [selected, tracks, wb]);
  useEffect(() => setPeak(null), [selected]);
  const cycle = (d: 1 | -1) => tracks.length && wb.setSelected(tracks[(index + d + tracks.length) % tracks.length].id);

  const W = 760;
  const H = 260;
  const padL = 44;
  const padR = 12;
  const padB = 26;
  const padT = 14;
  const profile = pv ? (signalView === "RAW" ? pv.raw : pv.processed) : null;
  const min = profile ? Math.min(...profile.signal, ...(showRaw && pv ? pv.raw.signal : [])) : 0;
  const max = profile ? Math.max(...profile.signal, ...(showRaw && pv ? pv.raw.signal : [])) : 1;
  const span = max - min || 1;
  const x = (h: number) => padL + (h / 100) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - min) / span) * (H - padT - padB);
  const hOf = (px: number) => ((px - padL) / (W - padL - padR)) * 100;
  const path = (p: Profile) => p.hRf.map((h, i) => `${i ? "L" : "M"}${x(h).toFixed(1)},${y(p.signal[i]).toFixed(1)}`).join(" ");

  const deriv = useMemo(() => {
    if (!pv || !derivative) return null;
    const samplesPerHrf = pv.processed.size / 100;
    const sg = SavitzkyGolay.forRegion(3, samplesPerHrf, 3);
    const d = sg.derivative(pv.processed.signal, derivative, 1 / samplesPerHrf);
    return { hRf: pv.processed.hRf, d };
  }, [pv, derivative]);

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

  const onPlotClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || !pv) return;
    const h = hOf(svgPoint(svgRef.current, e).x);
    if (h < 0 || h > 100) return;
    const hit = pv.spots.find((s) => h >= s.window.startHrf - 0.5 && h <= s.window.endHrf + 0.5);
    if (hit) {
      setPeak(hit.number);
      return;
    }
    if (addSpot && editable) {
      const w = PeakLocator.windowAround(pv.processed, h);
      if (!pv.manual) wb.setManualSpots({ ...wb.manualSpots, [String(pv.track.id)]: [...windowsOf(pv), { startHrf: Math.round(w.startHrf * 10) / 10, endHrf: Math.round(w.endHrf * 10) / 10 }] });
      else setWindows([...windowsOf(pv), { startHrf: Math.round(w.startHrf * 10) / 10, endHrf: Math.round(w.endHrf * 10) / 10 }]);
      setAddSpot(false);
    }
  };
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editing || !editable || !svgRef.current || !pv || peak === null) return;
    const s = pv.spots.find((sp) => sp.number === peak);
    if (!s) return;
    const px = svgPoint(svgRef.current, e).x;
    const tol = 40 * (W / svgRef.current.getBoundingClientRect().width);
    if (Math.abs(px - x(s.window.startHrf)) <= tol) drag.current = "start";
    else if (Math.abs(px - x(s.window.endHrf)) <= tol) drag.current = "end";
    if (drag.current) (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svgRef.current || !pv || peak === null) return;
    const h = clamp(Math.round(hOf(svgPoint(svgRef.current, e).x) * 10) / 10, 0, 100);
    const list = windowsOf(pv);
    const i = pv.spots.findIndex((sp) => sp.number === peak);
    if (i < 0) return;
    const w = list[i];
    list[i] = drag.current === "start" ? { startHrf: Math.min(h, w.endHrf - 0.5), endHrf: w.endHrf } : { startHrf: w.startHrf, endHrf: Math.max(h, w.startHrf + 0.5) };
    setWindows(list);
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
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <div className={`${card} space-y-3`}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="flex items-center gap-1">
              <button type="button" className={small} aria-label="Previous track" onClick={() => cycle(-1)} disabled={tracks.length < 2}>
                ◀
              </button>
              <span className="min-w-[7rem] text-center font-semibold">{track ? `Track ${track.id}` : "No track"}</span>
              <button type="button" className={small} aria-label="Next track" onClick={() => cycle(1)} disabled={tracks.length < 2}>
                ▶
              </button>
            </span>
            {editable && (
              <button type="button" className={toolToggle(addSpot)} onClick={() => setAddSpot(!addSpot)}>
                Add spot
              </button>
            )}
            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Densitogram</span>
              <button type="button" className={optionBox(false, true)} disabled title="Calibration comes with quantification (phase 4).">
                Calibration
              </button>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="flex gap-1">
              <button type="button" className={optionBox(signalView === "RAW")} onClick={() => setSignalView("RAW")}>
                Raw
              </button>
              <button type="button" className={optionBox(signalView === "PROCESSED")} onClick={() => setSignalView("PROCESSED")}>
                Processed
              </button>
            </span>
            <label className="flex items-center gap-1.5">
              Peaks:
              <select value={pv?.manual ? "MANUAL" : "AUTO"} disabled={!editable || !pv} onChange={(e) => (e.target.value === "MANUAL" ? (toManual(), setEditing(true)) : resetAuto())} className="rounded-lg border border-line bg-white px-2 py-1">
                <option value="AUTO">Auto</option>
                <option value="MANUAL">Manual</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              Smoothing:
              <select value={settings.densitometry.smoothing ? "SG" : "NONE"} disabled={!editable} onChange={(e) => wb.setSettings({ ...settings, densitometry: { ...settings.densitometry, smoothing: e.target.value === "SG" } })} className="rounded-lg border border-line bg-white px-2 py-1">
                <option value="SG">Savitzky–Golay</option>
                <option value="NONE">None</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> Raw signal
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Labels
            </label>
            <label className="flex items-center gap-1.5">
              Derivative:
              <select value={derivative} onChange={(e) => setDerivative(Number(e.target.value) as 0 | 1 | 2)} className="rounded-lg border border-line bg-white px-2 py-1">
                <option value={0}>Off</option>
                <option value={1}>D1</option>
                <option value={2}>D2</option>
              </select>
            </label>
            <button type="button" className={`${small} ml-auto`} onClick={() => setSettingsOpen(true)} aria-label="Densitogram settings">
              ⚙ Settings
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-[13rem_minmax(0,1fr)]">
            <div className="relative">
              <img src={`/api/modules/tlc/api/plates/${plate.id}/image?view=analytical&channel=${wb.image.channel}&black=${wb.image.postProcessing.blackPoint}&white=${wb.image.postProcessing.whitePoint}&denoise=${wb.image.postProcessing.denoise ? 1 : 0}`} alt="Plate strip" className="w-full rounded-lg border border-line" />
              <svg viewBox={`0 0 ${plate.widthPx} ${plate.heightPx}`} className="absolute inset-0 h-full w-full" aria-label="Tracks on the plate; tap one to select it">
                {tracks.map((t) => {
                  const xx = geometry.xMmToPx(t.centerMm - layout.trackWidthMm / 2);
                  const w = geometry.xMmToPx(layout.trackWidthMm);
                  return <rect key={t.id} x={xx} y={geometry.yMmToPx(layout.solventFrontMm)} width={w} height={geometry.yMmToPx(layout.baselineMm) - geometry.yMmToPx(layout.solventFrontMm)} fill={t.id === track?.id ? "rgb(37 99 235 / 0.3)" : "rgb(255 255 255 / 0.05)"} stroke={t.id === track?.id ? "#2563eb" : "rgb(255 255 255 / 0.5)"} strokeWidth={Math.max(1.5, plate.widthPx / 300)} className="cursor-pointer" onClick={() => wb.setSelected(t.id)} />;
                })}
              </svg>
            </div>
            <div>
              {pv && profile ? (
                <>
                  <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className={`w-full ${addSpot ? "cursor-crosshair" : editing ? "cursor-col-resize" : ""}`} role="img" aria-label={`Densitogram of ${pv.track.name}`} onClick={onPlotClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)}>
                    {pv.spots.map((s) => (
                      <rect key={s.number} x={x(s.window.startHrf)} y={padT} width={Math.max(1, x(s.window.endHrf) - x(s.window.startHrf))} height={H - padT - padB} fill={s.number === peak ? "rgb(37 99 235 / 0.18)" : "rgb(224 52 76 / 0.1)"} />
                    ))}
                    {windows.map((w) => (
                      <rect key={w.compound} x={x(w.min * 100)} y={H - padB} width={x(w.max * 100) - x(w.min * 100)} height={4} fill="#13965a" opacity={0.6}>
                        <title>{w.compound}</title>
                      </rect>
                    ))}
                    {showRaw && signalView === "PROCESSED" && <path d={path(pv.raw)} fill="none" stroke="#9aa3b5" strokeWidth={1} />}
                    <path d={path(profile)} fill="none" stroke="#1b2d57" strokeWidth={1.6} />
                    {pv.spots.map((s) => (
                      <g key={s.number}>
                        <line x1={x(s.window.startHrf)} x2={x(s.window.startHrf)} y1={padT} y2={H - padB} stroke={s.number === peak ? "#2563eb" : "#e0344c"} strokeWidth={s.number === peak && editing ? 2 : 1} strokeDasharray="4 3" />
                        <line x1={x(s.window.endHrf)} x2={x(s.window.endHrf)} y1={padT} y2={H - padB} stroke={s.number === peak ? "#2563eb" : "#e0344c"} strokeWidth={s.number === peak && editing ? 2 : 1} strokeDasharray="4 3" />
                        {labels && (
                          <text x={x(s.peak.maxHrf)} y={padT + 11} textAnchor="middle" fontSize={11} fill="#e0344c" fontWeight={700}>
                            {s.number}
                          </text>
                        )}
                      </g>
                    ))}
                    {[0, 25, 50, 75, 100].map((h) => (
                      <text key={h} x={x(h)} y={H - 8} textAnchor="middle" fontSize={10} fill="#5a6680">
                        {h}
                      </text>
                    ))}
                    <text x={2} y={padT + 10} fontSize={10} fill="#5a6680">
                      {max.toFixed(0)}
                    </text>
                    <text x={2} y={H - padB} fontSize={10} fill="#5a6680">
                      {min.toFixed(0)}
                    </text>
                    <text x={W - padR} y={H - 8} textAnchor="end" fontSize={10} fill="#5a6680">
                      hRF
                    </text>
                  </svg>
                  {deriv && (
                    <div className="relative">
                      <svg viewBox={`0 0 ${W} ${H * 0.45}`} className="w-full" role="img" aria-label={`D${derivative} of ${pv.track.name}`}>
                        {(() => {
                          const dmin = Math.min(...deriv.d);
                          const dmax = Math.max(...deriv.d);
                          const ds = dmax - dmin || 1;
                          const h2 = H * 0.45;
                          const yy = (v: number) => 6 + (1 - (v - dmin) / ds) * (h2 - 12);
                          return (
                            <>
                              <line x1={padL} x2={W - padR} y1={yy(0)} y2={yy(0)} stroke="#9aa3b5" strokeDasharray="3 3" />
                              <path d={deriv.hRf.map((h, i) => `${i ? "L" : "M"}${x(h).toFixed(1)},${yy(deriv.d[i]).toFixed(1)}`).join(" ")} fill="none" stroke="#b45f06" strokeWidth={1.3} />
                              <text x={padL} y={12} fontSize={10} fill="#b45f06" fontWeight={700}>
                                D{derivative}
                              </text>
                            </>
                          );
                        })()}
                      </svg>
                      <button type="button" className="absolute top-1 right-1 text-xs font-semibold text-brand hover:underline" onClick={() => setDerivative(0)}>
                        Close D{derivative}
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-muted">
                    {addSpot ? "Tap the curve where the spot is." : editing ? "Edit boundaries: drag the dashed start or end line of the selected peak." : "Tap inside a peak to select it."} Noise σ {fmt(pv.noise, 2)}.
                  </p>
                </>
              ) : (
                <p className="p-8 text-center text-sm text-muted">Select a track to see its densitogram.</p>
              )}
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

      <aside className={`${card} space-y-3 self-start`}>
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
                  <div className="grid grid-cols-2 gap-2">
                    <Stepper label="Start" value={selectedSpot.window.startHrf} step={0.5} min={0} max={100} onChange={(v) => setWindows(windowsOf(pv).map((w, i) => (pv.spots[i].number === peak ? { startHrf: Math.min(v, w.endHrf - 0.5), endHrf: w.endHrf } : w)))} />
                    <Stepper label="End" value={selectedSpot.window.endHrf} step={0.5} min={0} max={100} onChange={(v) => setWindows(windowsOf(pv).map((w, i) => (pv.spots[i].number === peak ? { startHrf: w.startHrf, endHrf: Math.max(v, w.startHrf + 0.5) } : w)))} />
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
