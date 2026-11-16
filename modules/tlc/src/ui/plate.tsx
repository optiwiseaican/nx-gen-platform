/** Types shared by the stage screens, plus the read-only snapshot view and the Rf table. */
import { useState } from "react";
import { RgbImage, argb } from "../engine";
import type { Channel, PostProcessing, Point } from "../engine";
import type { EvaluatedSpot, EvaluationInput, EvaluationResults, ImageQc } from "../api/pipeline";
import { Evaluation, Illumination } from "../shared/tlc";
import { Badge, CONCLUSION, Callout, card, fmtDate, mod, secondary } from "./lib";

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
  qcOverrideReason: string;
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
  qc: ImageQc | null;
  uploadedBy: string | null;
  uploadedAt: string;
}

export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Decodes an image URL into the engine's pixel format through a canvas (PNG: lossless). */
export async function loadPixels(url: string): Promise<RgbImage> {
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
export function svgPoint(svg: SVGSVGElement, e: { clientX: number; clientY: number }): Point {
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height };
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

/** A stored evaluation snapshot (read-only), with the recompute check. */
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
  const image = evaluation.input.image ?? { channel: r.plate.channel, postProcessing: r.plate.postProcessing };
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">Snapshot</dt>
        <dd>
          <b>{evaluation.code}</b> · {evaluation.createdBy} · {fmtDate(evaluation.createdAt)} · engine {evaluation.engineVersion}
        </dd>
        <dt className="text-muted">Analytical image</dt>
        <dd>
          {image.channel.toLowerCase()} channel, levels {image.postProcessing.blackPoint}–{image.postProcessing.whitePoint}
          {image.postProcessing.denoise ? ", denoised" : ""}
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
          {evaluation.input.settings.densitometry.subtractBackground ? `, background window ${evaluation.input.settings.densitometry.backgroundWindowMm} mm` : ""}, peak detection sensitivity{" "}
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
                      <th>Peak</th>
                      <th>Start hRF</th>
                      <th>Max hRF</th>
                      <th>End hRF</th>
                      <th>Rf</th>
                      <th>Height</th>
                      <th>Area</th>
                      <th>Compound</th>
                      <th>Status</th>
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
                        <td className="font-sans text-muted">{s.source === "MANUAL" ? "Manual" : "Detected"}</td>
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
        {verify && <Badge tone={verify.ok ? "pass" : "fail"}>{verify.ok ? "INTACT: RECOMPUTED RESULTS MATCH" : "MISMATCH"}</Badge>}
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

export const cardClass = card;
