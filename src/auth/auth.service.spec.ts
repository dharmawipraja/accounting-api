import { Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';
import { LoginFailureLimiter } from './login-failure-limiter';
import { MetricsService } from '../metrics/metrics.service';
import { RefreshTokenService } from './refresh-token.service';

const limiter = () =>
  new LoginFailureLimiter(null, {
    incLoginFailure: jest.fn(),
    incLoginLockout: jest.fn(),
  } as unknown as MetricsService);

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
      limiter(),
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
      limiter(),
    );

    await expect(auth.login('x@y.com', 'correct')).rejects.toBeInstanceOf(
      UnauthorizedDomainError,
    );
    expect(verifyOrDecoy).toHaveBeenCalled();
  });
});

describe('AuthService.login (success log)', () => {
  it('logs { event: login, userId, ip } at info on a successful login', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const users = {
      findByEmailWithHash: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'x@y.com',
        role: 'VIEWER',
        isActive: true,
        passwordHash: 'h',
      }),
      verifyPasswordOrDecoy: jest.fn().mockResolvedValue(true),
    } as unknown as UsersService;
    const auth = new AuthService(
      users,
      { signAsync: jest.fn().mockResolvedValue('t') } as unknown as JwtService,
      { getOrThrow: () => 'x' } as unknown as ConfigService,
      {
        issue: jest.fn().mockResolvedValue({ jti: 'j1', familyId: 'f1' }),
      } as unknown as RefreshTokenService,
      limiter(),
    );
    try {
      await expect(
        auth.login('x@y.com', 'correct', '9.9.9.9'),
      ).resolves.toEqual({ accessToken: 't', refreshToken: 't' });
      expect(log).toHaveBeenCalledWith({
        event: 'login',
        userId: 'u1',
        ip: '9.9.9.9',
      });
    } finally {
      log.mockRestore();
    }
  });
});
