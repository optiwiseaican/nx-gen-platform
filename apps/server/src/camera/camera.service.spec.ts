import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import type { NxGenConfig } from '../config/nxgen.config';
import type { AuditService } from '../audit/audit.service';
import { CameraError, CameraService } from './camera.service';
import type { PreviewEvent } from './camera.service';

/**
 * The camera service against the real camera helper (tools/camera-helper) in simulator mode, so
 * the whole path — process start, JSON protocol, still files, preview frames, audit — is tested
 * without a camera. Needs python3 on the PATH (skipped otherwise).
 */
const python = (() => {
  try {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const describeIf = python ? describe : describe.skip;

const principal = { userId: 'u-1', username: 'asha', fullName: 'Asha Analyst', roles: [], permissions: [] };
const origin = { ipAddress: '127.0.0.1', machineName: 'test', userAgent: 'jest' };

describeIf('CameraService with the simulated camera', () => {
  const events: Record<string, unknown>[] = [];
  const audit = { record: async (e: Record<string, unknown>) => void events.push(e) } as unknown as AuditService;
  let cameras: CameraService;

  beforeAll(() => {
    process.env.NXGEN_CAMERA = 'simulator';
    cameras = new CameraService({ production: false } as NxGenConfig, audit);
  });
  afterAll(async () => {
    await cameras.onModuleDestroy();
    delete process.env.NXGEN_CAMERA;
  });

  it('starts the helper on first use and lists the simulated camera', async () => {
    expect(cameras.status()).toMatchObject({ mode: 'SIMULATOR', helper: 'STOPPED' });
    const list = await cameras.list();
    expect(list).toEqual([expect.objectContaining({ serial: 'SIM-0001', simulated: true, openable: true })]);
    expect(cameras.status().helper).toBe('RUNNING');
    const info = await cameras.info('SIM-0001');
    expect(info.sensor).toMatchObject({ bits: 12, pixelFormat: 'BayerRG12' });
  });

  it('takes a lossless 16-bit still, checks its SHA-256 and audits the capture', async () => {
    const still = await cameras.still(principal, { exposureUs: 20000, gain: 1, whiteBalance: [1, 1, 1], purpose: 'test' }, origin);
    expect(still.data.subarray(1, 4).toString()).toBe('PNG');
    expect(still.data[24]).toBe(16); // IHDR bit depth
    expect(createHash('sha256').update(still.data).digest('hex')).toBe(still.sha256);
    expect(still).toMatchObject({ serial: 'SIM-0001', simulated: true, bitDepth: 16, sourceBits: 12, exposureUs: 20000 });
    expect(events.at(-1)).toMatchObject({ action: 'CAMERA_CAPTURE', result: 'SUCCESS', actor: 'u-1' });
    expect((events.at(-1)!.details as Record<string, unknown>).sha256).toBe(still.sha256);
  });

  it('a longer exposure gives a brighter image and eventually saturates', async () => {
    const dark = await cameras.still(principal, { exposureUs: 5000 }, origin);
    const bright = await cameras.still(principal, { exposureUs: 80000 }, origin);
    expect(dark.saturatedFraction).toBe(0);
    expect(bright.saturatedFraction).toBeGreaterThan(0.05);
  });

  it('runs stills one at a time when several are asked for together', async () => {
    const results = await Promise.all([1, 2, 3].map(() => cameras.still(principal, { exposureUs: 10000 }, origin)));
    expect(new Set(results.map((r) => r.sha256)).size).toBe(1);
  });

  it('refuses bad settings and unknown cameras, and audits the failure', async () => {
    await expect(cameras.still(principal, { exposureUs: 1 }, origin)).rejects.toThrow(/Exposure/);
    await expect(cameras.still(principal, { serial: 'NOPE', exposureUs: 1000 }, origin)).rejects.toThrow(CameraError);
    expect(events.at(-1)).toMatchObject({ action: 'CAMERA_CAPTURE', result: 'FAILURE' });
  });

  it('shares one live preview between viewers and stops it when the last one leaves', async () => {
    const a: PreviewEvent[] = [];
    const b: PreviewEvent[] = [];
    const settings = { exposureUs: 20000, gain: 1, whiteBalance: [1, 1, 1] as [number, number, number] };
    const stopA = await cameras.preview('SIM-0001', settings, (e) => a.push(e));
    const stopB = await cameras.preview('SIM-0001', settings, (e) => b.push(e));
    await new Promise((r) => setTimeout(r, 1500));
    stopA();
    stopB();
    const frames = a.filter((e) => e.kind === 'frame');
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(b.filter((e) => e.kind === 'frame').length).toBeGreaterThanOrEqual(3);
    const f = frames[0] as Extract<PreviewEvent, { kind: 'frame' }>;
    expect(f.mime).toBe('image/png');
    expect(f.width).toBeLessThanOrEqual(960);
    const before = a.length;
    await new Promise((r) => setTimeout(r, 700));
    expect(a.length).toBe(before);
  });

  it('changes a running preview in place, finds settings automatically, applies parameters', async () => {
    const frames: PreviewEvent[] = [];
    const unsubscribe = await cameras.preview('SIM-0001', { exposureUs: 20_000, gain: 1, whiteBalance: [1, 1, 1] }, (e) => frames.push(e));
    try {
      await new Promise((r) => setTimeout(r, 600));
      const before = frames.filter((f) => f.kind === 'frame').length;
      expect(before).toBeGreaterThan(0);
      const changed = await cameras.setPreview('SIM-0001', { exposureUs: 80_000, gain: 2 });
      expect(changed).toMatchObject({ exposureUs: 80_000, gain: 2, whiteBalance: [1, 1, 1] });
      await new Promise((r) => setTimeout(r, 600));
      // Same stream: frames continued, nothing ended.
      expect(frames.filter((f) => f.kind === 'frame').length).toBeGreaterThan(before);
      expect(frames.some((f) => f.kind === 'end')).toBe(false);
      // A second viewer with other settings also changes it in place, not by restarting.
      const seqOf = () => Math.max(...frames.filter((f): f is Extract<PreviewEvent, { kind: 'frame' }> => f.kind === 'frame').map((f) => f.seq));
      const seqBefore = seqOf();
      const second = await cameras.preview('SIM-0001', { exposureUs: 30_000, gain: 1, whiteBalance: [1.2, 1, 1.1] }, () => undefined);
      await new Promise((r) => setTimeout(r, 400));
      second();
      expect(seqOf()).toBeGreaterThan(seqBefore);

      const auto = await cameras.auto({ serial: 'SIM-0001', features: ['exposure', 'whiteBalance'], exposureUs: 1000, gain: 1, whiteBalance: [1, 1, 1] });
      expect(auto.by).toBe('host');
      expect(auto.exposureUs).toBeGreaterThan(1000);
      expect(auto.stats.saturated).toBeLessThanOrEqual(0.02);
      expect(auto.whiteBalance[1]).toBe(1);

      const applied = await cameras.apply('SIM-0001', { digitalGain: 1.5, blackLevelAuto: 'Continuous' });
      expect(applied).toEqual({ applied: { digitalGain: 1.5, blackLevelAuto: 'Continuous' }, unsupported: [] });
      const info = await cameras.info('SIM-0001');
      expect(info.capabilities?.autoOnHost).toEqual(['exposure', 'gain', 'whiteBalance']);
    } finally {
      unsubscribe();
    }
    await expect(cameras.setPreview('SIM-0001', { gain: 2 })).rejects.toThrow(/No live preview/);
  });

  it('starts the helper again after it crashes', async () => {
    const child = (cameras as unknown as { child: { kill(): void } }).child;
    child.kill();
    await new Promise((r) => setTimeout(r, 2500));
    expect((await cameras.list())[0].serial).toBe('SIM-0001');
  });
});

describe('CameraService switched off', () => {
  it('has no cameras and refuses captures', async () => {
    process.env.NXGEN_CAMERA = 'off';
    const cameras = new CameraService({ production: true } as NxGenConfig, { record: async () => undefined } as unknown as AuditService);
    delete process.env.NXGEN_CAMERA;
    expect(cameras.status()).toMatchObject({ mode: 'OFF', helper: 'OFF' });
    expect(await cameras.list()).toEqual([]);
    await expect(cameras.still(principal, { exposureUs: 1000 }, origin)).rejects.toThrow(/switched off/);
  });
});
