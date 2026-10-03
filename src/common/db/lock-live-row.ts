import { Prisma } from '@prisma/client';
import type { SqlTx } from './sequence';

/** Lock one live (not soft-deleted) row FOR UPDATE inside the caller's tx and
 *  return its `cols` (undefined when there is no such row):
 *  `SELECT <cols> FROM <table> WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`.
 *
 *  INJECTION SAFETY: `table` and `cols` are constant SQL supplied by the
 *  caller (never user input) → safe for Prisma.raw; `id` is bound. */
export async function lockLiveRow<T>(
  tx: SqlTx,
  table: string,
  id: string,
  cols: string,
): Promise<T | undefined> {
  const rows = await tx.$queryRaw<T[]>(
    Prisma.sql`SELECT ${Prisma.raw(cols)} FROM ${Prisma.raw(table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
  );
  return rows[0];
}
