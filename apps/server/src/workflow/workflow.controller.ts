import {
  Body,
  ForbiddenException,
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
   * One record's approval state, the steps the user may take and the signed
   * history. Visible to holders of the workflow's permissions or audit.view.
   */
  @Get('instances/:id')
  async detail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentPrincipal() p: Principal,
  ) {
    const instance = await this.workflow.get(id);
    const d = await this.workflow.definition(instance.definitionCode);
    if (
      ![
        d.editPermission,
        d.reviewPermission,
        d.approvePermission,
        'audit.view',
      ].some((x) => p.permissions.includes(x))
    )
      throw new ForbiddenException(
        'You do not have permission to view this record.',
      );
    return {
      instance,
      definition: {
        code: d.code,
        name: d.name,
        requireReview: d.requireReview,
      },
      allowedSteps: await this.workflow.allowedSteps(instance, p),
      history: await this.workflow.history(id),
    };
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
