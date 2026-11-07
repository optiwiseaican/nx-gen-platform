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
import type { SignatureInput } from '../signatures/signature.service';
import { DevicesService } from './devices.service';

type Payload = Record<string, unknown>;
const uuid = new ParseUUIDPipe();
const sig = (b: Payload) => b?.signature as SignatureInput | undefined;

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @RequirePermission('devices.view')
  @Get()
  list() {
    return this.devices.list();
  }

  /** Resolves a calibration to its instrument (links from My Tasks). */
  @RequirePermission('devices.view')
  @Get('calibrations/:calibrationId')
  calibration(@Param('calibrationId', uuid) id: string) {
    return this.devices.deviceOfCalibration(id);
  }

  @RequirePermission('devices.view')
  @Get(':id')
  get(@Param('id', uuid) id: string, @CurrentPrincipal() p: Principal) {
    return this.devices.get(id, p);
  }

  @RequirePermission('devices.manage')
  @Post()
  register(
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.devices.register(p, body ?? {}, originOf(req), sig(body));
  }

  @RequirePermission('devices.manage')
  @Put(':id')
  update(
    @Param('id', uuid) id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.devices.update(p, id, body ?? {}, originOf(req), sig(body));
  }

  @RequirePermission('devices.manage')
  @Post(':id/status')
  @HttpCode(200)
  status(
    @Param('id', uuid) id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.devices.setStatus(
      p,
      id,
      body?.status,
      body?.reason,
      originOf(req),
      sig(body),
    );
  }

  @RequirePermission('calibration.perform')
  @Post(':id/calibrations')
  calibrate(
    @Param('id', uuid) id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.devices.recordCalibration(p, id, body ?? {}, originOf(req));
  }

  @RequirePermission('calibration.perform')
  @Put(':id/calibrations/:calibrationId')
  correct(
    @Param('id', uuid) id: string,
    @Param('calibrationId', uuid) calibrationId: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.devices.updateCalibration(
      p,
      id,
      calibrationId,
      body ?? {},
      originOf(req),
    );
  }
}
