# Fuzzy + Full-Text Search (pg_trgm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `?q=` free-text parameter — typo-tolerant (fuzzy) + substring, relevance-ranked — to five list endpoints (partners, sales-invoices, purchase-bills, payments, journal-entries) using PostgreSQL `pg_trgm`, reusing the existing pagination envelope and filters.

**Architecture:** A hand-authored migration enables `pg_trgm` and adds GIN trigram indexes. A shared `trigram-search` helper builds a parameterized `$queryRaw` that returns matched, ranked, paginated **ids + total** (constant column/table allowlists; all values bound). Each service gains a `q` branch: when `q` (≥2 chars) is present it calls the helper, then hydrates the ranked ids via the normal (soft-delete-safe) Prisma client and `present()`s them; otherwise the existing query runs unchanged. Documents also match the joined partner's name.

**Tech Stack:** NestJS 11, Prisma 7 (`$queryRaw` + `Prisma.sql`/`Prisma.raw`/`Prisma.join`), PostgreSQL `pg_trgm`, Jest + testcontainers + supertest.

**Branch:** `feat/search-pg-trgm` (checked out; spec committed at `936cd37`).

**Spec of record:** `docs/superpowers/specs/2026-06-16-fuzzy-search-design.md`

---

## File Structure

**New files**
- `prisma/migrations/20260616000000_add_trigram_search/migration.sql` — `pg_trgm` + GIN trigram indexes.
- `src/common/search/trigram-search.ts` — query builder + runner + constants.
- `src/common/search/trigram-search.spec.ts` — unit tests for the builder.
- `src/common/dto/search-query.dto.ts` — `SearchQueryDto extends PaginationQueryDto` (adds `q`).

**Modified files**
- `src/invoicing/dto/list-sales-invoices.dto.ts`, `list-purchase-bills.dto.ts`, `list-payments.dto.ts` — extend `SearchQueryDto`.
- `src/ledger/journal/dto/list-journal-entries.dto.ts` — extend `SearchQueryDto`.
- `src/invoicing/business-partners.controller.ts` — `@Query()` type → `SearchQueryDto`.
- `src/invoicing/business-partners.service.ts`, `sales-invoices.service.ts`, `purchase-bills.service.ts`, `payments.service.ts` — `q` branch in `listPage()`.
- `src/ledger/journal/journal.controller.ts` (pass `q`) + `src/ledger/journal/journal.service.ts` — `q` branch in `list()`.
- e2e: `test/business-partners.e2e-spec.ts`, `test/sales-invoices.e2e-spec.ts`, `test/purchase-bills.e2e-spec.ts`, `test/payments.e2e-spec.ts`, `test/journal-list.e2e-spec.ts` — search tests.
- `docs/api/openapi.json` — regenerated (`q` param).

**Intentionally NOT touched:** accounts, tax-codes (not searchable by design).

---

## Task 1: Migration — `pg_trgm` extension + GIN trigram indexes

**Files:**
- Create: `prisma/migrations/20260616000000_add_trigram_search/migration.sql`

> This project hand-authors migrations with SQL not expressible in `schema.prisma` (e.g. the `journal_lines_one_sided` CHECK constraint). Trigram indexes + the extension are the same: migration-only, no `schema.prisma` change. Tests apply migrations via `prisma migrate deploy` (testcontainers), which does not drift-check. Do NOT run `prisma migrate dev` to regenerate this.

- [ ] **Step 1: Write the migration**

Create `prisma/migrations/20260616000000_add_trigram_search/migration.sql`:

```sql
-- Enable trigram fuzzy/substring search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes accelerate BOTH ILIKE '%...%' and similarity() searches.
CREATE INDEX IF NOT EXISTS "business_partners_name_trgm"  ON "business_partners" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "business_partners_code_trgm"  ON "business_partners" USING gin ("code" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "business_partners_npwp_trgm"  ON "business_partners" USING gin ("npwp" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "business_partners_email_trgm" ON "business_partners" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "sales_invoices_invoice_ref_trgm"  ON "sales_invoices" USING gin ("invoice_ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "sales_invoices_description_trgm"  ON "sales_invoices" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "purchase_bills_bill_ref_trgm"          ON "purchase_bills" USING gin ("bill_ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "purchase_bills_vendor_invoice_no_trgm" ON "purchase_bills" USING gin ("vendor_invoice_no" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "purchase_bills_description_trgm"       ON "purchase_bills" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "payments_ref_trgm"         ON "payments" USING gin ("ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "payments_description_trgm" ON "payments" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "journal_entries_entry_ref_trgm"   ON "journal_entries" USING gin ("entry_ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "journal_entries_description_trgm" ON "journal_entries" USING gin ("description" gin_trgm_ops);
```

