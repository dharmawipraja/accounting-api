import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { idempotencyContext } from '../idempotency/idempotency-context';
import { ConflictDomainError } from '../errors/domain-errors';

/**
 * PrismaService.transaction's idempotency mark, against a fake in-memory
 * "transaction" whose callback Prisma may run in an async context other than
 * the caller's. The fake records the statements it receives (it is the DB, not
 * an expectation on a mock). No DB connection is opened: the pg pool is lazy.
 */
function makeService(markedRows: number) {
  const config = {
    getOrThrow: () => 'postgresql://u:p@127.0.0.1:1/none',
    get: () => undefined,
  } as unknown as ConfigService;
  const svc = new PrismaService(config);
  const statements: unknown[][] = [];
  const queued: (() => void)[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push([strings.join('?'), ...values]);
      return Promise.resolve(markedRows);
    },
  };
  // Defer the callback to a queue drained OUTSIDE the caller's ALS context —
  // how a driver/pool may schedule it.
  const client = {
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) =>
      new Promise((resolve, reject) => {
        queued.push(() => {
          cb(tx).then(resolve, reject);
        });
      }),
  };
  Object.defineProperty(svc, 'client', { value: client });
  const drainOutsideContext = () =>
    idempotencyContext.exit(() => queued.splice(0).forEach((f) => f()));
  return { svc, statements, drainOutsideContext };
}

describe('PrismaService.transaction idempotency mark', () => {
  const ctx = { userId: 'u1', key: 'k1', token: 't1' };

  it('marks the key captured at call time even when the callback runs outside the caller context', async () => {
    const { svc, statements, drainOutsideContext } = makeService(1);
    const pending = idempotencyContext.run(ctx, () =>
      svc.transaction(() => Promise.resolve('ok')),
    );
    drainOutsideContext();
    await expect(pending).resolves.toBe('ok');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toEqual([
      expect.stringContaining("committed_at = now() AT TIME ZONE 'UTC'"),
      'u1',
      'k1',
      't1',
    ]);
  });

  it('rolls back with a 409 when the reservation token no longer matches (reclaimed)', async () => {
    const { svc, drainOutsideContext } = makeService(0);
    const pending = idempotencyContext.run(ctx, () =>
      svc.transaction(() => Promise.resolve('ok')),
    );
    drainOutsideContext();
    const err: unknown = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictDomainError);
    expect((err as ConflictDomainError).details).toMatchObject({
      reclaimed: true,
    });
  });

  it('issues no mark outside an idempotent request', async () => {
    const { svc, statements, drainOutsideContext } = makeService(1);
    const pending = svc.transaction(() => Promise.resolve(7));
    drainOutsideContext();
    await expect(pending).resolves.toBe(7);
    expect(statements).toHaveLength(0);
  });
});
