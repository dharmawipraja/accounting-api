# Architecture & Dead-Code Cleanup — Design

- **Date:** 2026-06-18
- **Status:** Approved (design); pending implementation plan
- **Source:** §3 "Architecture & dead code" of `docs/production-readiness-audit-2026-06-17.md`
- **Scope decision:** "Safe cleanup batch" — dead code + behavior-preserving DRY/quality consolidation. Candidates **C** (TOCTOU `FOR SHARE`) and **D** (account role flags) are **deferred to their own specs**.
- **API-contract decision:** Optimize for future scalability/maintainability; breaking changes are acceptable. We deliberately standardize **every** collection endpoint onto one paginated envelope (one intentional break — see §6).

## 1. Motivation

The audit identified §3 as the highest-leverage *maintainability* area: the four transactional document services (`sales-invoices`, `purchase-bills`, `payments`, `journal`) plus `business-partners` are near-identical twins, with list/serialization/lifecycle logic copy-pasted 3–5×, 14 repeated idempotency decorator blocks, ~9 duplicated `P2002` catch blocks, and a scatter of dead code and quality nits. None of this is a correctness bug today, but it multiplies the cost and risk of every future change (one edit becomes five) and concentrates risk in untested copy-paste (e.g. all 12 `as unknown as Decimal` money casts).

This effort collapses the duplication into a small set of **tested seams**, removes verified-dead code, and unifies the list contract — without changing financial behavior.

## 2. Goals / Non-goals

**Goals**
- Remove all 7 grep-verified dead-code items.
- Replace the duplicated list / money-serialization / document-lifecycle / posting-helper / date logic with single tested seams.
- Compose `@IdempotentWrite()` to end OpenAPI/behavior drift across 14 handlers.
- Resolve the 10 code-quality nits (those not already subsumed by the seams above).
- Standardize **all** list endpoints onto the `{data,total,limit,offset}` envelope and the shared `SearchQueryDto`.
- Keep the full test suite (80 unit + 198 e2e) green at every commit; add a unit spec for each new seam.

**Non-goals (deferred to their own specs)**
- **Candidate C** — pushing closed-year/period TOCTOU checks inside the write transaction (`FOR SHARE` on period). Behavior-changing, financial risk, scale-gated.
- **Candidate D** — replacing by-code account coupling (`CASH_CODES`, `AR/AP_CONTROL_CODE`, `RETAINED_EARNINGS_CODE`) with account role flags. Behavior-changing; touches reconciliation.
- Any change to core modules the audit ruled "deep, leave them": `PostingService`, `Money`, soft-delete extension, `trigram-search` ranking math, `BalancesService`.

## 3. Design decisions

1. **Composition over inheritance for the document lifecycle.** Shared `void()`/reverse-guard and `deleteDraft()` logic lives in an injected `DocumentLifecycleService`, parameterized by model + posting hooks — not a base class the four services inherit. Rationale: a base class would force the services into a shared shape and make each harder to read/test in isolation; an injected helper keeps each document service thin and independently testable.
2. **One uniform list contract.** Rather than "4 enveloped lists + 2 bare arrays," every collection endpoint returns `{data,total,limit,offset}` via the same `listPaginated()` seam and accepts the shared `SearchQueryDto`. One pattern is more maintainable and scalable than two; the cost is a deliberate, documented breaking change to `accounts` and `tax-codes` (§6).
3. **Lean on existing infrastructure.** The global exception filter already maps `P2002`→409 (`all-exceptions.filter.ts:18`, tested). Duplicated catch blocks are replaced by a thin `mapUniqueViolation(e, msg?)` helper that preserves friendly domain-specific messages while deleting the boilerplate; pure-generic cases can drop the catch entirely.
4. **Distinct response schemas, shared base.** `sales-invoice` and `purchase-bill` response DTOs `extend` a shared `TransactionalDocumentResponseDto` but keep their distinct names — dedup the fields without collapsing two domain concepts into one ambiguous schema.

## 4. New shared units

Each unit has one purpose, a defined interface, and replaces N copies.