(`20260616000000` sorts after the latest existing migration `20260613000000_generalize_idempotency_keys` — confirm with `ls prisma/migrations/`; bump if a later one exists.)

- [ ] **Step 2: Validate the migration applies to a real Postgres**

Run: `npm run test:e2e -- health` (use 600000ms timeout)
Expected: the testcontainer runs `prisma migrate deploy`, applies all migrations including `20260616000000_add_trigram_search` (extension + indexes), and the health spec passes. If the SQL is malformed, `migrate deploy` errors here — fix the SQL.

- [ ] **Step 3: Commit**

```bash
git add prisma/migrations/20260616000000_add_trigram_search
git commit -m "feat(search): pg_trgm extension + GIN trigram indexes"
```

---

## Task 2: `trigram-search` helper + unit tests

**Files:**
- Create: `src/common/search/trigram-search.ts`
- Test: `src/common/search/trigram-search.spec.ts`

- [ ] **Step 1: Write the failing unit test**

Create `src/common/search/trigram-search.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import {
  buildTrigramIdQuery,
  MIN_QUERY_LENGTH,
  SIMILARITY_THRESHOLD,
} from './trigram-search';

describe('buildTrigramIdQuery', () => {
  it('exposes sane constants', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(SIMILARITY_THRESHOLD).toBeLessThan(1);
  });

  it('parameterizes the query value (never interpolates it) and inlines identifiers', () => {
    const sql = buildTrigramIdQuery({
      table: 'business_partners',
      alias: 't',
      ownColumns: ['name', 'code'],
      filters: [],
      q: "bo'bby", // contains a quote — must NOT appear inline
      limit: 20,
      offset: 0,
    });
    // Identifiers are inlined (constants); the user value is bound, not inlined.
    expect(sql.sql).toContain('business_partners');
    expect(sql.sql).toContain('t.name');
    expect(sql.sql).toContain('t.code');
    expect(sql.sql).toContain('deleted_at IS NULL');
    expect(sql.sql).toContain('GREATEST');
    expect(sql.sql).toContain('COUNT(*) OVER()');
    expect(sql.sql).not.toContain("bo'bby");
    expect(sql.values).toContain("bo'bby");
    expect(sql.values).toContain(20); // limit
    expect(sql.values).toContain(0); // offset
  });

  it('adds a JOIN and joined column refs when a join is given', () => {
    const sql = buildTrigramIdQuery({
      table: 'sales_invoices',
      alias: 't',
      ownColumns: ['invoice_ref', 'description'],
      join: {
        table: 'business_partners',
        alias: 'p',
        onColumn: 'partner_id',
        columns: ['name'],
      },
      filters: [Prisma.sql`t.status::text = ${'POSTED'}`],
      q: 'budi',
      limit: 50,
      offset: 0,
    });
    expect(sql.sql).toContain('JOIN business_partners p');
    expect(sql.sql).toContain('p.name');
    expect(sql.sql).toContain('t.partner_id');
    expect(sql.values).toContain('POSTED'); // filter value bound
    expect(sql.values).toContain('budi');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- trigram-search`
Expected: FAIL — `Cannot find module './trigram-search'`.

- [ ] **Step 3: Implement the helper**

Create `src/common/search/trigram-search.ts`:

```typescript
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
  /** Base-table searchable columns (constants). */
  ownColumns: string[];
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
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npm test -- trigram-search`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint**

Run: `npx eslint src/common/search/trigram-search.ts src/common/search/trigram-search.spec.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/common/search/trigram-search.ts src/common/search/trigram-search.spec.ts
git commit -m "feat(search): parameterized trigram ranked-id query builder + tests"
```

---

## Task 3: `SearchQueryDto` + wire `q` into the five DTOs/controllers

