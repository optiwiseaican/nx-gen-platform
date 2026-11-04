import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { NXGEN_CONFIG } from '../config/nxgen.config';
import type { NxGenConfig } from '../config/nxgen.config';
import {
  AllowDuringPasswordChange,
  CurrentPrincipal,
  Public,
  RequirePermission,
} from './auth.decorators';
import { originOf, SESSION_COOKIE } from './auth.types';
import type { NxGenRequest, Principal } from './auth.types';
import { IdentityService } from './identity.service';

const str = (v: unknown, field: string, max = 300): string => {
  if (typeof v !== 'string' || v.length > max)
    throw new BadRequestException({ message: `${field} is required`, field });
  return v;
};

@Controller('setup')
export class SetupController {
  constructor(private readonly identity: IdentityService) {}

  @Public()
  @Get('status')
  status() {
    return this.identity.setupStatus();
  }

  /** Creates the first Super Administrator. Permanently closed once any user exists. */
  @Public()
  @Post('administrator')
  @HttpCode(201)
  createAdministrator(
    @Body() body: Record<string, unknown>,
    @Req() req: NxGenRequest,
  ) {
    return this.identity.createInitialAdministrator(
      {
        username: str(body?.username, 'username', 64),
        fullName: str(body?.fullName, 'fullName', 200),
        email: typeof body?.email === 'string' ? body.email : null,
        password: str(body?.password, 'password', 256),
      },
      originOf(req),
    );
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly identity: IdentityService,
    @Inject(NXGEN_CONFIG) private readonly config: NxGenConfig,
  ) {}

  private setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.production,
      path: '/',
      maxAge: this.config.security.sessionMaxHours * 3_600_000,
    });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: Record<string, unknown>,
    @Req() req: NxGenRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token, principal } = await this.identity.login(
      str(body?.username, 'username', 64),
      str(body?.password, 'password', 256),
      originOf(req),
    );
    this.setCookie(res, token);
    return principal;
  }

  @AllowDuringPasswordChange()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Req() req: NxGenRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.identity.logout(principal, originOf(req));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @AllowDuringPasswordChange()
  @Get('me')
  me(@CurrentPrincipal() principal: Principal) {
    return {
      ...principal,
      sessionIdleMinutes: this.config.security.sessionIdleMinutes,
    };
  }

  @AllowDuringPasswordChange()
  @Post('change-password')
  @HttpCode(200)
  changePassword(
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() principal: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.identity.changePassword(
      principal,
      str(body?.currentPassword, 'currentPassword', 256),
      str(body?.newPassword, 'newPassword', 256),
      originOf(req),
    );
  }
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermission('audit.view')
  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('action') action?: string,
  ) {
    const entries = await this.audit.list({
      limit: limit ? Number(limit) : 100,
      beforeSequence: before ? Number(before) : undefined,
      action: action || undefined,
    });
    return { entries, chain: await this.audit.verifyChain() };
  }
}
