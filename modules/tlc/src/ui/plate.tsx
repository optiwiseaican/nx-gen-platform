/**
 * The plate workbench, following the tablet's stages: Crop (outline → straightened plate) →
 * Plate (baseline, front, tracks) → Evaluation (densitograms, spots, Rf). The browser runs the
 * engine for live preview on the same straightened image the server holds; what is saved is
 * computed and stored by the server as an immutable snapshot (E01, E02, …).
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
  RgbImage,
  SpotDetector,
  SpotDetectorSettings,
  argb,
  polarityOf,
  quadAspect,
  quadFrom,
} from "../engine";
import type { Channel } from "../engine";
import type { EvaluatedSpot, EvaluationInput, EvaluationResults } from "../api/pipeline";
import { Evaluation, Illumination, RfWindow, TrackRole, evaluateRf } from "../shared/tlc";
import { Badge, CONCLUSION, Callout, ILLUMINATION_LABEL, card, field, fmtDate, mod, primary, secondary, send, small } from "./lib";

export interface PlateMeta {
  id: string;
  imageId: string;
  illumination: Illumination;
  corners: Point[];
  outlineSource: "AUTO" | "MANUAL";
  widthMm: number;
  heightMm: number;
  widthPx: number;
  heightPx: number;
  channel: Channel;
  postProcessing: PostProcessing;
  pixelsSha256: string;
  isCurrent: boolean;
  createdBy: string;
  createdAt: string;
}

export interface EvaluationSummary {
  id: string;
  code: string;
  number: number;
  plateId: string;
  conclusion: string;
  engineVersion: string;
  contentSha256: string;
  createdBy: string;
  createdAt: string;
  reasons: string[];
  analyticalSaturation: number;
  tracks: number;
  spots: number;
}

export type EvaluationFull = EvaluationSummary & { input: EvaluationInput; results: EvaluationResults };

export interface ImageMeta {
  id: string;
  illumination: Illumination;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  uploadedAt: string;
}

type EvalTrack = EvaluationInput["tracks"][number];

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Decodes an image URL into the engine's pixel format through a canvas (PNG: lossless). */
async function loadPixels(url: string): Promise<RgbImage> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const px = new Int32Array(canvas.width * canvas.height);
  for (let i = 0; i < px.length; i++) px[i] = argb(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
  return new RgbImage(canvas.width, canvas.height, px);
}

/** Pointer position in an SVG's user units (the image's own pixels). */
function svgPoint(svg: SVGSVGElement, e: { clientX: number; clientY: number }): Point {
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height };
}

// ---------------------------------------------------------------------------
// Stage 1 — Crop: outline the plate on an original image and straighten it
// ---------------------------------------------------------------------------

