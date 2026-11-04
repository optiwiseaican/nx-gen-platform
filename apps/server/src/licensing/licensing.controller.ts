import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
} from '@nestjs/common';
import {
  OpenUntilAdministratorExists,
  Public,
  RequirePermission,
} from '../auth/auth.decorators';
import { LicensingService } from './licensing.service';

interface ActivateBody {
  activationCode?: unknown;
  /** Contents of a .nxlic chosen via "Select License File" (PRD §15). */
  licenseFile?: unknown;
  licenseFileName?: unknown;
}

const MAX_LICENSE_FILE_CHARS = 64 * 1024;

@Controller('licensing')
export class LicensingController {
  constructor(private readonly licensing: LicensingService) {}

  /** Data for activation Screens 1 and 3. Deliberately excludes module entitlements (PRD §24, §28). */
  @Public()
  @Get('status')
  status() {
    return this.licensing.getStatus();
  }

  /** Screen 2. Domain failures return 200 with ok=false so the UI can show them in place. */
  @OpenUntilAdministratorExists()
  @RequirePermission('licensing.manage')
  @Post('activate')
  @HttpCode(200)
  activate(@Body() body: ActivateBody) {
    if (typeof body?.activationCode !== 'string')
      throw new BadRequestException('activationCode is required');
    if (body.licenseFile !== undefined) {
      if (
        typeof body.licenseFile !== 'string' ||
        body.licenseFile.length > MAX_LICENSE_FILE_CHARS
      ) {
        throw new BadRequestException(
          'licenseFile must be the text of a .nxlic file',
        );
      }
    }
    const fileName =
      typeof body.licenseFileName === 'string'
        ? body.licenseFileName.replace(/[^\w.\- ]/g, '').slice(0, 120)
        : undefined;
    return this.licensing.activate(
      body.activationCode,
      body.licenseFile,
      fileName,
    );
  }

  /**
   * Service / commissioning function: generate the activation request for the
   * License Authority. Not part of the customer three-screen flow.
   * Open during commissioning (before any user exists); afterwards requires licensing.manage.
   */
  @OpenUntilAdministratorExists()
  @RequirePermission('licensing.manage')
  @Post('request')
  @HttpCode(200)
  request() {
    return this.licensing.generateActivationRequest();
  }

  /**
   * Internal entitlement query for module applications (PRD §25).
   * Requires a signed-in user.
   */
  /**
   * Signed certificate for independent verification by the Electron shell.
   * Public: the certificate is a signed public document with no secrets; the desktop shell
   * fetches it before any user signs in.
   */
  @Public()
  @Get('certificate')
  certificate() {
    return { license: this.licensing.getActiveCertificate() };
  }

  /**
   * System Information view (PRD §7).
   * Open before the first administrator exists; afterwards requires system.view.
   */
  @OpenUntilAdministratorExists()
  @RequirePermission('system.view')
  @Get('system-information')
  systemInformation() {
    return this.licensing.getSystemInformation();
  }

  @Get('entitlements')
  entitlements() {
    return {
      active: this.licensing.isActive(),
      modules: this.licensing.getEntitlements(),
    };
  }
}