**Files:**
- Create: `src/common/dto/search-query.dto.ts`
- Modify: `src/invoicing/dto/list-sales-invoices.dto.ts`, `list-purchase-bills.dto.ts`, `list-payments.dto.ts`
- Modify: `src/ledger/journal/dto/list-journal-entries.dto.ts`
- Modify: `src/invoicing/business-partners.controller.ts`

- [ ] **Step 1: Create the shared search DTO**

Create `src/common/dto/search-query.dto.ts`:

```typescript
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from './pagination-query.dto';

/** Pagination + an optional free-text search term (`?q=`). */
export class SearchQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q?: string;
}
```

- [ ] **Step 2: Point the invoicing + journal list DTOs at `SearchQueryDto`**

In each of `src/invoicing/dto/list-sales-invoices.dto.ts`, `list-purchase-bills.dto.ts`, `list-payments.dto.ts`, and `src/ledger/journal/dto/list-journal-entries.dto.ts`: change the import + `extends`:
- Replace `import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';` with `import { SearchQueryDto } from '../../common/dto/search-query.dto';` (journal DTO uses `'../../../common/dto/search-query.dto'`).
- Replace `extends PaginationQueryDto` with `extends SearchQueryDto`.
Keep each DTO's own filter fields unchanged.

- [ ] **Step 3: Point the partners controller at `SearchQueryDto`**

In `src/invoicing/business-partners.controller.ts`: replace the `PaginationQueryDto` import with `import { SearchQueryDto } from '../common/dto/search-query.dto';` and change the list handler signature to `list(@Query() q: SearchQueryDto)`. (The handler still calls `this.partners.listPage(q)`.)

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint:ci`
Expected: exit 0. (Services don't read `q` yet — that's Tasks 4–8. No behavior change yet.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(search): add ?q= to the five list query DTOs"
```

---

## Task 4: Partners search branch + e2e

**Files:**
- Modify: `src/invoicing/business-partners.service.ts`
- Test: `test/business-partners.e2e-spec.ts`

- [ ] **Step 1: Add the search branch to `listPage`**

In `src/invoicing/business-partners.service.ts`: add imports `import { trigramSearch, MIN_QUERY_LENGTH } from '../common/search/trigram-search';`. Widen the `listPage` param to accept `q?: string` and add the branch at the top of the method (before the existing `findMany`/`count`):

```typescript
  async listPage(q: {
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: BusinessPartner[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const term = q.q?.trim() ?? '';
    if (term.length >= MIN_QUERY_LENGTH) {
      const { ids, total } = await trigramSearch(this.prisma, {
        table: 'business_partners',
        alias: 't',
        ownColumns: ['name', 'code', 'npwp', 'email'],
        filters: [],
        q: term,
        limit,
        offset,
      });
      const rows = ids.length
        ? await this.prisma.client.businessPartner.findMany({
            where: { id: { in: ids } },
          })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = ids.map((id) => byId.get(id)!).filter(Boolean);
      return { data, total, limit, offset };
    }
    const [data, total] = await Promise.all([
      this.prisma.client.businessPartner.findMany({
        orderBy: { code: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.businessPartner.count(),
    ]);
    return { data, total, limit, offset };
  }
```

- [ ] **Step 2: Add e2e search tests**

In `test/business-partners.e2e-spec.ts`, add a `describe('search (?q=)')` block that reuses the spec's existing `app`/`server()` and an authenticated token (reuse whatever token variable the spec already sets up; create one if the spec lacks it). Create two partners with distinct names via the service or HTTP, then:

```typescript
  describe('search (?q=)', () => {
    it('fuzzy-matches a typo, ranks the closer name first, and excludes non-matches', async () => {
      const partners = app.get(BusinessPartnersService);
      await partners.create({ code: 'SR-BUDI', name: 'PT Budi Jaya', isCustomer: true });
      await partners.create({ code: 'SR-SINAR', name: 'CV Sinar Abadi', isCustomer: true });
      const res = await request(server())
        .get('/v1/partners?q=budih') // typo for "Budi"
        .set('Authorization', `Bearer ${acct}`) // reuse the spec's token var
        .expect(200);
      const body = res.body as { data: { name: string }[]; total: number };
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].name).toBe('PT Budi Jaya');
      expect(body.data.every((p) => p.name !== 'CV Sinar Abadi')).toBe(true);
    });

    it('ignores a sub-min-length q (returns the normal list)', async () => {
      const res = await request(server())
        .get('/v1/partners?q=a&limit=5')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as { data: unknown[]; limit: number };
      expect(body.limit).toBe(5);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });
```

