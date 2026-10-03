import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { listPaginated } from '../common/pagination/paginated';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { tombstoneData } from '../common/prisma/tombstone';
import { UsersService, SafeUser } from './users.service';
import { generateTempPassword } from './temp-password';
import { passwordHasher } from './password-hashing';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';

import { USER_ADMIN_LOCK_KEY } from '../common/concurrency/advisory-lock-keys';
// Re-exported for existing importers; defined in the dependency-free keys module.
export { USER_ADMIN_LOCK_KEY };

export function toUserResponse(u: SafeUser): UserResponseDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt.toISOString(),
  };
}

@Injectable()
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /** Create with a generated one-time password; the caller (controller)
   *  returns it exactly once. Duplicate email → 409 via UsersService. */
  async createWithTempPassword(dto: CreateUserDto) {
    const tempPassword = generateTempPassword();
    const user = await this.users.create({
      email: dto.email,
      password: tempPassword,
      name: dto.name,
      role: dto.role,
      mustChangePassword: true,
    });
    return { user: toUserResponse(user), tempPassword };
  }

  async list(q: ListUsersQueryDto) {
    const where = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.isActive !== undefined ? { isActive: q.isActive === 'true' } : {}),
    };
    // No `search` (no ?q= on users — small bounded set): the seam takes the
    // non-search page branch, exactly like accounts/tax-codes.
    return listPaginated({
      limit: q.limit,
      offset: q.offset,
      present: toUserResponse,
      model: this.prisma.client.user,
      where,
      orderBy: { email: 'asc' },
    });
  }

  async getById(id: string): Promise<UserResponseDto> {
    const u = await this.users.findById(id);
    if (!u) throw new NotFoundDomainError('User not found', { id });
    return toUserResponse(u);
  }

  async update(
    actorId: string,
    id: string,
    dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    if (id === actorId && dto.role !== undefined)
      throw new ValidationFailedError('You cannot change your own role', {
        id,
      });
    if (id === actorId && dto.isActive === false)
      throw new ValidationFailedError('You cannot deactivate yourself', {
        id,
      });

    const leavesAdminPool = (u: { role: string; isActive: boolean }) =>
      u.role === 'ADMIN' &&
      u.isActive &&
      ((dto.role !== undefined && dto.role !== 'ADMIN') ||
        dto.isActive === false);

    const updated = await this.prisma.transaction(async (tx) => {
      // Soft-delete extension does NOT apply inside $transaction → filter explicitly.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY})`;
      const target = await tx.user.findFirst({
        where: { id, deletedAt: null },
      });
      if (!target) throw new NotFoundDomainError('User not found', { id });
      if (leavesAdminPool(target)) {
        const otherAdmins = await tx.user.count({
          where: {
            role: 'ADMIN',
            isActive: true,
            deletedAt: null,
            id: { not: id },
          },
        });
        if (otherAdmins === 0)
          throw new ValidationFailedError(
            'Cannot remove the last active ADMIN',
            { id },
          );
      }
      return tx.user.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    });

    // Role change or deactivation: kill refresh families (access dies within
    // one request anyway thanks to per-request freshness).
    if (dto.role !== undefined || dto.isActive !== undefined) {
      await this.refreshTokens.revokeAllForUser(id);
    }
    return toUserResponse(updated);
  }

  /** New one-time password; all sessions die; user must change on next login.
   *  Lock order: admin-pool advisory lock → the user row FOR UPDATE
   *  — the same row lock UsersService.changePassword takes before its write, so
   *  a reset and a self-service change serialize (a change that verified the
   *  pre-reset hash is refused once the reset commits). */
  async resetPassword(id: string) {
    const tempPassword = generateTempPassword();
    const passwordHash = await passwordHasher.hash(tempPassword);
    const updated = await this.prisma.transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY})`;
      // Soft-delete extension does NOT apply inside $transaction → filter explicitly.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM users WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
      if (rows.length === 0)
        throw new NotFoundDomainError('User not found', { id });
      return tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true },
      });
    });
    await this.refreshTokens.revokeAllForUser(id);
    return { user: toUserResponse(updated), tempPassword };
  }

  /** Soft-delete via tombstone; email becomes reusable. Same rails as update. */
  async remove(actorId: string, id: string): Promise<void> {
    if (id === actorId)
      throw new ValidationFailedError('You cannot delete yourself', { id });
    await this.prisma.transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY})`;
      const target = await tx.user.findFirst({
        where: { id, deletedAt: null },
      });
      if (!target) throw new NotFoundDomainError('User not found', { id });
      if (target.role === 'ADMIN' && target.isActive) {
        const otherAdmins = await tx.user.count({
          where: {
            role: 'ADMIN',
            isActive: true,
            deletedAt: null,
            id: { not: id },
          },
        });
        if (otherAdmins === 0)
          throw new ValidationFailedError(
            'Cannot remove the last active ADMIN',
            { id },
          );
      }
      // The tombstone write MUST commit under the same advisory lock as the
      // admin-pool count above — releasing the lock before writing would open
      // a window where a concurrent update() demotion, whose own count still
      // sees this row as an active admin, could drain the pool to zero.
      // This is the ONLY user-deletion path (it holds the admin-pool lock).
      await tx.user.update({
        where: { id },
        data: tombstoneData('email', target.email, id, actorId),
      });
    });
    await this.refreshTokens.revokeAllForUser(id);
  }
}
