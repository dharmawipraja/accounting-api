# Design: Fuzzy + Full-Text Search (`?q=`) via PostgreSQL `pg_trgm`

- **Date:** 2026-06-16
- **Status:** Approved (design); pending spec review → implementation plan
- **Type:** Feature (read-only; additive query parameter on existing endpoints)
- **Repo:** `accounting-api` (NestJS 11 + Prisma 7 + PostgreSQL, single-VM, single-company)

## 1. Context & Motivation

The list endpoints currently support structured filters (`?partnerId`, `?status`) and
offset pagination, but no free-text search. Users need to find records by typing a
name/reference/memo — typo-tolerantly. Because the stack is PostgreSQL, the
production-ready, well-maintained way to do this without new infrastructure is the
**`pg_trgm`** trigram extension (Postgres contrib): it provides fuzzy (typo-tolerant)
matching, substring matching, similarity ranking, and GIN-index acceleration, against
**live data** (no separate search service, no sync pipeline, always consistent).

## 2. Goals / Non-Goals

**Goals**
- Add an optional `?q=` free-text parameter to five list endpoints (below). When
  present, results are fuzzy/substring matched and ranked by relevance; when absent,
  the endpoint behaves exactly as today.
- Typo tolerance (e.g. `q=budih` finds "Budi"), substring matches, relevance ranking.
- Reuse the existing pagination envelope `{ data, total, limit, offset }` and compose
  with existing filters.

**Non-Goals**
- Cross-resource / global search (one search box over everything).
- Search on `accounts` / `tax-codes` (small bounded reference sets).
- Highlighting / snippets.
- `tsvector` linguistic full-text (stemming, language config) — **deferred** (see D5).
- Search analytics / query logging.

## 3. Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Scope | **partners + sales-invoices + purchase-bills + payments + journal-entries** | The resources where free-text search genuinely helps; the four doc lists already paginate |
| D2 | Engine | **PostgreSQL `pg_trgm`** (trigram) | Production-ready Postgres contrib; fuzzy + substring + ranking; no new service/sync; always consistent |
| D3 | API shape | **Optional `?q=` on the existing list endpoints**, relevance-ranked, composing with filters + pagination | Minimal new surface; one endpoint per resource |
| D4 | Documents | `?q=` matches the document's own fields **+ the related partner's name** (join) | "Find all invoices for *Budi*" is the natural expectation |
| D5 | Full-text depth | **Trigram-only now; defer `tsvector` FTS** | Fields are short (names/refs/short descriptions); trigram covers fuzzy + substring in one mechanism. Stemming/language config adds complexity for little gain here. |

## 4. Detailed Design

### 4.1 Searchable fields per resource

| Endpoint | Fields matched by `?q=` |
|----------|-------------------------|
| `GET /v1/partners` | `name`, `code`, `npwp`, `email` |
| `GET /v1/sales-invoices` | `invoice_ref`, `description`, **+ partner `name`** (join on `partner_id`) |
| `GET /v1/purchase-bills` | `bill_ref`, `vendor_invoice_no`, `description`, **+ partner `name`** |
| `GET /v1/payments` | `ref`, `description`, **+ partner `name`** |
| `GET /v1/journal-entries` | `entry_ref`, `description` (journals have no partner) |

(Partner `phone`/`address` are intentionally excluded — low search value; can be added later.)

### 4.2 Extension & indexes