Adapt `acct`/token + the `BusinessPartnersService` import to the spec's existing setup. If the spec doesn't import `BusinessPartnersService`, add the import.

- [ ] **Step 3: Run e2e + typecheck/lint**

Run: `npm run test:e2e -- business-partners` (600000ms timeout), then `npm run typecheck && npm run lint:ci`
Expected: all green. If the fuzzy assertion is flaky on ranking, confirm `similarity('PT Budi Jaya','budih') > similarity('CV Sinar Abadi','budih')` holds (it does); otherwise inspect the threshold.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(search): partner fuzzy search via ?q="
```

---

## Task 5: Sales-invoices search branch + e2e

**Files:**
- Modify: `src/invoicing/sales-invoices.service.ts`
- Test: `test/sales-invoices.e2e-spec.ts`

- [ ] **Step 1: Add the search branch to `listPage`**

In `src/invoicing/sales-invoices.service.ts`: add `import { Prisma } from '@prisma/client';` (if not present) and `import { trigramSearch, MIN_QUERY_LENGTH } from '../common/search/trigram-search';`. Add `q?: string` to the `listPage` param and branch at the top:

```typescript
  async listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: ReturnType<SalesInvoicesService['present']>[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const term = q.q?.trim() ?? '';
    if (term.length >= MIN_QUERY_LENGTH) {
      const filters: Prisma.Sql[] = [];
      if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
      if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
      const { ids, total } = await trigramSearch(this.prisma, {
        table: 'sales_invoices',
        alias: 't',
        ownColumns: ['invoice_ref', 'description'],
        join: { table: 'business_partners', alias: 'p', onColumn: 'partner_id', columns: ['name'] },
        filters,
        q: term,
        limit,
        offset,
      });
      const rows = ids.length
        ? await this.prisma.client.salesInvoice.findMany({ where: { id: { in: ids } } })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = ids.map((id) => byId.get(id)!).filter(Boolean).map((r) => this.present(r));
      return { data, total, limit, offset };
    }
    const where = { partnerId: q.partnerId, status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.client.salesInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.salesInvoice.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), total, limit, offset };
  }
```

- [ ] **Step 2: Add e2e search tests**

In `test/sales-invoices.e2e-spec.ts`, add a `describe('search (?q=)')` reusing the spec's setup (tokens, seeded accounts/tax codes, a partner). Create two invoices for a partner named e.g. "PT Budi Jaya" with distinct descriptions, then assert:

```typescript
  describe('search (?q=)', () => {
    it('matches by description and by partner name, composing with status', async () => {
      const partnerId = await newCustomer('SI-SEARCH'); // reuse the spec's partner helper
      await createInvoice(partnerId, 'Jasa konsultasi pajak'); // reuse the spec's create helper / inline HTTP
      await createInvoice(partnerId, 'Penjualan barang');
      // by description
      const byDesc = await request(server())
        .get('/v1/sales-invoices?q=konsultasi')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      expect((byDesc.body as { data: { description: string }[] }).data
        .some((i) => i.description?.includes('konsultasi'))).toBe(true);
      // by partner name
      const byPartner = await request(server())
        .get('/v1/sales-invoices?q=budi')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      expect((byPartner.body as { total: number }).total).toBeGreaterThanOrEqual(2);
    });
  });
```

Adapt helper/token names to the spec (e.g. it may already have `newCustomer` and an invoice-create helper; if not, create invoices via `POST /v1/sales-invoices` with `.set('Idempotency-Key', randomUUID())`). Drafts are searchable (no posting needed).

- [ ] **Step 3: Run e2e + typecheck/lint**

Run: `npm run test:e2e -- sales-invoices` (600000ms), then `npm run typecheck && npm run lint:ci`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(search): sales-invoice search (own fields + partner name) via ?q="
```

---

## Task 6: Purchase-bills search branch + e2e

**Files:**
- Modify: `src/invoicing/purchase-bills.service.ts`
- Test: `test/purchase-bills.e2e-spec.ts`

- [ ] **Step 1: Add the search branch to `listPage`**

