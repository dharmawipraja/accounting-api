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
});
