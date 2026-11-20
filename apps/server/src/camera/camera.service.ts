import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createInterface } from 'readline';
import type {
  CameraAutoRequest,
  CameraAutoResult,
  CameraDescriptor,
  CameraInfo,
  CameraParameters,
  CameraStatus,
  CameraStill,
  CameraStillRequest,
  ModulePrincipal,
  RequestOrigin,
} from '@crescent/module-sdk';
import { AuditService } from '../audit/audit.service';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';

/** What a preview listener receives: one frame, or the end of the stream with the reason. */
export type PreviewEvent =
  | { kind: 'frame'; mime: string; width: number; height: number; data: Buffer; seq: number }
  | { kind: 'end'; error: string | null };

export interface PreviewSettings {
  exposureUs: number;
  gain: number;
  whiteBalance: [number, number, number];
  parameters?: CameraParameters;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface PreviewGroup {
  serial: string;
  key: string;
  listeners: Set<(e: PreviewEvent) => void>;
}

/** Mode of the camera service: off, a simulated camera, or IDS cameras through IDS peak. */
type Mode = 'OFF' | 'SIMULATOR' | 'IDS';

const HELPER_START_MS = 20_000;
const COMMAND_MS = 30_000;
const RESTART_BACKOFF_MS = 2_000;

/** Camera errors the user can act on (no camera, camera busy…); shown as 409/400 by callers. */
export class CameraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CameraError';
  }
}

/**
 * Cameras on this computer (the lab PC the lamp box is connected to).
 *
 * Browsers cannot see industrial USB3 Vision cameras, so the server owns them: it runs the camera
 * helper (tools/camera-helper, built on IDS peak) as a child process and talks to it over
 * stdin/stdout. Modules capture through `ctx.cameras`; the UI watches the live preview through
 * GET /api/cameras/:serial/preview. Stills are taken one at a time; one preview per camera is shared
 * by every viewer. A helper that crashes is started again on the next request.
 *
 * NXGEN_CAMERA = off | simulator | ids (default: ids in production, simulator in development)
 * NXGEN_CAMERA_HELPER = path to the helper (frozen executable, or nxgen_camera.py)
 * NXGEN_PYTHON = Python to run a .py helper with (default python3, or python on Windows)
 */
@Injectable()
export class CameraService implements OnModuleDestroy {
  private readonly logger = new Logger(CameraService.name);
  private readonly mode: Mode;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private lastFailure: { at: number; message: string } | null = null;
  private helperInfo: { version: string | null; sdk: string | null; simulated: boolean } = {
    version: null,
    sdk: null,
    simulated: false,
  };
  private stillQueue: Promise<unknown> = Promise.resolve();
  private readonly previews = new Map<string, PreviewGroup>();

