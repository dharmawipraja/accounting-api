import { Prisma } from '@prisma/client';

/** A tx handle that accepts a parameterized Prisma.Sql — the form a dynamic table name
 *  requires (a tagged-template $executeRaw cannot vary the table). Satisfied structurally by
 *  the interactive-transaction client passed into a $transaction callback. */
export type SqlTx = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

/** Lock-and-increment a per-key counter inside the caller's transaction. Gapless because the
 *  increment shares the tx with the document write.
 *
 *  INJECTION SAFETY: `table` and the `key` COLUMN NAMES are constant identifiers supplied by the
 *  caller (never user input) → safe for Prisma.raw (same convention as trigram-search's
 *  ownColumns). The key VALUES are bound parameters. */
export async function nextSequenceNumber(
  tx: SqlTx,
  table: 'journal_sequences' | 'document_sequences',
  key: Record<string, string | number>,
): Promise<number> {
  const cols = Object.keys(key);
  const colList = Prisma.raw(cols.join(', '));
  const values = Prisma.join(cols.map((c) => Prisma.sql`${key[c]}`));
  const predicate = Prisma.join(
    cols.map((c) => Prisma.sql`${Prisma.raw(c)} = ${key[c]}`),
    ' AND ',
  );
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO ${Prisma.raw(table)} (${colList}, next_number, updated_at)
               VALUES (${values}, 1, now()) ON CONFLICT (${colList}) DO NOTHING`,
  );
  const rows = await tx.$queryRaw<{ next_number: number }[]>(
    Prisma.sql`SELECT next_number FROM ${Prisma.raw(table)} WHERE ${predicate} FOR UPDATE`,
  );
  const current = rows[0].next_number;
  await tx.$executeRaw(
    Prisma.sql`UPDATE ${Prisma.raw(table)} SET next_number = ${current + 1}, updated_at = now() WHERE ${predicate}`,
  );
  return current;
}
