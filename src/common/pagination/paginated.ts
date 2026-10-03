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
  search?: (args: {
    term: string;
    limit: number;
    offset: number;
  }) => Promise<{ ids: string[]; total: number }>;
  /** Hydrate full rows for the ranked ids (order not guaranteed; the seam re-orders to the id rank). Required iff `search` is provided. */
  hydrate?: (ids: string[]) => Promise<TRow[]>;
  /** Non-search branch: a page of rows + the matching total. */
  page: (args: {
    limit: number;
    offset: number;
  }) => Promise<{ rows: TRow[]; total: number }>;
}

/** A Prisma delegate's plain (no relations) list reads. */
export interface ListModel<TRow> {
  findMany(args: {
    where?: object;
    orderBy?: object;
    take?: number;
    skip?: number;
  }): PromiseLike<TRow[]>;
  count(args: { where?: object }): PromiseLike<number>;
}

/** The common case: `page` / `hydrate` read straight off one delegate —
 *  `where` + `orderBy` for the page, the ranked ids for the search hydrate. */
type ModelListParams<TRow extends { id: string }, TOut> = Omit<
  ListPaginatedParams<TRow, TOut>,
  'page' | 'hydrate'
> & { model: ListModel<TRow>; where?: object; orderBy: object };

/**
 * Shared offset-pagination + optional fuzzy-search list seam. Owns the
 * limit/offset defaulting, the MIN_QUERY_LENGTH branch, the relevance-rank
 * re-order (dropping ids that fail to hydrate), and the envelope assembly.
 * Callers supply Prisma-typed `search`/`hydrate`/`page` closures + a presenter.
 */
export async function listPaginated<TRow extends { id: string }, TOut>(
  p: ListPaginatedParams<TRow, TOut> | ModelListParams<TRow, TOut>,
): Promise<Paginated<TOut>> {
  const params = 'model' in p ? fromModel(p) : p;
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

function fromModel<TRow extends { id: string }, TOut>({
  model,
  where,
  orderBy,
  ...rest
}: ModelListParams<TRow, TOut>): ListPaginatedParams<TRow, TOut> {
  return {
    ...rest,
    hydrate: async (ids) => model.findMany({ where: { id: { in: ids } } }),
    page: async ({ limit, offset }) => {
      const [rows, total] = await Promise.all([
        model.findMany({ where, orderBy, take: limit, skip: offset }),
        model.count({ where }),
      ]);
      return { rows, total };
    },
  };
}
