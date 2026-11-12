import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readServiceSettings, SERVICE_ENV_FILE, serviceEnvironment } from '../service';

describe('desktop service settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nxgen-desktop-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const options = { resourcesPath: '/res', userDataPath: dir, port: 47810, localBuild: true };

  it('needs a settings file with a database', () => {
    expect(readServiceSettings(dir)).toBeNull();
    writeFileSync(join(dir, SERVICE_ENV_FILE), 'NXGEN_DATA_DIR=/data\n');
    expect(readServiceSettings(dir)).toBeNull();
    writeFileSync(join(dir, SERVICE_ENV_FILE), 'DATABASE_URL=postgres://x/y\n');
    expect(readServiceSettings(dir)).toEqual({ DATABASE_URL: 'postgres://x/y' });
  });

  it('serves the screens and API from one local address', () => {
    const env = serviceEnvironment(options, { DATABASE_URL: 'x' }, {});
    expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', PORT: '47810', NXGEN_WEB_DIR: '/res/web', NXGEN_WEB_URL: 'http://127.0.0.1:47810', DATABASE_URL: 'x' });
  });

  it('a local build does not run in production mode; a release build does', () => {
    expect(serviceEnvironment(options, {}, { NODE_ENV: 'production' }).NODE_ENV).toBeUndefined();
    expect(serviceEnvironment({ ...options, localBuild: false }, {}, {}).NODE_ENV).toBe('production');
  });
});
