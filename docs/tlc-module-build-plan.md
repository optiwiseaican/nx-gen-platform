# TLC module build plan — porting the TLC Tablet app into NxGen

Written 13 Nov 2026. Source app: `~/Desktop/VishalAP/TLC-Tablet-App` (Android, Kotlin/Compose;
`engine/` ≈ 8.2k LOC pure Kotlin + 3.5k LOC tests; `app/` ≈ 35k LOC, of which UI ≈ 21.6k).
Target: `modules/tlc` in this repo (today v1.0.0: analyses, three plate images, Rf typed in by hand,
signed approval). The approach is the same as the pH port (pH 1.1.0 → 1.8.x): the module's screens
follow the tablet, the science is ported one-to-one and proved against the tablet's own numbers, and
everything the core already provides (users, roles, audit, signatures, workflow, methods, instruments,
licensing) is used rather than copied.

## 1. What is not ported

| Tablet area | Why not |
|---|---|
| Users, roles, 15 permissions, password policy, lockout, admin recovery, session policy | Core already has all of it, and the tablet's unsalted SHA-256 passwords are weaker than the core's. Module permissions stay as the four `tlc.*` codes plus the new ones in §3. |
| Audit trail, hash chain, e-signatures, record states | Core (`audit`, `signatures`, workflow engine). |
| File Manager, managed files | Core reports/export tables cover it; revisit only if the user asks. |
| AMC & service contracts | Not TLC science. If wanted, it belongs in a separate `amc` module, not here. |
| Guided tours, touch-screen specifics, Android camera settings UI | Not applicable on a desktop web app. |
| Compound library from bundled V1 HTML files | Deferred (phase 6); the HTML files can be imported then. |

## 2. Decisions needed before phase 2 (ask the user / hardware team)

1. **Camera.** The tablet uses its own camera. On NxGen the choices are (a) a USB camera read by the
   browser (`getUserMedia`, works in Electron and Chrome), (b) the TLC Scan-10 box captures and sends the
   image, (c) upload only (already exists). The plan assumes **(a) with (c) as fallback**; the capture-QC
   maths is the same either way. Decision affects phase 5 only.
2. **Lamp box link.** Wi-Fi WebSocket box (`ws://192.168.4.1:81/ws`) can be driven from the NestJS
   server directly. The BLE controller cannot be driven from a browser reliably; if BLE is the production
   path, the desktop service (Electron) must bridge it. Decision affects phase 5 only.
3. **Where results are computed.** Recommended: **in the server**, from the stored original image, with
   the same TypeScript engine bundled into the UI for live preview (the pH `shared/` pattern). Stored
   results are then independent of the browser, and regenerating them from the raw image + recipe
   must give identical numbers (PRD reproducibility 1e-9).
4. **Acceptance limits.** The tablet has no r / CV% gate for calibrations and its diagnostic limits
   are "validation pending". NxGen should hold them as **signed acceptance profiles** (as pH does), with
   the tablet's values as defaults, so QA can set them without a code change.

## 3. Target shape of the module

- **Tables (`tlc_` prefix):** `tlc_analyses` (exists, extended), `tlc_images` (exists: raw, immutable,
  SHA-256), `tlc_plates` (crop corners, px/mm, plate size, illumination used for analysis),
  `tlc_tracks`, `tlc_densitograms` (raw vector immutable), `tlc_peaks`, `tlc_evaluations` (E01…
  immutable snapshots: recipe + results + hash), `tlc_method_settings` (per core method version),
  `tlc_calibrations`, `tlc_acceptance_profiles`, `tlc_diagnostic_runs`, `tlc_diagnostic_baselines`,
  `tlc_reactions`, `tlc_comparisons`.
- **Permissions:** existing `tlc.view / analyze / review / approve` plus `tlc.methods` (author TLC
  method settings), `tlc.profiles` (acceptance profiles, signed), `tlc.diagnostics` (run + baseline).
- **Workflows:** `TLC_ANALYSIS_APPROVAL` (exists); methods use the core method approval; profiles and
  baselines use a signed change (`USER_SESSION_CHANGE`-style policy entries).
- **Engine:** `modules/tlc/src/engine/` in TypeScript, no DOM, no native dependencies
  (`pngjs` + `jpeg-js` for decoding; `Float32Array` maths). Shared by API and UI.
- **UI stages** mirror the tablet: Picture → Crop → Plate → Evaluation → Compare → (Reaction), with the
  record list, My Tasks integration and signatures already in place.

## 4. Phases

**Status (13 Nov 2026):** phase 1 done (commit `a748da2`: `modules/tlc/src/engine`, 56 golden cases
reproduced bit for bit). Phase 2 done as tlc 1.1.0 (migration 002, plates and evaluation snapshots,
crop/layout/densitogram screens, recompute check; DB tests and a browser walkthrough pass). The
spot-detection and QC maths in §6 are now in the engine; the acceptance-profile limits (decision 4)
are still to come in phase 4.

