import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../errors/domain-errors';

const P2002 = new Prisma.PrismaClientKnownRequestError('dup', {
  code: 'P2002',
  clientVersion: 'test',
});

function makeService(ttlMs?: number) {
  const idempotencyKey = {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = { client: { idempotencyKey } } as unknown as PrismaService;
  const config = { get: () => ttlMs } as unknown as ConfigService;
  return { service: new IdempotencyService(prisma, config), idempotencyKey };
}

describe('IdempotencyService', () => {
  it('reserves a fresh key (replay:false)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockResolvedValue({});
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).resolves.toEqual({ replay: false });
  });

  it('replays a completed key with its stored response + status', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: { id: 'abc' },
      httpStatus: 201,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).resolves.toEqual({
      replay: true,
      response: { id: 'abc' },
      httpStatus: 201,
    });
  });

  it('rejects the same key on a different endpoint (422)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      method: 'POST',
      path: '/v1/tax/codes',
      requestHash: 'h',
      response: { id: 'x' },
      httpStatus: 201,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects the same key with a different body hash (422)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'OTHER',
      response: { id: 'x' },
      httpStatus: 201,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('reports an in-progress key (no response yet) as 409', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
  });

  it('treats a vanished reservation row as 409', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue(null);
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
  });

  it('complete() stores a JSON snapshot + status', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.update.mockResolvedValue({});
    await service.complete(
      'k',
      { id: 'abc', when: new Date('2026-01-01') },
      201,
    );
    expect(idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: 'k' },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        response: { id: 'abc', when: '2026-01-01T00:00:00.000Z' },
        httpStatus: 201,
      }),
    });
  });

  it('complete() serialises a null/undefined response as JSON null (line 155)', async () => {
    // Exercises the `response ?? null` branch in complete().
    const { service, idempotencyKey } = makeService();
    idempotencyKey.update.mockResolvedValue({});
    await service.complete('k', undefined, 204);
    expect(idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: 'k' },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({ response: null, httpStatus: 204 }),
    });
  });

  it('release() deletes and swallows errors', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.delete.mockRejectedValue(new Error('gone'));
    await expect(service.release('k')).resolves.toBeUndefined();
  });

  it('reclaims a stale in-flight key and re-reserves it', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create
      .mockRejectedValueOnce(P2002) // first attempt: row exists
      .mockResolvedValueOnce({}); // after reclaim: fresh insert succeeds
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
      completedAt: null,
      createdAt: new Date('2000-01-01'), // far older than the TTL
    });
    idempotencyKey.deleteMany.mockResolvedValue({ count: 1 });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).resolves.toEqual({ replay: false });
    expect(idempotencyKey.deleteMany).toHaveBeenCalled();
  });

  it('keeps a fresh in-flight key as 409 (not reclaimed)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
      completedAt: null,
      createdAt: new Date(), // fresh
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('re-throws a non-P2002 Prisma error from create (line 72)', async () => {
    // Exercises the `throw err` branch: a Prisma error that is NOT P2002
    // should propagate up rather than entering resolveExisting.
    const { service, idempotencyKey } = makeService();
    const dbErr = new Prisma.PrismaClientKnownRequestError('conn fail', {
      code: 'P1001',
      clientVersion: 'test',
    });
    idempotencyKey.create.mockRejectedValue(dbErr);
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBe(dbErr);
  });

  it('purgeCompleted() deletes old completed rows and returns count (explicit olderThanMs)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.deleteMany.mockResolvedValue({ count: 3 });
    const result = await service.purgeCompleted(3_600_000);
    expect(result).toBe(3);
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { completedAt: { lt: expect.any(Date) } },
    });
  });

  it('purgeCompleted() uses completedTtlMs default (86_400_000) when called without argument (line 33)', async () => {
    // Exercises the completedTtlMs getter + its ?? 86_400_000 fallback.
    // makeService() with no arg makes config.get() return undefined => ?? fires.
    const { service, idempotencyKey } = makeService(undefined);
    idempotencyKey.deleteMany.mockResolvedValue({ count: 0 });
    const result = await service.purgeCompleted();
    expect(result).toBe(0);
    expect(idempotencyKey.deleteMany).toHaveBeenCalled();
  });

  it('throws 409 when stale reclaim loses the race (cleared.count === 0, line 155)', async () => {
    // Exercises the `cleared.count === 0` branch: deleteMany wins nothing (another
    // retry already reclaimed it), so we fall through to the ConflictDomainError.
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
      completedAt: null,
      createdAt: new Date('2000-01-01'), // stale
    });
    idempotencyKey.deleteMany.mockResolvedValue({ count: 0 }); // lost the race
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
  });

  it('re-reserves successfully after winning the stale-reclaim race, but second create also collides (allowReclaim=false path, line 123)', async () => {
    // Exercises line 123: cleared.count > 0 → calls reserveOnce(..., false).
    // Second create fails with P2002 again, findUnique returns a completed record
    // (another request finished between delete and re-insert) → replay:true.
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create
      .mockRejectedValueOnce(P2002) // first attempt: row exists
      .mockRejectedValueOnce(P2002); // second attempt (allowReclaim=false): still collides
    idempotencyKey.findUnique
      .mockResolvedValueOnce({
        key: 'k',
        method: 'POST',
        path: '/v1/partners',
        requestHash: 'h',
        response: null,
        httpStatus: null,
        completedAt: null,
        createdAt: new Date('2000-01-01'), // stale — triggers reclaim
      })
      .mockResolvedValueOnce({
        key: 'k',
        method: 'POST',
        path: '/v1/partners',
        requestHash: 'h',
        response: { id: 'xyz' },
        httpStatus: 201,
        completedAt: new Date(),
        createdAt: new Date(),
      });
    idempotencyKey.deleteMany.mockResolvedValue({ count: 1 }); // won the reclaim
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).resolves.toEqual({ replay: true, response: { id: 'xyz' }, httpStatus: 201 });
  });

  it('inflightTtlMs defaults to 120000 when config returns undefined (line 33)', async () => {
    // makeService() passes `get: () => undefined` when ttlMs is omitted — exercises the ?? 120_000 branch.
    const { service, idempotencyKey } = makeService(undefined);
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
      completedAt: null,
      // createdAt within default 120s TTL => not stale => 409, no reclaim
      createdAt: new Date(),
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
    // deleteMany NOT called because the key is not stale under the default TTL
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });
});
