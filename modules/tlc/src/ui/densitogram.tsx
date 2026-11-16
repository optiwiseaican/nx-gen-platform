/**
 * Densitogram chart, ported from the TLC tablet's DensitogramPlot.kt (same views, colours, tools
 * and labels), drawn as SVG at the element's real pixel size.
 *
 * SINGLE: one track's processed (or raw) signal with its baseline, integration areas, boundaries
 * and labelled peaks. OVERLAY: all shown tracks on one axis. STACKED: tracks offset vertically (the
 * axis then shows a scale bar instead of values, since the offsets are for display only).
 *
 * Tools decide what a drag does: Zoom (drag sideways for hRF, up/down for intensity, a box for
 * both), Pan, Cursor (read-out). With no tool a drag pans once zoomed. Ctrl/⌘ + wheel or a trackpad
 * pinch zooms hRF about the pointer (Shift for intensity). A drag that starts on a boundary of the
 * selected peak moves that boundary when boundary editing is on.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "../engine";

export type ChartMode = "SINGLE" | "OVERLAY" | "STACKED";
export const CHART_MODES: { mode: ChartMode; label: string }[] = [
  { mode: "SINGLE", label: "Single Track" },
  { mode: "OVERLAY", label: "Overlay" },
  { mode: "STACKED", label: "Stacked" },
];
export type ChartTool = "NONE" | "ZOOM" | "PAN" | "CURSOR";

/** Visible hRF range; y follows the visible data unless fixed. Shared by the main and derivative charts. */
export interface Viewport {
  x0: number;
  x1: number;
  yRange: [number, number] | null;
  cursor: number | null;
}
export const FULL_VIEW: Viewport = { x0: 0, x1: 100, yRange: null, cursor: null };
export const isZoomed = (v: Viewport) => v.x0 > 0.01 || v.x1 < 99.99 || v.yRange !== null;

function setX(v: Viewport, a: number, b: number): Viewport {
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  if (hi - lo < 2) {
    const c = (lo + hi) / 2;
    lo = c - 1;
    hi = c + 1;
  }
  const w = hi - lo;
  if (lo < 0) {
    lo = 0;
    hi = Math.min(100, w);
  }
  if (hi > 100) {
    hi = 100;
    lo = Math.max(0, 100 - w);
  }
  return { ...v, x0: lo, x1: hi };
}
function setY(v: Viewport, a: number, b: number): Viewport {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return hi - lo > 1e-9 && Number.isFinite(lo) && Number.isFinite(hi) ? { ...v, yRange: [lo, hi] } : v;
}
function zoomAt(v: Viewport, center: number, factor: number): Viewport {
  const w = Math.min(100, Math.max(2, (v.x1 - v.x0) / factor));
  const t = (center - v.x0) / (v.x1 - v.x0);
  return setX(v, center - t * w, center - t * w + w);
}
function zoomYAt(v: Viewport, center: number, factor: number, [a, b]: [number, number]): Viewport {
  const h = (b - a) / factor;
  const t = (center - a) / (b - a);
  return setY(v, center - t * h, center - t * h + h);
}

export interface PlotPeak {
  number: number;
  startHrf: number;
  endHrf: number;
  apexHrf: number;
  selected: boolean;
}
export interface PlotTrack {
  id: number;
  label: string;
  profile: Profile;
  color: string;
  reference?: boolean;
}
export interface PlotBand {
  startHrf: number;
  endHrf: number;
  label: string;
  color: string;
}

export const PlotColors = {
  Processed: "#1E4FD8",
  Raw: "#8A939B",
  Baseline: "#E53935",
  Axis: "#5D6B68",
  Grid: "rgb(22 32 30 / 0.1)",
  Text: "#16201E",
  Derivative: "#8E4EC6",
  Peaks: ["#2E9D4A", "#3F6FE0", "#E5484D", "#8E4EC6", "#E08A1E", "#0F9BA8"],
};
export const TRACK_PALETTE = ["#1F77B4", "#D62728", "#2CA02C", "#9467BD", "#FF7F0E", "#8C564B", "#E377C2", "#17BECF"];
const REFERENCE_COLOR = "#16201E";
const peakColor = (n: number) => PlotColors.Peaks[(((n - 1) % PlotColors.Peaks.length) + PlotColors.Peaks.length) % PlotColors.Peaks.length];

