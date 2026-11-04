import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { LicensingModule } from './licensing/licensing.module';
import { SignaturesModule } from './signatures/signatures.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    CoreModule,
    LicensingModule,
    AuthModule,
    SignaturesModule,
    UsersModule,
  ],
})
export class AppModule {}
