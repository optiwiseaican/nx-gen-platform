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
import { AUDIT_EXPORT_HASH_HEADER, AuditService } from '../audit/audit.service';
import type { AuditQuery } from '../audit/audit.service';
import { PlatformIdentityService } from '../platform/platform-identity.service';
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

  private setCookie(res: Response, token: string, principal: Principal) {
    // The cookie lives as long as this session may (the account's own
    // maximum session length or the system's); the server enforces it anyway.
    const until = principal.session
      ? Date.parse(principal.session.expiresAt) - Date.now()
      : this.config.security.sessionMaxHours * 3_600_000;
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.production,
      path: '/',
      maxAge: Math.max(until, 60_000),
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
    this.setCookie(res, token, principal);
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
      sessionIdleMinutes:
        principal.sessionIdleMinutes ?? this.config.security.sessionIdleMinutes,
    };
  }

  /** Restart the inactivity timer ("Stay signed in"). Audited. */
  @AllowDuringPasswordChange()
  @Post('session/extend')
  @HttpCode(200)
  extendSession(
    @CurrentPrincipal() principal: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.identity.extendSession(principal, originOf(req));
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

type AuditFilterParams = Partial<
  Record<
    'action' | 'actor' | 'category' | 'result' | 'record' | 'from' | 'to',
    string
  >
>;

/** Validates the shared audit filters; dates are ISO 8601. */
function auditFilters(q: AuditFilterParams): AuditQuery {
  const date = (v: string | undefined, field: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException({
        message: `Invalid ${field} date.`,
        field,
      });
    return d.toISOString();
  };
  const text = (v: string | undefined) => v?.trim().slice(0, 200) || undefined;
  return {
    action: text(q.action),
    actor: text(q.actor),
    category: text(q.category),
    result: text(q.result),
    recordId: text(q.record),
    from: date(q.from, 'from'),
    to: date(q.to, 'to'),
  };
}

@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly platform: PlatformIdentityService,
  ) {}

  @RequirePermission('audit.view')
  @Get()
  async list(
    @Query() q: AuditFilterParams & { limit?: string; before?: string },
  ) {
    const entries = await this.audit.list({
      ...auditFilters(q),
      limit: q.limit ? Number(q.limit) : 100,
      beforeSequence: q.before ? Number(q.before) : undefined,
    });
    return { entries, chain: await this.audit.verifyChain() };
  }

  /**
   * CSV extract of the (filtered) trail with hash-chain columns. The export
   * itself is recorded in the trail, with the file's SHA-256 so a copy can
   * later be proven unaltered.
   */
  @RequirePermission('audit.view')
  @Get('export')
  async export(
    @Query() q: AuditFilterParams,
    @CurrentPrincipal() principal: Principal,
    @Req() req: NxGenRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const filters = auditFilters(q);
    const out = await this.audit.exportCsv(filters);
    const chain = await this.audit.verifyChain();
    const origin = originOf(req);
    await this.audit.record({
      category: 'SECURITY',
      action: 'AUDIT_TRAIL_EXPORTED',
      result: 'SUCCESS',
      actor: principal.userId,
      actorName: principal.fullName,
      tableName: 'audit_trail',
      platformInstanceId:
        this.platform.getIdentity().identity?.instanceId ?? null,
      ipAddress: origin.ipAddress,
      machineName: origin.machineName,
      details: {
        format: 'CSV',
        rows: out.rows,
        sha256: out.sha256,
        firstSequence: out.firstSequence,
        lastSequence: out.lastSequence,
        truncated: out.truncated,
        chainValid: chain.valid,
        filters: JSON.stringify(
          Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        ),
      },
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="nxgen-audit-trail-${stamp}.csv"`,
    );
    res.setHeader(AUDIT_EXPORT_HASH_HEADER, out.sha256);
    return out.csv;
  }
}
