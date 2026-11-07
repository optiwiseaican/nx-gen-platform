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
npm run build:module:ph                      # builds modules/ph/dist (module.json, api/, ui/, migrations/)
node tools/license-authority/dist/cli.js module-pack \
  --key tools/license-authority/keys/<vendor>.private.pem \
  --dir modules/ph/dist --out dist-modules/nxgen-ph-1.0.0.nxmod
```

Install it in NxGen under **Modules → Choose .nxmod package** (IT Administrator or Super Administrator; reason and
electronic signature). The core checks the Ed25519 signature, every file's SHA-256, the licence entitlement and the
core version; runs the module's prefix-checked migrations (`ph_*` tables only); and re-verifies the files at every
start. Disabling a module hides it and blocks its instruments; its data is kept.

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
