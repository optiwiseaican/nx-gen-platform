import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { CurrentPrincipal, RequirePermission } from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest, Principal } from '../auth/auth.types';
import type { SignatureInput } from '../signatures/signature.service';
import { SecurityPolicyService } from './security-policy.service';

@Controller('security/policy')
export class SecurityPolicyController {
  constructor(private readonly policy: SecurityPolicyService) {}

  /** The password, lockout and session rules in force. Any signed-in user. */
  @Get()
  current() {
    return this.policy.current();
  }

  @RequirePermission('security.manage')
  @Put()
  update(
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.policy.update(
      p,
      body?.changes,
      body?.reason,
      body?.signature as SignatureInput | undefined,
      originOf(req),
    );
  }
}
