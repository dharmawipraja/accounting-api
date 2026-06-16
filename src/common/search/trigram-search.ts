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
 * Shared FROM + JOIN + WHERE fragments used by both the id query and the count
 * query. Identifiers (table, alias, columns) are CONSTANTS inlined via
 * Prisma.raw; every VALUE (q, threshold, filter values) is bound.
 *
 * Partner JOIN note: the JOIN intentionally does NOT filter p.deleted_at — a
 * document remains findable by a since-deleted partner's name; the document's
 * OWN deleted_at IS NULL is still enforced below.
 */
function buildSharedClauses(input: TrigramSearchInput): {
  joinClause: Prisma.Sql;
  whereClause: Prisma.Sql;
  match: Prisma.Sql;
} {
  const refs = columnRefs(input);
  const match = Prisma.join(
    refs.map(
      (ref) =>
        Prisma.sql`(${ref} ILIKE ('%' || ${input.q} || '%') OR similarity(${ref}, ${input.q}) > ${SIMILARITY_THRESHOLD})`,
    ),
    ' OR ',
  );
  // Partner JOIN intentionally does NOT filter p.deleted_at — a document
  // remains findable by a since-deleted partner's name; the document's OWN
  // deleted_at IS NULL is still enforced in whereClause.
  const joinClause = input.join
    ? Prisma.sql`JOIN ${Prisma.raw(input.join.table)} ${Prisma.raw(input.join.alias)} ON ${Prisma.raw(input.join.alias)}.id = ${Prisma.raw(`${input.alias}.${input.join.onColumn}`)}`
    : Prisma.empty;
  const filterClause =
    input.filters.length > 0
      ? Prisma.sql`AND ${Prisma.join(input.filters, ' AND ')}`
      : Prisma.empty;
  const whereClause = Prisma.sql`
    WHERE ${Prisma.raw(input.alias)}.deleted_at IS NULL
      ${filterClause}
      AND (${match})`;
  return { joinClause, whereClause, match };
}

/**
 * Builds the parameterized ranked-ids query (no COUNT — total comes from the
 * separate count query). Identifiers are CONSTANTS inlined via Prisma.raw;
 * every VALUE (q, threshold, filters, limit, offset) is bound. Predicate per
 * column: substring (ILIKE, index-accelerated) OR fuzzy (similarity >
 * threshold). Ranked by best similarity, stable tiebreaker.
 *
 * PERF: the GIN trigram index accelerates the ILIKE arm; the `similarity() >`
 * arm is a recheck (the `%` operator + `SET LOCAL pg_trgm.similarity_threshold`
 * would be index-aware, but needs a tx — not worth it at single-company scale).
 */
export function buildTrigramIdQuery(input: TrigramSearchInput): Prisma.Sql {
  const refs = columnRefs(input);
  const rank = Prisma.join(
    refs.map((ref) => Prisma.sql`similarity(${ref}, ${input.q})`),
    ', ',
  );
  const { joinClause, whereClause } = buildSharedClauses(input);

  return Prisma.sql`
    SELECT ${Prisma.raw(input.alias)}.id AS id
    FROM ${Prisma.raw(input.table)} ${Prisma.raw(input.alias)}
    ${joinClause}
    ${whereClause}
    ORDER BY GREATEST(${rank}) DESC NULLS LAST,
             ${Prisma.raw(input.alias)}.created_at DESC,
             ${Prisma.raw(input.alias)}.id
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
}

/**
 * Builds the parameterized count query for the same match set as
 * buildTrigramIdQuery but with no ORDER BY / LIMIT / OFFSET. Running this in
 * parallel with the id query gives a correct total even when the page offset
 * overshoots the match count (which would collapse COUNT(*) OVER() to 0).
 */
export function buildTrigramCountQuery(input: TrigramSearchInput): Prisma.Sql {
  const { joinClause, whereClause } = buildSharedClauses(input);

  return Prisma.sql`
    SELECT COUNT(*) AS total
    FROM ${Prisma.raw(input.table)} ${Prisma.raw(input.alias)}
    ${joinClause}
    ${whereClause}
  `;
}

/**
 * Runs the ranked-id query and count query in parallel; returns ids (in rank
 * order) + correct total match count even when the page offset overshoots.
 */
export async function trigramSearch(
  prisma: PrismaService,
  input: TrigramSearchInput,
): Promise<{ ids: string[]; total: number }> {
  const [idRows, countRows] = await Promise.all([
    prisma.$queryRaw<{ id: string }[]>(buildTrigramIdQuery(input)),
    prisma.$queryRaw<{ total: bigint }[]>(buildTrigramCountQuery(input)),
  ]);
  return {
    ids: idRows.map((r) => r.id),
    total: Number(countRows[0].total),
  };
}
