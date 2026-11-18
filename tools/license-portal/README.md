# AICAN License Portal (vendor only)

Turns a lab PC's activation request into a licence file locked to that PC (master specification §11). It holds
the private signing key that NxGen installations trust; never ship it to customers.

**Lab PCs have no internet**, so the normal route is offline, with files carried on a USB stick:

1. AICAN creates an activation key for the customer: `keys create …` → `NXG-XXXX-XXXX-XXXX`.
2. The customer installs NxGen and types the key in the installer (or on the activation screen).
3. NxGen shows **Save Activation Request** → `NXG-PLT-….nxreq` (the PC's Platform Instance and hashed hardware IDs,
   no secrets).
4. At AICAN: `keys issue NXG-XXXX-XXXX-XXXX --request NXG-PLT-….nxreq` → `NXG-PLT-….nxlic`
   (or upload it on the portal page `http://127.0.0.1:4100/`).
5. On the lab PC: **Select License File** → activated. NxGen never needs a network.

Each key has a customer, modules, optional expiry and a computer limit (default 1). The same PC asking again
(repair, reinstall keeping `C:\ProgramData\NxGen`) does not use another slot; another PC beyond the limit is
refused (NX-LIC-E018). Online activation (`POST /api/v1/activate`, NxGen built with `NXGEN_LICENSE_PORTAL_URL`) uses
the same rules, for sites that do have internet.

By default the portal runs **offline on this computer**: its own built-in PostgreSQL (the one NxGen ships) in
`~/Library/Application Support/AICAN License Portal` (macOS), started and stopped by the portal and the CLI.

## Run

```bash
npm run build -w @crescent/local-postgres -w @crescent/licensing -w @crescent/license-portal
npm start -w @crescent/license-portal          # http://127.0.0.1:4100/  (Ctrl+C stops it and its database)
```

| Variable | Meaning |
|---|---|
| `PORTAL_DATA_DIR` | where the built-in database lives (default above) |
| `PORTAL_DATABASE_URL` | use this PostgreSQL server instead of the built-in one (e.g. when hosted) |
| `PORTAL_DATABASE_CA_CERT` | CA certificate when the URL uses TLS (`sslmode=require`) |
| `PORTAL_DB_SCHEMA` | default `license_portal` |
| `PORTAL_SIGNING_KEY_FILE` | Ed25519 private key (PEM); its public key must be in the NxGen build's trusted keys. Default in a checkout: the **demo** key in `tools/license-authority/keys/vendor-demo` (testing only) |
| `PORT`, `HOST` | default `4100`, `127.0.0.1` (this computer only) |
| `PORTAL_TRUST_PROXY` | set when behind a reverse proxy (HTTPS termination) so client addresses are recorded |

Hosting it for online activation: HTTPS in front, `HOST=0.0.0.0`, and NxGen builds made with
`NXGEN_LICENSE_PORTAL_URL=https://…`. Lab-PC builds leave that unset and use the file route only.

## Keys

```bash
npm run keys -w @crescent/license-portal -- create --customer-id C-100 --customer-name "QC Lab" --modules tlc,ph --devices 1
npm run keys -w @crescent/license-portal -- list
npm run keys -w @crescent/license-portal -- show NXG-XXXX-XXXX-XXXX
npm run keys -w @crescent/license-portal -- revoke NXG-XXXX-XXXX-XXXX
npm run keys -w @crescent/license-portal -- issue NXG-XXXX-XXXX-XXXX --request /Volumes/USB/NXG-PLT-1234-ABCD.nxreq
```
