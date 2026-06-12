# Frontend Integration Guide — Indonesian Accounting API

This guide is the prose companion to [`openapi.json`](./openapi.json) (in this same
folder). The OpenAPI document carries the request/response **schemas**; this guide
carries the **conventions, role rules, lifecycles, and glossary** you need to build
a correct frontend. Everything here is derived from the API source code.

- Schemas / types → `openapi.json` (generate a typed client from it).
- Conventions / roles / lifecycles / glossary → this file.

---

## 1. Overview & authentication

This is a **single-company** Indonesian accounting API. It follows Indonesian GAAP
(SAK / PSAK): a SAK-aligned chart of accounts, monthly accounting periods per fiscal
year, PPN (VAT) and PPh (withholding) tax handling, and the standard financial
statements (Neraca / balance sheet, Laba Rugi / income statement, Buku Besar /
general ledger, Arus Kas / cash flow).

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
- **There is no server-side logout.** To "log out", discard both tokens client-side.

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

### Pagination

Pagination is **not uniform** — check per endpoint:

- **`GET /ledger/journal-entries` is enveloped:**

  ```json
  { "data": [ ... ], "total": 123, "limit": 50, "offset": 0 }
  ```

  `limit` default **50**, **max 200**; `offset` default 0. Supports filters
  `?status=&sourceType=&fiscalYear=&from=&to=&limit=&offset=`.

- **Only `GET /ledger/journal-entries` returns the `{ data, total, limit, offset }`
  envelope.** Every other list endpoint — including `GET /audit` — returns a **bare
  JSON array** (no envelope): `/audit`, `/sales-invoices`, `/purchase-bills`,
  `/payments`, `/partners`, `/ledger/accounts`, `/tax/codes`, `/ledger/periods`.
  Do not look for `.data` on these. (`GET /audit` still accepts `limit`/`offset`
  query params for paging, but the response itself is a bare array.)

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
VIEWER — reads carry no `@Roles` restriction. `POST /tax/calculate` is a pure preview
and is likewise available to any authenticated user. The table below therefore lists
only the **mutating / privileged** endpoints, where the role actually gates access.

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
- **Discover drafts awaiting approval** via `GET /ledger/journal-entries?status=DRAFT`
  — this is your approval queue.
- Posting/reversing/create-and-post accept an optional `Idempotency-Key` request
  header; reuse the same key on retry to avoid double-posting.

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
- `GET    /auth/me` · any · current user `{ id, email, role }`
- `GET    /auth/admin-only` · ADMIN · RBAC smoke endpoint

### Health / ops (public, unauthenticated)
- `GET    /health` · public · liveness
- `GET    /ready` · public · readiness (503 if DB down)
- `GET    /metrics` · public · Prometheus metrics (may be token-gated by ops)

### Ledger — accounts
- `GET    /ledger/accounts` · any · list chart of accounts (bare array)
- `GET    /ledger/accounts/:id` · any · get one account
- `GET    /ledger/accounts/:id/balance` · any · account balance (`?asOf=`)
- `POST   /ledger/accounts` · ACCOUNTANT+ · create account
- `PATCH  /ledger/accounts/:id` · ACCOUNTANT+ · update account
- `POST   /ledger/accounts/:id/deactivate` · ADMIN · soft-deactivate account
- `DELETE /ledger/accounts/:id` · ADMIN · soft-delete account

### Ledger — journal
- `GET    /ledger/journal-entries` · any · **paginated** list `{ data, total, limit, offset }` (filters: `status, sourceType, fiscalYear, from, to, limit, offset`)
- `GET    /ledger/journal-entries/:id` · any · get one entry
- `POST   /ledger/journal-entries` · ACCOUNTANT+ · create draft (`?post=true` = create+post, APPROVER/ADMIN only)
- `POST   /ledger/journal-entries/:id/post` · APPROVER/ADMIN · post draft
- `POST   /ledger/journal-entries/:id/reverse` · APPROVER/ADMIN · reverse posted entry
- `DELETE /ledger/journal-entries/:id` · ACCOUNTANT+ · delete draft
- `POST   /ledger/opening-balances` · ADMIN · post opening balances

### Ledger — periods & trial balance
- `GET    /ledger/periods?fiscalYear=` · any · list monthly periods (bare array)
- `POST   /ledger/periods/generate` · APPROVER/ADMIN · generate a year's periods
- `POST   /ledger/periods/:id/close` · APPROVER/ADMIN · close a period
- `POST   /ledger/periods/:id/reopen` · ADMIN · reopen a period
- `GET    /ledger/trial-balance?asOf=` · any · trial balance

### Reports (all read, any auth)
- `GET    /reports/balance-sheet?asOf=` · any · Neraca
- `GET    /reports/income-statement?from=&to=` · any · Laba Rugi
- `GET    /reports/general-ledger?accountId=&from=&to=` · any · Buku Besar
- `GET    /reports/ar-aging?asOf=` · any · AR aging
- `GET    /reports/ap-aging?asOf=` · any · AP aging
- `GET    /reports/cash-flow?from=&to=` · any · Arus Kas