In `src/invoicing/purchase-bills.service.ts`: add `import { Prisma } from '@prisma/client';` (if absent) and `import { trigramSearch, MIN_QUERY_LENGTH } from '../common/search/trigram-search';`. Add `q?: string` and branch:

```typescript
  async listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: ReturnType<PurchaseBillsService['present']>[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const term = q.q?.trim() ?? '';
    if (term.length >= MIN_QUERY_LENGTH) {
      const filters: Prisma.Sql[] = [];
      if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
      if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
      const { ids, total } = await trigramSearch(this.prisma, {
        table: 'purchase_bills',
        alias: 't',
        ownColumns: ['bill_ref', 'vendor_invoice_no', 'description'],
        join: { table: 'business_partners', alias: 'p', onColumn: 'partner_id', columns: ['name'] },
        filters,
        q: term,
        limit,
        offset,
      });
      const rows = ids.length
        ? await this.prisma.client.purchaseBill.findMany({ where: { id: { in: ids } } })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = ids.map((id) => byId.get(id)!).filter(Boolean).map((r) => this.present(r));
      return { data, total, limit, offset };
    }
    const where = { partnerId: q.partnerId, status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.client.purchaseBill.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.purchaseBill.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), total, limit, offset };
  }
```

- [ ] **Step 2: Add e2e search tests**

In `test/purchase-bills.e2e-spec.ts`, mirror Task 5's e2e: create two bills (distinct `description`/`vendorInvoiceNo`) for a vendor, assert `?q=` matches by description, by `vendor_invoice_no` substring, and by partner name. Reuse the spec's vendor/create helpers and token; create bills via `POST /v1/purchase-bills` with `.set('Idempotency-Key', randomUUID())` if no helper exists.

```typescript
  describe('search (?q=)', () => {
    it('matches by vendor invoice no and partner name', async () => {
      const vendorId = await newVendor('PB-SEARCH'); // reuse spec helper
      await createBill(vendorId, { description: 'Pembelian ATK', vendorInvoiceNo: 'INV-AX-991' });
      const res = await request(server())
        .get('/v1/purchase-bills?q=AX-991')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      expect((res.body as { total: number }).total).toBeGreaterThanOrEqual(1);
    });
  });
```

Adapt helper/token names to the spec.

- [ ] **Step 3: Run e2e + typecheck/lint**

Run: `npm run test:e2e -- purchase-bills` (600000ms), then `npm run typecheck && npm run lint:ci`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(search): purchase-bill search (own fields + partner name) via ?q="
```

---

## Task 7: Payments search branch + e2e

**Files:**
- Modify: `src/invoicing/payments.service.ts`
- Test: `test/payments.e2e-spec.ts`

- [ ] **Step 1: Add the search branch to `listPage`**

In `src/invoicing/payments.service.ts`: add `import { Prisma } from '@prisma/client';` (if absent) and `import { trigramSearch, MIN_QUERY_LENGTH } from '../common/search/trigram-search';`. Add `q?: string` and branch:

```typescript
  async listPage(q: {
    q?: string;
    partnerId?: string;
    direction?: PaymentDirection;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: ReturnType<PaymentsService['present']>[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const term = q.q?.trim() ?? '';
    if (term.length >= MIN_QUERY_LENGTH) {
      const filters: Prisma.Sql[] = [];
      if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
      if (q.direction) filters.push(Prisma.sql`t.direction::text = ${q.direction}`);
      if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
      const { ids, total } = await trigramSearch(this.prisma, {
        table: 'payments',
        alias: 't',
        ownColumns: ['ref', 'description'],
        join: { table: 'business_partners', alias: 'p', onColumn: 'partner_id', columns: ['name'] },
        filters,
        q: term,
        limit,
        offset,
      });
      const rows = ids.length
        ? await this.prisma.client.payment.findMany({ where: { id: { in: ids } } })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = ids.map((id) => byId.get(id)!).filter(Boolean).map((r) => this.present(r));
      return { data, total, limit, offset };
    }
    const where = { partnerId: q.partnerId, direction: q.direction, status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.client.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.payment.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), total, limit, offset };
  }
```

- [ ] **Step 2: Add e2e search tests**

In `test/payments.e2e-spec.ts` (which already has `newCustomer`, `makePostedInvoice`, `acct`/`appr`, `server()`), add:

```typescript
  describe('search (?q=)', () => {
    it('matches a payment by description and by partner name, composing with direction', async () => {
      const customerId = await newCustomer('PAY-SEARCH');
      const invoiceId = await makePostedInvoice(customerId);
      await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: customerId,
          date: '2026-02-15',
          cashAccountId: acc['1-1000'],
          description: 'Pelunasan termin satu',
          allocations: [{ salesInvoiceId: invoiceId, amount: '600000' }],
        })
        .expect(201);
      const res = await request(server())
        .get('/v1/payments?q=termin&direction=RECEIPT')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      expect((res.body as { data: { description: string }[] }).data
        .some((p) => p.description?.includes('termin'))).toBe(true);
    });
  });
