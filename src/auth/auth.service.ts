import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { UsersService } from '../users/users.service';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';
import {
  AuthenticatedUser,
  JWT_ALGORITHM,
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /** @param ip the client address (`req.ip`), logged on success so every
   *  successful login leaves app-log evidence even if its audit row is lost. */
  async login(
    email: string,
    password: string,
    ip?: string,
  ): Promise<TokenPair> {
    const user = await this.users.findByEmailWithHash(email);
    // Always run a verify (decoy when the user is absent) so timing is constant.
    const valid = await this.users.verifyPasswordOrDecoy(user, password);
    if (!user || !user.isActive || !valid) {
      throw new UnauthorizedDomainError('Invalid credentials');
    }
    const { jti } = await this.refreshTokens.issue(user.id);
    const tokens = await this.issueTokens(
      { id: user.id, email: user.email, role: user.role },
      jti,
    );
    this.logger.log({ event: 'login', userId: user.id, ip: ip ?? null });
    return tokens;
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: RefreshJwtPayload;
    try {
      payload = await this.verifyRefresh(refreshToken);
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
      const payload = await this.verifyRefresh(refreshToken);
      await this.refreshTokens.revokeFamilyByJti(payload.jti);
    } catch {
      // Idempotent: an invalid/expired/unknown token has nothing to revoke.
    }
    return { ok: true };
  }

  async logoutAll(userId: string): Promise<{ ok: true }> {
    await this.refreshTokens.revokeAllForUser(userId);
    return { ok: true };
  }

  /** Change own password, then revoke ALL refresh families: other devices die
   *  now; the current access token stays valid ≤15m, after which the user
   *  logs in with the new password. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.users.changePassword(userId, currentPassword, newPassword);
    await this.refreshTokens.revokeAllForUser(userId);
  }

  /** Verify a refresh JWT: HS256-pinned, refresh secret, and `typ: refresh`
   *  (pre-typ refresh tokens are rejected → the client must log in again). */
  private async verifyRefresh(token: string): Promise<RefreshJwtPayload> {
    const payload = await this.jwt.verifyAsync<RefreshJwtPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      algorithms: [JWT_ALGORITHM],
    });
    if (payload?.typ !== 'refresh' || !payload.jti) {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    return payload;
  }

  private async issueTokens(
    user: Pick<AuthenticatedUser, 'id' | 'email' | 'role'>,
    jti: string,
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        typ: 'access',
      } satisfies JwtPayload,
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        algorithm: JWT_ALGORITHM,
        expiresIn: this.config.getOrThrow<string>(
          'JWT_ACCESS_TTL',
        ) as StringValue,
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, typ: 'refresh' } satisfies RefreshJwtPayload,
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        algorithm: JWT_ALGORITHM,
        expiresIn: this.config.getOrThrow<string>(
          'JWT_REFRESH_TTL',
        ) as StringValue,
      },
    );
    return { accessToken, refreshToken };
  }
}
