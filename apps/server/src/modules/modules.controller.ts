import {
  All,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  ForbiddenException,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ModulePrincipal } from '@crescent/module-sdk';
import {
  CurrentPrincipal,
  PassiveRequest,
  RequirePermission,
} from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest, Principal } from '../auth/auth.types';
import { IdentityService } from '../auth/identity.service';
import type { SignatureInput } from '../signatures/signature.service';
import { ModuleManagerService } from './module-manager.service';

type Payload = Record<string, unknown>;
const ID = /^[a-z][a-z0-9-]{1,31}$/;

@Controller('modules')
export class ModulesController {
  private readonly logger = new Logger('ModuleRouter');

  constructor(
    private readonly modules: ModuleManagerService,
    private readonly identity: IdentityService,
  ) {}

  /** Menu entries from running modules the user may open. */
  @Get()
  menu(@CurrentPrincipal() p: Principal) {
    return this.modules.menu(p);
  }

  @RequirePermission('modules.manage')
  @Get('installed')
  installed() {
    return this.modules.list();
  }

  /** Step 1: upload a .nxmod (application/octet-stream). Verified, nothing changed. */
  @RequirePermission('modules.manage')
  @Post('install/upload')
  @HttpCode(200)
  upload(@Req() req: NxGenRequest, @CurrentPrincipal() p: Principal) {
    const name = String(req.headers['x-file-name'] ?? '').slice(0, 200);
    return this.modules.stage(p, req.body, name);
  }

  /** Step 2: install what was verified, with reason and electronic signature. */
  @RequirePermission('modules.manage')
  @Post('install')
  @HttpCode(200)
  install(
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.modules.install(
      p,
      body?.stagingId,
      body?.reason,
      body?.signature as SignatureInput | undefined,
      originOf(req),
    );
  }

  @RequirePermission('modules.manage')
  @Post(':id/enable')
  @HttpCode(200)
  enable(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    if (!ID.test(id)) throw new NotFoundException();
    return this.modules.setEnabled(
      p,
      id,
      true,
      body?.reason,
      body?.signature as SignatureInput | undefined,
      originOf(req),
    );
  }

  @RequirePermission('modules.manage')
  @Post(':id/disable')
  @HttpCode(200)
  disable(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    if (!ID.test(id)) throw new NotFoundException();
    return this.modules.setEnabled(
      p,
      id,
      false,
      body?.reason,
      body?.signature as SignatureInput | undefined,
      originOf(req),
    );
  }

  /** What a module's UI needs to fit into NxGen (links back to the core). */
  @Get(':id/context')
  context(@Param('id') id: string) {
    if (!ID.test(id)) throw new NotFoundException();
    return this.modules.context4ui(id);
  }

  /**
   * Module API: /api/modules/<id>/api/<path>. Authenticated by the global
   * guard; the module route's permission is checked here. Marked passive so
   * polling routes don't extend the session; other routes record activity.
   */
  @PassiveRequest()
  @All(':id/api/*path')
  async dispatch(
    @Param('id') id: string,
    @Param('path') path: string | string[],
    @Req() req: NxGenRequest,
    @CurrentPrincipal() p: Principal,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rel = '/' + (Array.isArray(path) ? path.join('/') : path);
    const hit = ID.test(id) ? this.modules.route(id, req.method, rel) : null;
    if (!hit) throw new NotFoundException('No such module route.');
    if (!p.permissions.includes(hit.route.permission))
      throw new ForbiddenException({
        code: 'NX-AUTH-FORBIDDEN',
        message: 'You do not have permission for this action.',
        permission: hit.route.permission,
      });
    if (!hit.route.passive) await this.identity.touchSession(p.sessionId);
    const principal: ModulePrincipal = {
      userId: p.userId,
      username: p.username,
      fullName: p.fullName,
      roles: p.roles,
      permissions: p.permissions,
    };
    try {
      const out = await hit.route.handler({
        principal,
        params: hit.params,
        query: req.query as Record<string, string | undefined>,
        body: req.body,
        origin: originOf(req),
      });
      const file = out as {
        kind?: string;
        contentType?: string;
        data?: unknown;
        fileName?: string;
        immutable?: boolean;
      } | null;
      if (
        file?.kind === 'file' &&
        Buffer.isBuffer(file.data) &&
        typeof file.contentType === 'string'
      ) {
        // Private: only this signed-in browser keeps it; the URL is still access-checked on every
        // request the browser does make.
        if (file.immutable)
          res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        return new StreamableFile(file.data, {
          type: file.contentType,
          disposition: file.fileName
            ? `inline; filename="${file.fileName.replace(/[^\w.-]/g, '_')}"`
            : undefined,
        });
      }
      return out;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const err = e as {
        name?: string;
        status?: number;
        message?: string;
        field?: string;
      };
      if (
        err?.name === 'ModuleError' &&
        [400, 403, 404, 409].includes(err.status ?? 0)
      )
        throw new HttpException(
          { message: err.message, field: err.field },
          err.status!,
        );
      this.logger.error(
        `Module ${id} ${req.method} ${rel} failed: ${err?.message}`,
      );
      throw new InternalServerErrorException(
        'The module could not complete the request.',
      );
    }
  }
}
