import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { REPORT_SNAPSHOT_TX } from '../common/prisma/prisma.service';
import { POSTING_TX_OPTIONS } from '../ledger/posting/posting.service';

/**
 * Interactive-transaction budgets are additive: maxWait (waiting for a pooled
 * connection) + timeout (the transaction itself) must finish before the
 * request-timeout interceptor's 408, so a slow DB fails as a clean retryable
 * 409 (P2028) and the documented escalation order (DB → 408 → socket) holds.
 */
describe('interactive-transaction timeout budget', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
    jest.resetModules();
  });

  async function defaultRequestTimeout(): Promise<number> {
    delete process.env.REQUEST_TIMEOUT_MS;
    jest.resetModules();
    return (await import('./throttle.config')).REQUEST_TIMEOUT_MS;
  }

  it.each([
    ['REPORT_SNAPSHOT_TX', REPORT_SNAPSHOT_TX],
    ['POSTING_TX_OPTIONS', POSTING_TX_OPTIONS],
  ])('%s: maxWait + timeout < the default request timeout', async (_, o) => {
    const requestTimeout = await defaultRequestTimeout();
    expect(o.maxWait).toBeDefined();
    expect(o.timeout).toBeDefined();
    expect(o.maxWait! + o.timeout!).toBeLessThan(requestTimeout);
  });
});

describe('interactive-transaction options come from a budgeted constant', () => {
  it('no src/ file passes a literal { maxWait: … } besides the constants above', () => {
    const root = join(__dirname, '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const offenders = walk(root)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .filter((f) => /maxWait:\s*\d/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1))
      .filter(
        (f) =>
          f !== join('ledger', 'posting', 'posting.service.ts') &&
          f !== join('common', 'prisma', 'prisma.service.ts'),
      );
    expect(offenders).toEqual([]);
  });
});
