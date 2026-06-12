# Journal-Entry List Endpoint — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete + production-hardened accounting API. A deferred grooming-backlog feature (the one missing "list" endpoint). Read-only; no change to posting/ledger logic.

## 1. Context

Every resource (invoices, bills, payments, partners) has a `GET /` list — except **journal entries**, the core ledger object. Today you can only fetch one by id (`GET /ledger/journal-entries/:id`) or see *derived* views via reports (Buku Besar = per-account lines; trial balance = balances). There is no way to **browse the journal register** or, critically, **discover DRAFT entries awaiting posting** — which makes the existing draft→post + SoD approval workflow hard to use. This adds the missing list.

## 2. Endpoint

`GET /ledger/journal-entries` — a new `@Get()` handler on the existing `JournalController`, **any-authenticated** (no `@Roles`, matching `GET /:id` and the reports; VIEWER+). Backed by a new `JournalService.list(filter)`.

## 3. Query DTO

`src/ledger/journal/dto/list-journal-entries.dto.ts` — `JournalListQueryDto` (all `@IsOptional`; a bad value → 400 via the global `ValidationPipe`). Import `JournalStatus`, `JournalSourceType` from `@prisma/client`.

```ts
@IsEnum(JournalStatus) status?: JournalStatus;            // DRAFT | POSTED | REVERSED
@IsEnum(JournalSourceType) sourceType?: JournalSourceType; // MANUAL | OPENING | REVERSAL | SALES_INVOICE | PURCHASE_BILL | PAYMENT | CLOSING
@Type(() => Number) @IsInt() @Min(2000) @Max(2100) fiscalYear?: number;
@IsDateString() from?: string;  // inclusive, on entry.date
@IsDateString() to?: string;    // inclusive
@Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;   // default 50
@Type(() => Number) @IsInt() @Min(0) offset?: number;            // default 0
```

## 4. Service

`JournalService.list(filter)` (filter: `{ status?, sourceType?, fiscalYear?, from?: Date, to?: Date, limit, offset }`):

```ts
const where: Prisma.JournalEntryWhereInput = {
  status: filter.status,
  sourceType: filter.sourceType,
  fiscalYear: filter.fiscalYear,
  date: filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined,
};
const [rows, total] = await Promise.all([
  this.prisma.client.journalEntry.findMany({
    where,
    include: { lines: { select: { debit: true } } },
    orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }],
    take: filter.limit,
    skip: filter.offset,
  }),
  this.prisma.client.journalEntry.count({ where }),
]);
return { data: rows.map((r) => this.present(r)), total, limit: filter.limit, offset: filter.offset };
```
- `findMany` + `count` both go through `prisma.client` (the soft-delete-extended client), so both inject `deletedAt: null` consistently — soft-deleted entries are excluded and the `total` matches.
- All statuses are listed (drafts included) — no `posted_at` filter (unlike the balance queries).
- `from`/`to` are date-only ISO strings → `new Date()` gives UTC midnight, which compares correctly against the `@db.Date` `entry.date` (also UTC midnight). The controller does the `new Date()` conversion.

**`present()`** — header item, lines summed to a total then dropped:
```ts
private present(e: JournalEntry & { lines: { debit: Prisma.Decimal }[] }): JournalEntryListItem {
  const total = e.lines.reduce((s, l) => s.add(Money.of(l.debit.toString())), Money.zero());
  return {
    id: e.id,
    entryRef: e.entryRef,
    entryNumber: e.entryNumber,
    fiscalYear: e.fiscalYear,
    date: e.date.toISOString().slice(0, 10),
    description: e.description,
    status: e.status,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    totalDebit: total.toPersistence(), // 4dp string (Decimal#toJSON strips trailing zeros — don't return raw)
    lineCount: e.lines.length,
  };
}
```
Export the `JournalEntryListItem` interface from the service for the controller's return type.

## 5. Response shape

```jsonc
{
  "data": [
    { "id": "...", "entryRef": "JE/2026/000123", "entryNumber": 123, "fiscalYear": 2026,
      "date": "2026-03-15", "description": "Sale", "status": "POSTED",
      "sourceType": "SALES_INVOICE", "sourceId": "...", "totalDebit": "2000000.0000", "lineCount": 2 }
  ],
  "total": 1240, "limit": 50, "offset": 0
}
```
The paginated envelope (`data`/`total`/`limit`/`offset`) lets a register UI page through thousands of entries. (This is the first paginated-envelope list; the invoicing/audit lists return bare arrays — acceptable since the journal register is the one list that genuinely needs paging.)

## 6. Controller

```ts
@Get()
list(@Query() q: JournalListQueryDto) {
  return this.journal.list({
    status: q.status,
    sourceType: q.sourceType,
    fiscalYear: q.fiscalYear,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
  });
}
```
Place above `@Get(':id')`. No `@Roles` (any-authenticated).

## 7. Testing

`test/journal-list.e2e-spec.ts` (testcontainers; seed via `PostingService`/`JournalService`):
- Seed: 2–3 POSTED MANUAL entries on different dates (e.g. 2026-02-10, 2026-03-15) + 1 DRAFT (via `JournalService.createDraft`, not posted).
- `GET /ledger/journal-entries` → `data` newest-first (date desc); each item has `totalDebit` (4dp string) + `lineCount`, no `lines[]`; `total` = full count.
- `?status=DRAFT` → only the draft (proves the approver "find pending drafts" use-case); `?status=POSTED` → only posted.
- `?sourceType=MANUAL` → the manual entries; `?from=2026-03-01&to=2026-03-31` → only the March entry; `?fiscalYear=2026` → all 2026.
- `?limit=1` → `data.length === 1`, `total` = full count, `offset` respected.
- `?status=GARBAGE` → 400; `?fiscalYear=abc` → 400.
- Full 147 e2e + 38 unit stay green.

## 8. Build sequence (for the plan)

One task: `JournalListQueryDto` + `JournalService.list` (+ `present` + `JournalEntryListItem`) + the controller `@Get()` + the e2e. Read-only, mirrors the invoicing list + audit pagination patterns.

## 9. Notes / out of scope

- No change to create/post/reverse/delete or any ledger math; this is a read-only addition.
- Filtering by `partnerId` is intentionally out of scope — journal entries reference partners only indirectly via `sourceType`/`sourceId`; use the invoicing/payment list endpoints (which are partner-filtered) for that.
- Drill into the full entry (with `lines[]`) via the existing `GET /ledger/journal-entries/:id`.
