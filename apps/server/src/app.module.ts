import { Module } from '@nestjs/common';
import { LicensingModule } from './licensing/licensing.module';

@Module({
  imports: [LicensingModule],
})
export class AppModule {}
