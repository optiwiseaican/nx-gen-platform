import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CameraModule } from '../camera/camera.module';
import { DevicesModule } from '../devices/devices.module';
import { GatewayModule } from '../gateway/gateway.module';
import { LicensingModule } from '../licensing/licensing.module';
import { SignaturesModule } from '../signatures/signatures.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ModuleManagerService } from './module-manager.service';
import { ModulesController } from './modules.controller';

@Module({
  imports: [
    AuthModule,
    CameraModule,
    DevicesModule,
    GatewayModule,
    LicensingModule,
    SignaturesModule,
    WorkflowModule,
  ],
  controllers: [ModulesController],
  providers: [ModuleManagerService],
  exports: [ModuleManagerService],
})
export class ModulesModule {}
