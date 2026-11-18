import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { databaseChoice, machineDirectory, readServiceSettings, SERVICE_ENV_FILE, serviceEnvironment } from '../service';

describe('desktop service settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nxgen-desktop-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const options = { resourcesPath: '/res', userDataPath: dir, port: 47810, localBuild: true, machineDir: '/machine' };

  it('reads optional settings files, the later (this user) overriding the machine one', () => {
    const machine = join(dir, 'machine.env');
    const user = join(dir, SERVICE_ENV_FILE);
    expect(readServiceSettings([machine, user])).toEqual({});
    writeFileSync(machine, "NXGEN_CAMERA=ids\nNXGEN_DATA_DIR='C:\\nxgen\\data'\n");
    writeFileSync(user, 'NXGEN_CAMERA=simulator\n');
    expect(readServiceSettings([machine, user])).toEqual({ NXGEN_CAMERA: 'simulator', NXGEN_DATA_DIR: 'C:\\nxgen\\data' });
  });

  it('keeps one NxGen folder per Windows PC, in ProgramData', () => {
    expect(machineDirectory('/u', 'win32', { ProgramData: 'D:\\PD' })).toBe(join('D:\\PD', 'NxGen'));
    expect(machineDirectory('/u', 'win32', {})).toBe(join('C:\\ProgramData', 'NxGen'));
    expect(machineDirectory('/u', 'darwin', {})).toBe('/u');
  });

  it('installations always use the built-in database; only Mac test builds may use an external one', () => {
    expect(databaseChoice({ DATABASE_URL: 'postgres://aiven/x' }, 'win32')).toBe('built-in');
    expect(databaseChoice({ DATABASE_URL: 'postgres://aiven/x' }, 'linux')).toBe('built-in');
    expect(databaseChoice({}, 'darwin')).toBe('built-in');
    expect(databaseChoice({ DATABASE_URL: 'postgres://aiven/x' }, 'darwin')).toBe('external');
    const win = serviceEnvironment(options, { DATABASE_URL: 'postgres://aiven/x' }, { DATABASE_URL: 'postgres://env/x' }, 'win32');
    expect(win.DATABASE_URL).toBeUndefined();
    const local = serviceEnvironment({ ...options, databaseUrl: 'postgres://nxgen:pw@127.0.0.1:47811/postgres' }, { DATABASE_URL: 'postgres://aiven/x', DATABASE_CA_CERT: '/ca.pem' }, {}, 'win32');
    expect(local.DATABASE_URL).toBe('postgres://nxgen:pw@127.0.0.1:47811/postgres');
    expect(local.DATABASE_CA_CERT).toBeUndefined();
    expect(serviceEnvironment(options, { DATABASE_URL: 'postgres://aiven/x' }, {}, 'darwin').DATABASE_URL).toBe('postgres://aiven/x');
  });

  it('serves the screens and API from one local address, data in the machine folder', () => {
    const env = serviceEnvironment(options, {}, {});
    expect(env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', PORT: '47810', NXGEN_WEB_DIR: '/res/web', NXGEN_WEB_URL: 'http://127.0.0.1:47810', NXGEN_DATA_DIR: join('/machine', 'data') });
    expect(serviceEnvironment(options, { NXGEN_DATA_DIR: '/elsewhere' }, {}).NXGEN_DATA_DIR).toBe('/elsewhere');
  });

  it('points the service at the bundled camera helper; cameras are off on macOS unless configured', () => {
    const res = mkdtempSync(join(tmpdir(), 'nxgen-res-'));
    try {
      expect(serviceEnvironment({ ...options, resourcesPath: res }, {}, {}, 'win32').NXGEN_CAMERA_HELPER).toBeUndefined();
      mkdirSync(join(res, 'camera-helper'));
      writeFileSync(join(res, 'camera-helper', 'nxgen_camera.py'), '');
      expect(serviceEnvironment({ ...options, resourcesPath: res }, {}, {}, 'linux').NXGEN_CAMERA_HELPER).toBe(join(res, 'camera-helper', 'nxgen_camera.py'));
      writeFileSync(join(res, 'camera-helper', 'nxgen-camera.exe'), '');
      const win = serviceEnvironment({ ...options, resourcesPath: res }, {}, {}, 'win32');
      expect(win.NXGEN_CAMERA_HELPER).toBe(join(res, 'camera-helper', 'nxgen-camera.exe'));
      expect(win.NXGEN_CAMERA).toBe('ids');
      expect(serviceEnvironment(options, {}, {}, 'darwin').NXGEN_CAMERA).toBe('off');
      expect(serviceEnvironment(options, { NXGEN_CAMERA: 'simulator' }, {}, 'darwin').NXGEN_CAMERA).toBe('simulator');
    } finally {
      rmSync(res, { recursive: true, force: true });
    }
  });

  it('a local build does not run in production mode; a release build does', () => {
    expect(serviceEnvironment(options, {}, { NODE_ENV: 'production' }).NODE_ENV).toBeUndefined();
    expect(serviceEnvironment({ ...options, localBuild: false }, {}, {}).NODE_ENV).toBe('production');
  });
});
