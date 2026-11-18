#!/usr/bin/env node
/**
 * AICAN License Portal — VENDOR-ONLY. Offline by default: its own built-in database on this computer.
 * The page at http://127.0.0.1:4100/ turns an activation request file into a licence file.
 * See app.ts for the API and config.ts for the settings.
 */
import { computeKeyId, publicKeyFromPrivate } from '@crescent/licensing';
import { createPortalApp } from './app';
import { openPortalStore, signingKey } from './config';

async function main() {
  const key = signingKey();
  const opened = await openPortalStore();
  await opened.store.migrate();
  const port = Number(process.env.PORT ?? 4100);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createPortalApp(opened.store, key.pem).listen(port, host, () => {
    console.log(`AICAN License Portal: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
    console.log(`  data:        ${opened.location}`);
    console.log(`  signing key: ${computeKeyId(publicKeyFromPrivate(key.pem))}${key.demo ? ' (DEMO key from the checkout: testing only)' : ''}`);
    console.log('  Ctrl+C stops the portal and its database.');
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    void opened.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
