import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';
import { normalizeEmail } from './normalize-email';
import { passwordHasher } from './password-hashing';

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
    const email = normalizeEmail(input.email);
    const existing = await this.prisma.client.user.findFirst({
      where: { email },
    });
    if (existing) {
      throw new ConflictDomainError('A user with this email already exists', {
        email,
      });
    }
    const passwordHash = await passwordHasher.hash(input.password);
    try {
      const created = await this.prisma.client.user.create({
        data: {
          email,
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
        email,
      });
    }
  }

  /**
   * For authentication only — returns the full User including passwordHash.
   * Do NOT use in read/list endpoints (it would leak the hash).
   */
  async findByEmailWithHash(email: string): Promise<User | null> {
    return this.prisma.client.user.findFirst({
      where: { email: normalizeEmail(email) },
    });
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.client.user.findFirst({ where: { id } });
    return user ? stripHash(user) : null;
  }

  async verifyPassword(user: User, password: string): Promise<boolean> {
    return passwordHasher.verify(user.passwordHash, password);
  }

  private decoyHashPromise?: Promise<string>;

  /** A cached argon2 hash of random bytes — never matches any real password.
   *  A failed first hash (e.g. a 503 from the argon2 gate) is NOT cached, or
   *  every later unknown-email login would fail forever. */
  private decoyHash(): Promise<string> {
    this.decoyHashPromise ??= passwordHasher
      .hash(randomBytes(32).toString('hex'))
      .catch((err: unknown) => {
        this.decoyHashPromise = undefined;
        throw err;
      });
    return this.decoyHashPromise;
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
    if (user) return passwordHasher.verify(user.passwordHash, password);
    await passwordHasher.verify(await this.decoyHash(), password);
    return false;
  }

  /** Self-service password change: verifies the current password, re-hashes,
   *  clears mustChangePassword. Caller is responsible for session revocation.
   *  Reusing the current password is refused (422) — checked before any argon2
   *  work, and it discloses nothing (the caller supplied both values).
   *
   *  Serialized with an admin reset-password (AUDIT3-17): the argon2 work runs
   *  OUTSIDE any lock, then the write re-reads the row `FOR UPDATE` and only
   *  proceeds if the hash is still the one the current password was verified
   *  against. A reset (or another change) that committed in between wins — this
   *  change is refused as 401 "Current password is incorrect" (it no longer is),
   *  so a just-reset account can never be silently taken back. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (newPassword === currentPassword) {
      throw new ValidationFailedError(
        'New password must differ from the current password',
      );
    }
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId },
    });
    if (
      !user ||
      !(await passwordHasher.verify(user.passwordHash, currentPassword))
    ) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await passwordHasher.hash(newPassword);
    await this.prisma.transaction(async (tx) => {
      // Same row lock admin reset-password takes (after its admin-pool lock).
      const rows = await tx.$queryRaw<{ password_hash: string }[]>`
        SELECT password_hash FROM users
        WHERE id = ${userId} AND deleted_at IS NULL
        FOR UPDATE`;
      if (rows[0]?.password_hash !== user.passwordHash) {
        throw new UnauthorizedException('Current password is incorrect');
      }
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
      });
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
