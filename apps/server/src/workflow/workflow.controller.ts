import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { CurrentPrincipal } from '../auth/auth.decorators';
import { originOf } from '../auth/auth.types';
import type { NxGenRequest, Principal } from '../auth/auth.types';
import type { SignatureInput } from '../signatures/signature.service';
import { WorkflowService } from './workflow.service';

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  /** Versions waiting for the signed-in user's review or approval. */
  @Get('tasks')
  tasks(@CurrentPrincipal() p: Principal) {
    return this.workflow.tasks(p);
  }

  /**
   * Take a step: submit, withdraw, review, approve, reject, invalidate.
   * Permissions, independence and state are enforced by the engine.
   */
  @Post('instances/:id/:step')
  @HttpCode(200)
  act(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('step') step: string,
    @Body() body: Record<string, unknown>,
    @CurrentPrincipal() p: Principal,
    @Req() req: NxGenRequest,
  ) {
    return this.workflow.act(
      p,
      id,
      step.toUpperCase(),
      {
        comment: body?.reason ?? body?.comment,
        returnTo: body?.returnTo,
        signature: body?.signature as SignatureInput | undefined,
      },
      originOf(req),
    );
  }
}
