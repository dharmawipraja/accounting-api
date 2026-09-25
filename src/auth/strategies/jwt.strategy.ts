import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '../role.enum';
import { UsersService } from '../../users/users.service';

/** The only algorithm we sign with; pinned on every verify so a token can
 *  never pick its own (alg-confusion / 'none' downgrade). */
export const JWT_ALGORITHM = 'HS256' as const;

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  /** Token type — access tokens are `access`; anything else is rejected. */
  typ: 'access';
}

export interface RefreshJwtPayload {
  sub: string;
  jti: string;
  typ: 'refresh';
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      algorithms: [JWT_ALGORITHM],
    });
  }

  /** Per-request freshness (deliberate DB read): deactivation, deletion, and
   *  role changes take effect on the NEXT request, not at token expiry.
   *  findById is soft-delete-filtered, so a deleted user resolves to null. */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // typ gate: only access tokens authenticate a request. Tokens minted before
    // the typ claim existed (≤ JWT_ACCESS_TTL old) are rejected → re-login.
    if (!payload?.sub || payload.typ !== 'access') {
      throw new UnauthorizedException();
    }
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) throw new UnauthorizedException();
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
