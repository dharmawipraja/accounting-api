# Frontend Integration Guide — Indonesian Accounting API

This guide is the prose companion to [`openapi.json`](./openapi.json) (in this same
folder). The OpenAPI document carries the request/response **schemas**; this guide
carries the **conventions, role rules, lifecycles, and glossary** you need to build
a correct frontend. Everything here is derived from the API source code.

- Schemas / types → `openapi.json` (generate a typed client from it). Every 2xx response body is now fully typed under `components.schemas` as `*ResponseDto` / `*Dto` entries.
- Conventions / roles / lifecycles / glossary → this file.

---

## 1. Overview & authentication

This is a **single-company** Indonesian accounting API. It follows Indonesian GAAP
(SAK / PSAK): a SAK-aligned chart of accounts, monthly accounting periods per fiscal
year, PPN (VAT) and PPh (withholding) tax handling, and the standard financial
statements (Neraca / balance sheet, Laba Rugi / income statement, Buku Besar /
general ledger, Arus Kas / cash flow).

### Base path

All business endpoints are served under **`/v1`** (e.g. `POST /v1/sales-invoices`,
`GET /v1/ledger/accounts`). Operational probes (`/health`, `/ready`, `/metrics`) stay
**unprefixed** — they are version-neutral.

### Interactive docs

- An OpenAPI document is committed at `docs/api/openapi.json`.
- A live **Swagger UI is mounted at `/docs`** in every non-production environment.
  In production it is **off by default** and only served when `ENABLE_SWAGGER=true`.
  Do not assume `/docs` exists in prod — rely on the committed `openapi.json`.

### Login & tokens

```
POST /auth/login      { "email": "...", "password": "..." }
  → 200 { "accessToken": "<jwt>", "refreshToken": "<jwt>" }
```

- Send the access token on every authenticated request:
  `Authorization: Bearer <accessToken>`.
- **Access tokens are short-lived** (~15 minutes; exact TTL is the server's
  `JWT_ACCESS_TTL`). **Refresh tokens last ~7 days** (`JWT_REFRESH_TTL`).
- On a **401** (expired/invalid access token), call:

  ```
  POST /auth/refresh   { "refreshToken": "<refreshToken>" }
    → 200 { "accessToken": "...", "refreshToken": "..." }
  ```

  This returns a **fresh pair**. Persist both and retry the original request once.
  If refresh itself fails (401), the session is over → send the user back to login.
- `GET /auth/me` → `{ id, email, role }` for the currently authenticated user. Use
  this on app load to hydrate the user and drive role-gated UI.
- **Server-side logout is supported.** Call `POST /auth/logout { "refreshToken": "..." }` to revoke the current device's refresh token family (public endpoint, throttled). Call `POST /auth/logout-all` (authenticated) to revoke all sessions for the current user. On logout, also discard both tokens client-side.

### Rate limiting (throttle)

The API is rate-limited. Authenticated requests are budgeted **per user**, anonymous
auth endpoints **per IP**.

| Scope | Limit | Keyed by |
|---|---|---|
| `POST /auth/login` | 10 / min | IP |
| `POST /auth/refresh` | 30 / min | IP |
| All other endpoints | 300 / min | authenticated user |

(Defaults; operators can override via `THROTTLE_LOGIN_LIMIT` / `THROTTLE_REFRESH_LIMIT`
/ `THROTTLE_LIMIT`. Health/readiness/metrics probes are not throttled.)

On a **429**, back off and retry later (respect any `Retry-After`). Never hammer
`/auth/login` — it has the tightest budget.

---

## 2. Conventions

### Error envelope

**Every** 4xx/5xx response has this exact JSON shape:

```json
{
  "code": "NOT_FOUND",
  "message": "Resource not found",
  "details": { "errors": ["email must be an email"] },
  "traceId": "..."
}
```

- `code` — stable, machine-readable string. **Branch on this, not on `message`.**
- `message` — human-readable; safe to surface to users as a fallback.
- `details` — optional structured payload. For request-validation failures it is
  `{ "errors": [ ...per-field messages... ] }` (the class-validator messages) — use
  it to render inline field errors.
