import { Module } from '@nestjs/common';
import { WorkflowModule } from '../workflow/workflow.module';
import { MethodsController } from './methods.controller';
import { MethodsService } from './methods.service';

@Module({
  imports: [WorkflowModule],
  controllers: [MethodsController],
  providers: [MethodsService],
})
export class MethodsModule {}
