# Design: Typed Response Schemas for `openapi.json`

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Scope:** Document-only. No runtime behavior changes, no Prisma/migration changes, no new endpoints.

## Problem

`docs/api/openapi.json` documents request bodies well (26 request DTO schemas) but is
almost entirely missing **response** shapes. Of 71 success (2xx) responses across 51
paths, only **4** carry a real typed body — all `TokenPairDto` from auth. The other
**67** return either no `content` schema at all or a useless bare `{ "type": "object" }`.

### Root cause

The NestJS Swagger CLI plugin can only introspect decorated **DTO classes**. Every
resource controller returns one of:

- A Prisma type — e.g. `list(): Promise<Account[]>`, `get(): Promise<Account>` — which
  is a plain TypeScript type the plugin cannot read → emitted as *no content*.
- An inline plain object or an exported `interface` (reports, trial-balance, tax-calc,
  invoices) → emitted as bare `{ "type": "object" }`.

Only `src/auth/auth.controller.ts` uses `@ApiOkResponse({ type: TokenPairDto })` against
a real decorated class, which is why those endpoints alone are typed.

### Important subtlety: responses are not Prisma models

The serialized response shape deliberately differs from the Prisma model. We must
document the **serialized output**, not the entity:

- **Money** runs through `present()` / `.toFixed(4)` and Prisma `Decimal` serializes as a
  **string at 4 decimal places** (e.g. `"1000.0000"`), never a JS number.
- **Soft-delete fields** (`deletedAt`, `deletedBy`) are stripped from responses.
- **Computed fields** are added by `present()` — e.g. sales invoices gain `outstanding`
  and `paymentStatus`.
- **Envelopes:** the journal-entries list is the *only* enveloped list
  (`{ data, total, limit, offset }`); every other list is a bare array; `/audit` is a
  bare array.

## Goal

Add accurate, named response schemas for **every endpoint** so `openapi.json` is a
complete contract a future frontend can code-generate against.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mechanism | Decorated response DTO classes + `@ApiOkResponse/@ApiCreatedResponse({ type })` | Idiomatic NestJS; contract lives in code, type-checked against controller return types; the existing `auth.controller` already follows this pattern. |
| Runtime impact | **Document only** — no `ClassSerializerInterceptor` | Services already shape output deliberately and that shaping is locked down by 147 e2e tests; that tested output is the source of truth. No frontend consumes the API yet, so no consumer needs a runtime guarantee. Enforcement would mean re-plumbing working, tested serialization for no current benefit. |
| Accuracy | Derive/verify each DTO against the **real e2e response payload** | Borrows the one strength of auto-generation (matches reality) without sacrificing named, readable schemas. |
| List envelope | One **concrete** `JournalEntryListResponseDto`, not a generic `Paginated<T>` | Swagger generics need `getSchemaPath` + `allOf` indirection; with exactly one envelope it is not worth the noise. |
| Money fields | A shared `@ApiMoney()` decorator wrapping `@ApiProperty({ type: String, example: '1000.0000', … })` | ~60 money fields stay consistent and self-describing as 4-dp decimal strings. |

## Architecture

### File layout

- **Per-feature response DTOs** co-locate in the existing `dto/` folders next to request
  DTOs, e.g. `src/ledger/accounts/dto/account-response.dto.ts`.
- **Shared pieces** live in `src/common/openapi/`:
  - `openapi.models.ts` — already holds `ErrorEnvelopeDto`, `TokenPairDto`.
  - `api-money.decorator.ts` (new) — the `@ApiMoney()` helper.

### Controller wiring

Each controller method gains the matching decorator:

- `@ApiOkResponse({ type: X })` for 200 GET/POST-action responses.
- `@ApiOkResponse({ type: X, isArray: true })` for bare-array lists.
- `@ApiCreatedResponse({ type: X })` for 201 creates.
- `@ApiNoContentResponse()` for 204 deletes (no body).
- `@ApiExtraModels(...)` where a nested-only model must be referenced.

## Response DTOs (~26 classes)

