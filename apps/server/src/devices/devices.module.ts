import { Module } from '@nestjs/common';
import { SignaturesModule } from '../signatures/signatures.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

@Module({
  imports: [SignaturesModule, WorkflowModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
