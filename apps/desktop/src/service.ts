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
}

export const SERVICE_ENV_FILE = 'nxgen.env';

/** The settings a machine keeps outside the app: the database password never ships inside it. */
export function readServiceSettings(userDataPath: string): Record<string, string> | null {
  const file = join(userDataPath, SERVICE_ENV_FILE);
  if (!existsSync(file)) return null;
  const settings = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  return settings.DATABASE_URL ? settings : null;
}

export function serviceEnvironment(options: ServiceOptions, settings: Record<string, string>, base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const origin = `http://127.0.0.1:${options.port}`;
  const env: NodeJS.ProcessEnv = {
    ...base,
    ...settings,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(options.port),
    HOST: '127.0.0.1',
    NXGEN_WEB_DIR: join(options.resourcesPath, 'web'),
    NXGEN_WEB_URL: origin,
  };
  if (options.localBuild) delete env.NODE_ENV;
  else env.NODE_ENV = 'production';
  // The lamp box camera: the server runs the camera helper shipped in the app. IDS peak has no
  // macOS build, so cameras are off there unless the settings file asks for the simulator.
  if (!env.NXGEN_CAMERA_HELPER) {
    const helper = cameraHelperPath(options.resourcesPath, platform);
    if (helper) env.NXGEN_CAMERA_HELPER = helper;
  }
  if (!env.NXGEN_CAMERA && platform === 'darwin') env.NXGEN_CAMERA = 'off';
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
