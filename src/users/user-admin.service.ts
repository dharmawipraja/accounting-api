import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotFoundDomainError } from '../common/errors/domain-errors';
import { listPaginated } from '../common/pagination/paginated';
import { UsersService, SafeUser } from './users.service';
import { generateTempPassword } from './temp-password';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UserResponseDto } from './dto/user-response.dto';

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
    // No `search`/`hydrate` (no ?q= on users — small bounded set): the seam
    // takes the non-search `page` branch, exactly like accounts/tax-codes.
    return listPaginated({
      limit: q.limit,
      offset: q.offset,
      present: toUserResponse,
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.user.findMany({
            where,
            orderBy: { email: 'asc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.user.count({ where }),
        ]);
        return { rows, total };
      },
    });
  }

  async getById(id: string): Promise<UserResponseDto> {
    const u = await this.users.findById(id);
    if (!u) throw new NotFoundDomainError('User not found', { id });
    return toUserResponse(u);
  }
}
