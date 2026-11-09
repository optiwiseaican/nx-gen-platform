import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { CurrentPrincipal, RequirePermission } from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest, Principal } from '../auth/auth.types';
import type { SignatureInput } from '../signatures/signature.service';
import { UserAdminService } from './user-admin.service';

type Payload = Record<string, unknown>;
const sig = (body: Payload) => body?.signature as SignatureInput | undefined;

@Controller('users')
export class UsersController {
  constructor(private readonly users: UserAdminService) {}

  @RequirePermission('users.view')
  @Get()
  list() {
    return this.users.listUsers();
  }

  @RequirePermission('users.view')
  @Get('session-defaults')
  sessionDefaults() {
    return this.users.sessionDefaults();
  }

  @RequirePermission('users.view')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.users.getUser(id);
  }

  @RequirePermission('users.view')
  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.users.userHistory(id);
  }

  @RequirePermission('users.manage')
  @Post()
  create(
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.createUser(
      p,
      {
        username: body?.username,
        fullName: body?.fullName,
        email: body?.email,
        roles: body?.roles,
        reason: body?.reason,
      },
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('users.manage')
  @Put(':id/profile')
  profile(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.updateProfile(
      p,
      id,
      { fullName: body?.fullName, email: body?.email, reason: body?.reason },
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('users.manage')
  @Put(':id/session')
  session(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.setSessionTiming(
      p,
      id,
      {
        idleMinutes: body?.idleMinutes,
        maxHours: body?.maxHours,
        reason: body?.reason,
      },
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('users.manage')
  @Put(':id/roles')
  roles(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.setRoles(
      p,
      id,
      { roles: body?.roles, reason: body?.reason },
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('users.manage')
  @Post(':id/disable')
  @HttpCode(200)
  disable(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.setStatus(
      p,
      id,
      'DISABLED',
      body?.reason,
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('users.manage')
  @Post(':id/enable')
  @HttpCode(200)
  enable(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.setStatus(
      p,
      id,
      'ACTIVE',
      body?.reason,
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('users.manage')
  @Post(':id/unlock')
  @HttpCode(200)
  unlock(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.unlock(p, id, body?.reason, originOf(req), sig(body));
  }

  @RequirePermission('users.manage')
  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('id') id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.resetPassword(
      p,
      id,
      body?.reason,
      originOf(req),
      sig(body),
    );
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly users: UserAdminService) {}

  @RequirePermission('users.view')
  @Get()
  async list() {
    return {
      roles: await this.users.listRoles(),
      permissions: await this.users.listPermissions(),
    };
  }

  @RequirePermission('roles.manage')
  @Post()
  create(
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.createRole(
      p,
      {
        code: body?.code,
        name: body?.name,
        description: body?.description,
        permissions: body?.permissions,
        reason: body?.reason,
      },
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('roles.manage')
  @Put(':code/permissions')
  permissions(
    @Param('code') code: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.users.setRolePermissions(
      p,
      code,
      { permissions: body?.permissions, reason: body?.reason },
      originOf(req),
      sig(body),
    );
  }
}