A hand-authored migration:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- GIN trigram indexes accelerate BOTH ILIKE '%…%' and the % similarity operator.
CREATE INDEX business_partners_name_trgm   ON "business_partners" USING gin (name gin_trgm_ops);
CREATE INDEX business_partners_code_trgm   ON "business_partners" USING gin (code gin_trgm_ops);
-- … npwp, email; invoice_ref/description; bill_ref/vendor_invoice_no/description;
--    payments ref/description; journal entry_ref/description …
```

One GIN trigram index per searched column (it serves both substring and similarity).
Partner-name search on documents reuses `business_partners_name_trgm`.

### 4.3 Match & ranking semantics

- **Predicate** (per searchable field, OR'd together):
  `(field ILIKE '%' || :q || '%' OR field % :q)` — `ILIKE` catches exact infixes,
  `%` catches fuzzy/typo matches. Both use the GIN trigram index.
- **Ranking:** `ORDER BY GREATEST(similarity(field1, :q), similarity(field2, :q), …) DESC`,
  then a stable tiebreaker (`created_at DESC, id`) so equal-similarity rows page
  deterministically.
- **Threshold:** the trigram `%` operator uses `pg_trgm.similarity_threshold`
  (default `0.3`); applied via `SET LOCAL` inside the search transaction so it doesn't
  leak across connections. Tunable later if recall/precision needs adjusting.
- **Min length:** `q` is trimmed; if it is empty or `< 2` chars, it is **ignored**
  (the endpoint returns its normal unfiltered/paginated list). ≥ 2 chars activates search.

### 4.4 Implementation pattern — "ranked IDs via raw SQL → hydrate via Prisma"

1. `?q=` is added to each list **query DTO** (so controllers are unchanged). The DTO
   trims/normalizes `q`.
2. In the service `listPage()` (and partners' equivalent), branch:
   - **`q` absent/short** → the existing Prisma query, unchanged.
   - **`q` present** → a parameterized `$queryRaw` that computes the matched, ranked,
     **paginated id list + total** (total via `COUNT(*) OVER()` in the same query, or a
     parallel count). Then the **normal Prisma client** hydrates those rows
     `findMany({ where: { id: { in: ids } } })` (typed, soft-delete-safe), and the
     service re-orders to the ranked id order in JS and applies `present()` (documents).
   - This keeps raw SQL minimal (ids + score only) and avoids snake_case → DTO mapping.
3. **Soft-delete gotcha:** `$queryRaw` BYPASSES the soft-delete Prisma extension, so the
   raw `WHERE` **must explicitly include `deleted_at IS NULL`** plus the existing filters
   (`status` / `partner_id` / `direction`). (Hydration via the Prisma client is already
   soft-delete-safe, but the ids must be filtered at search time so `total` is correct.)
4. **Injection safety:** table/column names come from **constant allowlists** in code
   (never user input) and are interpolated by a small shared helper; all values
   (`q`, `limit`, `offset`, filter values) are **always parameterized**.

### 4.5 Shared helper

`src/common/search/trigram-search.ts` — a helper that, given a fixed table name, a
constant list of searchable columns, an optional partner join, the active filters, and
`{ q, limit, offset }`, builds and runs the parameterized ranked-ids query and returns
`{ ids: string[]; total: number }`. Each of the five services calls it from its search
branch and hydrates via Prisma. Column/table identifiers are compile-time constants;
only values are bound.

### 4.6 API behavior

- Request: `GET /v1/<resource>?q=<text>&limit=&offset=&<existing filters>`.
- Response: the **unchanged** envelope `{ data, total, limit, offset }` — `data` is the
  ranked page, `total` is the match count. Existing filters AND `q` apply together
  (filters narrow, `q` ranks within).
- `q` is documented in OpenAPI via the query DTO (`@ApiPropertyOptional`).

## 5. Per-endpoint summary

| Endpoint | Own fields | Partner-name join | Existing filters preserved |
|----------|-----------|-------------------|----------------------------|
| partners | name, code, npwp, email | — | (none today) |
| sales-invoices | invoice_ref, description | yes | partnerId, status |
| purchase-bills | bill_ref, vendor_invoice_no, description | yes | partnerId, status |
| payments | ref, description | yes | partnerId, direction, status |
| journal-entries | entry_ref, description | — | status, sourceType, fiscalYear, from, to |

## 6. Testing

- **e2e per resource:** typo'd query finds the record; substring match; relevance order
  (closer match ranks first); `?q=` composes with the resource's structured filters +
  pagination envelope (`total` reflects matches); partner-name match returns the right
  documents; soft-deleted rows are excluded; `q` shorter than 2 chars is ignored
  (returns the normal list).
- **Unit:** the `trigram-search` helper builds the expected parameterized query for a
  given column allowlist + filters (and never interpolates a value).
- The OpenAPI contract guard must still pass (response shapes unchanged).

## 7. Risks & Mitigations

- **Raw SQL bypasses soft-delete** → the raw WHERE explicitly filters `deleted_at IS NULL`;
  covered by an e2e asserting deleted rows never appear in search.
- **Injection** → identifiers are constants; all values parameterized; the helper has no
  path for user-controlled identifiers.
- **Index bloat / write cost** → GIN trigram indexes add write overhead; acceptable at
  single-company volumes; only the searched columns are indexed.
- **Ranking determinism** → stable tiebreaker (`created_at`, `id`) so pagination doesn't
  shuffle equal-score rows.
- **Threshold tuning** → default `0.3`; if users report missed/excess matches, tune
  `pg_trgm.similarity_threshold` (SET LOCAL) — no schema change needed.

## 8. Build Sequence

1. Migration: `CREATE EXTENSION pg_trgm` + GIN trigram indexes (hand-authored).
2. Shared `trigram-search` helper + unit test.
3. Add `q` to the five list query DTOs.
4. Wire the search branch into each of the five services (hydrate via Prisma; `present()`
   for documents); partner-name join for the three doc resources.
5. e2e per resource; regenerate `openapi.json` (the new `q` param) + contract guard.
6. Full verification (typecheck, lint, unit, e2e + coverage).
