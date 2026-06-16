import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Min trimmed length of `q` before search activates (shorter -> normal list). */
export const MIN_QUERY_LENGTH = 2;
/** Trigram similarity cutoff for a fuzzy (non-substring) match. */
export const SIMILARITY_THRESHOLD = 0.3;

export interface TrigramJoin {
  /** Joined table (constant), e.g. 'business_partners'. */
  table: string;
  /** Joined table alias (constant), e.g. 'p'. */
  alias: string;
  /** Base-table column (constant) referencing join.alias.id, e.g. 'partner_id'. */
  onColumn: string;
  /** Joined columns to search (constants), e.g. ['name']. */
  columns: string[];
}

export interface TrigramSearchInput {
  /** Base table (constant), e.g. 'sales_invoices'. */
  table: string;
  /** Base table alias (constant), e.g. 't'. */
  alias: string;
  /** Base-table searchable columns (constants); at least one (non-empty). */
  ownColumns: [string, ...string[]];
  /** Optional partner join. */
  join?: TrigramJoin;
  /** Extra WHERE predicates, alias-qualified + parameterized (built by the caller). */
  filters: Prisma.Sql[];
  /** The (already trimmed) search term. */
  q: string;
  limit: number;
  offset: number;
}

/** Column references (alias-qualified), built from CONSTANT identifiers only. */
function columnRefs(input: TrigramSearchInput): Prisma.Sql[] {
  const own = input.ownColumns.map((c) => Prisma.raw(`${input.alias}.${c}`));
  const joined = input.join
    ? input.join.columns.map((c) => Prisma.raw(`${input.join!.alias}.${c}`))
    : [];
  return [...own, ...joined];
}

/**
 * Builds the parameterized "ranked ids + total" query. Identifiers (table,
 * alias, columns) are CONSTANTS supplied by callers (never user input) and are
 * inlined via Prisma.raw; every VALUE (q, threshold, filters, limit, offset) is
 * bound. Predicate per column: substring (ILIKE, index-accelerated) OR fuzzy
 * (similarity > threshold). Ranked by best similarity, stable tiebreaker.
 *
 * PERF: the GIN trigram index accelerates the ILIKE arm; the `similarity() >`
 * arm is a recheck (the `%` operator + `SET LOCAL pg_trgm.similarity_threshold`
 * would be index-aware, but needs a tx — not worth it at single-company scale).
 */
export function buildTrigramIdQuery(input: TrigramSearchInput): Prisma.Sql {
  const refs = columnRefs(input);
  const match = Prisma.join(
    refs.map(
      (ref) =>
        Prisma.sql`(${ref} ILIKE ('%' || ${input.q} || '%') OR similarity(${ref}, ${input.q}) > ${SIMILARITY_THRESHOLD})`,
    ),
    ' OR ',
  );
  const rank = Prisma.join(
    refs.map((ref) => Prisma.sql`similarity(${ref}, ${input.q})`),
    ', ',
  );
  const joinClause = input.join
    ? Prisma.sql`JOIN ${Prisma.raw(input.join.table)} ${Prisma.raw(input.join.alias)} ON ${Prisma.raw(input.join.alias)}.id = ${Prisma.raw(`${input.alias}.${input.join.onColumn}`)}`
    : Prisma.empty;
  const filterClause =
    input.filters.length > 0
      ? Prisma.sql`AND ${Prisma.join(input.filters, ' AND ')}`
      : Prisma.empty;

  return Prisma.sql`
    SELECT ${Prisma.raw(input.alias)}.id AS id, COUNT(*) OVER() AS total
    FROM ${Prisma.raw(input.table)} ${Prisma.raw(input.alias)}
    ${joinClause}
    WHERE ${Prisma.raw(input.alias)}.deleted_at IS NULL
      ${filterClause}
      AND (${match})
    ORDER BY GREATEST(${rank}) DESC NULLS LAST,
             ${Prisma.raw(input.alias)}.created_at DESC,
             ${Prisma.raw(input.alias)}.id
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
}

/** Runs the ranked-id query; returns ids (in rank order) + total match count. */
export async function trigramSearch(
  prisma: PrismaService,
  input: TrigramSearchInput,
): Promise<{ ids: string[]; total: number }> {
  const rows = await prisma.$queryRaw<{ id: string; total: bigint }[]>(
    buildTrigramIdQuery(input),
  );
  return {
    ids: rows.map((r) => r.id),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}
