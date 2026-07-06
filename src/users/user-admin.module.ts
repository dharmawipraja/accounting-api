import { Module } from '@nestjs/common';
import { UsersModule } from './users.module';
import { AuthModule } from '../auth/auth.module';
import { UserAdminService } from './user-admin.service';
import { UserAdminController } from './user-admin.controller';

/** Separate from UsersModule so refresh-token revocation (AuthModule) can be
 *  consumed without a UsersModule↔AuthModule cycle. */
@Module({
  imports: [UsersModule, AuthModule],
  providers: [UserAdminService],
  controllers: [UserAdminController],
})
export class UserAdminModule {}
