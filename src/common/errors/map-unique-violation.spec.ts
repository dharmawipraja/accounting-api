import { Prisma } from '@prisma/client';
import {
  mapUniqueViolation,
  uniqueViolationIndex,
} from './map-unique-violation';
import { ConflictDomainError } from './domain-errors';

const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
  code: 'P2002',
  clientVersion: 'x',
});

describe('mapUniqueViolation', () => {
  it('throws a 409 ConflictDomainError on P2002', () => {
    expect(() =>
      mapUniqueViolation(p2002, 'Account code already exists'),
    ).toThrow(ConflictDomainError);
  });
  it('rethrows non-P2002 errors unchanged', () => {
    const other = new Error('boom');
    expect(() => mapUniqueViolation(other, 'x')).toThrow(other);
  });
});

describe('uniqueViolationIndex', () => {
  // Shape verified against Prisma 7 + @prisma/adapter-pg on real Postgres
  // (test/accounts.e2e-spec.ts asserts it on a live violation too).
  const withIndex = (index: unknown) =>
    new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: {
        modelName: 'Account',
        driverAdapterError: Object.assign(new Error('adapter'), {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            kind: 'UniqueConstraintViolation',
            constraint: { index },
          },
        }),
      },
    });

  it('names the violated unique index of a P2002', () => {
    expect(uniqueViolationIndex(withIndex('accounts_singleton_role'))).toBe(
      'accounts_singleton_role',
    );
  });

  it('is undefined for a P2002 without an index name, another code or a non-Prisma error', () => {
    expect(uniqueViolationIndex(p2002)).toBeUndefined();
    expect(uniqueViolationIndex(withIndex(42))).toBeUndefined();
    expect(
      uniqueViolationIndex(
        new Prisma.PrismaClientKnownRequestError('nf', {
          code: 'P2025',
          clientVersion: 'x',
          meta: withIndex('x').meta,
        }),
      ),
    ).toBeUndefined();
    expect(uniqueViolationIndex(new Error('boom'))).toBeUndefined();
  });
});
