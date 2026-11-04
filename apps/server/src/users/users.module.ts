import { Module } from '@nestjs/common';
import { RolesController, UsersController } from './users.controller';
import { UserAdminService } from './user-admin.service';

@Module({
  controllers: [UsersController, RolesController],
  providers: [UserAdminService],
  exports: [UserAdminService],
})
export class UsersModule {}
