import { MIN_QUERY_LENGTH } from '../search/trigram-search';
import { DEFAULT_PAGE_SIZE } from './pagination.constants';

export interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListPaginatedParams<TRow extends { id: string }, TOut> {
  q?: string;
  limit?: number;
  offset?: number;
  /** Map a hydrated row to its response shape. */
  present: (row: TRow) => TOut;
  /** Relevance-ranked id search; provide for endpoints with fuzzy ?q= support. Omit to disable search entirely (search-less endpoints like accounts/tax-codes). */
  search?: (args: { term: string; limit: number; offset: number }) => Promise<{ ids: string[]; total: number }>;
  /** Hydrate full rows for the ranked ids (order not guaranteed; the seam re-orders to the id rank). Required iff `search` is provided. */
  hydrate?: (ids: string[]) => Promise<TRow[]>;
  /** Non-search branch: a page of rows + the matching total. */
  page: (args: { limit: number; offset: number }) => Promise<{ rows: TRow[]; total: number }>;
}

/**
 * Shared offset-pagination + optional fuzzy-search list seam. Owns the
 * limit/offset defaulting, the MIN_QUERY_LENGTH branch, the relevance-rank
 * re-order (dropping ids that fail to hydrate), and the envelope assembly.
 * Callers supply Prisma-typed `search`/`hydrate`/`page` closures + a presenter.
 */
export async function listPaginated<TRow extends { id: string }, TOut>(
  params: ListPaginatedParams<TRow, TOut>,
): Promise<Paginated<TOut>> {
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  const offset = params.offset ?? 0;
  const term = params.q?.trim() ?? '';
  if (term.length >= MIN_QUERY_LENGTH && params.search && params.hydrate) {
    const { ids, total } = await params.search({ term, limit, offset });
    const rows = ids.length ? await params.hydrate(ids) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const data = ids
      .map((id) => byId.get(id))
      .filter((r): r is TRow => r !== undefined)
      .map(params.present);
    return { data, total, limit, offset };
  }
  const { rows, total } = await params.page({ limit, offset });
  return { data: rows.map(params.present), total, limit, offset };
}
