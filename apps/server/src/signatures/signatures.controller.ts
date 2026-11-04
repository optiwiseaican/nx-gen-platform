import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import { CurrentPrincipal, RequirePermission } from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest, Principal } from '../auth/auth.types';
import { SignatureService } from './signature.service';
import type { SignatureInput } from './signature.service';

@Controller('signatures')
export class SignaturesController {
  constructor(private readonly signatures: SignatureService) {}

  /** Which actions need a signature, and the available meanings. Any signed-in user. */
  @Get('policy')
  async policy() {
    return {
      policies: await this.signatures.policies(),
      meanings: await this.signatures.meanings(),
    };
  }

  @RequirePermission('security.manage')
  @Put('policy')
  update(
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.signatures.updatePolicies(
      p,
      body?.changes,
      body?.reason,
      body?.signature as SignatureInput | undefined,
      originOf(req),
    );
  }

  /** Signature records with manifestation and integrity status. */
  @RequirePermission('audit.view')
  @Get()
  list(@Query('table') table?: string, @Query('record') record?: string) {
    return this.signatures.list({
      tableName: table || undefined,
      recordId: record || undefined,
    });
  }
}
