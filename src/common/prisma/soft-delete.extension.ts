import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Models subject to soft delete. Add new soft-deletable models here as later
 * phases introduce them (e.g. 'BusinessPartner', 'TaxCode').
 *
 * Guarded operations: find* / count / aggregate / groupBy inject `deletedAt: null`;
 * update / updateMany inject `deletedAt: null` (a write to a tombstoned row matches
 * 0 rows -> P2025 -> 404 via the exception filter); delete / deleteMany / upsert throw
 * (hard delete and upsert are forbidden on soft-deletable models). The service
 * layer still does its own findFirst existence checks; this is defense-in-depth.
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

function isSoftDelete(model: string | undefined): boolean {
  return !!model && SOFT_DELETE_MODELS.has(model as Prisma.ModelName);
}

export function applySoftDelete(base: PrismaClient) {
  return base
    .$extends({
      name: 'soft-delete-filter',
      query: {
        $allModels: {
          async findMany({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async findFirst({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async findFirstOrThrow({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async count({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async findUnique({ model, args, query }) {
            if (!isSoftDelete(model)) {
              return query(args);
            }
            // Force-include deletedAt so the guard always sees it,
            // even if the caller's select projection omits it.
            const callerSelect = (args as { select?: Record<string, unknown> })
              .select;
            let injected = false;
            if (
              callerSelect !== undefined &&
              !Object.prototype.hasOwnProperty.call(callerSelect, 'deletedAt')
            ) {
              (args as { select?: Record<string, unknown> }).select = {
                ...callerSelect,
                deletedAt: true,
              };
              injected = true;
            }
            const found = await query(args);
            if (!found) return found;
            const row = found as Record<string, unknown>;
            if (row['deletedAt']) return null;
            if (injected) {
              const { deletedAt: _d, ...rest } = row;
              void _d; // unused — intentionally stripped
              return rest;
            }
            return found;
          },
          async findUniqueOrThrow({ model, args, query }) {
            if (!isSoftDelete(model)) {
              return query(args);
            }
            // Force-include deletedAt so the guard always sees it.
            const callerSelect = (args as { select?: Record<string, unknown> })
              .select;
            let injected = false;
            if (
              callerSelect !== undefined &&
              !Object.prototype.hasOwnProperty.call(callerSelect, 'deletedAt')
            ) {
              (args as { select?: Record<string, unknown> }).select = {
                ...callerSelect,
                deletedAt: true,
              };
              injected = true;
            }
            const found = await query(args);
            const row = found as Record<string, unknown>;
            if (row['deletedAt']) {
              throw new Prisma.PrismaClientKnownRequestError(
                'No record found',
                {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                },
              );
            }
            if (injected) {
              const { deletedAt: _d, ...rest } = row;
              void _d; // unused — intentionally stripped
              return rest;
            }
            return found;
          },
          async delete({ model, query, args }) {
            if (isSoftDelete(model)) {
              // Programmer-error guard: no HTTP route performs a hard delete. A plain Error
              // (→ 500 via the exception filter) is intentional so a stray hard-delete in code
              // surfaces loudly rather than masquerading as a normal 4xx response.
              throw new Error(
                `Hard delete forbidden on ${model}; use softDelete()`,
              );
            }
            return query(args);
          },
          async deleteMany({ model, query, args }) {
            if (isSoftDelete(model)) {
              // Programmer-error guard: no HTTP route performs a hard delete. A plain Error
              // (→ 500 via the exception filter) is intentional so a stray hard-delete in code
              // surfaces loudly rather than masquerading as a normal 4xx response.
              throw new Error(
                `Hard delete forbidden on ${model}; soft-delete records individually via softDelete()`,
              );
            }
            return query(args);
          },
          async update({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async updateMany({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async aggregate({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async groupBy({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async upsert({ model, args, query }) {
            if (isSoftDelete(model)) {
              // Programmer-error guard: upsert vs. soft-delete is ambiguous and no
              // route uses it. A plain Error (-> 500) surfaces a stray upsert loudly.
              throw new Error(
                `upsert forbidden on ${model}; soft-deletable models must update/softDelete explicitly`,
              );
            }
            return query(args);
          },
        },
      },
    })
    .$extends({
      name: 'soft-delete-methods',
      model: {
        $allModels: {
          async softDelete<T>(
            this: T,
            where: Record<string, unknown>,
            deletedBy?: string,
          ) {
            const ctx = Prisma.getExtensionContext(this);
            if (!isSoftDelete(ctx.$name)) {
              throw new Error(
                `softDelete() is not supported on model ${String(ctx.$name)}`,
              );
            }
            const typedCtx = ctx as unknown as {
              update: (a: unknown) => Promise<unknown>;
            };
            return typedCtx.update({
              where,
              data: { deletedAt: new Date(), deletedBy },
            });
          },
        },
      },
    });
}

export type ExtendedPrismaClient = ReturnType<typeof applySoftDelete>;