const PAD_L = 62;
const PAD_R = 14;
const PAD_R_AXIS = 52;
const PAD_T = 50;
const PAD_B = 44;
const PAD_T_COMPACT = 26;
const PAD_B_NO_TITLE = 26;
const ZOOM_MIN_PX = 24;

function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return mag * (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10);
}
function niceRange(lo: number, hi: number): [number, number] {
  if (Math.abs(hi - lo) < 1e-9) return [lo - 1, hi + 1];
  const step = niceStep((hi - lo) / 5);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}
function ticks(lo: number, hi: number): number[] {
  const step = niceStep((hi - lo) / 6);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}
function fmtTick(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(2);
}
const fmtValue = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

/** Signal values inside the hRF window, between edge and 100 − edge (all visible values if none). */
function interiorVisible(p: Profile, v: Viewport, edge: number): number[] {
  const inWindow: number[] = [];
  const inner: number[] = [];
  for (let i = 0; i < p.size; i++) {
    const h = p.hRf[i];
    if (h < v.x0 || h > v.x1) continue;
    inWindow.push(p.signal[i]);
    if (h >= edge && h <= 100 - edge) inner.push(p.signal[i]);
  }
  return inner.length ? inner : inWindow;
}
function interiorRange(p: Profile): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p.size; i++)
    if (p.hRf[i] >= 3 && p.hRf[i] <= 97) {
      lo = Math.min(lo, p.signal[i]);
      hi = Math.max(hi, p.signal[i]);
    }
  return lo <= hi ? [lo, hi] : [Math.min(...p.signal), Math.max(...p.signal)];
}
const chartFloor = (p: Profile) => Math.min(0, Math.min(...p.signal));
const minOf = (a: number[]) => a.reduce((m, x) => (x < m ? x : m), Infinity);
const maxOf = (a: number[]) => a.reduce((m, x) => (x > m ? x : m), -Infinity);

/** Scales a profile to 0–100 % of its interior maximum (Normalized response). */
export function normalizeToMax(p: Profile): Profile {
  const [, hi] = interiorRange(p);
  const k = hi > 1e-9 ? 100 / hi : 1;
  return p.withSignal(p.signal.map((s) => s * k));
}

export interface DensitogramProps {
  mode: ChartMode;
  viewport: Viewport;
  onViewport: (v: Viewport) => void;
  height: number;
  processed?: Profile | null;
  raw?: Profile | null;
  showProcessed?: boolean;
  peakBaselines?: boolean;
  peaks?: PlotPeak[];
  tracks?: PlotTrack[];
  selectedTrackId?: number | null;
  showLabels?: boolean;
  showBaseline?: boolean;
  showArea?: boolean;
  showLegend?: boolean;
  showGrid?: boolean;
  yLabel?: string;
  seriesLabel?: string;
  seriesColor?: string;
  zeroLine?: boolean;
  fitInterior?: boolean;
  compact?: boolean;
  xTitle?: boolean;
  bands?: PlotBand[];
  tool?: ChartTool;
  editBoundaries?: boolean;
  crosshair?: boolean;
  ariaLabel: string;
  onSelectPeak?: (n: number) => void;
  onSelectTrack?: (id: number) => void;
  onTapHrf?: (h: number) => void;
  onBoundary?: (n: number, start: boolean, h: number) => void;
}

