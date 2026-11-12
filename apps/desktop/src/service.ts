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

export function serviceEnvironment(options: ServiceOptions, settings: Record<string, string>, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
  return env;
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
