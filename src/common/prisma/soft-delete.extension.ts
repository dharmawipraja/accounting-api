import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Models subject to soft delete. Add new soft-deletable models here as later
 * phases introduce them (e.g. 'BusinessPartner', 'TaxCode').
 */
export const SOFT_DELETE_MODELS = new Set<string>(['User']);

function isSoftDelete(model: string | undefined): boolean {
  return !!model && SOFT_DELETE_MODELS.has(model);
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
            if (isSoftDelete(model)) {
              const found = await query(args);
              return found && (found as { deletedAt?: Date | null }).deletedAt
                ? null
                : found;
            }
            return query(args);
          },
          async findUniqueOrThrow({ model, args, query }) {
            const found = await query(args);
            if (
              isSoftDelete(model) &&
              found &&
              (found as { deletedAt?: Date | null }).deletedAt
            ) {
              throw new Prisma.PrismaClientKnownRequestError(
                'No record found',
                {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                },
              );
            }
            return found;
          },
          async delete({ model, query, args }) {
            if (isSoftDelete(model)) {
              throw new Error(
                `Hard delete forbidden on ${model}; use softDelete()`,
              );
            }
            return query(args);
          },
          async deleteMany({ model, query, args }) {
            if (isSoftDelete(model)) {
              throw new Error(
                `Hard delete forbidden on ${model}; use softDeleteMany()`,
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
            const ctx = Prisma.getExtensionContext(this) as unknown as {
              update: (a: unknown) => Promise<unknown>;
            };
            return ctx.update({
              where,
              data: { deletedAt: new Date(), deletedBy },
            });
          },
        },
      },
    });
}

export type ExtendedPrismaClient = ReturnType<typeof applySoftDelete>;
