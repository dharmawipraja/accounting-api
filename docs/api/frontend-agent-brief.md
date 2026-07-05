# Frontend Agent Brief — Indonesian Accounting API

> Copy this file into the **frontend repo root** as `AGENTS.md` (or `CLAUDE.md`).
> It tells an AI coding agent how to build a correct client for this API.

## Goal

Build a frontend for a **single-company Indonesian accounting API** (NestJS + Prisma +
PostgreSQL; Indonesian GAAP / SAK). Covers chart of accounts, journals, AR/AP
(sales invoices, purchase bills, payments), tax (PPN/PPh), financial reports, and
period / year-end close.

## Sources of truth (use these, don't guess)

1. **`openapi.json`** (committed in the API repo at `docs/api/openapi.json`) — the
   request **and response** **schemas**. **Every 2xx response body is now fully typed**
   (entity shapes are `*ResponseDto`, computed/report shapes are `*Dto`), so generating
   a typed client (e.g. `openapi-typescript`, `orval`) gives you **response** types too,
   not just request types — import them everywhere; don't hand-write any shape. Two
   schema conventions to know: money fields are **strings** even in responses (4dp), and
   soft-delete columns (`deletedAt`/`deletedBy`) are **omitted** from response schemas.
2. **`frontend-guide.md`** (same folder) — the **conventions, role matrix, lifecycles,
   and glossary**. Read it before writing client code; it explains the things OpenAPI
   can't (auth/refresh, money format, error envelope, soft-delete, draft→post flow).

When the two disagree about a *shape*, OpenAPI wins. For *behavior* (auth, roles,
lifecycles, money), follow the guide.

## Non-negotiable rules

1. **Money = 4-decimal strings.** Every monetary field is a string like
   `"2000000.0000"`. Use a **decimal library** (decimal.js / big.js / dinero.js) for
   all arithmetic; **never `parseFloat`/`Number()`** a money value. Send money as 4dp
   strings too. Format to rupiah only for display.
2. **Errors are an envelope:** `{ code, message, details?, traceId? }` on every 4xx/5xx.
   **Branch on `code`, not `message`.** Render `details.errors[]` as inline field
   errors. Surface `traceId` on error screens (it equals the `X-Request-Id` header).
   Respect the status taxonomy — especially **400 = bad request shape** vs
   **422 = domain-rule violation** (e.g. `UNBALANCED_ENTRY`).
3. **Auth = `Authorization: Bearer <accessToken>`.** Access token ~15m, refresh ~7d.
   On **401**, call `POST /auth/refresh { refreshToken }` for a fresh pair and retry
   once; if refresh fails, go to login. Call `POST /auth/logout { refreshToken }` to
   revoke the current device's refresh token server-side; call `POST /auth/logout-all`
   (authenticated) to revoke all sessions. Always discard tokens client-side too.
   On **429**, back off.
4. **Respect the role matrix** (VIEWER / ACCOUNTANT / APPROVER / ADMIN; see the guide).
   Reads are open to any authenticated user. Hide/disable actions a role can't do —
   **but still handle `403 FORBIDDEN` and `403 SEGREGATION_OF_DUTIES`** on every
   mutation (the creator of a document may be barred from posting it themselves).
5. **Dates are `YYYY-MM-DD`** (date-only). Reports use `?asOf=` (balance sheet, aging,
   trial balance) or `?from=&to=` (income statement, cash flow, general ledger).
6. **All business calls go under `/v1`.** Every endpoint except the operational probes
   (`/health`, `/ready`, `/metrics`) is served at `/v1/...` (e.g.
   `POST /v1/sales-invoices`, `GET /v1/ledger/accounts`). Do not call the un-prefixed
   business paths — they 404.
7. **Covered write endpoints require `Idempotency-Key`.** Pass a unique UUID header on
   every call to: invoice/bill/payment `create`/`:id/post`/`:id/void`, year-end close,
   journal create/post/reverse, and opening-balances. Store the key before sending so
   you can replay the same key on retry without changing the body. A missing key →
   `422`; same key + different body/endpoint → `422`; in-flight → `409`.
   (Partners/accounts/tax-codes creates are NOT covered — their unique `code` handles
   deduplication.)