- `traceId` — optional correlation id; see [traceId](#traceid) below.

### Status taxonomy

| Status | Meaning | Typical `code` values |
|---|---|---|
| 200 / 201 | Success | — |
| **400** | **Input shape / validation** — malformed body, query, or path param (`ValidationPipe`, `ParseUUIDPipe`, `ParseIntPipe`, bad JSON) | `HTTP_400`, `INVALID_INPUT` |
| **401** | Missing / expired / invalid token | `UNAUTHORIZED`, `HTTP_401` |
| **403** | Wrong role, or Segregation-of-Duties block | `FORBIDDEN`, `SEGREGATION_OF_DUTIES` |
| **404** | Resource not found (incl. soft-deleted) | `NOT_FOUND` |
| **409** | Conflict / closed period / closed year / unique violation | `CONFLICT`, `CLOSED_PERIOD`, `CLOSED_YEAR` |
| **422** | **Domain-rule violation** — request was well-formed but breaks an accounting rule | `VALIDATION_FAILED`, `UNBALANCED_ENTRY`, `INVALID_ACCOUNT` |
| **429** | Rate-limited | (throttler) |
| 500 | Unexpected server error | `INTERNAL_ERROR` |

#### 400 vs 422 — the important split

- **400** = the request is *shaped* wrong. A field is missing, the wrong type, a
  malformed UUID, a non-numeric `fiscalYear`, etc. Fix the payload and the same
  request will be accepted. The frontend should usually have caught these client-side.
- **422** = the request is *well-formed* but breaks an **accounting rule**. Examples:
  a journal entry whose debits ≠ credits (`UNBALANCED_ENTRY`), posting to a
  non-postable / invalid account (`INVALID_ACCOUNT`), a report range where
  `from > to` (`VALIDATION_FAILED`). These are domain errors the user must resolve
  by changing *what* they are doing, not the request format.

#### Domain error codes (from the source)

These are the typed domain errors the API raises (`src/common/errors/domain-errors.ts`):

| `code` | HTTP | When |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Generic domain-rule violation (e.g. report `from > to`) |
| `UNBALANCED_ENTRY` | 422 | Journal debits ≠ credits |
| `INVALID_ACCOUNT` | 422 | Account missing / non-postable / wrong type for the operation |
| `NOT_FOUND` | 404 | Entity does not exist (or is soft-deleted) |
| `CONFLICT` | 409 | Generic conflict / unique violation |
| `CLOSED_PERIOD` | 409 | Posting into a closed monthly period |
| `CLOSED_YEAR` | 409 | Posting into a closed fiscal year |
| `UNAUTHORIZED` | 401 | Auth failure raised in the domain layer |
| `FORBIDDEN` | 403 | Role not permitted for the operation |
| `SEGREGATION_OF_DUTIES` | 403 | Same user tried to both create and approve/post (see SoD) |

Prisma-level failures are normalized too: a unique conflict surfaces as `409 CONFLICT`,
a missing row as `404 NOT_FOUND`, malformed input as `400 INVALID_INPUT`.

### Money

**Every monetary field is a JSON string with exactly 4 decimal places**, e.g.
`"2000000.0000"`. This is the persistence format of the server's `Money` value
object (`decimal.js`, `toFixed(4)`, `ROUND_HALF_UP` — matching Indonesian Faktur
Pajak rounding).

- **Never `parseFloat`/`Number()` a money string for arithmetic.** Floats lose
  precision and will break reconciliation. Use a decimal library
  (`decimal.js`, `big.js`, `dinero.js`, …) on the frontend too.
- Send money **as 4dp strings** in request bodies as well.
- For display, format to rupiah (e.g. `Rp 2.000.000`) — but keep the raw 4dp string
  as the source of truth for any math.

### Response shapes

**Every 2xx response body is fully typed** in `openapi.json` under
`components.schemas`, so a generated client gives you response types, not just request
types. The conventions the schemas encode (rely on these):

- **Naming:** entity responses are `*ResponseDto` (e.g. `AccountResponseDto`,
  `SalesInvoiceResponseDto`); computed / report shapes are `*Dto` (e.g.
  `TrialBalanceDto`, `BalanceSheetDto`, `TaxCalculationDto`). A per-domain index is in
  §6 ([Response schema quick-map](#response-schema-quick-map)).
- **Money stays a string in responses too** (same 4dp rule as above) — including nested
  line `quantity`, `unitPrice`, and `amount`. Never `Number()` them.
- **Soft-delete bookkeeping is omitted.** `deletedAt` / `deletedBy` are intentionally
  absent from every response schema (a row you can read is, by definition, live).
- **Computed fields** appear on documents beyond their stored columns: sales invoices
  and purchase bills carry `outstanding` (= `total − amountPaid`) and `paymentStatus`
  (`UNPAID | PARTIAL | PAID`).
- **Nested collections are detail-only.** Invoice/bill `lines` and payment
  `allocations` are present on single-resource `GET`/`POST` responses but **omitted from
  list responses** (optional in the schema) — don't depend on them when rendering lists.
- **`DELETE` returns `204 No Content`** (empty body). The enveloped-vs-bare-array
  distinction for lists is covered next.

### Idempotency

Several write endpoints require an **`Idempotency-Key`** request header to make
retries safe. The key must be a unique string per logical request (a UUID is
recommended). The covered endpoints are:

- **Invoice/bill/payment:** `POST /v1/sales-invoices`, `POST /v1/sales-invoices/:id/post`,
  `POST /v1/sales-invoices/:id/void`, `POST /v1/purchase-bills`,
  `POST /v1/purchase-bills/:id/post`, `POST /v1/purchase-bills/:id/void`,
  `POST /v1/payments`, `POST /v1/payments/:id/post`, `POST /v1/payments/:id/void`.
- **Journals & opening balances:** `POST /v1/ledger/journal-entries`,
  `POST /v1/ledger/journal-entries/:id/post`,
  `POST /v1/ledger/journal-entries/:id/reverse`,
  `POST /v1/ledger/opening-balances`.
- **Year-end close:** `POST /v1/close/year-end`.

Behavior:
- **Replay** — a repeated call with the same key and identical body returns the
  original response (201/200) without re-executing the write. Safe to retry.
- **Retry after a timeout (408) or network failure — reuse the SAME key.** A
  408 does *not* mean the write failed: the server may still finish it after
  responding. Retrying with the same key is always safe (you get a replay, or
  a `409` while it's still running — back off and retry the same key). Retrying
  with a *new* key can create a duplicate invoice/payment.
- **Keys are scoped per user** — two different users may use the same key
  independently; a key never replays another user's response.
- **Body/endpoint mismatch** — same key with a different request body or a different
  endpoint → **`422 VALIDATION_FAILED`**.
- **In-flight** — same key while the first request is still being processed →
  **`409 CONFLICT`**.
- **Missing header** — omitting `Idempotency-Key` on a covered endpoint →
  **`422 VALIDATION_FAILED`**.

> **Not covered:** `POST /v1/partners`, `POST /v1/ledger/accounts`,
> `POST /v1/tax/codes` — these are already idempotent by virtue of their unique
> `code` constraint (duplicate → `409 CONFLICT`). `POST /v1/ledger/periods/generate`
> and non-create mutations (`PATCH`, `DELETE`, `*/deactivate`, `*/reopen`) are also
> not covered.

### Pagination

Pagination is **not uniform** — check per endpoint:

- **`GET /v1/ledger/journal-entries` and the four transactional lists are enveloped:**

  ```json
  { "data": [ ... ], "total": 123, "limit": 50, "offset": 0 }
  ```

  `limit` default **50**, **max 200**; `offset` default 0.

  The **enveloped** endpoints are:
  - `GET /v1/ledger/journal-entries` (filters: `q, status, sourceType, fiscalYear, from, to, limit, offset`)
  - `GET /v1/partners` (filters: `q, limit, offset`)
  - `GET /v1/sales-invoices` (filters: `q, partnerId, status, limit, offset`)
  - `GET /v1/purchase-bills` (filters: `q, partnerId, status, limit, offset`)
  - `GET /v1/payments` (filters: `q, partnerId, direction, status, limit, offset`)

  Read items from the `.data` array on these responses.

- **`GET /v1/ledger/accounts` and `GET /v1/tax/codes`** now return the standard
  `{ data, total, limit, offset }` envelope (same as every other paginated list).
  Read items from `.data`. Both accept `?limit` / `?offset` query params.

  > ⚠️ **Breaking change — FE client action required.** These two endpoints
  > previously returned a **bare JSON array**; they now return the `{ data, … }`
  > envelope. A frontend built before this change reads the response as an array
  > directly and will break. **Fix:** unwrap `.data` for `GET /v1/ledger/accounts`
  > and `GET /v1/tax/codes` (the other lists above were always enveloped). This is
  > the only list-shape change; no other endpoint's response shape changed.

- **Other bare-array list endpoints** — including `GET /v1/audit`, `GET /v1/ledger/periods`
  — return a **bare JSON array** (no envelope). `GET /v1/audit` still accepts
  `limit`/`offset` query params (limit default 50, max 200), but its response body
  is a bare array.

### Search (`?q=`)

Five list endpoints accept an optional **`?q=`** free-text search — **case-insensitive
partial match (ILIKE) + trigram fuzzy ranking**. It **combines with the other filters
(AND)**, and the envelope's `total` reflects the **filtered** count, so it drives
pagination correctly. Search spans the **whole filtered dataset**, not just the current
page — send `q` to the server, don't filter the current page client-side. A `q` shorter
than **2 characters** (after trimming) is ignored (the normal list is returned).

| Endpoint | `q` matches |
|---|---|
| `GET /v1/partners` | partner `name`, `code`, `npwp`, `email` |
| `GET /v1/sales-invoices` | `invoiceRef`, `description`, **customer** `name` + `code` |
| `GET /v1/purchase-bills` | `billRef`, `vendorInvoiceNo`, `description`, **vendor** `name` + `code` |
| `GET /v1/payments` | `ref`, `description`, **partner** `name` + `code` |
| `GET /v1/ledger/journal-entries` | `entryRef`, `description` |

`GET /v1/ledger/accounts`, `GET /v1/tax/codes`, `GET /v1/ledger/periods`, and
`GET /v1/audit` do **not** support `?q=` (accounts and tax-codes are small bounded sets
— fetch and filter them client-side).

### Dates

- Accounting dates are **date-only**, `YYYY-MM-DD` (no time component). Send them as
  `YYYY-MM-DD` strings.
- Report query parameters:
  - `?asOf=YYYY-MM-DD` — **balance sheet**, **AR/AP aging**, **trial balance**,
    account balance. Defaults to "today" if omitted.
  - `?from=YYYY-MM-DD&to=YYYY-MM-DD` — **income statement**, **cash flow**,
    **general ledger**. `from` must be on or before `to` (else `422 VALIDATION_FAILED`).
- Periods are **monthly**, grouped by fiscal year (an integer like `2026`).

### traceId

The **`X-Request-Id` response header** equals the error envelope's `traceId`.
Capture it and surface it on error screens ("Reference: `<traceId>`") so support /
operators can correlate the client error with server logs.

### Soft-delete

`DELETE` and the `*/deactivate` actions are **soft deletes**, not hard removals:

- After deletion the resource returns **404** and **disappears from list endpoints**.
- Unique codes (account code, tax code, partner code) are **tombstoned and become
  reusable** — you can create a new record with the same code afterward.
- Treat a 404 on a previously-known id as "it was deleted", not necessarily a bug.

---

## 3. Role matrix

Four roles exist: **VIEWER, ACCOUNTANT, APPROVER, ADMIN**.

**All read (`GET`) endpoints are available to any authenticated user**, including
VIEWER — reads carry no `@Roles` restriction. `POST /v1/tax/calculate` and
`POST /v1/journal-entries/preview` are pure, read-only previews and are likewise
available to any authenticated user. The table below therefore
lists only the **mutating / privileged** endpoints, where the role actually gates
access. All paths below are under `/v1` (e.g. `POST /partners` means
`POST /v1/partners`).

A "✓" means that role is allowed. `403 FORBIDDEN` is returned otherwise.

| Endpoint (mutation) | VIEWER | ACCOUNTANT | APPROVER | ADMIN |
|---|:--:|:--:|:--:|:--:|
| Create / update **accounts** (`POST /ledger/accounts`, `PATCH /ledger/accounts/:id`) | | ✓ | ✓ | ✓ |
| Deactivate / delete **account** (`POST /ledger/accounts/:id/deactivate`, `DELETE /ledger/accounts/:id`) | | | | ✓ |
| Create / update **partners** (`POST /partners`, `PATCH /partners/:id`) | | ✓ | ✓ | ✓ |
| Deactivate / delete **partner** (`POST /partners/:id/deactivate`, `DELETE /partners/:id`) | | | | ✓ |
| Create / update **tax codes** (`POST /tax/codes`, `PATCH /tax/codes/:id`) | | ✓ | ✓ | ✓ |
| Deactivate / delete **tax code** (`POST /tax/codes/:id/deactivate`, `DELETE /tax/codes/:id`) | | | | ✓ |
| Create / update **sales invoice** (`POST /sales-invoices`, `PATCH /sales-invoices/:id`) | | ✓ | ✓ | ✓ |
| Delete draft **sales invoice** (`DELETE /sales-invoices/:id`) | | ✓ | ✓ | ✓ |
| Post / void **sales invoice** (`POST /sales-invoices/:id/post`, `POST /sales-invoices/:id/void`) | | | ✓ | ✓ |
| Create / update **purchase bill** (`POST /purchase-bills`, `PATCH /purchase-bills/:id`) | | ✓ | ✓ | ✓ |
| Delete draft **purchase bill** (`DELETE /purchase-bills/:id`) | | ✓ | ✓ | ✓ |
| Post / void **purchase bill** (`POST /purchase-bills/:id/post`, `POST /purchase-bills/:id/void`) | | | ✓ | ✓ |
| Create **payment** (`POST /payments`) | | ✓ | ✓ | ✓ |
| Delete draft **payment** (`DELETE /payments/:id`) | | ✓ | ✓ | ✓ |
| Post / void **payment** (`POST /payments/:id/post`, `POST /payments/:id/void`) | | | ✓ | ✓ |
| Create draft / delete draft **journal** (`POST /ledger/journal-entries`, `DELETE /ledger/journal-entries/:id`) | | ✓ | ✓ | ✓ |
| Post / reverse **journal** (`POST /ledger/journal-entries/:id/post`, `POST /ledger/journal-entries/:id/reverse`) | | | ✓ | ✓ |
| Generate **periods** (`POST /ledger/periods/generate`) | | | ✓ | ✓ |
| Close **period** (`POST /ledger/periods/:id/close`) | | | ✓ | ✓ |
| Reopen **period** (`POST /ledger/periods/:id/reopen`) | | | | ✓ |
| Post **opening balances** (`POST /ledger/opening-balances`) | | | | ✓ |
| Run / reopen **year-end close** (`POST /close/year-end`, `POST /close/year-end/:fy/reopen`) | | | | ✓ |
| Update **company settings** (`PATCH /company/settings`) | | | | ✓ |
| Read **audit log** (`GET /audit`) | | | | ✓ |
| `GET /auth/admin-only` (RBAC smoke) | | | | ✓ |

> **Note on `POST /ledger/journal-entries?post=true`:** ACCOUNTANT may create drafts
> but **cannot create-and-post in one call** — passing `?post=true` as an ACCOUNTANT
> is rejected with `403 FORBIDDEN`. Create-and-post requires APPROVER/ADMIN.

### Segregation of Duties (SoD)

When SoD enforcement is enabled, **the user who created a document cannot be the same
user who posts/approves it**. Such an attempt returns **`403 SEGREGATION_OF_DUTIES`**.
In the UI, a creator should hand off to a different APPROVER/ADMIN for posting; handle
this 403 distinctly from a plain role error (it is *not* fixed by elevating the role).

---

## 4. Domain lifecycles

All financial documents follow a **draft → post → (reverse/void)** flow. Posting is
APPROVER/ADMIN only; creating drafts is ACCOUNTANT+. Posting writes the ledger entry;
voiding/reversing un-does a posted document.

### Journal entry

```
POST /ledger/journal-entries            create DRAFT            (ACCOUNTANT+)
  └─ ?post=true                         create AND post         (APPROVER/ADMIN only)
POST /ledger/journal-entries/:id/post   post the draft          (APPROVER/ADMIN)
POST /ledger/journal-entries/:id/reverse  reverse a posted entry (APPROVER/ADMIN)
DELETE /ledger/journal-entries/:id      delete a DRAFT          (ACCOUNTANT+)
```

- Debits must equal credits or you get `422 UNBALANCED_ENTRY`.
- **Discover drafts awaiting approval** via `GET /v1/ledger/journal-entries?status=DRAFT`
  — this is your approval queue.
- `POST /v1/ledger/journal-entries`, `/:id/post`, `/:id/reverse`, and
  `POST /v1/ledger/opening-balances` all **require an `Idempotency-Key` header** —
  pass a unique UUID on each new request; retries with the same key replay the original
  response safely (see [§2 Idempotency](#idempotency)).

### Sales invoice / Purchase bill

```
POST /sales-invoices   |  POST /purchase-bills      create DRAFT          (ACCOUNTANT+)
PATCH .../:id                                        edit a DRAFT          (ACCOUNTANT+)
POST  .../:id/post                                   post → ledger + AR/AP (APPROVER/ADMIN)
POST  .../:id/void                                   void a posted doc     (APPROVER/ADMIN)
DELETE .../:id                                        delete a DRAFT        (ACCOUNTANT+)
```

Posting an invoice/bill updates the AR/AP subledger and the corresponding control
account; voiding reverses it.

### Payment

```
POST /payments            create DRAFT, direction = RECEIPT | DISBURSEMENT,
                          with full allocation across invoices/bills   (ACCOUNTANT+)
POST /payments/:id/post   post the payment                            (APPROVER/ADMIN)
POST /payments/:id/void   void a posted payment                       (APPROVER/ADMIN)
DELETE /payments/:id      delete a DRAFT                               (ACCOUNTANT+)
```

A payment must allocate its full amount against open documents. RECEIPT = money in
(against AR), DISBURSEMENT = money out (against AP).

### Periods & year-end close

```
POST /ledger/periods/generate     generate the monthly periods for a fiscal year (APPROVER/ADMIN)
POST /ledger/periods/:id/close    close one monthly period                       (APPROVER/ADMIN)
POST /ledger/periods/:id/reopen   reopen a monthly period                        (ADMIN)

POST /close/year-end              { "fiscalYear": 2026 }  run year-end close      (ADMIN)
POST /close/year-end/:fy/reopen   reopen a closed fiscal year                     (ADMIN)
GET  /close/year-end/:fy          close status for a fiscal year (any auth; 404 if none)
```

- Posting into a **closed period** → `409 CLOSED_PERIOD`; into a **closed year** →
  `409 CLOSED_YEAR`. After year-end close, the year is locked against new posting.
- Year-end close zeroes the cumulative P&L into Laba Ditahan (retained earnings).

### Tax preview

```
POST /tax/calculate     pure preview of PPN/PPh on supplied lines (any authenticated user)
```

This computes tax but **posts nothing** — use it to show live tax figures while a
user is editing an invoice/bill.

### Journal-entry preview

```
POST /journal-entries/preview   the balanced debit/credit journal a document WOULD post
                                (read-only; any authenticated user)
```

A **read-only, non-persisting** dry run that returns the exact balanced journal entry a
document would generate — use it to show the accountant the debits/credits **before**
they save/post. It runs the **same posting logic as a real post** (it cannot diverge),
writes nothing, and needs **no `Idempotency-Key`**. The request is discriminated by
`nature`:

- **`SALE` / `PURCHASE`** — same body as `POST /tax/calculate`:

  ```jsonc
  { "nature": "SALE",              // or "PURCHASE"
    "settlementAccountId": "<uuid>",
    "lines": [{ "accountId": "<uuid>", "amount": "1000000.0000", "taxCodeIds": ["<uuid>"] }] }
  ```

- **`PAYMENT`** — its own shape (a payment has no tax lines; its entry is cash ↔ AR/AP
  control for the allocation total):

  ```jsonc
  { "nature": "PAYMENT",
    "direction": "RECEIPT",        // or "DISBURSEMENT"
    "cashAccountId": "<uuid>",
    "allocations": [{ "salesInvoiceId": "<uuid>", "amount": "500000.0000" }] }
    // DISBURSEMENT allocations use "purchaseBillId" instead
  ```

Response (`JournalPreviewResponseDto`) — each line carries a human-readable
`accountCode`/`accountName`; the non-active side is `"0.0000"` (never null):

```jsonc
{ "lines": [
    { "accountId": "<uuid>", "accountCode": "1-1200", "accountName": "Piutang Usaha", "debit": "1110000.0000", "credit": "0.0000" },
    { "accountId": "<uuid>", "accountCode": "4-1000", "accountName": "Pendapatan",    "debit": "0.0000",       "credit": "1000000.0000" },
    { "accountId": "<uuid>", "accountCode": "2-1100", "accountName": "PPN Keluaran",  "debit": "0.0000",       "credit": "110000.0000" } ],
  "totalDebit": "1110000.0000", "totalCredit": "1110000.0000", "balanced": true }
```

It validates the same way a real post does, so the user sees problems early: **`422`**
for a non-postable/unknown account, unknown/inactive tax code, non-positive settlement
(withholding ≥ gross), a missing AR/AP control account, or a wrong-type / non-positive
allocation; **`400`** for a malformed body. It does **not** run period-lock,
segregation-of-duties, or the deeper payment-allocation checks (partner-match /
target-POSTED / outstanding) — those stay at real post time.

---

## 5. Glossary

### SAK chart-of-accounts ranges (seeded)

Codes are `N-NNNN`; the `N-0000` rows are non-postable headers. Seeded leaves include:

| Code | Name (ID) | English |
|---|---|---|
| `1-1000` | Kas | Cash |
| `1-1100` | Bank | Bank |
| `1-1200` | Piutang Usaha | Accounts receivable (AR control) |
| `1-1300` | Persediaan | Inventory |
| `1-1400` | PPN Masukan | Input VAT |
| `1-1500` | Uang Muka PPh | Prepaid withholding tax |
| `2-1000` | Utang Usaha | Accounts payable (AP control) |
| `2-1100` | PPN Keluaran | Output VAT |
| `2-1200` | Utang PPh | Withholding tax payable |
| `3-1000` | Modal | Capital / equity |
| `3-2000` | Laba Ditahan | Retained earnings |
| `3-9000` | Saldo Awal | Opening-balance equity (plug) |
| `4-1000` | Pendapatan Penjualan | Sales revenue |
| `5-1000` | Harga Pokok Penjualan | Cost of goods sold (HPP / COGS) |

Header ranges: **1 = Aset (assets), 2 = Liabilitas (liabilities), 3 = Ekuitas
(equity), 4 = Pendapatan (revenue), 5 = Beban (expenses).**

### Terms

- **Fiscal year** — an integer (e.g. `2026`); the accounting year.
- **Period** — a monthly accounting period within a fiscal year; can be open or closed.
- **PPN** — Pajak Pertambahan Nilai = VAT (input `PPN Masukan` / output `PPN Keluaran`).
- **PPh** — Pajak Penghasilan = income / withholding tax.
- **Neraca** — balance sheet.
- **Laba Rugi** — income statement (profit & loss).
- **Buku Besar** — general ledger.
- **Arus Kas** — cash-flow statement.
- **Jurnal** — journal (entry).
- **Saldo Awal** — opening balance.
- **Faktur Pajak** — tax invoice (drives the 4dp rounding rule).

---

## 6. Endpoint catalog

Grouped by domain. Format: `METHOD · path · role · purpose`. Schemas are in
`openapi.json`; this is the human index. "any" = any authenticated user; "public" =
no auth.

### Auth
- `POST   /auth/login` · public · obtain a token pair
- `POST   /auth/refresh` · public · exchange a refresh token for a new pair
- `POST   /auth/logout` · public (throttled) · revoke the current device's refresh token family `{ "refreshToken": "..." }`
- `POST   /auth/logout-all` · any (authenticated) · revoke all sessions for the current user
- `GET    /auth/me` · any · current user `{ id, email, role }`
- `GET    /auth/admin-only` · ADMIN · RBAC smoke endpoint

### Health / ops (public, unauthenticated, version-neutral — no `/v1` prefix)
- `GET    /health` · public · liveness
- `GET    /ready` · public · readiness (503 if DB down)
- `GET    /metrics` · public · Prometheus metrics (may be token-gated by ops)

### Ledger — accounts
- `GET    /v1/ledger/accounts` · any · list chart of accounts (**envelope** `{data,total,limit,offset}`; supports `?limit`/`?offset`)
- `GET    /v1/ledger/accounts/:id` · any · get one account
- `GET    /v1/ledger/accounts/:id/balance` · any · account balance (`?asOf=`)
- `POST   /v1/ledger/accounts` · ACCOUNTANT+ · create account
- `PATCH  /v1/ledger/accounts/:id` · ACCOUNTANT+ · update account
- `POST   /v1/ledger/accounts/:id/deactivate` · ADMIN · soft-deactivate account
- `DELETE /v1/ledger/accounts/:id` · ADMIN · soft-delete account

### Ledger — journal
- `GET    /v1/ledger/journal-entries` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, status, sourceType, fiscalYear, from, to, limit, offset`)
- `GET    /v1/ledger/journal-entries/:id` · any · get one entry
- `POST   /v1/ledger/journal-entries` · ACCOUNTANT+ · create draft (`?post=true` = create+post, APPROVER/ADMIN only) · **requires `Idempotency-Key`**
- `POST   /v1/ledger/journal-entries/:id/post` · APPROVER/ADMIN · post draft · **requires `Idempotency-Key`**
- `POST   /v1/ledger/journal-entries/:id/reverse` · APPROVER/ADMIN · reverse posted entry · **requires `Idempotency-Key`**
- `DELETE /v1/ledger/journal-entries/:id` · ACCOUNTANT+ · delete draft
- `POST   /v1/ledger/opening-balances` · ADMIN · post opening balances · **requires `Idempotency-Key`**

### Ledger — periods & trial balance
- `GET    /v1/ledger/periods?fiscalYear=` · any · list monthly periods (bare array)
- `POST   /v1/ledger/periods/generate` · APPROVER/ADMIN · generate a year's periods
- `POST   /v1/ledger/periods/:id/close` · APPROVER/ADMIN · close a period
- `POST   /v1/ledger/periods/:id/reopen` · ADMIN · reopen a period
- `GET    /v1/ledger/trial-balance?asOf=` · any · trial balance

### Reports (all read, any auth)
- `GET    /v1/reports/balance-sheet?asOf=` · any · Neraca
- `GET    /v1/reports/income-statement?from=&to=` · any · Laba Rugi
- `GET    /v1/reports/general-ledger?accountId=&from=&to=` · any · Buku Besar
- `GET    /v1/reports/ar-aging?asOf=` · any · AR aging
- `GET    /v1/reports/ap-aging?asOf=` · any · AP aging
- `GET    /v1/reports/cash-flow?from=&to=` · any · Arus Kas

### Sales invoices
- `GET    /v1/sales-invoices` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, status, limit, offset`)
- `GET    /v1/sales-invoices/:id` · any · get one
- `POST   /v1/sales-invoices` · ACCOUNTANT+ · create draft · **requires `Idempotency-Key`**
- `PATCH  /v1/sales-invoices/:id` · ACCOUNTANT+ · update draft
- `POST   /v1/sales-invoices/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/sales-invoices/:id/void` · APPROVER/ADMIN · void · **requires `Idempotency-Key`**
- `DELETE /v1/sales-invoices/:id` · ACCOUNTANT+ · delete draft

### Purchase bills
- `GET    /v1/purchase-bills` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, status, limit, offset`)
- `GET    /v1/purchase-bills/:id` · any · get one
- `POST   /v1/purchase-bills` · ACCOUNTANT+ · create draft · **requires `Idempotency-Key`**
- `PATCH  /v1/purchase-bills/:id` · ACCOUNTANT+ · update draft
- `POST   /v1/purchase-bills/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/purchase-bills/:id/void` · APPROVER/ADMIN · void · **requires `Idempotency-Key`**
- `DELETE /v1/purchase-bills/:id` · ACCOUNTANT+ · delete draft

### Payments
- `GET    /v1/payments` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, direction, status, limit, offset`)
- `GET    /v1/payments/:id` · any · get one
- `POST   /v1/payments` · ACCOUNTANT+ · create draft (RECEIPT/DISBURSEMENT + allocations) · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/void` · APPROVER/ADMIN · void · **requires `Idempotency-Key`**
- `DELETE /v1/payments/:id` · ACCOUNTANT+ · delete draft

### Business partners
- `GET    /v1/partners` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, limit, offset`)
- `GET    /v1/partners/:id` · any · get one
- `POST   /v1/partners` · ACCOUNTANT+ · create
- `PATCH  /v1/partners/:id` · ACCOUNTANT+ · update
- `POST   /v1/partners/:id/deactivate` · ADMIN · deactivate
- `DELETE /v1/partners/:id` · ADMIN · delete

### Tax
- `GET    /v1/tax/codes` · any · list tax codes (**envelope** `{data,total,limit,offset}`; supports `?limit`/`?offset`)
- `GET    /v1/tax/codes/:id` · any · get one
- `POST   /v1/tax/codes` · ACCOUNTANT+ · create
- `PATCH  /v1/tax/codes/:id` · ACCOUNTANT+ · update
- `POST   /v1/tax/codes/:id/deactivate` · ADMIN · deactivate
- `DELETE /v1/tax/codes/:id` · ADMIN · delete
- `POST   /v1/tax/calculate` · any · PPN/PPh preview (posts nothing)

### Journal-entry preview
- `POST   /v1/journal-entries/preview` · any · read-only balanced-JE dry run for a SALE/PURCHASE/PAYMENT document (posts nothing; **no `Idempotency-Key`**). Distinct from the manual-journal CRUD at `/v1/ledger/journal-entries`.

### Close
- `POST   /v1/close/year-end` · ADMIN · run year-end close (`{ fiscalYear }`) · **requires `Idempotency-Key`**
- `POST   /v1/close/year-end/:fy/reopen` · ADMIN · reopen a closed year
- `GET    /v1/close/year-end/:fy` · any · close status (404 if none)

### Company
- `GET    /v1/company/settings` · any · company settings
- `PATCH  /v1/company/settings` · ADMIN · update company settings

### Audit
- `GET    /v1/audit` · ADMIN · audit log — **bare array** (no envelope) (filters: `userId, method, from, to, limit, offset`; `limit` default 50, **max 200**; `method` ∈ POST/PATCH/PUT/DELETE)

### Response schema quick-map

Each endpoint's 2xx body resolves to a named schema in `openapi.json` — look up the
fields there; this is just the name to find. The seven enveloped list endpoints wrap
their items in `{ data, total, limit, offset }`; bare-array endpoints return the item
schema directly in an array.

| Domain | Response schema(s) |
|---|---|
| Auth | `TokenPairDto` (login/refresh) · `AuthenticatedUserDto` (`/auth/me`) · `OkFlagDto` (`/auth/admin-only`) |
| Health / ops | `HealthStatusDto` · `ReadinessStatusDto` · `/metrics` → `text/plain` (not JSON) |
| Accounts | list → `AccountListResponseDto` (envelope) · single → `AccountResponseDto` · balance → `AccountBalanceDto` · trial balance → `TrialBalanceDto` |
| Journal | `JournalEntryResponseDto` (incl. `JournalLineResponseDto[]`) · list → `JournalEntryListResponseDto` (envelope; items `JournalEntryListItemDto`) · opening-balances → `JournalEntryResponseDto` |
| Periods | `FiscalPeriodResponseDto` (bare array on list) |
| Tax | list → `TaxCodeListResponseDto` (envelope) · single → `TaxCodeResponseDto` · calculate → `TaxCalculationDto` (`TaxBreakdownRowDto[]` + `CalculatedLineDto[]`) |
| Journal preview | `JournalPreviewResponseDto` (`JournalPreviewLineDto[]` + `totalDebit`/`totalCredit`/`balanced`) |
| Partners | `BusinessPartnerResponseDto` (single) · list → `BusinessPartnerListResponseDto` (envelope) |
| Sales invoices | `SalesInvoiceResponseDto` (single; incl. optional `SalesInvoiceLineResponseDto[]`) · list → `SalesInvoiceListResponseDto` (envelope) |
| Purchase bills | `PurchaseBillResponseDto` (single; incl. optional `PurchaseBillLineResponseDto[]`) · list → `PurchaseBillListResponseDto` (envelope) |
| Payments | `PaymentResponseDto` (single; incl. optional `PaymentAllocationResponseDto[]`) · list → `PaymentListResponseDto` (envelope) |
| Reports | `BalanceSheetDto` · `IncomeStatementDto` · `GeneralLedgerDto` · `AgingReportDto` (AR & AP) · `CashFlowDto` |
| Close | `YearEndClosingResponseDto` |
| Company | `CompanySettingsDto` |
| Audit | `AuditEntryDto` (bare array) |
| Errors (4xx/5xx) | `ErrorEnvelopeDto` |

---

## 7. Recommended frontend surface (stack-agnostic)

Screens → the endpoints they consume:

- **Login** — `/auth/login`, `/auth/refresh`, `/auth/me`.
- **Dashboard** — summary cards from `/v1/reports/balance-sheet`,
  `/v1/reports/income-statement`, `/v1/reports/cash-flow`, plus open-drafts count from
  `/v1/ledger/journal-entries?status=DRAFT`.
- **Chart of Accounts** — `/v1/ledger/accounts` (+ `:id/balance`); create/update for
  ACCOUNTANT+, deactivate/delete for ADMIN.
- **Journal register** — `/v1/ledger/journal-entries` (enveloped list + filters) with
  create/post/reverse (all requiring `Idempotency-Key`), and a **DRAFT approval queue**
  (`?status=DRAFT`) for APPROVER/ADMIN.
- **Sales Invoices / Purchase Bills / Payments** — enveloped list (with a server-side
  `?q=` **search box** — matches ref/partner name+code, spans the whole dataset) + draft
  editor + post/void (all writes requiring `Idempotency-Key`); payments need an
  allocation UI against open documents. In the editor, show a **live journal-entry
  preview** panel (debounced `POST /v1/journal-entries/preview`) next to the tax preview,
  so the accountant sees the balanced debits/credits before saving/posting.
- **Reports** — `/v1/reports/*` plus `/v1/ledger/trial-balance`; respect the `asOf` vs
  `from/to` parameter split per report.
- **Periods & Year-end Close** — `/v1/ledger/periods` (generate/close/reopen) and
  `/v1/close/year-end` (ADMIN; requires `Idempotency-Key`); show period open/closed
  state and the year-lock.
- **Tax** — `/v1/tax/codes` management + live `/v1/tax/calculate` preview inside invoice/bill editors.
- **Audit log** — `/v1/audit` (ADMIN only; bare-array response, filterable, `limit`/`offset` paging).
- **Company settings** — `/v1/company/settings` (read any, edit ADMIN).

### Cross-cutting work to build once

- **Auth/refresh fetch wrapper** — attach `Bearer`, transparently refresh on 401,
  redirect to login when refresh fails, and back off on 429.
- **Error-envelope handling** — branch on `code`, render `details.errors` as inline
  field errors, surface `traceId` on error screens.
- **Money formatting** — a decimal-backed money type; never floats; rupiah display
  formatter; 4dp strings on the wire.
- **Role-gated UI** — read the role from `/auth/me`, hide/disable actions a role
  cannot perform (per the role matrix), but **still handle 403/`SEGREGATION_OF_DUTIES`**
  defensively on every mutation.
- **Idempotency helper** — generate and attach a unique `Idempotency-Key` UUID on
  every call to a covered write endpoint (invoice/bill/payment create/post/void,
  year-end close, journal/opening-balances). Store the key before the call so you
  can replay it on retry without changing the body.
- **Pagination helpers** — build one reusable envelope reader for the seven enveloped
  lists (`accounts`, `tax-codes`, `journal-entries`, `partners`, `sales-invoices`,
  `purchase-bills`, `payments`); treat remaining bare-array lists (`periods`, `audit`)
  as plain arrays. **BREAKING (from prior guide):** `accounts` and `tax-codes` now
  return the envelope — unwrap `.data` instead of using the response directly as an array.
