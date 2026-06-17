import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsTokenGuard } from './metrics-token.guard';

function makeCtx(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  values: Record<string, string | undefined>,
): MetricsTokenGuard {
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new MetricsTokenGuard(config);
}

describe('MetricsTokenGuard', () => {
  it('denies in production when METRICS_TOKEN is unset (fail-closed)', () => {
    const guard = makeGuard({ NODE_ENV: 'production' });
    expect(() => guard.canActivate(makeCtx())).toThrow(UnauthorizedException);
  });

  it('allows in development when METRICS_TOKEN is unset', () => {
    const guard = makeGuard({ NODE_ENV: 'development' });
    expect(guard.canActivate(makeCtx())).toBe(true);
  });

  it('allows a correct bearer token', () => {
    const guard = makeGuard({
      NODE_ENV: 'production',
      METRICS_TOKEN: 'secret-token',
    });
    expect(guard.canActivate(makeCtx('Bearer secret-token'))).toBe(true);
  });

  it('denies a wrong bearer token', () => {
    const guard = makeGuard({
      NODE_ENV: 'production',
      METRICS_TOKEN: 'secret-token',
    });
    expect(() => guard.canActivate(makeCtx('Bearer nope'))).toThrow(
      UnauthorizedException,
    );
  });

  it('denies a missing Authorization header when token is configured', () => {
    const guard = makeGuard({
      NODE_ENV: 'production',
      METRICS_TOKEN: 'secret-token',
    });
    expect(() => guard.canActivate(makeCtx())).toThrow(UnauthorizedException);
  });
});
