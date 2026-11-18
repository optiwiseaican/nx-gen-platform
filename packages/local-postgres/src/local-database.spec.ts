import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';
import { LocalDatabase, bundledBinariesDir } from './index';

const binaries = bundledBinariesDir();
const runnable = !!binaries && LocalDatabase.available(binaries) && process.getuid?.() !== 0;

(runnable ? describe : describe.skip)('LocalDatabase (bundled PostgreSQL)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nxgen-localdb-'));
  const port = 47900 + Math.floor(Math.random() * 90);
  const db = new LocalDatabase({ binariesDir: binaries!, dir, port });

  afterAll(async () => {
    await db.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function query(url: string, sql: string) {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return (await client.query(sql)).rows;
    } finally {
      await client.end();
    }
  }

  it('creates the cluster with a random password on first start, local only', async () => {
    const url = await db.start();
    expect(url).toMatch(new RegExp(`^postgres://nxgen:[0-9a-f]{48}@127\\.0\\.0\\.1:${port}/postgres$`));
    const credentials = join(dir, 'credentials.json');
    expect(statSync(credentials).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(credentials, 'utf8')).port).toBe(port);
    const [row] = await query(url, "SELECT version() AS v, current_setting('listen_addresses') AS l");
    expect(row.v).toMatch(/^PostgreSQL 16\./);
    expect(row.l).toBe('127.0.0.1');
    await query(url, 'CREATE TABLE kept (n int); INSERT INTO kept VALUES (42)');
    // The password file given to initdb is gone.
    expect(require('fs').readdirSync(dir).filter((f: string) => f.startsWith('.pw-'))).toEqual([]);
  }, 180_000);

  it('rejects a wrong password', async () => {
    await expect(query(`postgres://nxgen:wrong@127.0.0.1:${port}/postgres`, 'SELECT 1')).rejects.toThrow(/password/);
  });

  it('stops, and starts again with the same data and password', async () => {
    await db.stop();
    expect(await db.isRunning()).toBe(false);
    const url = await db.start();
    expect(await db.ensureCreated()).toBe(false);
    expect(await query(url, 'SELECT n FROM kept')).toEqual([{ n: 42 }]);
  }, 180_000);

  it('uses a server another session already started, and leaves it running', async () => {
    const second = new LocalDatabase({ binariesDir: binaries!, dir, port });
    const url = await second.start();
    await second.stop();
    expect(await db.isRunning()).toBe(true);
    expect(await query(url, 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
    expect(existsSync(join(dir, 'postgres.log'))).toBe(true);
  }, 60_000);
});
