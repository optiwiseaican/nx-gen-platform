#!/usr/bin/env node
/** AICAN License Portal — VENDOR-ONLY service. See app.ts for the API and config.ts for its settings. */
import { computeKeyId, publicKeyFromPrivate } from '@crescent/licensing';
import { createPortalApp } from './app';
import { portalStore, signingKey } from './config';

async function main() {
  const store = portalStore();
  await store.migrate();
  const privateKeyPem = signingKey();
  const port = Number(process.env.PORT ?? 4100);
  const host = process.env.HOST ?? '0.0.0.0';
  createPortalApp(store, privateKeyPem).listen(port, host, () => {
    console.log(`AICAN License Portal on http://${host}:${port} (signing key ${computeKeyId(publicKeyFromPrivate(privateKeyPem))})`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
