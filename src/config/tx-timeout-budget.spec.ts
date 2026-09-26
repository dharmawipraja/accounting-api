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
