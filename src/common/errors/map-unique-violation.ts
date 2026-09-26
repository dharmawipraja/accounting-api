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

/**
 * Name of the unique index a Prisma P2002 violated, when the pg driver
 * adapter reports it (`meta.driverAdapterError.cause.constraint.index` —
 * shape verified on Prisma 7 + @prisma/adapter-pg); `undefined` otherwise.
 * Lets a caller whose insert can hit more than one unique index answer the
 * right 409 (e.g. accounts: code vs singleton role). Pure.
 */
export function uniqueViolationIndex(err: unknown): string | undefined {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  )
    return undefined;
  const meta = err.meta as
    | { driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } }
    | undefined;
  const index = meta?.driverAdapterError?.cause?.constraint?.index;
  return typeof index === 'string' ? index : undefined;
}
