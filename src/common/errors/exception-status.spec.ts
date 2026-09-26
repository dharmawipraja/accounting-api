import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  isTransientConflict,
  statusFromException,
  PRISMA_STATUS,
  TRANSIENT_CONFLICT,
} from './exception-status';
import {
  ConflictDomainError,
  ValidationFailedError,
  PasswordChangeRequiredError,
} from './domain-errors';

describe('statusFromException', () => {
  it('maps a DomainError to its own .status', () => {
    expect(statusFromException(new ConflictDomainError('dup'))).toBe(409);
    expect(statusFromException(new ValidationFailedError('bad'))).toBe(422);
  });

  it('maps PasswordChangeRequiredError to 403', () => {
    expect(
      statusFromException(new PasswordChangeRequiredError('change it')),
    ).toBe(403);
  });

  it('maps an HttpException to its getStatus()', () => {
    expect(statusFromException(new NotFoundException())).toBe(404);
    expect(statusFromException(new HttpException('teapot', 418))).toBe(418);
  });

  it('maps P2020 (value out of range, e.g. numeric overflow) to 400', () => {
    // A >16-integer-digit money value that slips past DTO validation must
    // degrade to a client error, not a 500 + Sentry incident.
    expect(PRISMA_STATUS.P2020).toEqual({
      status: 400,
      code: 'INVALID_INPUT',
      message: 'Value out of range',
    });
  });

  it('maps each known Prisma code per PRISMA_STATUS', () => {
    for (const [code, { status }] of Object.entries(PRISMA_STATUS)) {
      const err = new Prisma.PrismaClientKnownRequestError('m', {
        code,
        clientVersion: Prisma.prismaVersion.client,
      });
      expect(statusFromException(err)).toBe(status);
    }
  });

  it('maps an unmapped Prisma known code to 500', () => {
    const err = new Prisma.PrismaClientKnownRequestError('m', {
      code: 'P2037',
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(statusFromException(err)).toBe(500);
  });

  it('maps a PrismaClientValidationError to 400', () => {
    const err = new Prisma.PrismaClientValidationError('m', {
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(statusFromException(err)).toBe(400);
  });

  it('maps anything else to 500', () => {
    expect(statusFromException(new Error('boom'))).toBe(500);
    expect(statusFromException('nope')).toBe(500);
    expect(statusFromException(undefined)).toBe(500);
  });
});

describe('isTransientConflict (deadlock / serialization failure)', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('m', {
      code,
      clientVersion: 'test',
      meta,
    });
  // Shapes observed from Prisma 7.8 + @prisma/adapter-pg against real Postgres.
  const adapterErr = (code: string) => {
    const e = new Error('deadlock detected') as Error & { cause: unknown };
    e.name = 'DriverAdapterError';
    e.cause = { originalCode: code, kind: 'postgres', code };
    return e;
  };

  it('P2034 (40001 on a model query) is transient → 409', () => {
    expect(isTransientConflict(known('P2034'))).toBe(true);
    expect(statusFromException(known('P2034'))).toBe(409);
  });

  it('P2010 carrying 40P01/40001 (raw query) is transient → 409', () => {
    for (const code of ['40P01', '40001']) {
      const err = known('P2010', { driverAdapterError: adapterErr(code) });
      expect(isTransientConflict(err)).toBe(true);
      expect(statusFromException(err)).toBe(409);
    }
  });

  it('a bare DriverAdapterError 40P01 (model query) is transient → 409', () => {
    expect(isTransientConflict(adapterErr('40P01'))).toBe(true);
    expect(statusFromException(adapterErr('40P01'))).toBe(409);
  });

  it('a lock timeout (55P03 lock_not_available) is transient → 409, raw or model query', () => {
    const raw = known('P2010', { driverAdapterError: adapterErr('55P03') });
    expect(isTransientConflict(raw)).toBe(true);
    expect(statusFromException(raw)).toBe(409);
    expect(isTransientConflict(adapterErr('55P03'))).toBe(true);
    expect(statusFromException(adapterErr('55P03'))).toBe(409);
  });

  it('a statement timeout (57014 query_canceled) is transient → 409: raw (P2010), model (P2039) or bare', () => {
    // Shapes observed from Prisma 7.8 + adapter-pg against real Postgres with
    // `SET LOCAL statement_timeout`: raw → P2010, model query → P2039, both with
    // meta.driverAdapterError.
    const raw = known('P2010', { driverAdapterError: adapterErr('57014') });
    const model = known('P2039', {
      modelName: 'Account',
      driverAdapterError: adapterErr('57014'),
    });
    for (const err of [raw, model, adapterErr('57014')]) {
      expect(isTransientConflict(err)).toBe(true);
      expect(statusFromException(err)).toBe(409);
    }
  });

  it('P2028 (transaction API error: maxWait/timeout expired, tx already closed) is transient → 409', () => {
    // The interactive tx was rolled back by Prisma, so nothing committed and a
    // same-key retry is safe.
    expect(isTransientConflict(known('P2028'))).toBe(true);
    expect(statusFromException(known('P2028'))).toBe(409);
  });

  it('other codes and errors are not transient', () => {
    expect(isTransientConflict(known('P2002'))).toBe(false);
    expect(
      isTransientConflict(
        known('P2010', { driverAdapterError: adapterErr('23505') }),
      ),
    ).toBe(false);
    expect(isTransientConflict(known('P2010'))).toBe(false);
    expect(isTransientConflict(adapterErr('23505'))).toBe(false);
    expect(isTransientConflict(new Error('deadlock detected'))).toBe(false);
    expect(isTransientConflict(null)).toBe(false);
    expect(statusFromException(adapterErr('23505'))).toBe(500);
  });

  it('envelope is CONFLICT with retryable: true', () => {
    expect(TRANSIENT_CONFLICT).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      details: { retryable: true },
    });
  });
});
