/**
 * Smart Installer step, run by the desktop app before it starts the service (same environment).
 * Exit 0: installation verified (or already verified for this version); exit 1: verification failed;
 * the report is in <data>/platform/installation-report.json.
 */
import { loadConfig } from '../config/nxgen.config';
import { runSmartInstaller } from './smart-installer';

runSmartInstaller(loadConfig(), { webDir: process.env.NXGEN_WEB_DIR ?? null })
  .then(({ ran, report }) => {
    if (!ran) {
      console.log('[installer] installation already verified for this version');
      return;
    }
    console.log(`[installer] ${report!.installationId}: ${report!.verification}`);
    for (const c of report!.checks)
      console.log(`[installer]   ${c.status.padEnd(7)} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    if (report!.verification === 'FAIL') process.exitCode = 1;
  })
  .catch((err) => {
    console.error(`[installer] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