Effort is in working sessions of the kind used for pH (one session ≈ one focused day). Each phase ends
with a signed `.nxmod`, module-manager DB tests and a browser walkthrough, like pH.

### Phase 1 — Engine port with golden tests (3–4 sessions)
Port `engine/image`, `engine/plate`, `engine/signal`, `engine/quant`, `engine/stats` exactly:
- channels (INTENSITY 0.299/0.587/0.114, R, G, B), polarity (WHITE/UV254 dark spots, UV366 bright),
  black/white point stretch, 3×3 median;
- geometry in mm (defaults baseline 10, front 70, track width 6), hRf = 100·(y−b)/(f−b),
  plate presets 20×10 … 2.5×7.5 cm (±12 % aspect), homography + bilinear rectify (≤2400 px, ≥5 px/mm);
- plate detection (colour distance from border, Otsu fallback, min-area rectangle);
- baseline/front detection (rolling-median 6 mm, threshold max(4, 8·MAD), ≤1.2 mm half-width, ≥80 %
  width, baseline in bottom 30 %);
- track detection (col+row median background, σ = 1.4826·MAD, prominence ≥ max(0.15·range, 3σ),
  half-height split, width = widest+1 mm capped 0.9·spacing and 40 mm);
- densitogram (one sample per row, AVERAGE/MEDIAN, bilinear), Savitzky–Golay (2 mm, order 2, mirrored),
  background opening 15 mm + moving average, chord baseline, trapezoid integration;
- spot detection (prominence ≥ max(5σ, 4 % range, 3 levels)/sensitivity, min separation 1.5 mm,
  2 hRf end margin, FWHM ≤ 10 mm, window to 5 % height capped 2.5·HWHM), tap-to-peak ±5 hRf;
- quantification: LINEAR_THROUGH_ORIGIN / LINEAR / POLYNOMIAL, r, CV %, by height and area,
  back-calculation (nearest root), bias %, residuals, range flags, replicates (mean/SD/CV), residual
  review (curvature / trend |r|>0.8 / funnel |r|>0.85 n≥5), expected-peak match ±5 hRf;
- capture QC maths (table in §6) and analytical saturation (WARN 0.1 %, invalid 1 %).

**Golden tests:** run the tablet's 37 engine tests' fixtures (`engine/src/test/resources/plates`)
through the Kotlin engine once, save the outputs as JSON, and assert the TypeScript engine reproduces
them (Rf ≤ 0.005, areas ≤ 0.1 %). This is the proof the port is faithful; without it the module cannot
claim the tablet's results.

### Phase 2 — Plate workflow from images (3 sessions) → tlc 1.1.0
Replaces typed-in distances with image-derived results while keeping manual override.
- Crop stage: auto outline or drag corners, rotate, plate size preset/custom, illumination choice.
- Plate stage: baseline/front/tracks auto-detected and editable; track table (name, role STANDARD /
  SAMPLE / BLANK / QC, volume, concentration, dilution, sample ID); RAW / ANALYTICAL / ENHANCED views.
- Evaluation stage: densitogram per track, peaks (auto + manual boundaries), peak table
  (start/max/end hRf, height, area, relative area %), Rf evaluation against method windows (existing).
- Every accept/adjust is a `UserDecision` row with user and time; evaluation saved as an immutable
  snapshot `E01, E02…` with recipe and SHA-256; raw densitogram vectors immutable (guard trigger like
  NXGEN-PH-001).
- Original image + crop + recipe → recompute must reproduce the snapshot (test).

### Phase 3 — TLC methods (2 sessions) → tlc 1.2.0
- `tlc_method_settings` keyed by core `method_versions.id`: plate size, illumination, channel,
  post-processing, track templates (name, centre mm, reference, volume, concentration, dilution),
  densitometry settings, spot sensitivity, expected peaks hRf ± tolerance, camera settings.
- Follows the core method's approval: only APPROVED versions can be applied; editing creates the next
  version (core already does this).
- Apply-to-plate rule from `MethodLayout.kt` (lane count equal → names by position, else template
  positions). Project-level default method.

### Phase 4 — Quantification, reports, acceptance profiles (3 sessions) → tlc 1.3.0
- Calibration tab: model choice (never auto-picked by best R²), standards with exclude-with-reason,
  back-calculated amounts and bias, residual plot and review flags, replicates, range flags
  (never extrapolated), results by sample.
- Acceptance profiles (signed): r min, CV % max, |bias| max (tablet shows 15 % red), saturation limits,
  capture-QC limits. SST failure → results not reportable (already `SST_FAILED`).
