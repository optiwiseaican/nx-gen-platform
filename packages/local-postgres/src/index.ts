import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/** The built-in database's port: fixed so a second Windows session on the PC finds the running server. */
export const LOCAL_DATABASE_PORT = 47811;
const USER = 'nxgen';
const DATABASE = 'postgres';

export interface LocalDatabaseOptions {
  /** Folder holding bin/, lib/ and share/ of the bundled PostgreSQL. */
  binariesDir: string;
  /** Machine folder for the database: <dir>/pgdata, <dir>/credentials.json, <dir>/postgres.log. */
  dir: string;
  port?: number;
  platform?: NodeJS.Platform;
}

interface Credentials {
  user: string;
  password: string;
  port: number;
}

/**
 * The PostgreSQL that ships inside the NxGen installer. On first start it creates the cluster with a random
 * password (kept in credentials.json beside it, never in the app); afterwards it starts and stops it with the app.
 * Only 127.0.0.1 is listened on, with scram-sha-256 authentication.
 */
export class LocalDatabase {
  private readonly binariesDir: string;
  private readonly dir: string;
  private readonly port: number;
  private readonly exe: string;
  /** False when another session on this computer had already started the server: that one stops it. */
  private owned = false;

  constructor(options: LocalDatabaseOptions) {
    this.binariesDir = options.binariesDir;
    this.dir = options.dir;
    this.port = options.port ?? LOCAL_DATABASE_PORT;
    this.exe = (options.platform ?? process.platform) === 'win32' ? '.exe' : '';
  }

  static available(binariesDir: string, platform: NodeJS.Platform = process.platform): boolean {
    return existsSync(join(binariesDir, 'bin', `postgres${platform === 'win32' ? '.exe' : ''}`));
  }

  get dataDir(): string {
    return join(this.dir, 'pgdata');
  }

  get logFile(): string {
    return join(this.dir, 'postgres.log');
  }

  private bin(name: string): string {
    return join(this.binariesDir, 'bin', `${name}${this.exe}`);
  }

  private async tool(name: string, args: string[], timeoutMs = 120_000) {
    return run(this.bin(name), args, { windowsHide: true, timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C', LC_MESSAGES: 'C' } });
  }

  private credentials(): Credentials {
    return JSON.parse(readFileSync(join(this.dir, 'credentials.json'), 'utf8')) as Credentials;
  }

  /** Creates the cluster on first use. Safe to call every start. */
  async ensureCreated(): Promise<boolean> {
    if (existsSync(join(this.dataDir, 'PG_VERSION'))) return false;
    mkdirSync(this.dir, { recursive: true });
    // A half-made cluster from an interrupted first start: initdb needs an empty folder.
    rmSync(this.dataDir, { recursive: true, force: true });
    const credentials: Credentials = { user: USER, password: randomBytes(24).toString('hex'), port: this.port };
    const pwfile = join(this.dir, `.pw-${randomBytes(6).toString('hex')}`);
    writeFileSync(pwfile, `${credentials.password}\n`, { mode: 0o600 });
    try {
      await this.tool('initdb', [
        `--pgdata=${this.dataDir}`,
        `--username=${USER}`,
        `--pwfile=${pwfile}`,
        '--auth=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
      ]);
    } finally {
      rmSync(pwfile, { force: true });
    }
    appendFileSync(
      join(this.dataDir, 'postgresql.conf'),
      `\n# NxGen built-in database\nlisten_addresses = '127.0.0.1'\nport = ${this.port}\n`,
    );
    const file = join(this.dir, 'credentials.json');
    writeFileSync(file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
    return true;
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.tool('pg_ctl', ['status', '-D', this.dataDir], 30_000);
      return true;
    } catch {
      return false; // exit 3: not running (a stale postmaster.pid is handled by the server itself)
    }
  }

  /**
   * pg_ctl start with no pipes: the server it leaves running would otherwise inherit them and keep the call open.
   * Its messages go to postgres.log.
   */
  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin('pg_ctl'), ['start', '-D', this.dataDir, '-l', this.logFile, '-w', '-t', '90'], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LC_MESSAGES: 'C' },
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`The built-in database did not start (pg_ctl exit ${code}); see ${this.logFile}`)),
      );
    });
  }

  /** Creates (first time) and starts the server; returns the service's DATABASE_URL. */
  async start(): Promise<string> {
    await this.ensureCreated();
    if (await this.isRunning()) {
      this.owned = false;
    } else {
      await this.startServer();
      this.owned = true;
    }
    const c = this.credentials();
    return `postgres://${c.user}:${encodeURIComponent(c.password)}@127.0.0.1:${c.port}/${DATABASE}`;
  }

  /** Stops the server if this session started it (fast shutdown: open transactions roll back, data is safe). */
  async stop(): Promise<void> {
    if (!this.owned) return;
    this.owned = false;
    await this.tool('pg_ctl', ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '60'], 90_000).catch(() => undefined);
  }
}

/** The platform's @embedded-postgres package (development and the portal); packaged apps ship its native/ folder. */
export const EMBEDDED_POSTGRES_PACKAGE: Partial<Record<NodeJS.Platform, string>> = {
  win32: '@embedded-postgres/windows-x64',
  linux: '@embedded-postgres/linux-x64',
  darwin: '@embedded-postgres/darwin-arm64',
};

export function bundledBinariesDir(platform: NodeJS.Platform = process.platform): string | null {
  const pkg = EMBEDDED_POSTGRES_PACKAGE[platform];
  if (!pkg) return null;
  try {
    // The package exports only dist/index.js; native/ sits beside dist/.
    return join(dirname(require.resolve(pkg)), '..', 'native');
  } catch {
    return null;
  }
}
