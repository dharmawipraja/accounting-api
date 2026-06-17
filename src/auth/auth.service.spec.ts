import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';
import { RefreshTokenService } from './refresh-token.service';

describe('AuthService.login (constant-time)', () => {
  it('verifies a hash even when the user does not exist (no early return)', async () => {
    const verifyOrDecoy = jest.fn().mockResolvedValue(false);
    const users = {
      findByEmailWithHash: jest.fn().mockResolvedValue(null),
      verifyPasswordOrDecoy: verifyOrDecoy,
    } as unknown as UsersService;
    const auth = new AuthService(
      users,
      {} as unknown as JwtService,
      {} as unknown as ConfigService,
      {} as unknown as RefreshTokenService,
    );

    await expect(auth.login('ghost@x.com', 'whatever')).rejects.toBeInstanceOf(
      UnauthorizedDomainError,
    );
    expect(verifyOrDecoy).toHaveBeenCalledWith(null, 'whatever');
  });

  it('rejects an inactive user even with a valid password', async () => {
    const verifyOrDecoy = jest.fn().mockResolvedValue(true);
    const users = {
      findByEmailWithHash: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'x@y.com',
        role: 'VIEWER',
        isActive: false,
        passwordHash: 'h',
      }),
      verifyPasswordOrDecoy: verifyOrDecoy,
    } as unknown as UsersService;
    const auth = new AuthService(
      users,
      {} as unknown as JwtService,
      {} as unknown as ConfigService,
      {} as unknown as RefreshTokenService,
    );

    await expect(auth.login('x@y.com', 'correct')).rejects.toBeInstanceOf(
      UnauthorizedDomainError,
    );
    expect(verifyOrDecoy).toHaveBeenCalled();
  });
});