```

Ensure `randomUUID` is imported in the spec.

- [ ] **Step 3: Run e2e + typecheck/lint**

Run: `npm run test:e2e -- payments` (600000ms), then `npm run typecheck && npm run lint:ci`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(search): payment search (own fields + partner name) via ?q="
```

---

## Task 8: Journal-entries search branch + e2e

**Files:**
- Modify: `src/ledger/journal/journal.service.ts`
- Modify: `src/ledger/journal/journal.controller.ts`
- Test: `test/journal-list.e2e-spec.ts`

- [ ] **Step 1: Pass `q` from the controller**

In `src/ledger/journal/journal.controller.ts`, the list handler builds a filter object from `JournalListQueryDto`. Add `q: q.q` to that object passed to `this.journal.list({...})` (the DTO now has `q` via `SearchQueryDto`).

- [ ] **Step 2: Add the search branch to `list`**

In `src/ledger/journal/journal.service.ts`: add `import { trigramSearch, MIN_QUERY_LENGTH } from '../../common/search/trigram-search';` (`Prisma` is already imported). Add `q?: string` to the `JournalListFilter` type and branch at the top of `list()` (before the existing `where`/`findMany`). Journal `present()` needs `lines: { debit }`, so hydration includes lines:

```typescript
    const term = filter.q?.trim() ?? '';
    if (term.length >= MIN_QUERY_LENGTH) {
      const filters: Prisma.Sql[] = [];
      if (filter.status) filters.push(Prisma.sql`t.status::text = ${filter.status}`);
      if (filter.sourceType) filters.push(Prisma.sql`t.source_type::text = ${filter.sourceType}`);
      if (filter.fiscalYear) filters.push(Prisma.sql`t.fiscal_year = ${filter.fiscalYear}`);
      if (filter.from) filters.push(Prisma.sql`t.date >= ${filter.from}`);
      if (filter.to) filters.push(Prisma.sql`t.date <= ${filter.to}`);
      const { ids, total } = await trigramSearch(this.prisma, {
        table: 'journal_entries',
        alias: 't',
        ownColumns: ['entry_ref', 'description'],
        filters,
        q: term,
        limit: filter.limit,
        offset: filter.offset,
      });
      const rows = ids.length
        ? await this.prisma.client.journalEntry.findMany({
            where: { id: { in: ids } },
            include: { lines: { select: { debit: true } } },
          })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = ids.map((id) => byId.get(id)!).filter(Boolean).map((r) => this.present(r));
      return { data, total, limit: filter.limit, offset: filter.offset };
    }
```

(Place this immediately after computing `term`, before the existing `const where = {...}` block. Confirm `JournalListFilter` includes `q?: string`, `limit: number`, `offset: number` — `limit`/`offset` already exist.)

- [ ] **Step 3: Add e2e search tests**

In `test/journal-list.e2e-spec.ts` (reuse its app/token/account setup), create two posted/draft entries with distinct descriptions, then:

```typescript
  describe('search (?q=)', () => {
    it('matches journal entries by description', async () => {
      // create an entry with a distinctive memo via the spec's existing create path
      await createEntry('Penyesuaian akhir bulan'); // reuse spec helper or POST with Idempotency-Key
      const res = await request(server())
        .get('/v1/ledger/journal-entries?q=penyesuaian')
        .set('Authorization', `Bearer ${appr}`)
        .expect(200);
      expect((res.body as { data: { description: string }[] }).data
        .some((e) => e.description?.toLowerCase().includes('penyesuaian'))).toBe(true);
    });
  });
```

