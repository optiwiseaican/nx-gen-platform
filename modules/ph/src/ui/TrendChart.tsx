import { useEffect, useRef, useState } from "react";

export interface ChartPoint {
  at: number;
  value: number | null;
}

const H = 190;
const M = { top: 12, right: 12, bottom: 26, left: 48 };
const LINE = "#2563eb";
const GRID = "#e3e8f2";
const TEXT = "#5a6680";
const SURFACE = "#ffffff";

function evenly(min: number, max: number, count: number) {
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + step * i);
}

/** Round axis values covering the range, about `count` intervals. */
function roundTicks(min: number, max: number, count = 4) {
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * power).find((n) => n >= rough) ?? 10 * power;
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step);
  return Array.from({ length: last - first + 1 }, (_, i) => (first + i) * step);
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * One measure over time, on its own axis. A silence longer than `maxGapMs`
 * breaks the line, so no reading is implied where none arrived.
 */
export function TrendChart({ title, unit, digits, points, from, to, maxGapMs, minSpan, thresholds = [] }: {
  title: string;
  unit: string;
  digits: number;
  points: ChartPoint[];
  from: number;
  to: number;
  maxGapMs: number;
  minSpan: number;
  thresholds?: { value: number; label: string }[];
}) {
  const ref = useRef<SVGSVGElement>(null);
  // Drawn at its real width, so the text stays one size however wide the chart is.
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [hover, setHover] = useState<{ x: number; y: number; point: ChartPoint & { value: number } } | null>(null);
  const valid = points.filter((p): p is ChartPoint & { value: number } => typeof p.value === "number");
  const latest = valid[valid.length - 1] ?? null;
  const values = [...valid.map((p) => p.value), ...thresholds.map((t) => t.value)];
  let low = values.length ? Math.min(...values) : 0;
  let high = values.length ? Math.max(...values) : minSpan;
  if (high - low < minSpan) {
    const mid = (high + low) / 2;
    low = mid - minSpan / 2;
    high = mid + minSpan / 2;
  }
  const yTicks = roundTicks(low, high);
  low = yTicks[0];
  high = yTicks[yTicks.length - 1];
  const axisDigits = Math.max(0, Math.min(digits, Math.ceil(-Math.log10(yTicks[1] - yTicks[0]) + 1e-9) + 1));
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const x = (at: number) => M.left + ((at - from) / Math.max(1, to - from)) * innerW;
  const y = (v: number) => M.top + innerH - ((v - low) / (high - low)) * innerH;

  let d = "";
  valid.forEach((p, i) => {
    const joined = i > 0 && p.at - valid[i - 1].at <= maxGapMs;
    d += `${joined ? "L" : "M"}${x(p.at).toFixed(1)} ${y(p.value).toFixed(1)}`;
  });

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !valid.length) return;
    const at = from + (((e.clientX - box.left) / box.width) * W - M.left) * ((to - from) / innerW);
    const point = valid.reduce((a, b) => (Math.abs(b.at - at) < Math.abs(a.at - at) ? b : a));
    setHover({ x: x(point.at), y: y(point.value), point });
  }

  return (
    <figure className="m-0">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-bold">{title}</span>
        <span className="font-mono text-sm tabular-nums">{latest ? `${latest.value.toFixed(digits)} ${unit}` : "—"}</span>
      </figcaption>
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`${title} over time${latest ? `, latest ${latest.value.toFixed(digits)} ${unit}` : ", no readings"}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          style={{ touchAction: "pan-y", display: "block" }}
        >
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
              <text x={M.left - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={TEXT}>{v.toFixed(axisDigits)}</text>
            </g>
          ))}
          {evenly(from, to, W < 420 ? 2 : 4).map((t, i, all) => (
            <text key={t} x={x(t)} y={H - 7} textAnchor={i === 0 ? "start" : i === all.length - 1 ? "end" : "middle"} fontSize={11} fill={TEXT}>{clock(t)}</text>
          ))}
          {thresholds.map((t) => (
            <g key={t.label}>
              <line x1={M.left} x2={W - M.right} y1={y(t.value)} y2={y(t.value)} stroke={TEXT} strokeWidth={1} strokeDasharray="4 4" />
              <text x={W - M.right} y={y(t.value) - 4} textAnchor="end" fontSize={11} fill={TEXT} stroke={SURFACE} strokeWidth={3} paintOrder="stroke">{t.label}</text>
            </g>
          ))}
          {d && <path d={d} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {latest && !hover && <circle cx={x(latest.at)} cy={y(latest.value)} r={4} fill={LINE} stroke={SURFACE} strokeWidth={2} />}
          {hover && (
            <>
              <line x1={hover.x} x2={hover.x} y1={M.top} y2={M.top + innerH} stroke={TEXT} strokeWidth={1} />
              <circle cx={hover.x} cy={hover.y} r={4} fill={LINE} stroke={SURFACE} strokeWidth={2} />
            </>
          )}
          {!valid.length && (
            <text x={M.left + innerW / 2} y={M.top + innerH / 2} textAnchor="middle" fontSize={13} fill={TEXT}>No readings in this period</text>
          )}
        </svg>
        {hover && (
          <div
            className="pointer-events-none absolute top-1 rounded-md border border-line bg-white px-2 py-1 text-xs shadow"
            style={hover.x > W / 2 ? { right: `${((W - hover.x) / W) * 100 + 1}%` } : { left: `${(hover.x / W) * 100 + 1}%` }}
          >
            <b className="font-mono tabular-nums">{hover.point.value.toFixed(digits)} {unit}</b>
            <span className="ml-2 text-muted">{new Date(hover.point.at).toLocaleTimeString()}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
