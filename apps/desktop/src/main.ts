import { app, BrowserWindow, dialog } from 'electron';
import type { ChildProcess } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import * as path from 'path';
import { checkLicense, loadShellTrustedKeys, ShellLicenseResult } from './license-check';
import { LocalDatabase } from './local-database';
import { databaseChoice, machineDirectory, readServiceSettings, runSmartInstaller, SERVICE_ENV_FILE, startService } from './service';

// In development the shell loads the Next.js dev server and talks to the API on :4000.
// In packaged standalone builds the local NestJS service serves both UI and API.
const SERVICE_PORT = 47810;
const PACKAGED_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const WEB_URL = process.env.CRESCENT_WEB_URL ?? (app.isPackaged ? `${PACKAGED_URL}/` : 'http://localhost:3000');
const API_URL = process.env.CRESCENT_API_URL ?? (app.isPackaged ? PACKAGED_URL : 'http://127.0.0.1:4000');
const SMOKE_TEST = process.env.NXGEN_SHELL_SMOKE_TEST === '1';
/** Set at build time for a build meant only for the machine it was made on. */
const LOCAL_BUILD = process.env.NXGEN_LOCAL_BUILD === '1';

/**
 * Routes usable without a shell-verified license: activation, system information, and sign-in
 * (re-activating once administrators exist needs an IT or Super Administrator session).
 */
const OPEN_ROUTES = new Set(['/', '/system/', '/login/', '/change-password/']);

// Trusted PUBLIC keys ship inside the app resources in packaged builds.
const CONFIG_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'config')
  : path.resolve(__dirname, '..', '..', 'server', 'config');
const trustedKeys = loadShellTrustedKeys(CONFIG_DIR, app.isPackaged && !LOCAL_BUILD);

