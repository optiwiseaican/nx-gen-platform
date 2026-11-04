import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AuditController,
  AuthController,
  SetupController,
} from './auth.controller';
import { AuthGuard } from './auth.guard';
import { IdentityService } from './identity.service';

@Module({
  controllers: [SetupController, AuthController, AuditController],
  providers: [IdentityService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [IdentityService],
})
export class AuthModule {}
