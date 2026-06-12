import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsTokenGuard } from './metrics-token.guard';

function ctx(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

const guard = (token?: string): MetricsTokenGuard =>
  new MetricsTokenGuard({ get: () => token } as unknown as ConfigService);

describe('MetricsTokenGuard', () => {
  it('allows the scrape when no METRICS_TOKEN is configured (network isolation)', () => {
    expect(guard(undefined).canActivate(ctx())).toBe(true);
  });

  it('allows a correct bearer when METRICS_TOKEN is set', () => {
    expect(guard('s3cret').canActivate(ctx('Bearer s3cret'))).toBe(true);
  });

  it('rejects a missing or wrong bearer when METRICS_TOKEN is set', () => {
    expect(() => guard('s3cret').canActivate(ctx())).toThrow(
      UnauthorizedException,
    );
    expect(() => guard('s3cret').canActivate(ctx('Bearer nope'))).toThrow(
      UnauthorizedException,
    );
  });
});
