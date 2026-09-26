import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as ms from 'ms';
import type { StringValue } from 'ms';
import { RefreshTokenStatus } from '@prisma/client';
import { LedgerTx, PrismaService } from '../common/prisma/prisma.service';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';

import { REFRESH_SESSION_LOCK_NS } from '../common/concurrency/advisory-lock-keys';
// Re-exported for existing importers; defined in the dependency-free keys module.
export { REFRESH_SESSION_LOCK_NS };

/**
 * Per-user serialization point for every refresh-token writer (issue, rotate,
 * revoke one family, revoke all). Row locks alone are not enough: a revoke's UPDATE
 * snapshot predates a successor that a concurrent rotate INSERTs, so the
 * successor would survive the revoke. Holding this lock first means the revoke's
 * UPDATE statement starts only after the rotate committed (READ COMMITTED → a
 * fresh snapshot that sees the successor). Lock order: this lock → token rows.
 * The app's revokes run AFTER (never inside) the user-admin tx that holds
 * 71_001_001 and the user row lock. The one path holding them together
 * (scripts/create-admin.ts, break-glass reset) takes 71_001_001 → THIS lock →
 * the user row FOR UPDATE → token rows: a holder of this lock can wait on a user
 * row (issue/rotate INSERT a refresh token, whose FK check takes FOR KEY SHARE on
 * the user row), so the row lock must never be held while waiting for this one.
 */
async function lockUserSessions(tx: LedgerTx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_SESSION_LOCK_NS}::int4, hashtext(${userId}))`;
}

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private expiresAt(): Date {
    const ttl = this.config.getOrThrow<string>(
      'JWT_REFRESH_TTL',
    ) as StringValue;
    return new Date(Date.now() + ms(ttl));
  }

  /** Start a new session family and issue its first refresh-token row. */
  async issue(userId: string): Promise<{ jti: string; familyId: string }> {
    const jti = randomUUID();
    const familyId = randomUUID();
    // Same per-user lock as rotate/revoke: a login racing a password reset /
    // logout-all either commits first (and is then revoked) or runs after it.
    await this.prisma.transaction(async (tx) => {
      await lockUserSessions(tx, userId);
      await tx.refreshToken.create({
        data: { id: jti, userId, familyId, expiresAt: this.expiresAt() },
      });
    });
    return { jti, familyId };
  }

  /**
   * Rotate an ACTIVE refresh token: consume it and issue a successor in the same
   * family. Replaying a CONSUMED token (theft signal) revokes the whole family.
   * The consume + create (and the family revoke) are atomic.
   *
   * We use a discriminated result rather than throwing inside $transaction so that
   * the family-revoke updateMany is NOT rolled back when reuse is detected.
   */
  async rotate(
    jti: string,
    userId: string,
  ): Promise<{ jti: string; familyId: string }> {
    type RotateResult =
      | { ok: true; jti: string; familyId: string }
      | { ok: false; reason: 'invalid' | 'reuse' };

    const result = await this.prisma.transaction(
      async (tx): Promise<RotateResult> => {
        await lockUserSessions(tx, userId);
        const rows = await tx.$queryRaw<
          {
            id: string;
            user_id: string;
            family_id: string;
            status: RefreshTokenStatus;
          }[]
        >`SELECT id, user_id, family_id, status FROM refresh_tokens WHERE id = ${jti} FOR UPDATE`;
        const row = rows[0];
        if (!row || row.user_id !== userId || row.status === 'REVOKED') {
          return { ok: false, reason: 'invalid' };
        }
        if (row.status === 'CONSUMED') {
          await tx.refreshToken.updateMany({
            where: { familyId: row.family_id },
            data: { status: 'REVOKED' },
          });
          return { ok: false, reason: 'reuse' };
        }
        const newJti = randomUUID();
        await tx.refreshToken.update({
          where: { id: jti },
          data: {
            status: 'CONSUMED',
            consumedAt: new Date(),
            replacedById: newJti,
          },
        });
        await tx.refreshToken.create({
          data: {
            id: newJti,
            userId,
            familyId: row.family_id,
            expiresAt: this.expiresAt(),
          },
        });
        return { ok: true, jti: newJti, familyId: row.family_id };
      },
    );

    if (!result.ok) {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    return { jti: result.jti, familyId: result.familyId };
  }

  /** Revoke the entire family of the given token (logout one device). No-op if unknown. */
  async revokeFamilyByJti(jti: string): Promise<void> {
    const row = await this.prisma.client.refreshToken.findUnique({
      where: { id: jti },
    });
    if (!row) return;
    // family_id / user_id are immutable, so reading them before the lock is safe.
    await this.prisma.transaction(async (tx) => {
      await lockUserSessions(tx, row.userId);
      await tx.refreshToken.updateMany({
        where: { familyId: row.familyId },
        data: { status: 'REVOKED' },
      });
    });
  }

  /** Revoke every session for a user (logout all devices). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await lockUserSessions(tx, userId);
      await tx.refreshToken.updateMany({
        where: { userId },
        data: { status: 'REVOKED' },
      });
    });
  }

  /**
   * Hard-delete rows past their expiry. CONSUMED/REVOKED rows are kept until they
   * expire so a replay within the TTL is still detectable. Returns the count.
   */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.client.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }
}
