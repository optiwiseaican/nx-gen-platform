import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { NxGenRequest, Principal } from './auth.types';

export const ACCESS_KEY = 'nxgen:access';
export const PERMISSION_KEY = 'nxgen:permission';
export const ALLOW_PASSWORD_CHANGE_KEY = 'nxgen:allow-password-change';

/** No authentication required. */
export const Public = () => SetMetadata(ACCESS_KEY, 'public');

/**
 * Open without login ONLY until the first administrator exists (activation,
 * commissioning). Afterwards it behaves like a normal protected route.
 */
export const OpenUntilAdministratorExists = () =>
  SetMetadata(ACCESS_KEY, 'setup');

/** Requires the signed-in user to hold this permission (backend RBAC, master spec §5). */
export const RequirePermission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);

/** Reachable while the user is forced to change an expired/temporary password. */
export const AllowDuringPasswordChange = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<NxGenRequest>().principal,
);
