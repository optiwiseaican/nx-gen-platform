import { Module } from '@nestjs/common';
import { SignaturesModule } from '../signatures/signatures.module';
import { RolesController, UsersController } from './users.controller';
import { UserAdminService } from './user-admin.service';

@Module({
  imports: [SignaturesModule],
  controllers: [UsersController, RolesController],
  providers: [UserAdminService],
  exports: [UserAdminService],
})
export class UsersModule {}
