import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  CurrentPrincipal,
  PassiveRequest,
  Public,
  RequirePermission,
} from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest, Principal } from '../auth/auth.types';
import { GatewayService } from './gateway.service';

type Payload = Record<string, unknown>;

@Controller('gateway')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  /** Ports, connection status, live instruments and unregistered senders. Polled by the screen. */
  @RequirePermission('devices.view')
  @PassiveRequest()
  @Get()
  overview() {
    return this.gateway.overview();
  }

  /** Live packet monitor: the latest lines from the dongles, accepted or not. Memory only. */
  @RequirePermission('devices.view')
  @PassiveRequest()
  @Get('packets')
  packets(
    @Query('port') port?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    return this.gateway.recentPackets(
      port || undefined,
      Number(after) || 0,
      Number(limit) || undefined,
    );
  }

  @RequirePermission('devices.view')
  @Get('messages/:deviceId')
  messages(
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.gateway.messages(deviceId, limit ? Number(limit) : 50);
  }

  @RequirePermission('devices.manage')
  @Post('ports')
  addPort(
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.gateway.savePort(p, null, body ?? {}, originOf(req));
  }

  @RequirePermission('devices.manage')
  @Put('ports/:id')
  updatePort(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: Payload,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.gateway.savePort(p, id, body ?? {}, originOf(req));
  }

  /**
   * Development only (refused when NODE_ENV=production): feed packet lines as
   * if they came from a USB dongle. The API listens on 127.0.0.1 only.
   * Packets are marked SIMULATOR and can never become instrument data.
   */
  @Public()
  @Post('simulator/packets')
  @HttpCode(200)
  simulate(@Body() body: Payload) {
    return this.gateway.simulate(body?.lines);
  }
}
