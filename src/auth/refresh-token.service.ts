import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as ms from 'ms';
import type { StringValue } from 'ms';
import { RefreshTokenStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';

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
    await this.prisma.client.refreshToken.create({
      data: { id: jti, userId, familyId, expiresAt: this.expiresAt() },
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

    const result = await this.prisma.client.$transaction(
      async (tx): Promise<RotateResult> => {
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
    await this.prisma.client.refreshToken.updateMany({
      where: { familyId: row.familyId },
      data: { status: 'REVOKED' },
    });
  }
}