8. **Pagination is mixed.** Seven list endpoints return the envelope
   `{ data, total, limit, offset }` (limit default 50, max 200) — **read `.data`**:
   `GET /v1/partners`, `GET /v1/sales-invoices`, `GET /v1/purchase-bills`,
   `GET /v1/payments`, `GET /v1/ledger/journal-entries`, and — **newly enveloped**
   `GET /v1/ledger/accounts`, `GET /v1/tax/codes`. The remaining lists return a
   **bare array** (no `.data`): `GET /v1/ledger/periods`, `GET /v1/audit`.
   > ⚠️ **Breaking change — action required.** `accounts` and `tax/codes` used to be
   > bare arrays; they are now enveloped. Unwrap `.data` for them (the other five were
   > always enveloped). This is the only list-shape change.
9. **Soft-delete → 404.** Deleting/deactivating makes a resource 404 and removes it
   from lists; unique codes are reusable afterward. Don't treat that 404 as a crash.
10. **Draft → post approval flow.** Documents (journals, invoices, bills, payments) are
    created as drafts by ACCOUNTANT+, then **posted by APPROVER/ADMIN**. Build an
    approval queue (e.g. `GET /v1/ledger/journal-entries?status=DRAFT`).
11. **Server-side search (`?q=`).** Five lists accept an optional `?q=` (case-insensitive
    partial + trigram fuzzy, combines with other filters via AND, `total` is the filtered
    count): `GET /v1/partners` (name/code/npwp/email), `/v1/sales-invoices` &
    `/v1/purchase-bills` & `/v1/payments` (own ref fields + partner name+code),
    `/v1/ledger/journal-entries` (entryRef/description). Send `q` to the server — don't
    filter the current page client-side (search spans the whole dataset). `<2` chars is
    ignored. Accounts/tax-codes have **no** `?q=` (small sets — filter client-side).
12. **Journal-entry preview.** `POST /v1/journal-entries/preview` returns the exact
    balanced debit/credit entry a document *would* post — read-only, **no
    `Idempotency-Key`**, any authenticated user. Body is discriminated by `nature`:
    `SALE`/`PURCHASE` use the `/tax/calculate` shape (`settlementAccountId` + `lines`);
    `PAYMENT` uses `{ direction, cashAccountId, allocations }`. Response is
    `{ lines:[{accountId,accountCode,accountName,debit,credit}], totalDebit, totalCredit,
    balanced }` (4dp strings, inactive side `"0.0000"`). Use it for a live preview panel
    in the document editor; it validates like a real post (same `422`s) but writes nothing.

## Do / Don't

**Do**
- Generate and commit a typed client from `openapi.json`; regenerate when the API changes.
- Centralize fetch in one wrapper (auth header, 401-refresh, 429 backoff, envelope parsing).
- Keep money as decimal strings end-to-end; format only at the view layer.
- Gate UI by role from `GET /auth/me`, and still handle server 403s.

**Don't**
- Don't `parseFloat` money. Don't do float math on amounts.
- Don't call business endpoints without the `/v1` prefix — they 404.
- Don't assume `/docs` (Swagger UI) exists in production — it's gated behind
  `ENABLE_SWAGGER` there. Rely on the committed `openapi.json`.
- Don't omit `Idempotency-Key` on covered writes (invoice/bill/payment create/post/void,
  year-end close, journal/opening-balances) — the API returns `422` without it.
- Don't read a list response body as a bare array for the seven enveloped endpoints
  (`/v1/partners`, `/v1/sales-invoices`, `/v1/purchase-bills`, `/v1/payments`,
  `/v1/ledger/journal-entries`, `/v1/ledger/accounts`, `/v1/tax/codes`) — iterate
  `.data`, not the root.
- Don't expect a pagination envelope on periods/audit, or that a creator can self-approve.
- Don't rely on nested `lines` (invoices/bills) or `allocations` (payments) in **list**
  responses — they're **detail-only** (present on single-resource GET/POST, omitted from
  lists; optional in the schema).
- Don't branch on `message` strings — branch on `code`.

## Regenerating `openapi.json`

The committed spec lives at `docs/api/openapi.json` in the **API repo**. To refresh it,
run in that repo:

```bash
npm run openapi:export
```

(builds the app and writes the OpenAPI document). Re-run your client codegen against
the updated file afterward.