let licenseResult: ShellLicenseResult = { kind: 'SERVICE_UNAVAILABLE' };
let service: ChildProcess | null = null;
let serviceLog = '';
let serviceStopped = false;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function shellPage(title: string, body: string, tone: 'info' | 'fail'): string {
  const color = tone === 'fail' ? '#b91c1c' : '#0b5cd5';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;background:#f3f5f9;color:#111827}
header{background:#0b2545;color:#fff;padding:16px 32px;font-weight:700;font-size:20px}
main{max-width:640px;margin:64px auto;background:#fff;border:1px solid #d9dee7;border-radius:8px;padding:32px}
h1{font-size:22px;margin:0 0 12px;color:${color}}p{color:#4b5563;line-height:1.5}code{font-family:Consolas,monospace}</style>
</head><body><header>NxGen Compliance Platform</header><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function waitForLicenseService(win: BrowserWindow): Promise<ShellLicenseResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await checkLicense(API_URL, trustedKeys);
    if (result.kind !== 'SERVICE_UNAVAILABLE' || serviceStopped) return result;
    if (attempt === 0) {
      await win.loadURL(
        shellPage('Starting NxGen services…', '<p>Waiting for the local NxGen License Service to start.</p>', 'info'),
      );
    }
    if (SMOKE_TEST && attempt >= (app.isPackaged ? 40 : 2)) return result;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function showRejected(win: BrowserWindow, result: Extract<ShellLicenseResult, { kind: 'REJECTED' }>) {
  console.error(`[nxgen-shell] License rejected by desktop shell: ${result.errorCode}`);
  void win.loadURL(
    shellPage(
      result.title,
      `<p>${escapeHtml(result.message)}</p><p>Error: <code>${result.errorCode}</code> (desktop shell verification)</p>
       <p>NxGen cannot open regulated functions on this computer. Contact your NxGen Administrator.</p>`,
      'fail',
    ),
  );
}

/**
 * Re-verify when the user moves past the open routes (e.g. after completing
 * activation in the UI). Client-side navigation cannot be cancelled, so a
 * failed check sends the window back to the activation screen.
 */
function guardNavigation(win: BrowserWindow) {
  win.webContents.on('did-navigate-in-page', (_e, url) => {
    void (async () => {
      const route = new URL(url).pathname;
      if (OPEN_ROUTES.has(route) || licenseResult.kind === 'VERIFIED') return;
      licenseResult = await checkLicense(API_URL, trustedKeys);
      if (licenseResult.kind === 'REJECTED') showRejected(win, licenseResult);
      else if (licenseResult.kind !== 'VERIFIED') void win.loadURL(WEB_URL);
    })();
  });
}

/** Starts the local service in a packaged app. Returns false, with a page explaining why, if it cannot. */
async function bootService(win: BrowserWindow): Promise<boolean> {
  if (!app.isPackaged || service) return true;
  const userData = app.getPath('userData');
  const machineDir = machineDirectory(userData);
  const settings = readServiceSettings([path.join(machineDir, SERVICE_ENV_FILE), path.join(userData, SERVICE_ENV_FILE)]);

  // The built-in database (always, except a Mac test build pointed at an external server).
  let databaseUrl: string | undefined;
  if (databaseChoice(settings) === 'built-in') {
    const binariesDir = path.join(process.resourcesPath, 'postgres');
    if (!LocalDatabase.available(binariesDir)) {
      await win.loadURL(
        shellPage(
          'NxGen is not set up on this computer',
          `<p>This build has no built-in database and no database settings.</p><p>Expected: <code>${escapeHtml(path.join(userData, SERVICE_ENV_FILE))}</code></p>`,
          'fail',
        ),
      );
      return false;
    }
    localDatabase = new LocalDatabase({ binariesDir, dir: path.join(machineDir, 'database') });
    if (!existsSync(path.join(localDatabase.dataDir, 'PG_VERSION'))) {
      await win.loadURL(shellPage('Preparing NxGen…', '<p>Creating the NxGen database on this computer. This happens once.</p>', 'info'));
    }
    try {
      databaseUrl = await localDatabase.start();
    } catch (err) {
      await win.loadURL(
        shellPage(
          'NxGen could not start its database',
          `<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p><p>Details: <code>${escapeHtml(localDatabase.logFile)}</code></p>`,
          'fail',
        ),
      );
      return false;
    }
  }

  const options = {
    resourcesPath: process.resourcesPath,
    userDataPath: userData,
    port: SERVICE_PORT,
    localBuild: LOCAL_BUILD,
    machineDir,
    databaseUrl,
    licensePortalUrl: process.env.NXGEN_BUILD_PORTAL_URL || undefined,
  };

  // Smart Installer step: identity and installation verification (first start, and after an update).
  const installed = await runSmartInstaller(options, settings);
  console.log(installed.output.trim());
  if (!installed.ok) {
    const report = path.join(settings.NXGEN_DATA_DIR || path.join(machineDir, 'data'), 'platform', 'installation-report.json');
    await win.loadURL(
      shellPage(
        'NxGen installation could not be verified',
        `<pre style="white-space:pre-wrap">${escapeHtml(installed.output.trim())}</pre><p>Report: <code>${escapeHtml(report)}</code></p>`,
        'fail',
      ),
    );
    return false;
  }

  const started = startService(options, settings);
  service = started.child;
  serviceLog = started.logFile;
  service.on('exit', () => {
    serviceStopped = true;
    service = null;
  });
  return true;
}

function stopService() {
  service?.kill();
  service = null;
}

let localDatabase: LocalDatabase | null = null;
let shuttingDown = false;

async function createWindow(): Promise<void> {
  const smokeShot = SMOKE_TEST ? process.env.NXGEN_SHELL_SMOKE_SHOT : undefined;
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: !SMOKE_TEST || !!smokeShot,
    title: 'NxGen Compliance Platform',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  guardNavigation(win);
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[nxgen-shell] failed to load ${url}: ${code} ${description}`);
  });

  if (!(await bootService(win))) {
    if (SMOKE_TEST) app.quit();
    return;
  }
  licenseResult = await waitForLicenseService(win);
  if (serviceStopped && licenseResult.kind === 'SERVICE_UNAVAILABLE') {
    await win.loadURL(
      shellPage('NxGen could not start', `<p>The NxGen service stopped while starting.</p><p>Details: <code>${escapeHtml(serviceLog)}</code></p>`, 'fail'),
    );
    if (SMOKE_TEST) app.quit();
    return;
  }
  console.log(`[nxgen-shell] trusted keys: ${trustedKeys.length}, license check: ${JSON.stringify(licenseResult)}`);

  if (licenseResult.kind === 'REJECTED') showRejected(win, licenseResult);
  else if (licenseResult.kind === 'SERVICE_UNAVAILABLE') {
    dialog.showErrorBox('NxGen', 'The NxGen License Service is not available. Restart NxGen.');
  } else {
    // ACTIVE + verified → normal UI; NOT_ACTIVE → the UI shows the activation screens.
    try {
      await win.loadURL(WEB_URL);
      console.log(`[nxgen-shell] loaded ${win.webContents.getURL()}`);
    } catch (err) {
      console.error(`[nxgen-shell] UI load failed: ${(err as Error).message}`);
      await win.loadURL(
        shellPage('NxGen could not open', '<p>The NxGen user interface could not be loaded. Restart NxGen.</p>', 'fail'),
      );
    }
  }

  if (smokeShot) {
    await new Promise((r) => setTimeout(r, 4000));
    writeFileSync(smokeShot, (await win.webContents.capturePage()).toPNG());
  }
  if (SMOKE_TEST) app.quit();
}

const onlyInstance = app.requestSingleInstanceLock();
if (!onlyInstance) app.quit();
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
// Quit in order: the service first, then the built-in database it was using.
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopService();
  if (!localDatabase) return;
  event.preventDefault();
  void localDatabase.stop().finally(() => app.exit(0));
});

app.whenReady().then(() => {
  if (!onlyInstance) return;
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || SMOKE_TEST) app.quit();
});
