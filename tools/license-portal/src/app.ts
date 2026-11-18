import express, { Request, Response } from 'express';
import { LICENSE_ERRORS, LicenseErrorCode } from '@crescent/licensing';
import { activate, PortalRefusal } from './portal';
import { PortalStore } from './store';

/**
 * HTTP API and offline page of the AICAN License Portal.
 *
 *   POST /api/v1/activate   { activationCode, request, channel? } → 200 { license, fileName }
 *                           refusals: 4xx { errorCode, title, message } (the NxGen error catalogue)
 *   GET  /api/v1/health     → { ok: true }
 *   GET  /                  offline activation page: activation key + activation request file → licence file
 */
export function createPortalApp(store: PortalStore, privateKeyPem: string) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.PORTAL_TRUST_PROXY) app.set('trust proxy', process.env.PORTAL_TRUST_PROXY);
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/v1/activate', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { activationCode?: unknown; request?: unknown; channel?: unknown };
    try {
      const issued = await activate(store, privateKeyPem, {
        activationCode: typeof body.activationCode === 'string' ? body.activationCode : '',
        request: body.request,
        channel: body.channel === 'OFFLINE' ? 'OFFLINE' : 'ONLINE',
        clientIp: req.ip ?? null,
      });
      res.json({ license: issued.licenseText, fileName: issued.fileName });
    } catch (err) {
      if (err instanceof PortalRefusal) {
        const info = LICENSE_ERRORS[err.errorCode];
        res.status(err.status).json({ errorCode: err.errorCode, title: info.title, message: info.message, detail: err.message });
        return;
      }
      console.error(`[license-portal] activation failed: ${(err as Error).stack ?? err}`);
      const code = LicenseErrorCode.SERVICE_UNAVAILABLE;
      res.status(500).json({ errorCode: code, title: 'License Portal Error', message: 'The license could not be issued. Try again later.' });
    }
  });

  app.get('/', (_req, res) => {
    res.type('html').send(OFFLINE_PAGE);
  });

  return app;
}

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AICAN License Portal</title>
<style>
:root{--ink:#111827;--muted:#4b5563;--line:#d9dee7;--brand:#0b5cd5;--bg:#f3f5f9;--fail:#b91c1c;--ok:#15803d}
body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink)}
header{background:#0b2545;color:#fff;padding:16px 24px;font-weight:700;font-size:20px}
main{max-width:640px;margin:40px auto;background:#fff;border:1px solid var(--line);border-radius:8px;padding:28px}
h1{font-size:22px;margin:0 0 8px}p{color:var(--muted);line-height:1.5}
label{display:block;font-weight:600;margin:18px 0 6px}
input[type=text]{width:100%;box-sizing:border-box;font:16px Consolas,monospace;padding:10px;border:1px solid var(--line);border-radius:6px;text-transform:uppercase}
button{margin-top:22px;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:11px 20px;font-size:15px;cursor:pointer}
#result{margin-top:18px;font-weight:600}.fail{color:var(--fail)}.ok{color:var(--ok)}
@media (max-width:680px){main{margin:16px}}
</style></head><body><header>AICAN License Portal</header><main>
<h1>Activate NxGen offline</h1>
<p>For a computer without internet: in NxGen choose <b>Save activation request</b>, bring the <code>.nxreq</code> file here,
and enter the activation key you received from AICAN. Take the license file back to NxGen and choose <b>Select license file</b>.</p>
<form id="f">
<label for="code">Activation key</label><input id="code" type="text" placeholder="NXG-XXXX-XXXX-XXXX" autocomplete="off" required>
<label for="req">Activation request (.nxreq)</label><input id="req" type="file" accept=".nxreq,.json,.txt" required>
<button type="submit">Get license file</button></form>
<div id="result" role="status"></div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('result'); out.className = ''; out.textContent = 'Issuing license…';
  try {
    const file = document.getElementById('req').files[0];
    const request = await file.text();
    const res = await fetch('api/v1/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationCode: document.getElementById('code').value, request, channel: 'OFFLINE' }) });
    const body = await res.json();
    if (!res.ok) { out.className = 'fail'; out.textContent = body.title + ' (' + body.errorCode + '): ' + body.message; return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body.license], { type: 'application/json' }));
    a.download = body.fileName; a.click();
    out.className = 'ok'; out.textContent = 'License file downloaded: ' + body.fileName;
  } catch (err) { out.className = 'fail'; out.textContent = 'The license could not be issued: ' + err.message; }
});
</script></main></body></html>`;