export function CropStage({
  analysisId,
  images,
  plate,
  editable,
  onSaved,
}: {
  analysisId: string;
  images: ImageMeta[];
  plate: PlateMeta | null;
  editable: boolean;
  onSaved: (message: string) => Promise<void>;
}) {
  const [imageId, setImageId] = useState(plate?.imageId ?? images[0]?.id ?? "");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [corners, setCorners] = useState<Point[] | null>(plate?.corners ?? null);
  const [source, setSource] = useState<"AUTO" | "MANUAL">(plate?.outlineSource ?? "MANUAL");
  const [preset, setPreset] = useState(plate ? (PLATE_PRESETS.find((p) => p.widthMm === plate.widthMm && p.heightMm === plate.heightMm)?.label ?? "custom") : "5 × 10 cm");
  const [widthMm, setWidthMm] = useState(String(plate?.widthMm ?? 50));
  const [heightMm, setHeightMm] = useState(String(plate?.heightMm ?? 100));
  const [channel, setChannel] = useState<Channel>(plate?.channel ?? "INTENSITY");
  const [pp, setPp] = useState<PostProcessing>(plate?.postProcessing ?? { blackPoint: 0, whitePoint: 255, denoise: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!plate);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);

  const image = images.find((i) => i.id === imageId) ?? null;
  const sameImage = plate?.imageId === imageId;

  useEffect(() => {
    if (!imageId) return;
    const img = new Image();
    img.onload = () => {
      setSize({ w: img.naturalWidth, h: img.naturalHeight });
      if (!sameImage || !plate) {
        setCorners([
          { x: 0, y: 0 },
          { x: img.naturalWidth - 1, y: 0 },
          { x: img.naturalWidth - 1, y: img.naturalHeight - 1 },
          { x: 0, y: img.naturalHeight - 1 },
        ]);
        setSource("MANUAL");
      } else setCorners(plate.corners);
    };
    img.src = `/api/modules/tlc/api/images/${imageId}`;
  }, [imageId, sameImage, plate]);

  const applyPreset = (label: string) => {
    setPreset(label);
    const p = PLATE_PRESETS.find((x) => x.label === label);
    if (p) {
      setWidthMm(String(p.widthMm));
      setHeightMm(String(p.heightMm));
    }
  };

  async function autoOutline() {
    setBusy("Finding the plate…");
    setError(null);
    try {
      const r = await mod<{ outline: { corners: Point[]; fill: number; preset: { label: string } | null } | null }>(`/analyses/${analysisId}/outline?imageId=${imageId}`);
      if (!r.outline) {
        setError("No clean plate outline was found; drag the corners by hand.");
        return;
      }
      setCorners(r.outline.corners);
      setSource("AUTO");
      if (r.outline.preset) applyPreset(r.outline.preset.label);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const rotate = () => {
    if (!corners) return;
    setCorners([corners[3], corners[0], corners[1], corners[2]]);
    setSource("MANUAL");
  };

  async function straighten() {
    if (!corners) return;
    setBusy("Straightening…");
    setError(null);
    try {
      await mod(`/analyses/${analysisId}/plate`, send({ imageId, corners, widthMm: Number(widthMm), heightMm: Number(heightMm), channel, postProcessing: pp, outlineSource: source }));
      setOpen(false);
      await onSaved("Plate straightened. Any earlier evaluation now needs to be repeated on the new plate.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const onPointerDown = (i: number) => (e: React.PointerEvent) => {
    if (!editable) return;
    drag.current = i;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current === null || !svgRef.current || !corners || !size) return;
    const p = svgPoint(svgRef.current, e);
    setCorners(corners.map((c, j) => (j === drag.current ? { x: clamp(Math.round(p.x), 0, size.w - 1), y: clamp(Math.round(p.y), 0, size.h - 1) } : c)));
    setSource("MANUAL");
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const aspect = corners ? quadAspect(quadFrom(corners)) : null;
  const nominal = Number(widthMm) / Number(heightMm);
  const aspectOff = aspect !== null && Number.isFinite(nominal) && Math.abs(aspect / nominal - 1) > 0.12;

  return (
    <section className={`${card} space-y-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-bold">2. Straightened plate</h3>
          <p className="text-sm text-muted">Outline the plate on the original image; NxGen straightens it to its real size. The original image is never changed.</p>
        </div>
        {plate && editable && (
          <button className={secondary} onClick={() => setOpen(!open)}>
            {open ? "Keep the current plate" : "Straighten again…"}
          </button>
        )}
      </div>

      {plate && (
        <div className="flex flex-wrap gap-4 text-sm">
          <img src={`/api/modules/tlc/api/plates/${plate.id}/image`} alt="Straightened plate" className="max-h-72 rounded-xl border border-line bg-canvas object-contain" />
          <dl className="grid content-start gap-x-6 gap-y-1 sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted">Source</dt>
            <dd>
              {ILLUMINATION_LABEL[plate.illumination]} image · outline {plate.outlineSource === "AUTO" ? "found automatically" : "set by the analyst"}
            </dd>
            <dt className="text-muted">Size</dt>
            <dd>
              {plate.widthMm} × {plate.heightMm} mm · {plate.widthPx} × {plate.heightPx} px ({(plate.widthPx / plate.widthMm).toFixed(1)} px/mm)
            </dd>
            <dt className="text-muted">Analytical image</dt>
            <dd>
              {plate.channel.toLowerCase()} channel
              {plate.postProcessing.denoise ? ", denoised" : ""}
              {plate.postProcessing.blackPoint !== 0 || plate.postProcessing.whitePoint !== 255 ? `, levels ${plate.postProcessing.blackPoint}–${plate.postProcessing.whitePoint}` : ""}
            </dd>
            <dt className="text-muted">Pixels SHA-256</dt>
            <dd className="break-all font-mono text-[11px]">{plate.pixelsSha256}</dd>
            <dt className="text-muted">Straightened</dt>
            <dd>
              {plate.createdBy} · {fmtDate(plate.createdAt)}
            </dd>
          </dl>
        </div>
      )}

      {editable && open && (
        <div className="space-y-4 rounded-xl border border-line p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-semibold">
              Original image
              <select value={imageId} onChange={(e) => setImageId(e.target.value)} className={field}>
                {images.map((i) => (
                  <option key={i.id} value={i.id}>
                    {ILLUMINATION_LABEL[i.illumination]} · {i.fileName}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={small} onClick={() => void autoOutline()} disabled={!!busy}>
              Find plate automatically
            </button>
            <button type="button" className={small} onClick={rotate} disabled={!corners}>
              Rotate 90°
            </button>
          </div>
          {size && corners && (
            <div className="relative max-w-3xl">
              <img src={`/api/modules/tlc/api/images/${imageId}`} alt="" className="w-full rounded-xl border border-line bg-canvas" draggable={false} />
              <svg
                ref={svgRef}
                viewBox={`0 0 ${size.w} ${size.h}`}
                className="absolute inset-0 h-full w-full touch-none"
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                aria-label="Plate outline; drag the corners"
              >
                <polygon points={corners.map((c) => `${c.x},${c.y}`).join(" ")} fill="rgb(37 99 235 / 0.12)" stroke="#2563eb" strokeWidth={Math.max(2, size.w / 400)} vectorEffect="non-scaling-stroke" />
                {corners.map((c, i) => (
                  <g key={i}>
                    <circle cx={c.x} cy={c.y} r={Math.max(10, size.w / 60)} fill="#fff" stroke="#2563eb" strokeWidth={Math.max(2, size.w / 400)} className="cursor-move" onPointerDown={onPointerDown(i)} />
                    <text x={c.x} y={c.y} dy={Math.max(4, size.w / 200)} textAnchor="middle" fontSize={Math.max(12, size.w / 60)} fill="#2563eb" fontWeight={700} pointerEvents="none">
                      {["TL", "TR", "BR", "BL"][i]}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm font-semibold">
              Plate size
              <select value={preset} onChange={(e) => applyPreset(e.target.value)} className={field}>
                {PLATE_PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            <label className="text-sm font-semibold">
              Width (mm)
              <input inputMode="decimal" value={widthMm} onChange={(e) => (setWidthMm(e.target.value), setPreset("custom"))} className={`${field} font-mono`} />
            </label>
            <label className="text-sm font-semibold">
              Height (mm)
              <input inputMode="decimal" value={heightMm} onChange={(e) => (setHeightMm(e.target.value), setPreset("custom"))} className={`${field} font-mono`} />
            </label>
            <label className="text-sm font-semibold">
              Channel for analysis
              <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={field}>
                <option value="INTENSITY">Intensity</option>
                <option value="RED">Red</option>
                <option value="GREEN">Green</option>
                <option value="BLUE">Blue</option>
              </select>
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm font-semibold">
              Black point <span className="font-mono font-normal text-muted">{pp.blackPoint}</span>
              <input type="range" min={0} max={254} value={pp.blackPoint} onChange={(e) => setPp({ ...pp, blackPoint: Math.min(Number(e.target.value), pp.whitePoint - 1) })} className="mt-2 w-full" />
            </label>
            <label className="text-sm font-semibold">
              White point <span className="font-mono font-normal text-muted">{pp.whitePoint}</span>
              <input type="range" min={1} max={255} value={pp.whitePoint} onChange={(e) => setPp({ ...pp, whitePoint: Math.max(Number(e.target.value), pp.blackPoint + 1) })} className="mt-2 w-full" />
            </label>
            <label className="flex items-center gap-2 pt-6 text-sm font-semibold">
              <input type="checkbox" checked={pp.denoise} onChange={(e) => setPp({ ...pp, denoise: e.target.checked })} />
              Denoise (3×3 median)
            </label>
          </div>
          {aspectOff && (
            <Callout tone="warn">
              The outline’s proportions ({aspect!.toFixed(2)}) do not match a {widthMm} × {heightMm} mm plate ({nominal.toFixed(2)}). Check the corners or the plate size.
            </Callout>
          )}
          {error && <Callout tone="fail">{error}</Callout>}
          <div className="flex flex-wrap items-center gap-3">
            <button className={primary} onClick={() => void straighten()} disabled={!!busy || !corners || !image}>
              {busy ?? "Straighten plate"}
            </button>
            <span className="text-xs text-muted">Outline: {source === "AUTO" ? "found automatically" : "set by hand"}</span>
          </div>
        </div>
      )}
      {!plate && !editable && <p className="text-sm text-muted">The plate was not straightened.</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stages 3–4 — Plate layout and evaluation (live preview with the engine)
// ---------------------------------------------------------------------------

interface Layout {
  baselineMm: number;
  solventFrontMm: number;
  trackWidthMm: number;
  baselineSource: "DETECTED" | "MANUAL";
  frontSource: "DETECTED" | "MANUAL";
}

interface TrackPreview {
  track: EvalTrack;
  processed: Profile;
  spots: DetectedSpot[];
  noise: number;
  manual: boolean;
}

function assignCompound(rf: number, windows: RfWindow[]): string {
  return windows.find((w) => rf >= w.min && rf <= w.max)?.compound ?? "";
}

export function PlateWorkbench({
  analysisId,
  plate,
  windows,
  current,
  editable,
  onSaved,
}: {
  analysisId: string;
  plate: PlateMeta;
  windows: RfWindow[];
  /** The latest stored evaluation on this plate, if any: its inputs seed the form. */
  current: EvaluationFull | null;
  editable: boolean;
  onSaved: (message: string) => Promise<void>;
}) {
  const [rgb, setRgb] = useState<RgbImage | null>(null);
  const [layout, setLayout] = useState<Layout>(() =>
    current ? current.input.layout : { ...DEFAULT_DEVELOPMENT, baselineSource: "MANUAL", frontSource: "MANUAL" },
  );
  const [tracks, setTracks] = useState<EvalTrack[]>(current?.input.tracks ?? []);
  const [settings, setSettings] = useState<{ densitometry: DensitometrySettings; spotDetector: SpotDetectorSettings }>(
    current?.input.settings ?? { densitometry: DEFAULT_DENSITOMETRY, spotDetector: DEFAULT_SPOT_DETECTOR },
  );
  const [manualSpots, setManualSpots] = useState<Record<string, PeakWindow[]>>(current?.input.manualSpots ?? {});
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "baseline" | "front" | "track"; id?: number } | null>(null);

  useEffect(() => {
    loadPixels(`/api/modules/tlc/api/plates/${plate.id}/image`)
      .then(setRgb)
      .catch((e: Error) => setError(e.message));
  }, [plate.id]);

  const gray = useMemo(() => (rgb ? ImageOps.apply(rgb, plate.postProcessing).channel(plate.channel) : null), [rgb, plate]);
  const geometry = useMemo(() => new PlateGeometry(plate.widthPx, plate.heightPx, plate.widthMm, plate.heightMm), [plate]);
  const polarity = polarityOf(plate.illumination);
  const dev = { baselineMm: layout.baselineMm, solventFrontMm: layout.solventFrontMm, trackWidthMm: layout.trackWidthMm };
  const layoutOk = layout.solventFrontMm - layout.baselineMm >= 5 && layout.trackWidthMm >= 1;

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
    setDetected(
      `${l.trackCentersMm.length} track${l.trackCentersMm.length === 1 ? "" : "s"} found · baseline ${l.baselineFound ? "found" : "not found (default used)"} · front ${l.frontFound ? "found" : "not found (default used)"}`,
    );
  }, [gray, geometry]);

  useEffect(() => {
    if (gray && !current && tracks.length === 0 && editable) autoDetect();
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
        return { track: t, processed, spots, noise: dp.noise, manual: !!manual };
      } catch {
        return { track: t, processed: new Profile([0, 100], [0, 0], 1), spots: [], noise: 0, manual: false };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gray, geometry, layout, tracks, settings, manualSpots, polarity]);

  const preview: Evaluation | null = useMemo(() => {
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
  const saturation = useMemo(() => (rgb && layoutOk && tracks.length ? CaptureQc.analyticalSaturation(rgb, geometry, dev, tracks.map((t) => ({ id: t.id, name: t.name, centerMm: t.centerMm }))) : 0), [rgb, geometry, layout, tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTrack = (id: number, patch: Partial<EvalTrack>) => setTracks(tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const addTrack = () => {
    const id = tracks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const last = tracks[tracks.length - 1];
    const centerMm = clamp(last ? last.centerMm + Math.max(layout.trackWidthMm + 2, 8) : layout.trackWidthMm, 0, plate.widthMm);
    setTracks([...tracks, { id, name: `T${id}`, role: "SAMPLE", centerMm: Math.round(centerMm * 10) / 10, sampleVolumeUl: null, concentration: null, dilutionFactor: null, sampleId: "", source: "MANUAL" }]);
    setSelected(id);
  };
  const removeTrack = (id: number) => {
    setTracks(tracks.filter((t) => t.id !== id));
    const { [String(id)]: _, ...rest } = manualSpots;
    setManualSpots(rest);
    if (selected === id) setSelected(null);
  };

  // Dragging the baseline, the front and the tracks on the plate image.
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !svgRef.current || !editable) return;
    const p = svgPoint(svgRef.current, e);
    const yMm = Math.round(geometry.yPxToMm(p.y) * 10) / 10;
    const xMm = Math.round(geometry.xPxToMm(p.x) * 10) / 10;
    if (drag.current.kind === "baseline") setLayout({ ...layout, baselineMm: clamp(yMm, 0, layout.solventFrontMm - 5), baselineSource: "MANUAL" });
    else if (drag.current.kind === "front") setLayout({ ...layout, solventFrontMm: clamp(yMm, layout.baselineMm + 5, plate.heightMm), frontSource: "MANUAL" });
    else setTrack(drag.current.id!, { centerMm: clamp(xMm, 0, plate.widthMm), source: "MANUAL" });
  };
  const startDrag = (kind: "baseline" | "front" | "track", id?: number) => (e: React.PointerEvent) => {
    if (!editable) return;
    drag.current = { kind, id };
    if (kind === "track") setSelected(id!);
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const setManual = (p: TrackPreview, on: boolean) => {
    const key = String(p.track.id);
    if (on) setManualSpots({ ...manualSpots, [key]: p.spots.map((s) => ({ startHrf: Math.round(s.window.startHrf * 10) / 10, endHrf: Math.round(s.window.endHrf * 10) / 10 })) });
    else {
      const { [key]: _, ...rest } = manualSpots;
      setManualSpots(rest);
    }
  };
  const setWindows = (id: number, list: PeakWindow[]) => setManualSpots({ ...manualSpots, [String(id)]: list });

  async function save() {
    setBusy("Evaluating on the server…");
    setError(null);
    try {
      const e = await mod<EvaluationFull>(`/analyses/${analysisId}/evaluations`, send({ layout, tracks, settings, manualSpots }));
      await onSaved(`Evaluation ${e.code} saved: ${CONCLUSION[e.conclusion].label.toLowerCase()}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const stroke = Math.max(1.5, plate.widthPx / 500);
  const fontSize = Math.max(11, plate.widthPx / 45);
  const selectedPreview = previews.find((p) => p.track.id === selected) ?? null;

  return (
    <>
      <section className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold">3. Plate layout</h3>
            <p className="text-sm text-muted">Baseline, solvent front and tracks. Drag the lines and tracks on the plate, or type the values.</p>
          </div>
          {editable && (
            <button className={secondary} onClick={autoDetect} disabled={!gray}>
              Detect layout automatically
            </button>
          )}
        </div>
        {detected && <p className="text-sm text-muted">{detected}</p>}
        {!rgb && !error && <p className="text-sm text-muted">Loading the plate…</p>}
        {error && <Callout tone="fail">{error}</Callout>}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="relative max-w-3xl">
            <img src={`/api/modules/tlc/api/plates/${plate.id}/image?processed=1`} alt="Straightened plate with layout" className="w-full rounded-xl border border-line bg-canvas" draggable={false} />
            <svg ref={svgRef} viewBox={`0 0 ${plate.widthPx} ${plate.heightPx}`} className="absolute inset-0 h-full w-full touch-none" onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)} aria-label="Plate layout overlay">
              {tracks.map((t) => {
                const x = geometry.xMmToPx(t.centerMm - layout.trackWidthMm / 2);
                const w = geometry.xMmToPx(layout.trackWidthMm);
                const y1 = geometry.yMmToPx(layout.solventFrontMm);
                const y0 = geometry.yMmToPx(layout.baselineMm);
                const active = t.id === selected;
                return (
                  <g key={t.id} onPointerDown={startDrag("track", t.id)} className={editable ? "cursor-ew-resize" : ""}>
                    <rect x={x} y={y1} width={w} height={y0 - y1} fill={active ? "rgb(37 99 235 / 0.22)" : t.role === "STANDARD" ? "rgb(19 150 90 / 0.14)" : "rgb(37 99 235 / 0.1)"} stroke={active ? "#2563eb" : t.role === "STANDARD" ? "#13965a" : "#2563eb"} strokeWidth={stroke} strokeDasharray={active ? undefined : `${stroke * 3} ${stroke * 2}`} />
                    <text x={x + w / 2} y={y0 + fontSize * 1.3} textAnchor="middle" fontSize={fontSize} fontWeight={700} fill={t.role === "STANDARD" ? "#13965a" : "#2563eb"} pointerEvents="none">
                      {t.name}
                    </text>
                    {previews
                      .find((p) => p.track.id === t.id)
                      ?.spots.map((s) => {
                        const ys = geometry.yMmToPx(layout.baselineMm + (s.window.startHrf / 100) * (layout.solventFrontMm - layout.baselineMm));
                        const ye = geometry.yMmToPx(layout.baselineMm + (s.window.endHrf / 100) * (layout.solventFrontMm - layout.baselineMm));
                        return <rect key={s.number} x={x} y={ye} width={w} height={ys - ye} fill="none" stroke="#e0344c" strokeWidth={stroke} pointerEvents="none" />;
                      })}
                  </g>
                );
              })}
              <g onPointerDown={startDrag("baseline")} className={editable ? "cursor-ns-resize" : ""}>
                <line x1={0} x2={plate.widthPx} y1={geometry.yMmToPx(layout.baselineMm)} y2={geometry.yMmToPx(layout.baselineMm)} stroke="#b45f06" strokeWidth={stroke * 1.5} />
                <line x1={0} x2={plate.widthPx} y1={geometry.yMmToPx(layout.baselineMm)} y2={geometry.yMmToPx(layout.baselineMm)} stroke="transparent" strokeWidth={stroke * 8} />
                <text x={fontSize / 2} y={geometry.yMmToPx(layout.baselineMm) - fontSize / 3} fontSize={fontSize} fill="#b45f06" fontWeight={700} pointerEvents="none">
                  baseline {fmt(layout.baselineMm)} mm
                </text>
              </g>
              <g onPointerDown={startDrag("front")} className={editable ? "cursor-ns-resize" : ""}>
                <line x1={0} x2={plate.widthPx} y1={geometry.yMmToPx(layout.solventFrontMm)} y2={geometry.yMmToPx(layout.solventFrontMm)} stroke="#b45f06" strokeWidth={stroke * 1.5} />
                <line x1={0} x2={plate.widthPx} y1={geometry.yMmToPx(layout.solventFrontMm)} y2={geometry.yMmToPx(layout.solventFrontMm)} stroke="transparent" strokeWidth={stroke * 8} />
                <text x={fontSize / 2} y={geometry.yMmToPx(layout.solventFrontMm) - fontSize / 3} fontSize={fontSize} fill="#b45f06" fontWeight={700} pointerEvents="none">
                  front {fmt(layout.solventFrontMm)} mm
                </text>
              </g>
            </svg>
          </div>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <label className="font-semibold">
                Baseline (mm)
                <input inputMode="decimal" value={layout.baselineMm} disabled={!editable} onChange={(e) => setLayout({ ...layout, baselineMm: Number(e.target.value), baselineSource: "MANUAL" })} className={`${field} font-mono`} />
              </label>
              <label className="font-semibold">
                Front (mm)
                <input inputMode="decimal" value={layout.solventFrontMm} disabled={!editable} onChange={(e) => setLayout({ ...layout, solventFrontMm: Number(e.target.value), frontSource: "MANUAL" })} className={`${field} font-mono`} />
              </label>
              <label className="font-semibold">
                Track width (mm)
                <input inputMode="decimal" value={layout.trackWidthMm} disabled={!editable} onChange={(e) => setLayout({ ...layout, trackWidthMm: Number(e.target.value) })} className={`${field} font-mono`} />
              </label>
            </div>
            {!layoutOk && <Callout tone="warn">The solvent front must be at least 5 mm above the baseline, and the track width at least 1 mm.</Callout>}
            <div className="space-y-2">
              {tracks.map((t) => (
                <div key={t.id} className={`rounded-xl border p-2.5 ${t.id === selected ? "border-brand bg-brand-50/40" : "border-line"}`} onClick={() => setSelected(t.id)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <input aria-label={`Track ${t.id} name`} value={t.name} disabled={!editable} onChange={(e) => setTrack(t.id, { name: e.target.value })} className="w-20 rounded-lg border border-line px-2 py-1 font-semibold" />
                    <select aria-label={`Track ${t.id} role`} value={t.role} disabled={!editable} onChange={(e) => setTrack(t.id, { role: e.target.value as TrackRole })} className="rounded-lg border border-line bg-white px-2 py-1">
                      <option value="STANDARD">Standard</option>
                      <option value="SAMPLE">Sample</option>
                    </select>
                    <label className="flex items-center gap-1 text-xs text-muted">
                      at
                      <input aria-label={`Track ${t.id} position`} inputMode="decimal" value={t.centerMm} disabled={!editable} onChange={(e) => setTrack(t.id, { centerMm: Number(e.target.value), source: "MANUAL" })} className="w-16 rounded-lg border border-line px-2 py-1 font-mono text-ink" />
                      mm
                    </label>
                    {editable && (
                      <button type="button" className="ml-auto text-xs font-semibold text-fail hover:underline" onClick={() => removeTrack(t.id)}>
                        Remove
                      </button>
                    )}
                  </div>
                  {t.id === selected && (
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <label>
                        Volume (µl)
                        <input inputMode="decimal" value={t.sampleVolumeUl ?? ""} disabled={!editable} onChange={(e) => setTrack(t.id, { sampleVolumeUl: e.target.value === "" ? null : Number(e.target.value) })} className="mt-0.5 w-full rounded-lg border border-line px-2 py-1 font-mono" />
                      </label>
                      <label>
                        {t.role === "STANDARD" ? "Concentration" : "Dilution factor"}
                        <input
                          inputMode="decimal"
                          value={(t.role === "STANDARD" ? t.concentration : t.dilutionFactor) ?? ""}
                          disabled={!editable}
                          onChange={(e) => setTrack(t.id, t.role === "STANDARD" ? { concentration: e.target.value === "" ? null : Number(e.target.value) } : { dilutionFactor: e.target.value === "" ? null : Number(e.target.value) })}
                          className="mt-0.5 w-full rounded-lg border border-line px-2 py-1 font-mono"
                        />
                      </label>
                      <label className="col-span-2">
                        Sample / lot ID
                        <input value={t.sampleId} disabled={!editable} onChange={(e) => setTrack(t.id, { sampleId: e.target.value })} className="mt-0.5 w-full rounded-lg border border-line px-2 py-1" />
                      </label>
                      <p className="col-span-2 text-muted">Position {t.source === "DETECTED" ? "found automatically" : t.source === "METHOD" ? "from the method" : "set by the analyst"}.</p>
                    </div>
                  )}
                </div>
              ))}
              {editable && (
                <button type="button" className={small} onClick={addTrack}>
                  + Add track
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className={`${card} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold">4. Densitograms and spots</h3>
            <p className="text-sm text-muted">
              Each track is scanned from the baseline (hRf 0) to the front (hRf 100). Spots are found automatically; adjust them by hand where needed. Rf = hRf ÷ 100.
            </p>
          </div>
          {editable && (
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-brand">Processing settings</summary>
              <div className="mt-2 grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settings.densitometry.smoothing} onChange={(e) => setSettings({ ...settings, densitometry: { ...settings.densitometry, smoothing: e.target.checked } })} />
                  Savitzky–Golay smoothing
                </label>
                <label className="flex items-center gap-2">
                  window
                  <input inputMode="decimal" value={settings.densitometry.smoothingMm} onChange={(e) => setSettings({ ...settings, densitometry: { ...settings.densitometry, smoothingMm: Number(e.target.value) } })} className="w-16 rounded-lg border border-line px-2 py-1 font-mono" />
                  mm
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settings.densitometry.subtractBackground} onChange={(e) => setSettings({ ...settings, densitometry: { ...settings.densitometry, subtractBackground: e.target.checked } })} />
                  Background correction
                </label>
                <label className="flex items-center gap-2">
                  window
                  <input inputMode="decimal" value={settings.densitometry.backgroundWindowMm} onChange={(e) => setSettings({ ...settings, densitometry: { ...settings.densitometry, backgroundWindowMm: Number(e.target.value) } })} className="w-16 rounded-lg border border-line px-2 py-1 font-mono" />
                  mm
                </label>
                <label className="flex items-center gap-2">
                  Across the track
                  <select value={settings.densitometry.aggregation} onChange={(e) => setSettings({ ...settings, densitometry: { ...settings.densitometry, aggregation: e.target.value as DensitometrySettings["aggregation"] } })} className="rounded-lg border border-line bg-white px-2 py-1">
                    <option value="AVERAGE">average</option>
                    <option value="MEDIAN">median</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  Spot sensitivity
                  <input inputMode="decimal" value={settings.spotDetector.sensitivity} onChange={(e) => setSettings({ ...settings, spotDetector: { ...settings.spotDetector, sensitivity: Number(e.target.value) } })} className="w-16 rounded-lg border border-line px-2 py-1 font-mono" />
                </label>
              </div>
            </details>
          )}
        </div>
        {saturation > 0.001 && (
          <Callout tone={saturation > 0.01 ? "fail" : "warn"}>
            {(saturation * 100).toFixed(2)} % of the pixels inside the tracks are saturated{saturation > 0.01 ? "; peak heights and areas there are wrong and the evaluation cannot conclude. Recapture with less exposure." : "."}
          </Callout>
        )}
        <div className="grid gap-4 xl:grid-cols-2">
          {previews.map((p) => (
            <Densitogram
              key={p.track.id}
              preview={p}
              windows={windows}
              editable={editable}
              onToggleManual={(on) => setManual(p, on)}
              onWindows={(list) => setWindows(p.track.id, list)}
              onSelect={() => setSelected(p.track.id)}
              active={p.track.id === selected}
            />
          ))}
          {previews.length === 0 && <p className="text-sm text-muted">Add tracks to see their densitograms.</p>}
        </div>
        {selectedPreview && <p className="text-xs text-muted">Noise σ of {selectedPreview.track.name}: {fmt(selectedPreview.noise, 2)} grey levels.</p>}
        {preview && <RfTable evaluation={preview} title={editable ? "Preview" : "Result"} />}
        {editable && (
          <>
            {error && <Callout tone="fail">{error}</Callout>}
            <div className="flex flex-wrap items-center gap-3">
              <button className={primary} onClick={() => void save()} disabled={!!busy || !layoutOk || tracks.length === 0}>
                {busy ?? (current ? `Save evaluation E${String(current.number + 1).padStart(2, "0")}` : "Save evaluation E01")}
              </button>
              <span className="text-xs text-muted">NxGen recomputes everything from the straightened plate and stores it as an unchangeable snapshot.</span>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function Densitogram({
  preview,
  windows,
  editable,
  active,
  onToggleManual,
  onWindows,
  onSelect,
}: {
  preview: TrackPreview;
  windows: RfWindow[];
  editable: boolean;
  active: boolean;
  onToggleManual: (on: boolean) => void;
  onWindows: (list: PeakWindow[]) => void;
  onSelect: () => void;
}) {
  const { processed, spots, track, manual } = preview;
  const W = 600;
  const H = 170;
  const padL = 36;
  const padB = 22;
  const padT = 10;
  const min = Math.min(...processed.signal);
  const max = Math.max(...processed.signal);
  const span = max - min || 1;
  const x = (h: number) => padL + (h / 100) * (W - padL - 8);
  const y = (v: number) => padT + (1 - (v - min) / span) * (H - padT - padB);
  const path = processed.hRf.map((h, i) => `${i ? "L" : "M"}${x(h).toFixed(1)},${y(processed.signal[i]).toFixed(1)}`).join(" ");
  const svgRef = useRef<SVGSVGElement>(null);

  const addAt = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!editable || !manual || !svgRef.current) return;
    const p = svgPoint(svgRef.current, e);
    const h = ((p.x - padL) / (W - padL - 8)) * 100;
    if (h < 0 || h > 100) return;
    const w = PeakLocator.windowAround(processed, h);
    onWindows([...spots.map((s) => s.window), { startHrf: Math.round(w.startHrf * 10) / 10, endHrf: Math.round(w.endHrf * 10) / 10 }]);
  };

  return (
    <div className={`space-y-2 rounded-xl border p-3 ${active ? "border-brand" : "border-line"}`} onClick={onSelect}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p className="font-semibold">
          {track.name} <span className="font-normal text-muted">· {track.role === "STANDARD" ? "standard" : "sample"} · {spots.length} spot{spots.length === 1 ? "" : "s"}</span>
        </p>
        {editable && (
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={manual} onChange={(e) => onToggleManual(e.target.checked)} />
            Adjust spots by hand
          </label>
        )}
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className={`w-full ${manual && editable ? "cursor-crosshair" : ""}`} role="img" aria-label={`Densitogram of ${track.name}`} onClick={addAt}>
        {spots.map((s) => (
          <rect key={s.number} x={x(s.window.startHrf)} y={padT} width={Math.max(1, x(s.window.endHrf) - x(s.window.startHrf))} height={H - padT - padB} fill="rgb(224 52 76 / 0.12)" />
        ))}
        {windows.map((w) => (
          <rect key={w.compound} x={x(w.min * 100)} y={H - padB} width={x(w.max * 100) - x(w.min * 100)} height={4} fill="#13965a" opacity={0.6}>
            <title>{w.compound}</title>
          </rect>
        ))}
        <path d={path} fill="none" stroke="#1b2d57" strokeWidth={1.5} />
        {spots.map((s) => (
          <g key={s.number}>
            <line x1={x(s.peak.maxHrf)} x2={x(s.peak.maxHrf)} y1={padT} y2={H - padB} stroke="#e0344c" strokeWidth={1} strokeDasharray="3 2" />
            <text x={x(s.peak.maxHrf)} y={padT + 10} textAnchor="middle" fontSize={11} fill="#e0344c" fontWeight={700}>
              {s.number}
            </text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((h) => (
          <text key={h} x={x(h)} y={H - 6} textAnchor="middle" fontSize={10} fill="#5a6680">
            {h}
          </text>
        ))}
        <text x={2} y={padT + 10} fontSize={10} fill="#5a6680">
          {max.toFixed(0)}
        </text>
        <text x={2} y={H - padB} fontSize={10} fill="#5a6680">
          {min.toFixed(0)}
        </text>
        <text x={W - 8} y={H - 6} textAnchor="end" fontSize={10} fill="#5a6680">
          hRf
        </text>
      </svg>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] text-xs">
        <thead className="text-left uppercase tracking-wide text-muted">
          <tr>
            <th className="pb-1">#</th>
            <th className="pb-1">Start</th>
            <th className="pb-1">Max</th>
            <th className="pb-1">End</th>
            <th className="pb-1">Rf</th>
            <th className="pb-1">Height</th>
            <th className="pb-1">Area</th>
            <th className="pb-1">Compound</th>
            {editable && manual && <th />}
          </tr>
        </thead>
        <tbody className="divide-y divide-line font-mono">
          {spots.map((s, i) => {
            const rf = Math.round((s.peak.maxHrf / 100) * 1000) / 1000;
            return (
              <tr key={s.number}>
                <td className="py-1">{s.number}</td>
                <td>
                  {editable && manual ? (
                    <input aria-label={`${track.name} spot ${s.number} start`} inputMode="decimal" value={s.window.startHrf} onChange={(e) => onWindows(spots.map((x2, j) => (j === i ? { startHrf: Number(e.target.value), endHrf: x2.window.endHrf } : x2.window)))} className="w-14 rounded border border-line px-1" />
                  ) : (
                    fmt(s.window.startHrf)
                  )}
                </td>
                <td>{fmt(s.peak.maxHrf)}</td>
                <td>
                  {editable && manual ? (
                    <input aria-label={`${track.name} spot ${s.number} end`} inputMode="decimal" value={s.window.endHrf} onChange={(e) => onWindows(spots.map((x2, j) => (j === i ? { startHrf: x2.window.startHrf, endHrf: Number(e.target.value) } : x2.window)))} className="w-14 rounded border border-line px-1" />
                  ) : (
                    fmt(s.window.endHrf)
                  )}
                </td>
                <td className="font-semibold">{rf.toFixed(3)}</td>
                <td>{fmt(s.peak.height)}</td>
                <td>{fmt(s.peak.area, 0)}</td>
                <td className="font-sans">{assignCompound(rf, windows) || <span className="text-muted">—</span>}</td>
                {editable && manual && (
                  <td>
                    <button type="button" className="text-fail hover:underline" onClick={() => onWindows(spots.filter((_, j) => j !== i).map((x2) => x2.window))}>
                      remove
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
          {spots.length === 0 && (
            <tr>
              <td colSpan={8} className="py-1 font-sans text-muted">
                No spots above the noise.{manual && editable ? " Click the densitogram to add one." : ""}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      {manual && editable && <p className="text-xs text-muted">Click the curve to add a spot at that position.</p>}
    </div>
  );
}

export function RfTable({ evaluation, title }: { evaluation: Evaluation; title: string }) {
  const rows = [...evaluation.suitability.map((s) => ({ ...s, kind: "Suitability" })), ...evaluation.identification.map((s) => ({ ...s, kind: "Identification" }))];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <Badge tone={CONCLUSION[evaluation.conclusion].tone}>{CONCLUSION[evaluation.conclusion].label}</Badge>
      </div>
      {evaluation.reasons.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-muted">
          {evaluation.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="pb-1">Check</th>
                <th className="pb-1">Track</th>
                <th className="pb-1">Compound</th>
                <th className="pb-1">Rf</th>
                <th className="pb-1">Window</th>
                <th className="pb-1">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((s, i) => (
                <tr key={i}>
                  <td className="py-1.5">{s.kind}</td>
                  <td>{s.track}</td>
                  <td>{s.compound}</td>
                  <td className="font-mono">{s.rf === null ? "not found" : s.rf.toFixed(3)}</td>
                  <td className="font-mono">
                    {s.window.min}–{s.window.max}
                  </td>
                  <td>{s.pass ? <Badge tone="pass">PASS</Badge> : <Badge tone="fail">FAIL</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stored evaluation snapshots (read-only), with the recompute check
// ---------------------------------------------------------------------------

export function EvaluationSnapshot({ evaluation, plate }: { evaluation: EvaluationFull; plate: PlateMeta | null }) {
  const [verify, setVerify] = useState<{ ok: boolean; checks: Record<string, { ok: boolean; stored?: string; recomputed?: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = evaluation.results;
  async function check() {
    setBusy(true);
    setError(null);
    try {
      setVerify(await mod(`/evaluations/${evaluation.id}/verify`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const W = 600;
  const H = 150;
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">Snapshot</dt>
        <dd>
          <b>{evaluation.code}</b> · {evaluation.createdBy} · {fmtDate(evaluation.createdAt)} · engine {evaluation.engineVersion}
        </dd>
        <dt className="text-muted">Layout</dt>
        <dd>
          baseline {fmt(evaluation.input.layout.baselineMm)} mm ({evaluation.input.layout.baselineSource.toLowerCase()}), front {fmt(evaluation.input.layout.solventFrontMm)} mm ({evaluation.input.layout.frontSource.toLowerCase()}), track width{" "}
          {fmt(evaluation.input.layout.trackWidthMm)} mm
        </dd>
        <dt className="text-muted">Processing</dt>
        <dd>
          {evaluation.input.settings.densitometry.aggregation.toLowerCase()} across the track
          {evaluation.input.settings.densitometry.smoothing ? `, Savitzky–Golay ${evaluation.input.settings.densitometry.smoothingMm} mm` : ", no smoothing"}
          {evaluation.input.settings.densitometry.subtractBackground ? `, background window ${evaluation.input.settings.densitometry.backgroundWindowMm} mm` : ""}, spot sensitivity{" "}
          {evaluation.input.settings.spotDetector.sensitivity}
        </dd>
        <dt className="text-muted">Plate</dt>
        <dd className="break-all font-mono text-[11px]">pixels SHA-256 {r.plate.pixelsSha256}</dd>
        <dt className="text-muted">Content SHA-256</dt>
        <dd className="break-all font-mono text-[11px]">{evaluation.contentSha256}</dd>
      </dl>
      {plate && plate.id !== evaluation.plateId && <Callout tone="warn">This snapshot was computed on an earlier straightened plate, not the current one.</Callout>}
      <div className="grid gap-4 xl:grid-cols-2">
        {r.tracks.map((t) => {
          const min = Math.min(...t.profile.processed);
          const max = Math.max(...t.profile.processed);
          const span = max - min || 1;
          const x = (h: number) => 36 + (h / 100) * (W - 44);
          const y = (v: number) => 10 + (1 - (v - min) / span) * (H - 32);
          return (
            <div key={t.id} className="rounded-xl border border-line p-3">
              <p className="text-sm font-semibold">
                {t.name} <span className="font-normal text-muted">· {t.role === "STANDARD" ? "standard" : "sample"} at {fmt(t.centerMm)} mm</span>
              </p>
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Densitogram of ${t.name}`}>
                {t.spots.map((s: EvaluatedSpot) => (
                  <rect key={s.number} x={x(s.window.startHrf)} y={10} width={Math.max(1, x(s.window.endHrf) - x(s.window.startHrf))} height={H - 32} fill="rgb(224 52 76 / 0.12)" />
                ))}
                <path d={t.profile.hRf.map((h, i) => `${i ? "L" : "M"}${x(h).toFixed(1)},${y(t.profile.processed[i]).toFixed(1)}`).join(" ")} fill="none" stroke="#1b2d57" strokeWidth={1.5} />
                {t.spots.map((s: EvaluatedSpot) => (
                  <text key={s.number} x={x(s.peak.maxHrf)} y={20} textAnchor="middle" fontSize={11} fill="#e0344c" fontWeight={700}>
                    {s.number}
                  </text>
                ))}
                {[0, 50, 100].map((h) => (
                  <text key={h} x={x(h)} y={H - 6} textAnchor="middle" fontSize={10} fill="#5a6680">
                    {h}
                  </text>
                ))}
              </svg>
              <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-xs">
                <thead className="text-left uppercase tracking-wide text-muted">
                  <tr>
                    <th>#</th>
                    <th>Start</th>
                    <th>Max</th>
                    <th>End</th>
                    <th>Rf</th>
                    <th>Height</th>
                    <th>Area</th>
                    <th>Compound</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line font-mono">
                  {t.spots.map((s: EvaluatedSpot) => (
                    <tr key={s.number}>
                      <td className="py-1">{s.number}</td>
                      <td>{fmt(s.window.startHrf)}</td>
                      <td>{fmt(s.peak.maxHrf)}</td>
                      <td>{fmt(s.window.endHrf)}</td>
                      <td className="font-semibold">{s.rf.toFixed(3)}</td>
                      <td>{fmt(s.peak.height)}</td>
                      <td>{fmt(s.peak.area, 0)}</td>
                      <td className="font-sans">{s.compound || "—"}</td>
                      <td className="font-sans text-muted">{s.source === "MANUAL" ? "by hand" : "auto"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          );
        })}
      </div>
      <RfTable evaluation={r.rf} title="Result" />
      <div className="flex flex-wrap items-center gap-3">
        <button className={secondary} onClick={() => void check()} disabled={busy}>
          {busy ? "Recomputing…" : "Verify: recompute from the original image"}
        </button>
        {verify && (
          <Badge tone={verify.ok ? "pass" : "fail"}>{verify.ok ? "INTACT: RECOMPUTED RESULTS MATCH" : "MISMATCH"}</Badge>
        )}
      </div>
      {verify && (
        <ul className="text-xs text-muted">
          {Object.entries(verify.checks).map(([k, v]) => (
            <li key={k}>
              {v.ok ? "✓" : "✗"} {k.replace(/([A-Z])/g, " $1").toLowerCase()}
              {v.stored && v.recomputed && v.stored !== v.recomputed ? ` — stored ${v.stored.slice(0, 12)}…, recomputed ${v.recomputed.slice(0, 12)}…` : ""}
            </li>
          ))}
        </ul>
      )}
      {error && <Callout tone="fail">{error}</Callout>}
    </div>
  );
}
