import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest } from '../auth/auth.types';
import { RecoveryService } from './recovery.service';

/**
 * Administrator recovery. Public by necessity (nobody can sign in), so it
 * only ever produces a request code; nothing changes until a response signed
 * by the vendor key is presented.
 */
@Controller('recovery')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Public()
  @Post('request')
  @HttpCode(200)
  request(@Body() body: Record<string, unknown>, @Req() req: NxGenRequest) {
    return this.recovery.createRequest(
      body?.username,
      body?.reason,
      originOf(req),
    );
  }

  @Public()
  @Post('complete')
  @HttpCode(200)
  complete(@Body() body: Record<string, unknown>, @Req() req: NxGenRequest) {
    return this.recovery.complete(body?.response, originOf(req));
  }
}