Each mirrors the **serialized** shape (money→string, soft-delete fields omitted, computed
fields included).

### Ledger
- `AccountResponseDto` — list (array), get, create, update, deactivate.
- `AccountBalanceDto` — `GET /ledger/accounts/{id}/balance`.
- `FiscalPeriodResponseDto` — periods list/generate/close/reopen.
- `JournalLineResponseDto` — nested line (money fields as strings).
- `JournalEntryResponseDto` — get/create/post/reverse (+ nested lines, `totalDebit`).
- `JournalEntryListItemDto` + `JournalEntryListResponseDto` — the enveloped list
  `{ data, total, limit, offset }`.
- `TrialBalanceDto` — currently a bare object.

### Tax
- `TaxCodeResponseDto` — `rate` as string.
- `TaxCalculationDto` — `POST /tax/calculate` result.

### Invoicing / AR-AP
- `BusinessPartnerResponseDto`.
- `SalesInvoiceLineResponseDto` (nested) + `SalesInvoiceResponseDto`
  (+ `outstanding`, `paymentStatus`).
- `PurchaseBillLineResponseDto` (nested) + `PurchaseBillResponseDto`
  (+ outstanding/status).
- `PaymentResponseDto` (+ nested allocations).

### Reports
Convert the existing exported `interface`s (`ReportLine`, `ReportGroup`, `CashFlowLine`)
into decorated classes the plugin can read:
- `BalanceSheetDto`, `IncomeStatementDto`, `GeneralLedgerDto`, `AgingReportDto`,
  `CashFlowDto`.

### Misc
- `CompanySettingsDto` — `GET/PATCH /company/settings`.
- `AuditEntryDto` — `GET /audit` (bare array via `isArray: true`).
- `AuthenticatedUserDto` — `GET /auth/me`.
- Health/ready status object — minimal.

## Judgment calls (approved)

1. **204 deletes** → `@ApiNoContentResponse()`, no body (they return nothing).
2. **`/metrics`** → documented as `text/plain` Prometheus string, not JSON. Low value;
   minimal treatment.
3. **Reports' nested lines** get their own small DTO classes rather than inline objects,
   so they `$ref` cleanly.

## Regression safety net (new)

Add a guard test (unit or e2e) that loads the freshly exported `openapi.json` and asserts
**every 2xx response has a non-empty body schema**, except a small whitelist of
legitimately body-less responses (204 deletes, `/health`, `/ready`, and `text/plain`
`/metrics`). A future endpoint added without a response type fails CI.

The assertion is the inverse of the diagnostic that found this gap: walk
`paths[*][method].responses[2xx]`; for each non-whitelisted entry require
`content['application/json'].schema` to exist and not equal `{ "type": "object" }`.

## Verification

- Regenerate the doc: `npm run openapi:export` (builds, then exports DB-free in preview
  mode).
- Run the full verify gate: 38 unit + 147 e2e. All must stay green — we only added
  decorators and otherwise-unused DTO classes, so runtime behavior is unchanged.
- Spot-check several regenerated schemas against the asserting e2e payloads (money as
  4-dp strings, no `deletedAt`/`deletedBy`, computed fields present, journal-list
  enveloped, `/audit` bare array).

## Out of scope

- Runtime serialization enforcement (`ClassSerializerInterceptor`).
- Any Prisma schema or migration change.
- New endpoints or any change to response *behavior*.
- Re-formatting `/metrics` output (only labeling it `text/plain`).

## Affected areas (for the plan)

- New: `src/common/openapi/api-money.decorator.ts`; ~26 `*-response.dto.ts` files across
  feature `dto/` folders.
- Edited: ~13 controllers (response decorators) — auth, company, accounts, periods,
  journal, tax-codes, tax, partners, sales-invoices, purchase-bills, payments, reports,
  audit, plus health/metrics.
- New: one guard test.
- Regenerated: `docs/api/openapi.json`.
- Possibly cross-linked: `docs/api/frontend-guide.md` (where it hand-describes response
  shapes that are now formally in the spec).
