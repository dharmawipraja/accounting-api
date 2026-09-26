import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AuditService,
  isAuditContentError,
  storableRow,
  UNSTORABLE_BODY,
} from './audit.service';

describe('storableRow', () => {
  const entry = {
    userId: 'u1',
    userRole: 'ADMIN',
    method: 'POST',
    path: '/v1/partners/%00?q=\ud800',
    params: { id: 'a\u0000b' },
    body: { name: 'x\ud800', password: 'kept-as-is' },
    statusCode: 400,
    durationMs: 3,
    ip: '127.0.0.1',
    requestId: 'r1',
    clientRequestId: null,
    entityId: null,
  };

  it('makes every caller-derived string storable, keeping the row fields', () => {
    expect(storableRow(entry)).toEqual({
      ...entry,
      path: '/v1/partners/%00?q=\ufffd',
      params: { id: 'ab' },
      // no redaction here (the body was already sanitized by its builder)
      body: { name: 'x\ufffd', password: 'kept-as-is' },
    });
  });

  it('stores {} for a missing params / body', () => {
    const row = storableRow({ ...entry, params: null, body: undefined });
    expect(row.params).toEqual({});
    expect(row.body).toEqual({});
  });

  it('the fallback body is a plain marker object', () => {
    expect(UNSTORABLE_BODY).toEqual({ _unstorable: true });
  });
});

describe('isAuditContentError / AuditService.record fallback (I3)', () => {
  const adapterErr = (code: string) =>
    Object.assign(new Error('adapter'), {
      name: 'DriverAdapterError',
      cause: { kind: 'postgres', originalCode: code },
    });
  const wrapped = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('m', {
      code: 'P2010',
      clientVersion: Prisma.prismaVersion.client,
      meta: { driverAdapterError: adapterErr(code) },
    });

  it('is true only for content SQLSTATEs (22021, 22P05, 22P02, 22001, 54000), bare or wrapped', () => {
    for (const code of ['22021', '22P05', '22P02', '22001', '54000']) {
      expect(isAuditContentError(adapterErr(code))).toBe(true);
      expect(isAuditContentError(wrapped(code))).toBe(true);
    }
    for (const err of [
      adapterErr('08006'), // connection failure
      adapterErr('57P01'), // admin shutdown
      adapterErr('53300'), // too many connections
      wrapped('40P01'),
      new Prisma.PrismaClientKnownRequestError('pool timeout', {
        code: 'P2024',
        clientVersion: Prisma.prismaVersion.client,
      }),
      new Error('Connection terminated unexpectedly'),
      undefined,
      'x',
    ]) {
      expect(isAuditContentError(err)).toBe(false);
    }
  });

  function serviceWith(create: jest.Mock) {
    const prisma = { client: { auditLog: { create } } };
    return new AuditService(prisma as never);
  }
  const row = {
    userId: 'u1',
    userRole: 'ADMIN',
    method: 'POST',
    path: '/v1/x',
    params: { id: 'p' },
    body: { a: 1 },
    statusCode: 400,
    durationMs: 1,
    ip: null,
    requestId: 'r1',
    clientRequestId: null,
    entityId: null,
  };

  it('a content error is retried ONCE with body {_unstorable:true} and params {}', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(adapterErr('22P05'))
      .mockResolvedValueOnce({});
    await serviceWith(create).record(row);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(2, {
      data: {
        ...row,
        params: {},
        body: UNSTORABLE_BODY,
      },
    });
  });

  it('a connection / pool error is NOT retried (logged once), and record never throws', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const create = jest.fn().mockRejectedValue(adapterErr('08006'));
    await expect(serviceWith(create).record(row)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
