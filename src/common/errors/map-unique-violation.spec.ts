import { Prisma } from '@prisma/client';
import { mapUniqueViolation } from './map-unique-violation';
import { ConflictDomainError } from './domain-errors';

const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });

describe('mapUniqueViolation', () => {
  it('throws a 409 ConflictDomainError on P2002', () => {
    expect(() => mapUniqueViolation(p2002, 'Account code already exists')).toThrow(ConflictDomainError);
  });
  it('rethrows non-P2002 errors unchanged', () => {
    const other = new Error('boom');
    expect(() => mapUniqueViolation(other, 'x')).toThrow(other);
  });
});