  constructor(
    @Inject(NXGEN_CONFIG) config: NxGenConfig,
    private readonly audit: AuditService,
  ) {
    const wanted = (process.env.NXGEN_CAMERA ?? '').trim().toLowerCase();
    this.mode =
      wanted === 'off'
        ? 'OFF'
        : wanted === 'ids'
          ? 'IDS'
          : wanted === 'simulator'
            ? 'SIMULATOR'
            : config.production
              ? 'IDS'
              : 'SIMULATOR';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  status(): CameraStatus {
    return {
      mode: this.mode,
      helper:
        this.mode === 'OFF'
          ? 'OFF'
          : this.child
            ? 'RUNNING'
            : this.lastFailure
              ? 'FAILED'
              : 'STOPPED',
      helperVersion: this.helperInfo.version,
      sdk: this.helperInfo.sdk,
      simulated: this.mode === 'SIMULATOR',
      error: this.lastFailure?.message ?? null,
    };
  }

  async list(): Promise<CameraDescriptor[]> {
    if (this.mode === 'OFF') return [];
    const r = await this.command({ cmd: 'list' });
    return (r.cameras as CameraDescriptor[]).map((c) => ({
      ...c,
      simulated: this.mode === 'SIMULATOR',
    }));
  }

  async info(serial: string | null): Promise<CameraInfo> {
    const r = await this.command({ cmd: 'info', serial: serial ?? '' });
    delete r.id;
    delete r.ok;
    return r as unknown as CameraInfo;
  }

  /**
   * One full-resolution still, written by the helper as a lossless 16-bit RGB PNG. Stills are
   * queued so two captures never interleave; each is audited with the camera and settings used.
   */
  still(
    principal: ModulePrincipal,
    request: CameraStillRequest,
    origin: RequestOrigin,
  ): Promise<CameraStill> {
    const run = this.stillQueue.then(() =>
      this.takeStill(principal, request, origin),
    );
    this.stillQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Subscribes to a camera's live preview. The first subscriber starts it, the last one to leave
   * stops it. A viewer asking for other settings changes the running preview in place (the newest
   * request wins); the stream itself is never restarted for a settings change.
   */
  async preview(
    serial: string,
    settings: PreviewSettings,
    listener: (e: PreviewEvent) => void,
  ): Promise<() => void> {
    if (this.mode === 'OFF') throw new CameraError('Cameras are switched off on this server.');
    const key = JSON.stringify(settings);
    let group = this.previews.get(serial);
    if (!group) {
      await this.command({ cmd: 'preview_start', serial, maxSize: 960, fps: 5, ...settings });
      group = { serial, key, listeners: new Set() };
      this.previews.set(serial, group);
    } else if (group.key !== key) {
      await this.command({ cmd: 'preview_set', serial, ...settings });
      group.key = key;
    }
    group.listeners.add(listener);
    const g = group;
    return () => {
      g.listeners.delete(listener);
      if (g.listeners.size === 0 && this.previews.get(serial) === g) {
        this.previews.delete(serial);
        this.command({ cmd: 'preview_stop', serial }).catch(() => undefined);
      }
    };
  }

  /** Changes the running preview's exposure, gain, white balance or parameters without restarting it. */
  async setPreview(serial: string, settings: Partial<PreviewSettings>): Promise<PreviewSettings> {
    const group = this.previews.get(serial);
    if (!group) throw new CameraError('No live preview is running for this camera.');
    const r = await this.command({ cmd: 'preview_set', serial, ...settings });
    const s = r.settings as { exposureUs: number; gain: number; wb: number[] };
    const current: PreviewSettings = {
      ...(JSON.parse(group.key) as PreviewSettings),
      exposureUs: Number(s.exposureUs),
      gain: Number(s.gain),
      whiteBalance: s.wb.map(Number) as [number, number, number],
      ...(settings.parameters ? { parameters: settings.parameters } : {}),
    };
    group.key = JSON.stringify(current);
    return current;
  }

  /**
   * The camera's auto features, run once: on the camera (IDS peak ExposureAuto / GainAuto /
   * BalanceWhiteAuto) where it has them, else on the host from raw frame statistics. A running
   * preview follows the result.
   */
  async auto(request: CameraAutoRequest): Promise<CameraAutoResult> {
    const features = request.features.filter((f) => ['exposure', 'gain', 'whiteBalance'].includes(f));
    if (!features.length) throw new CameraError('Choose what to set automatically: exposure, gain or white balance.');
    const exposureUs = Number(request.exposureUs);
    if (!(exposureUs >= 10 && exposureUs <= 10_000_000)) throw new CameraError('Exposure must be between 10 µs and 10 s.');
    const r = await this.command(
      {
        cmd: 'auto',
        serial: request.serial ?? '',
        features,
        exposureUs,
        gain: Number(request.gain ?? 1),
        whiteBalance: request.whiteBalance ?? [1, 1, 1],
        target: Math.min(0.9, Math.max(0.05, Number(request.target ?? 0.45))),
      },
      60_000,
    );
    const result: CameraAutoResult = {
      serial: String(r.serial),
      exposureUs: Number(r.exposureUs),
      gain: Number(r.gain),
      whiteBalance: (r.whiteBalance as number[]).map(Number) as [number, number, number],
      by: r.by as CameraAutoResult['by'],
      stats: r.stats as CameraAutoResult['stats'],
    };
    const group = this.previews.get(result.serial);
    if (group) group.key = JSON.stringify({ ...(JSON.parse(group.key) as PreviewSettings), exposureUs: result.exposureUs, gain: result.gain, whiteBalance: result.whiteBalance });
    return result;
  }

  /** Advanced parameters on the camera; returns what it accepted and what it has no node for. */
  async apply(serial: string, parameters: CameraParameters): Promise<{ applied: CameraParameters; unsupported: string[] }> {
    const r = await this.command({ cmd: 'apply', serial, parameters });
    return { applied: r.applied as CameraParameters, unsupported: r.unsupported as string[] };
  }

  async onModuleDestroy(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 300));
    if (this.child) this.child.kill();
  }