export function DensitogramPlot(props: DensitogramProps) {
  const {
    mode,
    viewport,
    onViewport,
    height,
    processed = null,
    raw = null,
    showProcessed = true,
    peakBaselines = true,
    peaks = [],
    tracks = [],
    selectedTrackId = null,
    showLabels = true,
    showBaseline = true,
    showArea = true,
    showLegend = true,
    showGrid = true,
    yLabel = "Intensity (AU)",
    seriesLabel,
    seriesColor,
    zeroLine = false,
    fitInterior = false,
    compact = false,
    xTitle = true,
    bands = [],
    tool = "NONE",
    editBoundaries = false,
    crosshair = false,
  } = props;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, Math.floor(el.getBoundingClientRect().width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const main = showProcessed ? processed : raw;

  // y range: what is visible inside the hRF window (the tablet's rules per view).
  const stackStep = useMemo(
    () => (mode === "STACKED" && tracks.length ? Math.max(1e-6, maxOf(tracks.map((t) => { const [lo, hi] = interiorRange(t.profile); return hi - lo; }))) * 0.75 : 0),
    [mode, tracks],
  );
  const [autoLo, autoHi] = useMemo((): [number, number] => {
    if (mode === "STACKED") {
      const lo = tracks.length ? minOf(tracks.map((t) => interiorRange(t.profile)[0])) : 0;
      const hi = (tracks.length ? maxOf(tracks.map((t) => interiorRange(t.profile)[1])) : 1) + stackStep * Math.max(0, tracks.length - 1);
      return niceRange(lo, hi + (hi - lo) * 0.08);
    }
    const visible: number[] =
      mode === "SINGLE"
        ? main
          ? interiorVisible(main, viewport, fitInterior ? 3 : 2)
          : []
        : tracks.flatMap((t) => t.profile.signal.filter((_, i) => t.profile.hRf[i] >= viewport.x0 && t.profile.hRf[i] <= viewport.x1 && (!fitInterior || (t.profile.hRf[i] >= 3 && t.profile.hRf[i] <= 97))));
    if (fitInterior && visible.length > 20) {
      const sorted = [...visible].sort((a, b) => a - b);
      const lo = sorted[Math.floor(sorted.length * 0.01)];
      const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
      const pad = (hi - lo) * 0.1;
      return niceRange(Math.min(lo - pad, 0), Math.max(hi + pad, 0));
    }
    const lo = visible.length ? minOf(visible) : 0;
    const hi = visible.length ? maxOf(visible) : 1;
    if (mode === "SINGLE") {
      // Fit tightly so peaks fill the height; leave room above the tallest peak for its label.
      const span = hi - Math.min(lo, 0) > 1e-9 ? hi - Math.min(lo, 0) : 1;
      return [Math.min(lo, 0) - span * 0.03, hi + span * (showLabels && peaks.length ? 0.16 : 0.05)];
    }
    return niceRange(Math.min(lo, 0), hi + (hi - lo) * 0.12);
  }, [mode, tracks, main, viewport, fitInterior, showLabels, peaks.length, stackStep]);
  const [y0, y1] = viewport.yRange ?? [autoLo, autoHi];

  // Raw overlay in the Processed view: own scale (right axis), mapped onto the plot height.
  const rawScale = useMemo((): [number, number] | null => {
    if (mode !== "SINGLE" || !showProcessed || !raw) return null;
    const v = interiorVisible(raw, viewport, 2);
    if (!v.length) return null;
    const lo = minOf(v);
    const hi = maxOf(v);
    return hi > lo ? niceRange(lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.12) : null;
  }, [mode, showProcessed, raw, viewport]);
  const rawToY = (v: number) => (rawScale ? y0 + ((v - rawScale[0]) / (rawScale[1] - rawScale[0])) * (y1 - y0) : v);

  const padTop = compact ? PAD_T_COMPACT : PAD_T;
  const padBottom = xTitle ? PAD_B : PAD_B_NO_TITLE;
  const padRight = rawScale ? PAD_R_AXIS : PAD_R;
  const plot = { left: PAD_L, top: padTop, right: width - padRight, bottom: height - padBottom };
  const pw = plot.right - plot.left;
  const ph = plot.bottom - plot.top;
  const px = (h: number) => plot.left + ((h - viewport.x0) / (viewport.x1 - viewport.x0)) * pw;
  const py = (v: number) => plot.bottom - ((v - y0) / (y1 - y0)) * ph;
  const xOf = (p: number) => viewport.x0 + ((p - plot.left) / pw) * (viewport.x1 - viewport.x0);
  const yOf = (p: number) => y0 + ((plot.bottom - p) / ph) * (y1 - y0);
  const unit = yLabel.includes("%") ? "%" : "AU";

  const pathOf = (hRf: number[], values: number[]) => {
    let d = "";
    for (let i = 0; i < hRf.length; i++) d += `${i ? "L" : "M"}${px(hRf[i]).toFixed(1)},${py(values[i]).toFixed(1)}`;
    return d;
  };

  // ---- pointer interaction ----
  const svg = useRef<SVGSVGElement>(null);
  const action = useRef<{ kind: "zoom" | "pan" | "cursor" | "boundary" | "tap"; start: { x: number; y: number }; last: { x: number; y: number }; peak?: number; startEdge?: boolean } | null>(null);
  const [zoomBox, setZoomBox] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inPlot = (p: { x: number; y: number }) => p.x >= plot.left && p.x <= plot.right && p.y >= plot.top - 30 && p.y <= plot.bottom;

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = local(e);
    if (!inPlot(p)) return;
    let kind: NonNullable<typeof action.current>["kind"] = "tap";
    let peak: number | undefined;
    let startEdge: boolean | undefined;
    const sel = peaks.find((k) => k.selected);
    if (tool === "CURSOR") {
      kind = "cursor";
      onViewport({ ...viewport, cursor: Math.min(100, Math.max(0, xOf(p.x))) });
    } else if (mode === "SINGLE" && editBoundaries && sel && Math.min(Math.abs(p.x - px(sel.startHrf)), Math.abs(p.x - px(sel.endHrf))) <= 12) {
      kind = "boundary";
      peak = sel.number;
      startEdge = Math.abs(p.x - px(sel.startHrf)) <= Math.abs(p.x - px(sel.endHrf));
    } else if (tool === "ZOOM") kind = "zoom";
    else if (tool === "PAN" || isZoomed(viewport)) kind = "pan";
    action.current = { kind, start: p, last: p, peak, startEdge };
    svg.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const a = action.current;
    if (!a) return;
    const p = local(e);
    const moved = Math.hypot(p.x - a.start.x, p.y - a.start.y) > 4;
    if (a.kind === "boundary") props.onBoundary?.(a.peak!, a.startEdge!, Math.min(100, Math.max(0, xOf(p.x))));
    else if (a.kind === "cursor") onViewport({ ...viewport, cursor: Math.min(100, Math.max(0, xOf(p.x))) });
    else if (a.kind === "zoom" && moved) setZoomBox({ a: a.start, b: p });
    else if (a.kind === "pan" && moved) {
      const dx = p.x - a.last.x;
      const dy = p.y - a.last.y;
      let v = setX(viewport, viewport.x0 - (dx / pw) * (viewport.x1 - viewport.x0), viewport.x1 - (dx / pw) * (viewport.x1 - viewport.x0));
      if (viewport.yRange) v = setY(v, y0 + (dy / ph) * (y1 - y0), y1 + (dy / ph) * (y1 - y0));
      onViewport(v);
    }
    a.last = p;
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const a = action.current;
    action.current = null;
    if (!a) return;
    const p = local(e);
    const tap = Math.hypot(p.x - a.start.x, p.y - a.start.y) <= 4;
    if (a.kind === "zoom" && zoomBox) {
      const zx = Math.abs(zoomBox.a.x - zoomBox.b.x) > ZOOM_MIN_PX;
      const zy = Math.abs(zoomBox.a.y - zoomBox.b.y) > ZOOM_MIN_PX;
      let v = viewport;
      if (zy) v = setY(v, yOf(zoomBox.a.y), yOf(zoomBox.b.y));
      if (zx) v = setX(v, Math.min(100, Math.max(0, xOf(zoomBox.a.x))), Math.min(100, Math.max(0, xOf(zoomBox.b.x))));
      onViewport(v);
      setZoomBox(null);
      return;
    }
    setZoomBox(null);
    if (!tap || a.kind === "boundary" || a.kind === "cursor") return;
    const h = xOf(p.x);
    if (h < 0 || h > 100) return;
    if (mode === "SINGLE") {
      const hits = peaks.filter((k) => h >= k.startHrf - 0.5 && h <= k.endHrf + 0.5).sort((m, n) => Math.abs(m.apexHrf - h) - Math.abs(n.apexHrf - h));
      if (hits.length) props.onSelectPeak?.(hits[0].number);
      else props.onTapHrf?.(h);
    } else if (mode === "STACKED") {
      const yv = yOf(p.y);
      let best: PlotTrack | null = null;
      let bestD = Infinity;
      tracks.forEach((t, i) => {
        const d = Math.abs(t.profile.signal[t.profile.indexOf(h)] + i * stackStep - yv);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      });
      if (best) props.onSelectTrack?.((best as PlotTrack).id);
    }
  };
  // Ctrl/⌘ + wheel (and trackpad pinch) zooms: hRF about the pointer, or intensity with Shift.
  const latest = useRef({ viewport, onViewport, xOf, yOf, y0, y1, inPlot });
  latest.current = { viewport, onViewport, xOf, yOf, y0, y1, inPlot };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const L = latest.current;
      const r = el.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!L.inPlot(p)) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.01);
      L.onViewport(e.shiftKey ? zoomYAt(L.viewport, L.yOf(p.y), factor, [L.y0, L.y1]) : zoomAt(L.viewport, L.xOf(p.x), factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- drawing ----
  const clipId = useMemo(() => `clip-${Math.random().toString(36).slice(2)}`, []);
  const xTicks = ticks(viewport.x0, viewport.x1);
  const yTicks = ticks(y0, y1);
  const mainColor = seriesColor ?? (showProcessed ? PlotColors.Processed : PlotColors.Raw);

  const peakArea = (p: Profile, k: PlotPeak) => {
    const i0 = p.indexOf(k.startHrf);
    const i1 = Math.min(p.size - 1, Math.max(i0 + 1, p.indexOf(k.endHrf)));
    if (i1 <= i0) return null;
    let d = `M${px(p.hRf[i0])},${py(p.signal[i0])}`;
    for (let i = i0; i <= i1; i++) d += `L${px(p.hRf[i])},${py(p.signal[i])}`;
    if (!peakBaselines) {
      const floor = py(chartFloor(p));
      d += `L${px(p.hRf[i1])},${floor}L${px(p.hRf[i0])},${floor}`;
    }
    return <path key={`a${k.number}`} d={d + "Z"} fill={peakColor(k.number)} fillOpacity={k.selected ? 0.38 : 0.22} />;
  };
  const chord = (p: Profile, k: PlotPeak) => {
    const i0 = p.indexOf(k.startHrf);
    const i1 = Math.min(p.size - 1, Math.max(i0 + 1, p.indexOf(k.endHrf)));
    return <line key={`c${k.number}`} x1={px(p.hRf[i0])} y1={py(p.signal[i0])} x2={px(p.hRf[i1])} y2={py(p.signal[i1])} stroke={PlotColors.Baseline} strokeWidth={1.5} strokeDasharray="9 6" />;
  };
  const peakMarks = (p: Profile, k: PlotPeak) => {
    const c = peakColor(k.number);
    const apex = { x: px(k.apexHrf), y: py(p.signal[p.indexOf(k.apexHrf)]) };
    const top = Math.max(plot.top, apex.y - 18);
    const stroke = k.selected ? 2 : 1.2;
    const labelY = Math.max(plot.top - 28, apex.y - 10);
    return (
      <g key={`m${k.number}`}>
        {[k.startHrf, k.endHrf].map((h, i) => (
          <g key={i}>
            <line x1={px(h)} x2={px(h)} y1={top} y2={plot.bottom} stroke={c} strokeWidth={stroke} strokeDasharray="7 5" />
            {k.selected && <circle cx={px(h)} cy={plot.bottom - 2} r={editBoundaries ? 7 : 5} fill={c} className={editBoundaries ? "cursor-ew-resize" : ""} />}
          </g>
        ))}
        <circle cx={apex.x} cy={apex.y} r={k.selected ? 5.5 : 4} fill={c} />
        {k.selected && <circle cx={apex.x} cy={apex.y} r={2} fill="#fff" />}
        {showLabels && (
          <text x={apex.x} y={labelY} textAnchor="middle" fill={PlotColors.Text}>
            <tspan x={apex.x} dy={-14} fontSize={13} fontWeight={700}>
              P{k.number}
            </tspan>
            <tspan x={apex.x} dy={14} fontSize={11.5}>
              hRF {k.apexHrf.toFixed(1)}
            </tspan>
          </text>
        )}
      </g>
    );
  };

  const lineColor = (t: PlotTrack) => (t.reference ? REFERENCE_COLOR : t.color);
  const lineWidth = (t: PlotTrack) => (t.id === selectedTrackId ? 3 : t.reference ? 2.4 : 1.7);

  // Legend entries.
  const legend: { label: string; color: string; dashed: boolean }[] =
    mode === "SINGLE"
      ? seriesLabel
        ? [{ label: seriesLabel, color: seriesColor ?? PlotColors.Processed, dashed: false }]
        : [
            ...(showProcessed ? [{ label: "Processed signal", color: PlotColors.Processed, dashed: false }] : []),
            ...(raw ? [{ label: "Raw signal", color: PlotColors.Raw, dashed: showProcessed }] : []),
            ...(showBaseline ? [{ label: "Baseline", color: PlotColors.Baseline, dashed: true }] : []),
          ]
      : tracks.slice(0, 8).map((t) => ({ label: t.label + (t.reference ? " (reference)" : ""), color: lineColor(t), dashed: !!t.reference }));
  const legendItems: { x: number; y: number; item: (typeof legend)[number] }[] = [];
  {
    let lx = plot.left + 12;
    let ly = compact ? 4 : 8;
    for (const item of legend) {
      const w = 34 + item.label.length * 6.6 + 18;
      if (lx + w > plot.right) {
        lx = plot.left + 12;
        ly += 16;
      }
      legendItems.push({ x: lx, y: ly, item });
      lx += w;
    }
  }

  // Cursor read-out.
  const cursor = (() => {
    const h = viewport.cursor;
    if (h === null || h < viewport.x0 || h > viewport.x1) return null;
    const rows: { label: string; v: number; color: string }[] =
      mode === "SINGLE"
        ? main
          ? [
              { label: seriesLabel?.split(" ·")[0] ?? (showProcessed ? "Processed" : "Raw"), v: main.signal[main.indexOf(h)], color: mainColor },
              ...(showProcessed && raw ? [{ label: "Raw", v: raw.signal[raw.indexOf(h)], color: PlotColors.Raw }] : []),
            ]
          : []
        : tracks.map((t) => ({ label: t.label, v: t.profile.signal[t.profile.indexOf(h)], color: lineColor(t) }));
    const points: { v: number; color: string }[] =
      mode === "SINGLE"
        ? main
          ? [{ v: main.signal[main.indexOf(h)], color: mainColor }]
          : []
        : mode === "STACKED"
          ? tracks.map((t, i) => ({ v: t.profile.signal[t.profile.indexOf(h)] + i * stackStep, color: lineColor(t) }))
          : tracks.map((t) => ({ v: t.profile.signal[t.profile.indexOf(h)], color: lineColor(t) }));
    const inPeak = mode === "SINGLE" ? peaks.find((k) => h >= k.startHrf && h <= k.endHrf) : undefined;
    const title = `hRF ${h.toFixed(1)}${inPeak ? `  ·  Peak P${inPeak.number}` : ""}`;
    const lines = rows.slice(0, 10).map((r) => `${r.label}   ${fmtValue(r.v)} ${unit}`);
    const w = Math.max(title.length * 7.4, ...lines.map((l) => l.length * 6.8)) + 22;
    const hh = 22 + lines.length * 16;
    const x = px(h);
    const left = x + 12 + w <= plot.right ? x + 12 : x - 12 - w;
    return (
      <g pointerEvents="none">
        <line x1={x} x2={x} y1={plot.top} y2={plot.bottom} stroke="rgb(22 32 30 / 0.8)" strokeWidth={1.2} />
        {points.length === 1 && <line x1={plot.left} x2={plot.right} y1={py(points[0].v)} y2={py(points[0].v)} stroke="rgb(22 32 30 / 0.4)" strokeDasharray="6 5" />}
        {points.map((pt, i) => (
          <g key={i}>
            <circle cx={x} cy={py(pt.v)} r={5.5} fill="#fff" />
            <circle cx={x} cy={py(pt.v)} r={4} fill={pt.color} />
          </g>
        ))}
        <rect x={left} y={plot.top + 6} width={w} height={hh} rx={7} fill="#fff" stroke="rgb(22 32 30 / 0.2)" />
        <text x={left + 11} y={plot.top + 22} fontSize={12.5} fontWeight={700} fill={PlotColors.Text}>
          {title}
        </text>
        {lines.map((l, i) => (
          <text key={i} x={left + 11} y={plot.top + 38 + i * 16} fontSize={11.5} fontWeight={500} fill={rows[i].color}>
            {l}
          </text>
        ))}
      </g>
    );
  })();

  const cursorClass = tool === "CURSOR" || tool === "ZOOM" || crosshair ? "cursor-crosshair" : tool === "PAN" || isZoomed(viewport) ? "cursor-grab" : editBoundaries ? "cursor-col-resize" : "";

  return (
    <div ref={box} className="w-full" style={{ height }}>
      <svg
        ref={svg}
        width={width}
        height={height}
        role="img"
        aria-label={props.ariaLabel}
        className={`touch-none select-none ${cursorClass}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => ((action.current = null), setZoomBox(null))}
        fontFamily="Roboto, system-ui, sans-serif"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={plot.left} y={plot.top - 40} width={pw} height={ph + 40} />
          </clipPath>
        </defs>
        {/* Raw axis on the right */}
        {rawScale && (
          <g>
            <line x1={plot.right} x2={plot.right} y1={plot.top} y2={plot.bottom} stroke={PlotColors.Raw} strokeWidth={1.2} />
            {ticks(rawScale[0], rawScale[1]).map((v) => {
              const yy = plot.bottom - ((v - rawScale[0]) / (rawScale[1] - rawScale[0])) * ph;
              return (
                <g key={v}>
                  <line x1={plot.right} x2={plot.right + 5} y1={yy} y2={yy} stroke={PlotColors.Raw} />
                  <text x={plot.right + 8} y={yy + 4} fontSize={11} fill={PlotColors.Raw}>
                    {fmtTick(v)}
                  </text>
                </g>
              );
            })}
            <text x={plot.right + 8} y={plot.top - 8} fontSize={11} fontWeight={600} fill={PlotColors.Raw}>
              Raw
            </text>
          </g>
        )}
        {/* Frame: grid, ticks, axes, titles */}
        {xTicks.map((v) => (
          <g key={`x${v}`}>
            {showGrid && <line x1={px(v)} x2={px(v)} y1={plot.top} y2={plot.bottom} stroke={PlotColors.Grid} />}
            <text x={px(v)} y={plot.bottom + 17} textAnchor="middle" fontSize={11.5} fill={PlotColors.Axis}>
              {fmtTick(v)}
            </text>
          </g>
        ))}
        {mode !== "STACKED" &&
          yTicks.map((v) => (
            <g key={`y${v}`}>
              {showGrid && <line x1={plot.left} x2={plot.right} y1={py(v)} y2={py(v)} stroke={PlotColors.Grid} />}
              <text x={plot.left - 8} y={py(v) + 4} textAnchor="end" fontSize={11.5} fill={PlotColors.Axis}>
                {fmtTick(v)}
              </text>
            </g>
          ))}
        <line x1={plot.left} x2={plot.left} y1={plot.top} y2={plot.bottom} stroke={PlotColors.Axis} strokeWidth={1.3} />
        <line x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} stroke={PlotColors.Axis} strokeWidth={1.3} />
        {xTitle && (
          <text x={plot.left + pw / 2} y={height - 6} textAnchor="middle" fontSize={12.5} fill={PlotColors.Axis}>
            hRF
          </text>
        )}
        <text transform={`translate(14 ${plot.top + ph / 2}) rotate(-90)`} textAnchor="middle" dominantBaseline="middle" fontSize={12.5} fill={PlotColors.Axis}>
          {mode === "STACKED" ? `${yLabel}, offset per track` : yLabel}
        </text>
        {/* Bands (method Rf windows) */}
        {bands.map((b) => {
          const l = Math.max(plot.left, px(b.startHrf));
          const r = Math.min(plot.right, px(b.endHrf));
          if (r <= l) return null;
          return (
            <g key={`${b.label}${b.startHrf}`}>
              <rect x={l} y={plot.top} width={r - l} height={ph} fill={b.color} fillOpacity={0.1} />
              <title>{b.label}</title>
            </g>
          );
        })}
        <g clipPath={`url(#${clipId})`}>
          {mode === "SINGLE" && main && (
            <>
              {showArea && peaks.map((k) => peakArea(main, k))}
              {showProcessed && raw && <path d={pathOf(raw.hRf, raw.signal.map(rawToY))} fill="none" stroke={PlotColors.Raw} strokeWidth={1.4} strokeDasharray="9 6" />}
              {showBaseline && (
                <>
                  <line x1={plot.left} x2={plot.right} y1={py(chartFloor(main))} y2={py(chartFloor(main))} stroke={PlotColors.Baseline} strokeWidth={1.4} strokeDasharray="9 6" />
                  {peakBaselines && peaks.map((k) => chord(main, k))}
                </>
              )}
              {zeroLine && <line x1={plot.left} x2={plot.right} y1={py(0)} y2={py(0)} stroke={PlotColors.Axis} strokeOpacity={0.7} strokeWidth={1.2} />}
              <path d={pathOf(main.hRf, main.signal)} fill="none" stroke={mainColor} strokeWidth={seriesColor ? 1.8 : 2.2} strokeLinejoin="round" />
              {peaks.map((k) => peakMarks(main, k))}
            </>
          )}
          {mode === "OVERLAY" &&
            [...tracks].sort((a, b) => Number(!!a.reference) - Number(!!b.reference)).map((t) => <path key={t.id} d={pathOf(t.profile.hRf, t.profile.signal)} fill="none" stroke={lineColor(t)} strokeWidth={lineWidth(t)} strokeDasharray={t.reference ? "9 6" : undefined} />)}
          {mode === "STACKED" &&
            tracks.map((t, i) => {
              const off = i * stackStep;
              const zero = py(chartFloor(t.profile) + off);
              const label = t.label + (t.reference ? " (reference)" : "");
              const labelW = label.length * 6.6;
              const labelLeft = plot.right - labelW - 6;
              let peakTop = zero;
              for (let j = 0; j < t.profile.size; j++) {
                const xx = px(t.profile.hRf[j]);
                if (xx >= labelLeft && xx <= plot.right && t.profile.hRf[j] >= 3 && t.profile.hRf[j] <= 97) peakTop = Math.min(peakTop, py(t.profile.signal[j] + off));
              }
              return (
                <g key={t.id}>
                  <line x1={plot.left} x2={plot.right} y1={zero} y2={zero} stroke={lineColor(t)} strokeOpacity={0.45} strokeDasharray="3 5" />
                  <path d={pathOf(t.profile.hRf, t.profile.signal.map((s) => s + off))} fill="none" stroke={lineColor(t)} strokeWidth={lineWidth(t)} strokeDasharray={t.reference ? "9 6" : undefined} />
                  <text x={labelLeft} y={Math.min(plot.bottom - 4, Math.max(plot.top + 12, peakTop - 6))} fontSize={11.5} fontWeight={600} fill={lineColor(t)}>
                    {label}
                  </text>
                </g>
              );
            })}
        </g>
        {mode === "STACKED" &&
          (() => {
            const step = niceStep((y1 - y0) / 6);
            const len = Math.abs(py(0) - py(step));
            const x = plot.left - 26;
            const bottom = plot.bottom - 6;
            return (
              <g stroke={PlotColors.Axis}>
                <line x1={x} x2={x} y1={bottom} y2={bottom - len} strokeWidth={2} />
                <line x1={x - 5} x2={x + 5} y1={bottom} y2={bottom} strokeWidth={1.6} />
                <line x1={x - 5} x2={x + 5} y1={bottom - len} y2={bottom - len} strokeWidth={1.6} />
                <text x={x} y={bottom - len - 18} textAnchor="middle" fontSize={10.5} fill={PlotColors.Axis} stroke="none">
                  <tspan x={x}>{fmtTick(step)}</tspan>
                  <tspan x={x} dy={12}>
                    {unit}
                  </tspan>
                </text>
              </g>
            );
          })()}
        {zoomBox &&
          (() => {
            const zy = Math.abs(zoomBox.a.y - zoomBox.b.y) > ZOOM_MIN_PX;
            const zx = Math.abs(zoomBox.a.x - zoomBox.b.x) > ZOOM_MIN_PX || !zy;
            const left = zx ? Math.min(zoomBox.a.x, zoomBox.b.x) : plot.left;
            const right = zx ? Math.max(zoomBox.a.x, zoomBox.b.x) : plot.right;
            const top = zy ? Math.min(zoomBox.a.y, zoomBox.b.y) : plot.top;
            const bottom = zy ? Math.max(zoomBox.a.y, zoomBox.b.y) : plot.bottom;
            return <rect x={left} y={top} width={right - left} height={bottom - top} fill="rgb(63 111 224 / 0.13)" stroke="rgb(63 111 224 / 0.6)" strokeWidth={1.2} />;
          })()}
        {cursor}
        {showLegend &&
          legendItems.map(({ x, y, item }) => (
            <g key={item.label}>
              <line x1={x} x2={x + 26} y1={y + 7} y2={y + 7} stroke={item.color} strokeWidth={2.5} strokeDasharray={item.dashed ? "7 4" : undefined} />
              <text x={x + 32} y={y + 11} fontSize={11.5} fill={PlotColors.Text}>
                {item.label}
              </text>
            </g>
          ))}
      </svg>
    </div>
  );
}
