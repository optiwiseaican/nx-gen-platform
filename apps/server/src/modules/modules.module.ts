import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { GatewayModule } from '../gateway/gateway.module';
import { LicensingModule } from '../licensing/licensing.module';
import { SignaturesModule } from '../signatures/signatures.module';
import { ModuleManagerService } from './module-manager.service';
import { ModulesController } from './modules.controller';

@Module({
  imports: [
    AuthModule,
    DevicesModule,
    GatewayModule,
    LicensingModule,
    SignaturesModule,
  ],
  controllers: [ModulesController],
  providers: [ModuleManagerService],
  exports: [ModuleManagerService],
})
export class ModulesModule {}
