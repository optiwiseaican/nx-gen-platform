import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LICENSE_ERRORS, LicenseErrorCode } from '@crescent/licensing';
import { LicensingService } from './licensing.service';

const REQUIRES_LICENSE = 'nxgen:requires-license';

/**
 * Backend license enforcement (Technical Architecture §2, §6): hiding menu
 * items is not enough. Mark controllers/handlers that perform regulated work:
 *
 *   @RequiresLicense()        platform must be ACTIVE
 *   @RequiresLicense('tlc')   platform ACTIVE and TLC module entitled
 *
 * Read-only access to records, audit trail, backup and archive must NOT use
 * this decorator, so they keep working in restricted mode (License PRD §40).
 */
export const RequiresLicense = (moduleId?: string) =>
  SetMetadata(REQUIRES_LICENSE, moduleId ?? true);

@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly licensing: LicensingService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<
      string | true | undefined
    >(REQUIRES_LICENSE, [context.getHandler(), context.getClass()]);
    if (requirement === undefined) return true;

    if (!this.licensing.isActive()) {
      throw new ForbiddenException({
        code: 'NX-LIC-NOT-ACTIVE',
        message: 'NxGen Platform is not activated.',
      });
    }
    if (
      typeof requirement === 'string' &&
      !this.licensing.hasModule(requirement)
    ) {
      const info =
        LICENSE_ERRORS[LicenseErrorCode.PLATFORM_ENTITLEMENT_MISSING];
      throw new ForbiddenException({
        code: 'NX-LIC-MODULE-NOT-LICENSED',
        module: requirement,
        message: info.action,
      });
    }
    return true;
  }
}
