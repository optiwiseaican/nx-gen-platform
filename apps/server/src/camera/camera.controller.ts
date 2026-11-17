import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { PassiveRequest, RequirePermission } from '../auth/auth.decorators';
import type { NxGenRequest } from '../auth/auth.types';
import { CameraError, CameraService } from './camera.service';
import type { PreviewSettings } from './camera.service';

const SERIAL = /^[\w.-]{1,64}$/;
const BOUNDARY = 'nxgenframe';
/** A preview stream ends after this long; the page simply reopens it if still needed. */
const PREVIEW_MAX_MS = 15 * 60_000;

/** Cameras on the server's computer: status, list and the live preview stream. */
@Controller('cameras')
export class CameraController {
  constructor(private readonly cameras: CameraService) {}

  @RequirePermission('devices.view')
  @PassiveRequest()
  @Get()
  async overview() {
    const status = this.cameras.status();
    if (status.mode === 'OFF') return { status, cameras: [] };
    try {
      return { status: this.cameras.status(), cameras: await this.cameras.list() };
    } catch (e) {
      return { status: { ...this.cameras.status(), error: (e as Error).message }, cameras: [] };
    }
  }

  @RequirePermission('devices.view')
  @PassiveRequest()
  @Get(':serial')
  async info(@Param('serial') serial: string) {
    if (!SERIAL.test(serial)) throw new BadRequestException('Unknown camera.');
    try {
      return await this.cameras.info(serial);
    } catch (e) {
      if (e instanceof CameraError) throw new ConflictException(e.message);
      throw e;
    }
  }

  /**
   * Live preview as an image stream (multipart/x-mixed-replace): put the URL in an <img> and the
   * browser shows each new frame. Closing the page or removing the image ends the stream.
   */
  @RequirePermission('devices.view')
  @PassiveRequest()
  @Get(':serial/preview')
  async preview(
    @Param('serial') serial: string,
    @Query('exposureUs') exposureUs: string | undefined,
    @Query('gain') gain: string | undefined,
    @Query('wb') wb: string | undefined,
    @Req() req: NxGenRequest,
    @Res() res: Response,
  ): Promise<void> {
    if (!SERIAL.test(serial)) throw new BadRequestException('Unknown camera.');
    const settings: PreviewSettings = {
      exposureUs: clampNumber(exposureUs, 20_000, 10, 2_000_000),
      gain: clampNumber(gain, 1, 1, 64),
      whiteBalance: parseWb(wb),
    };
    let unsubscribe: (() => void) | null = null;
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      clearTimeout(maxTimer);
      unsubscribe?.();
      res.end();
    };
    const maxTimer = setTimeout(end, PREVIEW_MAX_MS);
    req.on('close', end);
    try {
      unsubscribe = await this.cameras.preview(serial, settings, (e) => {
        if (finished) return;
        if (e.kind === 'end') return end();
        if (!res.headersSent)
          res.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
        res.write(`--${BOUNDARY}\r\nContent-Type: ${e.mime}\r\nContent-Length: ${e.data.length}\r\n\r\n`);
        res.write(e.data);
        res.write('\r\n');
      });
      if (finished) unsubscribe();
    } catch (e) {
      clearTimeout(maxTimer);
      finished = true;
      if (!res.headersSent)
        res.status(e instanceof CameraError ? 409 : 500).json({ message: (e as Error).message });
      else res.end();
    }
  }
}

function clampNumber(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseWb(v: string | undefined): [number, number, number] {
  const parts = (v ?? '').split(',').map(Number);
  return parts.length === 3 && parts.every((x) => x >= 0.1 && x <= 8)
    ? (parts as [number, number, number])
    : [1, 1, 1];
}