- PDF via core `reports/report-pdf.ts`: header, plate & method, plate image with overlay, tracks,
  spots, densitogram charts, calibration, data integrity (image SHA-256, capture metadata), signatures.
  CSV kinds: peaks, spots, profiles, standards, results (UTF-8, dot decimal,
  `<AnalysisID>_<EvaluationID>_<content>.csv`). Report versions RPT v1/v2 recorded with hash.

### Phase 5 — Hardware: capture, lamps, diagnostics (3–4 sessions, after decisions 1–2) → tlc 1.4.0
- Lamp box driver in the server (WebSocket protocol: `status`/`select`/`ping`, events `door`,
  `uv_timeout`; door interlock and 120 s UV limit are in firmware and are surfaced, not re-implemented).
  BLE controller via desktop bridge if required. Simulator kept for tests.
- Capture sequence as the tablet: storage check, plate detect, position check, select lamp → settle
  1500 ms → capture, auto-retake ≤2 when |EV| ≥ 0.3, bracket pick, lamps off in `finally`.
  Capture QC gate (§6) on every image, including uploads.
- Diagnostics: 7 groups / 29 checks, READY / READY WITH WARNING / NOT READY, continue-on-warning with
  reason or signature, admin baselines (previous one retained), per-capture guard that cannot be
  overridden, run history and PDF. Limits come from the acceptance profile.

### Phase 6 — Advanced analysis (3 sessions, order by user priority) → tlc 1.5.0+
- Compare views: overlay, stacked, mirror, difference, heatmap, 3D, waterfall, scatter, box.
- Derivatives D1/D2, shoulder detection, Gaussian/Lorentzian/pseudo-Voigt fitting (LM, ≤300 iterations,
  ≤5 components), profile similarity (hRf 3–97, ±5 hRf alignment, Pearson).
- Reaction monitoring projects (compound assignment ±3 hRf, relative response, endpoint rule,
  trend fits), project comparison (ΔRf 0.02/0.05, criteria with SOP source), compound library.
- Dashboard cards (Need Action / In Progress / My Reviews / Pending Approval) — most of this is the core
  My Tasks page; add only the TLC "next action" resolver.

## 5. Order and dependencies

```
Phase 1 (engine + golden tests)
   └─ Phase 2 (plate workflow)  ── Phase 3 (methods) ── Phase 4 (quant + reports + profiles)
                                                           └─ Phase 5 (hardware)  ── Phase 6 (advanced)
```
Phases 1–4 need no hardware and give a usable product from uploaded or camera images. Phase 5 waits
on the two hardware decisions. Total ≈ 17–20 sessions.

## 6. Capture QC limits to carry over (defaults for the acceptance profile)

Image downscaled to ~1200 px, plate rectified to 480 px; any FAIL → RECAPTURE_REQUIRED, any WARN →
REVIEW, else READY. Exposure target 200, clip 252, EV = log2(200/level) clamped [−2, +3], |EV| ≤ 0.5 OK.

| Check | WARN | FAIL |
|---|---|---|
| Plate share of frame | < 6 % | < 3 % |
| Off-centre | > 0.2 | – |
| Rotation | > 8° | – |
| Perspective | > 10° | > 25° |
| Clipping (WHITE/UV254) | channel > 0.2 % | luma > 2 % |
| Clipping (UV366) | > 0.05 % | > 0.5 % |
| Underexposure (WHITE/UV254) | background < 100 | < 60 or dark fraction > 0.2 |
| Underexposure (UV366) | highlight < 90 | < 40 |
| Uniformity (8 cells, min/max) | < 0.7 | < 0.45 |
| Glare (16 cells) | any hot cell | ≥ 3 % area |
| Obstruction (outline fill) | < 0.93 | < 0.85 |
| Focus (edge width) | > 6 ‰ | > 12 ‰ |
| Stability (motion) | > 4 ‰ | > 12 ‰ |

Lamp diagnostics (validation pending): response ±15 % / ±25 %, uniformity ≥ 70 / 55 %, stability
CV ≤ 2 / 5 %, saturation WARN 0.5 % FAIL 2 %, dark rise 5 / 10, light leak 8 / 15, noise ratio 2 / 3.

## 7. Risks

- **Faithfulness.** Without the golden dataset (phase 1) the port's numbers cannot be defended in a
  validation. Do this first, not last.
- **Image size.** Raw images are 8–40 MB; store once (`tlc_images`, exists), compute from a cached
  rectified copy, never re-encode the original.
- **Two sessions on one module.** Another session is working on `modules/ph` in this repo. Keep TLC
  work in `modules/tlc` and core changes minimal and additive; coordinate before touching
  `module-manager.db.spec.ts`, which both modules' tests live in.
- **Spec drift.** The tablet's `feature-status.md` contradicts itself (§123 vs §§61–72; §122 vs the
  dashboard gap analysis). This plan follows the code, not the status document.
