# AICAN License Portal (vendor only)

Activates NxGen installations with an **activation key** (master specification §11). It holds the
private signing key that NxGen installations trust; never ship it to customers.

- **Online:** NxGen sends the key and the computer's activation request to `POST /api/v1/activate` and gets
  back a licence bound to that computer. The user only types the key (in the installer or on the activation
  screen); internet is needed once, NxGen then runs offline.
- **Offline:** on a lab PC without internet, NxGen saves an activation request (`.nxreq`). Upload it with the
  key on the portal's page (`GET /`) from any computer, and load the licence file you get in NxGen.
- **Keys:** each key has a customer, modules, optional expiry and a computer limit (default 1). The same
  computer activating again (repair, reinstall keeping `C:\ProgramData\NxGen`) does not use another slot.

## Run

```bash
npm run build -w @crescent/license-portal
PORTAL_DATABASE_URL=postgres://… PORTAL_SIGNING_KEY_FILE=/secure/aican.private.pem PORT=4100 \
  npm start -w @crescent/license-portal
```

| Variable | Meaning |
|---|---|
| `PORTAL_DATABASE_URL` | PostgreSQL for keys and issued licences (falls back to `DATABASE_URL`) |
| `PORTAL_DATABASE_CA_CERT` | CA certificate when the URL uses TLS (`sslmode=require`) |
| `PORTAL_DB_SCHEMA` | default `license_portal` |
| `PORTAL_SIGNING_KEY_FILE` | Ed25519 private key (PEM); its public key must be in the NxGen build's trusted keys |
| `PORT`, `HOST` | default `4100`, `0.0.0.0` |
| `PORTAL_TRUST_PROXY` | set when behind a reverse proxy (HTTPS termination) so client addresses are recorded |

Put it behind HTTPS before customers use it. NxGen builds learn its address at build time:
`NXGEN_LICENSE_PORTAL_URL=https://licenses.example.com npm run package:win`.

## Keys

```bash
npm run keys -w @crescent/license-portal -- create --customer-id C-100 --customer-name "QC Lab" --modules tlc,ph --devices 1
npm run keys -w @crescent/license-portal -- list
npm run keys -w @crescent/license-portal -- show NXG-XXXX-XXXX-XXXX
npm run keys -w @crescent/license-portal -- revoke NXG-XXXX-XXXX-XXXX
```
