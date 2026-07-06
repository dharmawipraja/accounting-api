import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
} from '../common/errors/domain-errors';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  role: Role;
  mustChangePassword?: boolean;
}

export type SafeUser = Omit<User, 'passwordHash'>;

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
    try {
      const created = await this.prisma.client.user.create({
        data: {
          email: input.email,
          passwordHash,
          name: input.name,
          role: input.role,
          mustChangePassword: input.mustChangePassword ?? false,
        },
      });
      return stripHash(created);
    } catch (err) {
      // Concurrent creates can both pass the pre-check above; the unique
      // constraint is the real guard. Map it to a clean 409.
      mapUniqueViolation(err, 'A user with this email already exists', {
        email: input.email,
      });
    }
  }

  /**
   * For authentication only — returns the full User including passwordHash.
   * Do NOT use in read/list endpoints (it would leak the hash).
   */
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

  private decoyHashPromise?: Promise<string>;

  /** A cached argon2 hash of random bytes — never matches any real password. */
  private decoyHash(): Promise<string> {
    return (this.decoyHashPromise ??= argon2.hash(
      randomBytes(32).toString('hex'),
    ));
  }

  /**
   * Verify a password against the user's hash, or — when the user is absent —
   * against a decoy hash, so login timing does not reveal whether the email
   * exists. Always returns false for the decoy path.
   */
  async verifyPasswordOrDecoy(
    user: User | null,
    password: string,
  ): Promise<boolean> {
    if (user) return argon2.verify(user.passwordHash, password);
    await argon2.verify(await this.decoyHash(), password);
    return false;
  }

  /** Self-service password change: verifies the current password, re-hashes,
   *  clears mustChangePassword. Caller is responsible for session revocation. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId },
    });
    if (!user || !(await argon2.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.client.user.update({
      where: { id: userId },
      data: {
        passwordHash: await argon2.hash(newPassword),
        mustChangePassword: false,
      },
    });
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const user = await this.prisma.client.user.findFirst({ where: { id } });
    if (!user) {
      throw new NotFoundDomainError('User not found', { id });
    }
    // Tombstone the unique email so it can be reused, and mark soft-deleted.
    await this.prisma.client.user.tombstoneDelete(
      id,
      'email',
      user.email,
      deletedBy,
    );
  }
}
