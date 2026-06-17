import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { UsersService } from '../users/users.service';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';
import {
  AuthenticatedUser,
  JwtPayload,
  RefreshJwtPayload,
} from './strategies/jwt.strategy';
import { RefreshTokenService } from './refresh-token.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findByEmailWithHash(email);
    // Always run a verify (decoy when the user is absent) so timing is constant.
    const valid = await this.users.verifyPasswordOrDecoy(user, password);
    if (!user || !user.isActive || !valid) {
      throw new UnauthorizedDomainError('Invalid credentials');
    }
    const { jti } = await this.refreshTokens.issue(user.id);
    return this.issueTokens(
      { id: user.id, email: user.email, role: user.role },
      jti,
    );
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: RefreshJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshJwtPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    const { jti } = await this.refreshTokens.rotate(payload.jti, user.id);
    return this.issueTokens(
      { id: user.id, email: user.email, role: user.role },
      jti,
    );
  }

  async logout(refreshToken: string): Promise<{ ok: true }> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshJwtPayload>(
        refreshToken,
        { secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET') },
      );
      await this.refreshTokens.revokeFamilyByJti(payload.jti);
    } catch {
      // Idempotent: an invalid/expired/unknown token has nothing to revoke.
    }
    return { ok: true };
  }

  private async issueTokens(
    user: AuthenticatedUser,
    jti: string,
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role } satisfies JwtPayload,
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.config.getOrThrow<string>(
          'JWT_ACCESS_TTL',
        ) as StringValue,
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.getOrThrow<string>(
          'JWT_REFRESH_TTL',
        ) as StringValue,
      },
    );
    return { accessToken, refreshToken };
  }
}
