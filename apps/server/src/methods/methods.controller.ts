import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { CurrentPrincipal, RequirePermission } from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest, Principal } from '../auth/auth.types';
import { MethodsService } from './methods.service';

const uuid = new ParseUUIDPipe();

@Controller('methods')
export class MethodsController {
  constructor(private readonly methods: MethodsService) {}

  @RequirePermission('methods.view')
  @Get()
  list() {
    return this.methods.list();
  }

  @RequirePermission('methods.view')
  @Get(':id')
  get(@Param('id', uuid) id: string, @CurrentPrincipal() p: Principal) {
    return this.methods.get(id, p);
  }

  @RequirePermission('methods.edit')
  @Post()
  create(
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.methods.create(p, body ?? {}, originOf(req));
  }

  @RequirePermission('methods.edit')
  @Put(':id/versions/:versionId')
  update(
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.methods.updateDraft(
      p,
      id,
      versionId,
      body ?? {},
      originOf(req),
    );
  }

  @RequirePermission('methods.edit')
  @Post(':id/versions')
  @HttpCode(200)
  newVersion(
    @Param('id', uuid) id: string,
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.methods.newVersion(p, id, body?.reason, originOf(req));
  }
}
