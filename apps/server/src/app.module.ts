import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { LicensingModule } from './licensing/licensing.module';
import { MethodsModule } from './methods/methods.module';
import { SecurityConfigModule } from './security/security-config.module';
import { SignaturesModule } from './signatures/signatures.module';
import { UsersModule } from './users/users.module';
import { WorkflowModule } from './workflow/workflow.module';

@Module({
  imports: [
    CoreModule,
    LicensingModule,
    AuthModule,
    SignaturesModule,
    SecurityConfigModule,
    UsersModule,
    WorkflowModule,
    MethodsModule,
  ],
})
export class AppModule {}