  // ---------------------------------------------------------------------------
  // Stills
  // ---------------------------------------------------------------------------

  private async takeStill(
    principal: ModulePrincipal,
    request: CameraStillRequest,
    origin: RequestOrigin,
  ): Promise<CameraStill> {
    const exposureUs = Number(request.exposureUs);
    const gain = Number(request.gain ?? 1);
    const wb = request.whiteBalance ?? [1, 1, 1];
    if (!(exposureUs >= 10 && exposureUs <= 10_000_000))
      throw new CameraError('Exposure must be between 10 µs and 10 s.');
    if (!(gain >= 1 && gain <= 64)) throw new CameraError('Gain must be between 1 and 64.');
    const path = join(tmpdir(), `nxgen-camera-${randomUUID()}.png`);
    try {
      const r = await this.command(
        {
          cmd: 'still',
          serial: request.serial ?? '',
          path,
          exposureUs,
          gain,
          whiteBalance: wb,
          ...(request.parameters ? { parameters: request.parameters } : {}),
        },
        Math.ceil(exposureUs / 1000) * 3 + 120_000,
      );
      const data = await readFile(path);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== r.sha256)
        throw new CameraError('The image from the camera helper was damaged on the way (SHA-256 mismatch).');
      const still: CameraStill = {
        data,
        sha256,
        contentType: 'image/png',
        serial: String(r.serial),
        simulated: this.mode === 'SIMULATOR',
        width: Number(r.width),
        height: Number(r.height),
        bitDepth: Number(r.bitDepth),
        sourceBits: Number(r.sourceBits),
        pixelFormat: String(r.pixelFormat),
        exposureUs: Number(r.exposureUs),
        gain: Number(r.gain),
        whiteBalance: (r.whiteBalance as number[]).map(Number) as [number, number, number],
        temperatureC: r.temperatureC == null ? null : Number(r.temperatureC),
        saturatedFraction: Number(r.saturatedFraction),
        capturedAt: new Date().toISOString(),
      };
      await this.audit.record({
        category: 'DEVICES',
        action: 'CAMERA_CAPTURE',
        result: 'SUCCESS',
        actor: principal.userId,
        actorName: principal.fullName,
        ipAddress: origin.ipAddress,
        machineName: origin.machineName,
        details: {
          serial: still.serial,
          simulated: still.simulated,
          sha256,
          width: still.width,
          height: still.height,
          exposureUs: still.exposureUs,
          gain: still.gain,
          whiteBalance: still.whiteBalance.join('/'),
          purpose: request.purpose ?? null,
        },
      });
      return still;
    } catch (e) {
      await this.audit
        .record({
          category: 'DEVICES',
          action: 'CAMERA_CAPTURE',
          result: 'FAILURE',
          actor: principal.userId,
          actorName: principal.fullName,
          ipAddress: origin.ipAddress,
          machineName: origin.machineName,
          details: { serial: request.serial ?? null, error: (e as Error).message, purpose: request.purpose ?? null },
        })
        .catch(() => undefined);
      throw e;
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Helper process
  // ---------------------------------------------------------------------------

  private async command(
    body: Record<string, unknown>,
    timeoutMs = COMMAND_MS,
  ): Promise<Record<string, unknown>> {
    if (this.mode === 'OFF') throw new CameraError('Cameras are switched off on this server.');
    await this.ensureHelper();
    const child = this.child;
    if (!child?.stdin) throw new CameraError('The camera helper is not running.');
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CameraError(`The camera did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      child.stdin!.write(JSON.stringify({ id, ...body }) + '\n');
    });
  }

  private ensureHelper(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.lastFailure && Date.now() - this.lastFailure.at < RESTART_BACKOFF_MS)
      return Promise.reject(new CameraError(this.lastFailure.message));
    this.starting = this.startHelper().finally(() => (this.starting = null));
    return this.starting;
  }

  /** The command line that runs the helper, from the environment or the repository layout. */
  private helperCommand(): { cmd: string; args: string[] } {
    let helper = process.env.NXGEN_CAMERA_HELPER?.trim();
    if (!helper) {
      // Development: walk up from this file to the repository's tools/camera-helper.
      let dir = __dirname;
      for (let i = 0; i < 8 && !helper; i++) {
        const candidate = join(dir, 'tools', 'camera-helper', 'nxgen_camera.py');
        if (existsSync(candidate)) helper = candidate;
        dir = dirname(dir);
      }
    }
    if (!helper || !existsSync(helper))
      throw new CameraError(
        'The camera helper is not installed on this computer (set NXGEN_CAMERA_HELPER).',
      );
    const args = this.mode === 'SIMULATOR' ? ['--simulate'] : [];
    if (helper.endsWith('.py')) {
      const python =
        process.env.NXGEN_PYTHON?.trim() ||
        (process.platform === 'win32' ? 'python' : 'python3');
      return { cmd: python, args: ['-u', resolve(helper), ...args] };
    }
    return { cmd: helper, args };
  }

  private startHelper(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const fail = (message: string) => {
        this.lastFailure = { at: Date.now(), message };
        if (!settled) {
          settled = true;
          reject(new CameraError(message));
        }
      };
      let command: { cmd: string; args: string[] };
      try {
        command = this.helperCommand();
      } catch (e) {
        fail((e as Error).message);
        return;
      }
      this.logger.log(`Starting camera helper (${this.mode}): ${command.cmd} ${command.args.join(' ')}`);
      const child = spawn(command.cmd, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const startTimer = setTimeout(() => {
        fail('The camera helper did not start within 20 s.');
        child.kill();
      }, HELPER_START_MS);
      child.on('error', (e) => {
        clearTimeout(startTimer);
        fail(`The camera helper could not be started: ${e.message}`);
      });
      child.stderr?.on('data', (d: Buffer) => this.logger.warn(`camera helper: ${d.toString().trim()}`));
      createInterface({ input: child.stdout! }).on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.event === 'ready') {
          clearTimeout(startTimer);
          this.child = child;
          this.lastFailure = null;
          this.helperInfo = { version: String(msg.version), sdk: null, simulated: !!msg.simulated };
          if (!settled) {
            settled = true;
            resolvePromise();
          }
          this.command({ cmd: 'hello' })
            .then((h) => (this.helperInfo.sdk = h.sdk == null ? null : String(h.sdk)))
            .catch(() => undefined);
          return;
        }
        if (msg.event) return this.onEvent(msg);
        const p = this.pending.get(Number(msg.id));
        if (!p) return;
        this.pending.delete(Number(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(new CameraError(String(msg.error ?? 'The camera reported an error.')));
      });
      child.on('exit', (code, signal) => {
        clearTimeout(startTimer);
        const message = `The camera helper stopped (${signal ?? `exit ${code}`}).`;
        if (this.child === child) {
          this.child = null;
          this.lastFailure = { at: Date.now(), message };
          this.logger.warn(message);
        } else fail(message);
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new CameraError(message));
        }
        this.pending.clear();
        for (const g of this.previews.values())
          for (const l of g.listeners) l({ kind: 'end', error: message });
        this.previews.clear();
      });
    });
  }

  private onEvent(msg: Record<string, unknown>): void {
    if (msg.event === 'preview') {
      const g = this.previews.get(String(msg.serial));
      if (!g) return;
      const frame: PreviewEvent = {
        kind: 'frame',
        mime: String(msg.mime),
        width: Number(msg.width),
        height: Number(msg.height),
        seq: Number(msg.seq),
        data: Buffer.from(String(msg.data), 'base64'),
      };
      for (const l of g.listeners) l(frame);
    } else if (msg.event === 'lost') {
      const serial = String(msg.serial);
      const g = this.previews.get(serial);
      this.previews.delete(serial);
      const error = `Camera ${serial} stopped sending images: ${String(msg.error ?? '')}`;
      if (g) for (const l of g.listeners) l({ kind: 'end', error });
      this.audit
        .record({
          category: 'DEVICES',
          action: 'CAMERA_LOST',
          result: 'FAILURE',
          actor: 'SYSTEM_CAMERA',
          details: { serial, error: String(msg.error ?? '') },
        })
        .catch(() => undefined);
    } else if (msg.event === 'log') {
      this.logger.log(`camera helper: ${String(msg.message)}`);
    }
  }
}
