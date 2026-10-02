import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Models subject to soft delete. Add new soft-deletable models here.
 *
 * Guarded operations: find* / count / aggregate / groupBy / update / updateMany
 * inject `deletedAt: null` into `where` (findUnique* and update accept it alongside
 * the unique key, so a tombstoned row reads as missing: null / P2025 -> 404 via the
 * exception filter); delete / deleteMany / upsert throw (hard delete and upsert are
 * forbidden on soft-deletable models). Soft delete is a plain update — see
 * `tombstoneData()`. The service layer still does its own findFirst existence
 * checks; this is defense-in-depth.
 */
export const SOFT_DELETE_MODELS = new Set<Prisma.ModelName>([
  'User',
  'Account',
  'JournalEntry',
  'TaxCode',
  'BusinessPartner',
  'SalesInvoice',
  'PurchaseBill',
  'Payment',
]);

const FILTERED_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
]);

/** Programmer-error guards: no route hard-deletes or upserts a soft-deletable
 *  model. A plain Error (-> 500 via the exception filter) is intentional so a
 *  stray call surfaces loudly rather than masquerading as a normal 4xx. */
const FORBIDDEN_OPERATIONS: Record<string, string> = {
  delete: 'Hard delete forbidden on %s; soft-delete via tombstoneData()',
  deleteMany:
    'Hard delete forbidden on %s; soft-delete records individually via tombstoneData()',
  upsert:
    'upsert forbidden on %s; soft-deletable models must update/soft-delete explicitly',
};

export function applySoftDelete(base: PrismaClient) {
  return base.$extends({
    name: 'soft-delete-filter',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!SOFT_DELETE_MODELS.has(model)) return query(args);
          const forbidden = FORBIDDEN_OPERATIONS[operation];
          if (forbidden) throw new Error(forbidden.replace('%s', model));
          if (FILTERED_OPERATIONS.has(operation)) {
            const typed = args as { where?: object };
            typed.where = { ...typed.where, deletedAt: null };
          }
          return query(args);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof applySoftDelete>;
