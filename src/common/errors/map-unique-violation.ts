import { Prisma } from '@prisma/client';
import { ConflictDomainError } from './domain-errors';

/**
 * Rethrows a Prisma P2002 (unique constraint) as a 409 ConflictDomainError with
 * a friendly message; rethrows anything else unchanged. Replaces the repeated
 * `instanceof PrismaClientKnownRequestError && code === 'P2002'` catch blocks.
 */
export function mapUniqueViolation(
  err: unknown,
  message: string,
  context?: Record<string, unknown>,
): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  ) {
    throw new ConflictDomainError(message, context);
  }
  throw err;
}
