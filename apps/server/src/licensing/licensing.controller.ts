import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
} from '@nestjs/common';
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
  @Get('status')
  status() {
    return this.licensing.getStatus();
  }

  /** Screen 2. Domain failures return 200 with ok=false so the UI can show them in place. */
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
   * TODO(auth): restrict to the service/commissioning role once authentication exists.
   */
  @Post('request')
  @HttpCode(200)
  request() {
    return this.licensing.generateActivationRequest();
  }

  /**
   * Internal entitlement query for module applications (PRD §25).
   * TODO(auth): restrict to authenticated sessions once authentication exists.
   */
  @Get('entitlements')
  entitlements() {
    return {
      active: this.licensing.isActive(),
      modules: this.licensing.getEntitlements(),
    };
  }
}
