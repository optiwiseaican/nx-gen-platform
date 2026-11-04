import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { LicensingModule } from './licensing/licensing.module';

@Module({
  imports: [CoreModule, LicensingModule, AuthModule],
})
export class AppModule {}
