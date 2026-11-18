# Crescent Pharma Compliance Platform

A single compliance platform for laboratory instruments (TLC, pH, spectrophotometer, vision, environmental and stability monitoring). It is designed to meet FDA 21 CFR Part 11, EU Annex 11, GAMP 5, GMP, ALCOA+ and CSV.

The full specification is in `docs/master-specification-v1.0.docx`.

## Structure

| Path | Stack | Purpose |
|---|---|---|
| `apps/web` | Next.js + React + TS | UI |
| `apps/server` | NestJS | API and Compliance Core (audit, e-signatures, licensing, etc.) |
| `apps/desktop` | Electron | Desktop shell for standalone mode |
| `packages/shared` | TypeScript | Types shared by all apps |
| `packages/licensing` | TypeScript | `.nxlic` format, Ed25519 verify, platform binding, fingerprint (shipped) |
| `tools/license-authority` | Node CLI | **Vendor-only** key generation and license issuing — never shipped |

## Licensing (offline activation)

Specs: License & Activation PRD V3.0 + Technical Architecture. Summary of the implementation:

- **License file** `.nxlic`: JSON envelope; Ed25519 signature over `NXGEN-LICENSE-v1\n` + canonical JSON (RFC 8785-compatible) of the payload, with a `keyId` for key rotation.
- **Binding**: primary = Platform Instance UID (`NXG-PLT-XXXX-XXXX`); secondary = weighted, hashed machine fingerprint (RAM/disk/NIC changes tolerated, motherboard swap → `REACTIVATION_REQUIRED`).
- **Activation code** `NXG-XXXX-XXXX-XXXX`: Crockford Base32 + Luhn check char; it selects the package, the signature is the trust anchor.
- **Workstation storage**: activated license is AES-256-GCM encrypted (bound to the platform UID) and **re-verified from its signature at every start**. Clock-rollback evidence is HMAC-protected.
- **Audit**: every activation step is recorded as `SYSTEM_LICENSE_SERVICE` in a hash-chained append-only log (interim until the Postgres audit engine).
- **Errors** `NX-LIC-E001…E010` per PRD, plus E011–E015 extensions (hardware changed, version scope, installation not verified, code mismatch, identity invalid).

### Try it locally

```bash
npm run build -w @crescent/shared -w @crescent/licensing
npm run dev:license -w @crescent/server   # simulates install + issues a dev license, prints the activation code
npm run dev:server                        # restart if it printed "new dev signing key"
npm run dev:web                           # http://localhost:3000 → enter the code
```

### Vendor workflow

```bash
npm run build -w @crescent/license-authority
node tools/license-authority/dist/cli.js keygen --out tools/license-authority/keys/prod --label "NxGen 2026"
# On the workstation (service function): POST /api/licensing/request  → NXR1… code / .nxreq file
node tools/license-authority/dist/cli.js issue --key <keyId>.private.pem --request site.nxreq \
  --customer-id CUST-001 --customer-name "Crescent Pharma" --modules ph,tlc --out site.nxlic
```

## Modules (signed `.nxmod` packages)

Instrument functions are separate modules installed into the core (Technical Architecture §3–§6, Option B).
The first is **pH** (`modules/ph`): pH meters that reach NxGen through the AICAN USB dongle (ESP-NOW → USB serial,
same JSON packets as the LabApp WebSocket app).

```bash
npm run build:modules                        # builds modules/ph/dist and modules/tlc/dist
node tools/license-authority/dist/cli.js module-pack \
  --key tools/license-authority/keys/<vendor>.private.pem \
  --dir modules/tlc/dist --out dist-modules/nxgen-tlc-1.0.0.nxmod     # same for ph
```

Install it in NxGen under **Modules → Choose .nxmod package** (IT Administrator or Super Administrator; reason and
electronic signature). The core checks the Ed25519 signature, every file's SHA-256, the licence entitlement and the
core version; runs the module's prefix-checked migrations (`ph_*` tables only); and re-verifies the files at every
start. Disabling a module hides it and blocks its instruments; its data is kept.

- **TLC** (`modules/tlc`): plate analyses (`TLC-0001`…) on an approved TLC method and a usable instrument; original
  plate images (white / UV 254 / UV 366) stored once with SHA-256; Rf evaluation against the method's Rf windows
  (method parameters with unit `Rf`, e.g. `Paracetamol · 0.40–0.50 · Rf`); signed review and approval; instrument check.
- Contract a module may use: `packages/module-sdk` (core API v1).
- Device gateway: **Instruments → Connections** configures the dongle's serial port. During development,
  `POST /api/gateway/simulator/packets` feeds packets (refused when `NODE_ENV=production`; data is marked simulated).

## Getting started

```bash
npm install
cp .env.example .env
npm run db:up          # Postgres via Docker (or point DATABASE_URL at a local install)
npm run build -w @crescent/shared
npm run dev:server     # http://localhost:4000
npm run dev:web        # http://localhost:3000
npm run dev:desktop    # Electron window loading the web app
```

## Desktop app (local builds)

`npm run package:mac` (on a Mac) or `npm run package:win` (on the Windows PC) writes this computer's settings from
`.env` and builds the app into `apps/desktop/release/`. Windows gets `NxGen-Setup-2.0.0.exe`, which installs for the
current user with Start menu and desktop shortcuts. Build the Windows installer on the lab PC itself: it bundles
`nxgen-camera.exe`, which `tools/camera-helper/build.ps1` builds there against IDS peak.

Windows lab PC, one time:

1. Install Node.js 22, Git, Python 3.10+ (tick "Add python.exe to PATH") and IDS peak; check the camera in IDS peak
   Cockpit, then close Cockpit.
2. `git clone …` and `npm install`. Copy the files git does not carry from the development Mac into the same places
   (USB stick, not email: they hold the database password and private signing keys):
   `.env`, `apps/server/config/database-ca.pem`, `apps/server/config/trusted-license-keys.dev.json`,
   `tools/license-authority/keys/`, and the module packages in `dist-modules/` (e.g. `nxgen-tlc-1.2.1.nxmod`).
3. `npm run build -w @crescent/shared -w @crescent/licensing`, then `npm run dev:license -w @crescent/server`; keep the
   activation code it prints.
4. `npm run package:win`, then run `apps\desktop\release\NxGen-Setup-2.0.0.exe`.
5. Open NxGen and enter the activation code. Install the TLC module under **Modules → Choose .nxmod package** from
   `dist-modules\`. The settings (`%APPDATA%\NxGen\nxgen.env`) use the real camera (`NXGEN_CAMERA=ids`) unless `.env`
   sets `NXGEN_CAMERA`; the service log is `%APPDATA%\NxGen\logs\service.log`.
