import { Module } from '@nestjs/common';
import { SignaturesModule } from '../signatures/signatures.module';
import { RecoveryController } from './recovery.controller';
import { RecoveryService } from './recovery.service';
import { RolesController, UsersController } from './users.controller';
import { UserAdminService } from './user-admin.service';

@Module({
  imports: [SignaturesModule],
  controllers: [UsersController, RolesController, RecoveryController],
  providers: [UserAdminService, RecoveryService],
  exports: [UserAdminService],
})
export class UsersModule {}