Adapt the create path + token to the spec (entries are created via `POST /v1/ledger/journal-entries` with `?post=...` and an `Idempotency-Key`; drafts are searchable).

- [ ] **Step 4: Run e2e + typecheck/lint**

Run: `npm run test:e2e -- journal-list` (600000ms), then `npm run typecheck && npm run lint:ci`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(search): journal-entry search via ?q="
```

---

## Task 9: Regenerate `openapi.json` + contract guard

**Files:**
- Modify (generated): `docs/api/openapi.json`

- [ ] **Step 1: Regenerate**

Run: `npm run openapi:export`
Expected: prints `Wrote docs/api/openapi.json`. The five list endpoints now show an optional `q` query parameter.

- [ ] **Step 2: Contract guard + openapi specs**

Run: `npm test -- openapi`
Expected: PASS (response shapes unchanged; only a new request query param added).

- [ ] **Step 3: Sanity-check the `q` param landed**

Run: `node -e "const d=require('./docs/api/openapi.json'); const p=d.paths['/v1/partners'].get.parameters||[]; console.log('partners q param:', p.some(x=>x.name==='q'));"`
Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add docs/api/openapi.json
git commit -m "docs(openapi): document the ?q= search parameter"
```

---

## Task 10: Full verification gate

- [ ] **Step 1: Run the whole pipeline**

Run: `npm run verify`
Expected: `typecheck` (0), `lint:ci` (0), `test` (unit incl. the new `trigram-search` tests), `test:e2e:cov` (all e2e green; coverage thresholds — statements/functions/lines 84%, branches 62% — still met).
Note: `test:e2e:cov` runs the full suite (slow, many testcontainers). If a single Bash call's 10-min cap is exceeded, run it in the background and wait for completion.

- [ ] **Step 2: If coverage dipped**

The search branches add code exercised by the per-resource e2e tests; the helper is unit-tested. If `test:e2e:cov` fails only on coverage, add a focused e2e covering an uncovered branch (e.g. a `?q=` with a filter that yields zero matches → `{ data: [], total: 0 }`). Re-run `npm run verify` until green.

- [ ] **Step 3: Final commit (if Step 2 added tests)**

```bash
git add -A
git commit -m "test(search): cover zero-match branch to hold coverage gate"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §3 D1 scope → Tasks 4–8 (the five resources); D2 pg_trgm → Tasks 1–2; D3 `?q=` on existing endpoints → Task 3 + the service branches; D4 partner-name join → Tasks 5–7 (`join` in the helper input); D5 trigram-only → no tsvector anywhere. §4.2 indexes → Task 1. §4.3 semantics (ILIKE+similarity, 0.3 threshold, GREATEST rank, ≥2 min) → Task 2 helper + the `MIN_QUERY_LENGTH` guard in each service. §4.4 ranked-ids→hydrate + soft-delete + injection-safety → Task 2 + service branches. §6 testing → Tasks 4–8 + 10. OpenAPI → Task 9.
- **Implementation note vs spec §4.3:** the helper uses an explicit `similarity() > 0.3` constant + `ILIKE` (both work without a session GUC), rather than the `%` operator + `SET LOCAL pg_trgm.similarity_threshold`. Same UX, simpler/self-contained; the GIN trigram index still accelerates the `ILIKE` branch. Tunable by changing `SIMILARITY_THRESHOLD`.
- **Soft-delete:** every raw query filters `t.deleted_at IS NULL` (in `buildTrigramIdQuery`); hydration via `this.prisma.client` is also soft-delete-safe.
- **Injection:** identifiers (table/alias/columns) are constants from the services; all values (`q`, threshold, filters, limit, offset) are bound — asserted by the Task 2 unit test.
- **e2e adaptation:** the e2e snippets reference each spec's existing token/helper names (`acct`, `appr`, `newCustomer`, `makePostedInvoice`, `acc`). Match them to the actual spec; create rows via the service or `POST … + Idempotency-Key`. Drafts are searchable (no posting required).
- **Naming consistency:** helper exports `buildTrigramIdQuery`, `trigramSearch`, `MIN_QUERY_LENGTH`, `SIMILARITY_THRESHOLD`; the shared DTO is `SearchQueryDto`; every service uses the `term.length >= MIN_QUERY_LENGTH` guard.
