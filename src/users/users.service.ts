import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
} from '../common/errors/domain-errors';

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  role: Role;
}

type SafeUser = Omit<User, 'passwordHash'>;

function stripHash(user: User): SafeUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput): Promise<SafeUser> {
    const existing = await this.prisma.client.user.findFirst({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictDomainError('A user with this email already exists', {
        email: input.email,
      });
    }
    const passwordHash = await argon2.hash(input.password);
    const created = await this.prisma.client.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        role: input.role,
      },
    });
    return stripHash(created);
  }

  async findByEmail(email: string): Promise<SafeUser | null> {
    const user = await this.prisma.client.user.findFirst({ where: { email } });
    return user ? stripHash(user) : null;
  }

  async findByEmailWithHash(email: string): Promise<User | null> {
    return this.prisma.client.user.findFirst({ where: { email } });
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.client.user.findFirst({ where: { id } });
    return user ? stripHash(user) : null;
  }

  async verifyPassword(user: User, password: string): Promise<boolean> {
    return argon2.verify(user.passwordHash, password);
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const user = await this.prisma.client.user.findFirst({ where: { id } });
    if (!user) {
      throw new NotFoundDomainError('User not found', { id });
    }
    // Tombstone the unique email so it can be reused, and mark soft-deleted.
    await this.prisma.client.user.update({
      where: { id },
      data: {
        email: `${user.email}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
  }
}
