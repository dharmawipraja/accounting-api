import { ExecutionContext, RequestTimeoutException } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { delay } from 'rxjs/operators';
import { RequestTimeoutInterceptor } from './request-timeout.interceptor';

function ctx(url: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ url }) }),
  } as unknown as ExecutionContext;
}

describe('RequestTimeoutInterceptor', () => {
  it('passes through a fast response', async () => {
    const i = new RequestTimeoutInterceptor(50);
    const out = await firstValueFrom(
      i.intercept(ctx('/v1/reports/balance-sheet'), { handle: () => of('ok') }),
    );
    expect(out).toBe('ok');
  });

  it('throws 408 when the handler exceeds the limit', async () => {
    const i = new RequestTimeoutInterceptor(20);
    await expect(
      firstValueFrom(
        i.intercept(ctx('/v1/reports/balance-sheet'), {
          handle: () => of('late').pipe(delay(100)),
        }),
      ),
    ).rejects.toBeInstanceOf(RequestTimeoutException);
  });

  it('does NOT cap operational probes', async () => {
    const i = new RequestTimeoutInterceptor(20);
    const out = await firstValueFrom(
      i.intercept(ctx('/health'), {
        handle: () => of('alive').pipe(delay(60)),
      }),
    );
    expect(out).toBe('alive');
  });
});
