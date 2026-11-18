import { ChildProcess, spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseEnv } from 'util';

export interface ServiceOptions {
  resourcesPath: string;
  userDataPath: string;
  port: number;
  /** Local builds trust the same keys as a development install; release builds run in production mode. */
  localBuild: boolean;
  /** See machineDirectory(): the service's data folder is <machineDir>/data unless the settings name one. */
  machineDir: string;
  /** The built-in database's address; absent when a Mac test build uses DATABASE_URL from its settings. */
  databaseUrl?: string;
  /** AICAN License Portal set when the app was built (NXGEN_LICENSE_PORTAL_URL); settings may override it. */
  licensePortalUrl?: string;
}

/** Where the installer saves the activation key typed during setup (used once by the service). */
export const ACTIVATION_KEY_FILE = 'activation-key.txt';

export const SERVICE_ENV_FILE = 'nxgen.env';

/**
 * The folder NxGen keeps for the whole computer: the built-in database, the data folder (licence binding,
 * installed modules) and optional machine settings. Windows: C:\ProgramData\NxGen, shared by every Windows
 * user of the lab PC. Elsewhere (Mac test builds; Linux until its installer exists) the user's app folder.
 */
export function machineDirectory(userDataPath: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return join(env.ProgramData || env.ALLUSERSPROFILE || 'C:\\ProgramData', 'NxGen');
  return userDataPath;
}

/** Optional settings files (machine first, then this user's), merged; later files win. */
export function readServiceSettings(files: string[]): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const file of files) {
    if (existsSync(file)) Object.assign(settings, parseEnv(readFileSync(file, 'utf8')));
  }
  return settings;
}

/**
 * Which database the service uses. Installations (Windows, Linux) always use the built-in one: an external
 * server is only for Mac test builds, from DATABASE_URL in the settings file.
 */
export function databaseChoice(settings: Record<string, string>, platform: NodeJS.Platform = process.platform): 'external' | 'built-in' {
  return platform === 'darwin' && settings.DATABASE_URL ? 'external' : 'built-in';
}

export function serviceEnvironment(options: ServiceOptions, settings: Record<string, string>, base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const origin = `http://127.0.0.1:${options.port}`;
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...settings,
    NXGEN_DATA_DIR: settings.NXGEN_DATA_DIR || join(options.machineDir, 'data'),
    NXGEN_ACTIVATION_KEY_FILE: join(options.machineDir, ACTIVATION_KEY_FILE),
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(options.port),
    HOST: '127.0.0.1',
    NXGEN_WEB_DIR: join(options.resourcesPath, 'web'),
    NXGEN_WEB_URL: origin,
  };
  const portal = settings.NXGEN_LICENSE_PORTAL_URL || options.licensePortalUrl;
  if (portal) env.NXGEN_LICENSE_PORTAL_URL = portal;
  if (options.localBuild) delete env.NODE_ENV;
  else env.NODE_ENV = 'production';
  // The database: the built-in one's address, or (Mac test builds only) the external one from the settings.
  if (options.databaseUrl) {
    env.DATABASE_URL = options.databaseUrl;
    delete env.DATABASE_CA_CERT;
  } else if (databaseChoice(settings, platform) !== 'external') {
    delete env.DATABASE_URL;
  }
  // The lamp box camera: the server runs the camera helper shipped in the app; the real IDS camera on
  // Windows and Linux (NXGEN_CAMERA=simulator in the settings to test without one). IDS peak has no
  // macOS build, so cameras are off there unless the settings file asks for the simulator.
  if (!env.NXGEN_CAMERA_HELPER) {
    const helper = cameraHelperPath(options.resourcesPath, platform);
    if (helper) env.NXGEN_CAMERA_HELPER = helper;
  }
  if (!env.NXGEN_CAMERA) env.NXGEN_CAMERA = platform === 'darwin' ? 'off' : 'ids';
  return env;
}

/** The camera helper shipped in the app's resources (frozen executable, else the Python script). */
export function cameraHelperPath(resourcesPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const dir = join(resourcesPath, 'camera-helper');
  for (const name of [platform === 'win32' ? 'nxgen-camera.exe' : 'nxgen-camera', 'nxgen_camera.py']) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Runs the NestJS service with Electron's own Node, logging to a file the user can send us. */
export function startService(options: ServiceOptions, settings: Record<string, string>): { child: ChildProcess; logFile: string } {
  const logDir = join(options.userDataPath, 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'service.log');
  const log = openSync(logFile, 'a');
  chmodSync(logFile, 0o600);
  const child = spawn(process.execPath, [join(options.resourcesPath, 'server', 'dist', 'main.js')], {
    cwd: join(options.resourcesPath, 'server'),
    env: serviceEnvironment(options, settings, process.env),
    stdio: ['ignore', log, log],
  });
  return { child, logFile };
}

/**
 * The Smart Installer step (service: dist/installer/main.js) with the service's environment: creates the
 * Platform Instance identity and installation record on first start, re-verifies after an update.
 */
export function runSmartInstaller(options: ServiceOptions, settings: Record<string, string>): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(options.resourcesPath, 'server', 'dist', 'installer', 'main.js')], {
      cwd: join(options.resourcesPath, 'server'),
      env: serviceEnvironment(options, settings, process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (err) => resolve({ ok: false, output: `${output}${err.message}` }));
    child.on('exit', (code) => resolve({ ok: code === 0, output }));
  });
}
