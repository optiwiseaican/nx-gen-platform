import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_KEY,
  ALLOW_PASSWORD_CHANGE_KEY,
  PERMISSION_KEY,
} from './auth.decorators';
import { NxGenRequest, originOf, readSessionCookie } from './auth.types';
import { IdentityService } from './identity.service';

/**
 * Global authentication + authorization guard. Every route is protected unless
 * explicitly marked; permissions are enforced here on the backend, never only
 * by hiding UI elements.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const access = this.reflector.getAllAndOverride<
      'public' | 'setup' | undefined
    >(ACCESS_KEY, targets);
    const permission = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_KEY,
      targets,
    );
    const req = context.switchToHttp().getRequest<NxGenRequest>();

    const token = readSessionCookie(req);
    if (token)
      req.principal =
        (await this.identity.authenticate(token, originOf(req))) ?? undefined;

    if (access === 'public') return true;
    if (access === 'setup' && !(await this.identity.administratorExists()))
      return true;

    const principal = req.principal;
    if (!principal)
      throw new UnauthorizedException({
        code: 'NX-AUTH-REQUIRED',
        message: 'Sign in to continue.',
      });

    if (
      principal.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(
        ALLOW_PASSWORD_CHANGE_KEY,
        targets,
      )
    ) {
      throw new ForbiddenException({
        code: 'NX-AUTH-PASSWORD-CHANGE',
        message: 'You must change your password before continuing.',
      });
    }
    if (permission && !principal.permissions.includes(permission)) {
      throw new ForbiddenException({
        code: 'NX-AUTH-FORBIDDEN',
        message: 'You do not have permission for this action.',
        permission,
      });
    }
    return true;
  }
}