### Sales invoices
- `GET    /sales-invoices` · any · list (bare array)
- `GET    /sales-invoices/:id` · any · get one
- `POST   /sales-invoices` · ACCOUNTANT+ · create draft
- `PATCH  /sales-invoices/:id` · ACCOUNTANT+ · update draft
- `POST   /sales-invoices/:id/post` · APPROVER/ADMIN · post
- `POST   /sales-invoices/:id/void` · APPROVER/ADMIN · void
- `DELETE /sales-invoices/:id` · ACCOUNTANT+ · delete draft

### Purchase bills
- `GET    /purchase-bills` · any · list (bare array)
- `GET    /purchase-bills/:id` · any · get one
- `POST   /purchase-bills` · ACCOUNTANT+ · create draft
- `PATCH  /purchase-bills/:id` · ACCOUNTANT+ · update draft
- `POST   /purchase-bills/:id/post` · APPROVER/ADMIN · post
- `POST   /purchase-bills/:id/void` · APPROVER/ADMIN · void
- `DELETE /purchase-bills/:id` · ACCOUNTANT+ · delete draft

### Payments
- `GET    /payments` · any · list (bare array)
- `GET    /payments/:id` · any · get one
- `POST   /payments` · ACCOUNTANT+ · create draft (RECEIPT/DISBURSEMENT + allocations)
- `POST   /payments/:id/post` · APPROVER/ADMIN · post
- `POST   /payments/:id/void` · APPROVER/ADMIN · void
- `DELETE /payments/:id` · ACCOUNTANT+ · delete draft

### Business partners
- `GET    /partners` · any · list (bare array)
- `GET    /partners/:id` · any · get one
- `POST   /partners` · ACCOUNTANT+ · create
- `PATCH  /partners/:id` · ACCOUNTANT+ · update
- `POST   /partners/:id/deactivate` · ADMIN · deactivate
- `DELETE /partners/:id` · ADMIN · delete

### Tax
- `GET    /tax/codes` · any · list tax codes (bare array)
- `GET    /tax/codes/:id` · any · get one
- `POST   /tax/codes` · ACCOUNTANT+ · create
- `PATCH  /tax/codes/:id` · ACCOUNTANT+ · update
- `POST   /tax/codes/:id/deactivate` · ADMIN · deactivate
- `DELETE /tax/codes/:id` · ADMIN · delete
- `POST   /tax/calculate` · any · PPN/PPh preview (posts nothing)

### Close
- `POST   /close/year-end` · ADMIN · run year-end close (`{ fiscalYear }`)
- `POST   /close/year-end/:fy/reopen` · ADMIN · reopen a closed year
- `GET    /close/year-end/:fy` · any · close status (404 if none)

### Company
- `GET    /company/settings` · any · company settings
- `PATCH  /company/settings` · ADMIN · update company settings

### Audit
- `GET    /audit` · ADMIN · audit log — **bare array** (no envelope) (filters: `userId, method, from, to, limit, offset`; `limit` default 50, **max 500**; `method` ∈ POST/PATCH/PUT/DELETE)

---

## 7. Recommended frontend surface (stack-agnostic)

Screens → the endpoints they consume:

- **Login** — `/auth/login`, `/auth/refresh`, `/auth/me`.
- **Dashboard** — summary cards from `/reports/balance-sheet`,
  `/reports/income-statement`, `/reports/cash-flow`, plus open-drafts count from
  `/ledger/journal-entries?status=DRAFT`.
- **Chart of Accounts** — `/ledger/accounts` (+ `:id/balance`); create/update for
  ACCOUNTANT+, deactivate/delete for ADMIN.
- **Journal register** — `/ledger/journal-entries` (paginated list + filters) with
  create/post/reverse, and a **DRAFT approval queue** (`?status=DRAFT`) for APPROVER/ADMIN.
- **Sales Invoices / Purchase Bills / Payments** — list + draft editor + post/void;
  payments need an allocation UI against open documents.
- **Reports** — `/reports/*` plus `/ledger/trial-balance`; respect the `asOf` vs
  `from/to` parameter split per report.
- **Periods & Year-end Close** — `/ledger/periods` (generate/close/reopen) and
  `/close/year-end` (ADMIN); show period open/closed state and the year-lock.
- **Tax** — `/tax/codes` management + live `/tax/calculate` preview inside invoice/bill editors.
- **Audit log** — `/audit` (ADMIN only; bare-array response, filterable, `limit`/`offset` paging).
- **Company settings** — `/company/settings` (read any, edit ADMIN).

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
- **Pagination helpers** — one for the single enveloped list (`journal-entries`),
  and treat all other lists (including `/audit`) as bare arrays.