### 4.1 `listPaginated()` + pagination constants
- **Location:** `src/common/pagination/` (`pagination.constants.ts`, `list-paginated.ts`).
- **Interface:** `listPaginated(model, { q?, where?, present, orderBy?, limit?, offset? }) → { data, total, limit, offset }`.
- **Behavior:** applies `DEFAULT_PAGE_SIZE`/`MAX_LIMIT`; when `q` is present, delegates ranked-id selection + count to `trigram-search.ts`; otherwise a standard `findMany` + `count`. Soft-delete `deletedAt: null` is injected by the Prisma extension (not re-added). Maps rows through `present`.
- **Replaces:** `listPage()` ×5 (`sales-invoices.service.ts:191`, `purchase-bills.service.ts:195`, `payments.service.ts:195`, `journal.service.ts:190`, `business-partners.service.ts:74`); resolves nit #2 (limit drift) by sourcing limits from `pagination.constants.ts`.
- **Limit reconciliation (nit #2):** define `DEFAULT_PAGE_SIZE = 50` and `MAX_LIMIT = 200` as named constants. The outlier `audit-query.dto.ts:22` `@Max(500)` is reconciled to either `MAX_LIMIT` (preferred — one cap everywhere) or a separately-named `AUDIT_MAX_LIMIT` constant if a larger audit-export page is justified. No silent magic numbers remain; the plan picks one.

### 4.2 `serializeMoney(obj, fields)`
- **Location:** `src/common/money/serialize-money.ts`.
- **Interface:** returns a shallow copy with the named Decimal fields rendered to 4dp strings via `Money`.
- **Replaces:** `present()` money-serialization ×3 (sales ≡ purchase verbatim, payments) and **all 12 `as unknown as Decimal` casts** (nit #1). Routed through `Money` so no raw `.toFixed(4)` survives (nit #9).

### 4.3 `@IdempotentWrite()` (candidate E)
- **Location:** `src/common/idempotency/idempotent-write.decorator.ts`.
- **Interface:** `applyDecorators(Idempotent(), ApiHeader({ name: 'Idempotency-Key', ... }))`.
- **Replaces:** the `@Idempotent()` + `@ApiHeader` block repeated 14× across 6 controllers — structurally prevents the two from drifting apart.

### 4.4 `DocumentLifecycleService` (injected)
- **Location:** `src/invoicing/document-lifecycle.service.ts` (or `src/ledger/` if a more neutral home fits the module graph — settled in the plan).
- **Interface:** `reverseWithGuard(model, id, ctx, hooks)` and `softDeleteDraft(model, id, ctx)`, parameterized by model + posting hooks.
- **Replaces:** `void()`/reverse-with-race-guard ×3 (`sales:343`, `purchase:347`, `payments:431`) and `deleteDraft()` conditional soft-delete ×4 (`journal:94`, `sales:250`, `purchase:254`, `payments:261`). The intentional defense-in-depth `updateMany` `deletedAt` guards in `deleteDraft` are preserved.

### 4.5 Control-account + tax-line helpers
- Single `AR_CONTROL_CODE`/`AP_CONTROL_CODE` source (currently redeclared in 3 files) + one control-account lookup helper (×3).
- Shared `taxableLines()` mapper (`sales-invoices.service.ts:62` ≡ `purchase-bills.service.ts:64`).

### 4.6 Posting/number internals unify
- Unify `RawTxClient` (`posting.service.ts:26`) ≡ `RawTx` (`document-number.service.ts:4`) into one shared type.
- Unify `buildEntryRef` (`posting.service.ts:374`) ≡ `buildRef` (`document-number.service.ts:34`) into one util.
- Route inline `fiscalYearFor` reimplementations (`balance-sheet.service.ts:62`, `periods.service.ts:23`) to the public `PostingService.fiscalYearFor()`.

### 4.7 Date helpers
- **Location:** `src/common/dates/`.
- `truncateToUtcDay(date)` replacing UTC day-truncation duplicated 5× (`balances:60`, `aging:23`, `general-ledger:24`, `periods:72`, `cash-flow:86`).
- A reusable DTO `@Transform(...)→Date` (nit #6) replacing inline `new Date(dto.date)` (`sales-invoices.controller.ts:68`, `journal.controller.ts:50`); also replaces `q.post === 'true'` string-boolean with a transformed boolean query type (nit #4).

### 4.8 `mapUniqueViolation(e, msg?)`
- **Location:** `src/common/errors/` (beside `domain-errors.ts`).
- **Replaces:** the ~9 hand-rolled `P2002` try/catch blocks in services (`accounts` ×2, `posting`, `tax-codes` ×2, `sales-invoices`, `purchase-bills`, `business-partners`, `payments`, `users`, `company`). Preserves friendly domain messages; the `idempotency.service.ts` `P2002` path (the reserve race) is intentional and **kept** (nit #3).

### 4.9 Response DTOs
- `TransactionalDocumentResponseDto` base; `SalesInvoiceResponseDto` / `PurchaseBillResponseDto` extend it (twin DTOs differ by 3 fields, #144). Distinct schema names retained.
- Standardize bespoke `*ListQueryDto` onto the existing shared `SearchQueryDto` (nit #8).
- Settle reports naming drift (`reports.controller.ts:27` mixes `balanceSheetSvc` with `aging`/`cashFlow`) (nit #7).
- Contain the unavoidable `soft-delete.extension.ts` casts (`:64,71,93,100,198`) in one typed wrapper (nit #10).

### 4.10 Dead-code deletions (7)
`Money.lessThan()` (`money.ts:56`); `UsersService.findByEmail()` (`users.service.ts:63`, only consumer is a test — update/remove that test); `AccountBalanceRow.parentId` (`balances.service.ts:30,44,73,80,97`); the duplicate `ReportLine` interface (`income-statement.service.ts:9` / `balance-sheet.service.ts:9` — extract one shared definition); redundant manual `deletedAt: null` in `tax-codes.service.ts:107,114` (extension injects it; the `deleteDraft` defense-in-depth ones stay); test-only trigram exports (`trigram-search.ts:7,96,122`) made internal (candidate B) and the spec adjusted; the duplicate HTTP-method constant (`audit.interceptor.ts:14` / `audit-query.dto.ts:15`) consolidated to one source.

## 5. Finding → resolution traceability

| §3 finding | Resolved by |
|------------|-------------|
| Dead: `Money.lessThan`, `findByEmail`, `parentId`, dup `ReportLine`, redundant `deletedAt:null`, test-only trigram exports, dup HTTP-method const | §4.10 |
| Dup: `listPage()` ×5 | §4.1 |
| Dup: `present()` ×3 + 12 casts | §4.2 |
| Dup: `void()` ×3, `deleteDraft()` ×4 | §4.4 |
| Dup: control-account ×3 + redeclared codes; `taxableLines()` ×2 | §4.5 |
| Dup: `RawTx`/`RawTxClient`, `buildRef`/`buildEntryRef`, inline `fiscalYearFor` | §4.6 |
| Dup: UTC truncation ×5 | §4.7 |
| Dup: `@Idempotent`+`@ApiHeader` ×14 | §4.3 (candidate E) |
| Dup: twin response DTOs; list envelope rewritten 4–5× | §4.9, §4.1 |
| Deepening A (`listPaginated` + `serializeMoney`) | §4.1, §4.2 |
| Deepening B (trigram exports → internal) | §4.10 |
| Deepening C, D | **Deferred** (§2 Non-goals) |
| Nit 1 (casts) | §4.2 |
| Nit 2 (limit drift / hoist constants) | §4.1 |
| Nit 3 (`P2002` ×12) | §4.8 |
| Nit 4 (`post === 'true'`) | §4.7 |
| Nit 5 (unbounded `findMany`) | §6 (paginate via envelope) |
| Nit 6 (inline `new Date`) | §4.7 |
| Nit 7 (reports naming) | §4.9 |
| Nit 8 (`*ListQueryDto` standardize) | §4.9 |
| Nit 9 (raw `.toFixed(4)`) | §4.2 |
| Nit 10 (soft-delete casts) | §4.9 |

## 6. The one deliberate breaking change

`GET /v1/accounts` and `GET /v1/tax-codes` currently return **bare arrays** (intentional, per prior design). To achieve one uniform list contract they will return the `{data,total,limit,offset}` envelope like every other collection endpoint, accepting `SearchQueryDto`.

**Downstream coordination (explicit, not silent):**
- Re-run `npm run openapi:export`; commit the regenerated `docs/api/openapi.json`.
- Update the OpenAPI/typed-response guard test (`src/common/openapi/openapi-contract.spec.ts`) expectations.
- Update `docs/api/frontend-guide.md` (the "bare-array lists" note).
- Flag the matching unwrap change for the sibling `accounting-client` repo as a follow-up task (out of this repo's scope, but recorded so it is not missed).

## 7. Execution approach & sequencing

Single branch `refactor/architecture-cleanup`, grouped commits, full suite green after each:

1. **Seams first (with unit tests):** `pagination.constants` + `listPaginated`, `serializeMoney`, `@IdempotentWrite`, date helpers, `mapUniqueViolation`, `DocumentLifecycleService`, posting/number unifications, control-account/tax-line helpers, response-DTO base.
2. **Migrate consumers** one module at a time onto the seams (transactional services, then partners, then accounts/tax-codes for the envelope change), running unit + e2e after each module.
3. **Standardize list contract** (the §6 break) + regenerate OpenAPI + update guard test + docs.
4. **Delete dead code** last, once all references are gone.

## 8. Verification & testing strategy

- The existing **80 unit + 198 e2e** suite is the behavioral contract for all behavior-preserving work: it must be green after every commit.
- Each new seam (§4.1–§4.8) gets a dedicated unit spec — it becomes a single point of failure and must be independently tested.
- The OpenAPI contract test must pass; for the §6 break, its expectations are updated in the same commit as the regenerated `openapi.json`.
- `tsc --noEmit` (typecheck) and `lint:ci` clean before finishing (note: run `prisma generate` first if the generated client is stale).
- Final full-suite run + OpenAPI export before the branch is considered done.

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| `listPaginated` must compose with raw-SQL trigram search correctly | Cover both the `q`-present (ranked) and `q`-absent paths in the seam's unit spec; e2e search tests already exercise the endpoints |
| Extracting `void()`/`deleteDraft()` could subtly change transaction/posting semantics | Composition (not inheritance); keep the defense-in-depth `updateMany` guards; rely on existing e2e for reversal/void/delete paths; add characterization tests where coverage is thin before extracting |
| Deleting `P2002` catches could coarsen error messages | `mapUniqueViolation(e, msg?)` preserves domain-specific messages; status stays 409 |
| §6 break ripples to the frontend | Explicitly tracked as a coordination follow-up; OpenAPI + guard + docs updated in-repo |
| Stale generated Prisma client surfaces phantom type errors | `prisma generate` before typecheck (known gotcha) |

## 10. Out of scope

Candidates **C** and **D** (financial-behavior changes), and any change to the core modules the audit ruled deep. Each deferred item gets its own brainstorm → spec → plan cycle.
