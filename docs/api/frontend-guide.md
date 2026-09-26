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

- **Emails are case-insensitive.** The server trims and lowercases the email on
  login and user creation (`' Budi@Example.COM '` logs in as `budi@example.com`),
  and `GET /auth/me` / user responses always return the lowercased form. Two users
  cannot differ only by case (`409`). `password` is capped at **128** chars (`400`).
- Send the access token on every authenticated request:
  `Authorization: Bearer <accessToken>`.
- Tokens are typed (`typ: "access"` / `typ: "refresh"`): an access token is never
  accepted by `/auth/refresh` and vice versa. **Deploy note (2026-09):** tokens
  issued before this change carry no `typ` and are rejected with `401` — access
  tokens on the next request, refresh tokens on the next `/auth/refresh`. Handle
  it like any expired session: send the user back to login once.
- **Access tokens are short-lived** (~15 minutes; exact TTL is the server's
  `JWT_ACCESS_TTL`). **Refresh tokens last ~7 days** (`JWT_REFRESH_TTL`).
- On a **401** (expired/invalid access token), call:

  ```
  POST /auth/refresh   { "refreshToken": "<refreshToken>" }
    → 200 { "accessToken": "...", "refreshToken": "..." }
  ```

  This returns a **fresh pair**. Persist both and retry the original request once.
  If refresh itself fails (401), the session is over → send the user back to login.

- `GET /auth/me` → `{ id, email, role, mustChangePassword }` for the currently
  authenticated user. Use this on app load to hydrate the user, drive role-gated UI,
  and route a pending-password user straight to the change-password screen (see
  [Forced password change](#forced-password-change)).
- **Server-side logout is supported.** Call `POST /auth/logout { "refreshToken": "..." }` to revoke the current device's refresh token family (public endpoint, throttled). Call `POST /auth/logout-all` (authenticated) to revoke all sessions for the current user. On logout, also discard both tokens client-side.

### Rate limiting (throttle)

The API is rate-limited. Authenticated requests are budgeted **per user**, anonymous
auth endpoints **per IP** (login additionally per email).

| Scope                        | Limit     | Keyed by           |
| ---------------------------- | --------- | ------------------ |
| `POST /auth/login`           | 10 / min  | email (lowercased) |
| `POST /auth/login`           | 30 / min  | client IP          |
| `POST /auth/refresh`         | 30 / min  | IP                 |
| `POST /auth/logout`          | 30 / min  | IP                 |
| `POST /auth/change-password` | 10 / min  | authenticated user |
| All other endpoints          | 300 / min | authenticated user |

Both login buckets apply at once: 10 attempts per account and 30 attempts per client
IP (whatever emails it tries), per minute. Either one returns **429**.

(Defaults; operators can override via `THROTTLE_LOGIN_LIMIT` / `THROTTLE_LOGIN_IP_LIMIT` / `THROTTLE_REFRESH_LIMIT`
/ `THROTTLE_CHANGE_PASSWORD_LIMIT` / `THROTTLE_LIMIT`. Health/readiness/metrics probes
are not throttled.)

On a **429**, back off and retry later: every 429 carries a standard `Retry-After`
header (seconds until the bucket frees), and CORS exposes it (`Access-Control-Expose-Headers:
Retry-After`) so browser code can read it. Never hammer
`/auth/login` — it has the tightest budget.

Login and change-password can also answer **`503`** under a burst of password
checks (the server caps concurrent password hashing). It is transient: retry after
a short backoff.

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

| Status    | Meaning                                                                                                                           | Typical `code` values                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 200 / 201 | Success                                                                                                                           | —                                                          |
| **400**   | **Input shape / validation** — malformed body, query, or path param (`ValidationPipe`, `ParseUUIDPipe`, `ParseIntPipe`, bad JSON, a JSON body nested deeper than 32 levels), incl. an explicit `null` on a non-nullable `PATCH` field or a string over its length cap | `HTTP_400`, `INVALID_INPUT`                                |
| **401**   | Missing / expired / invalid token                                                                                                 | `UNAUTHORIZED`, `HTTP_401`                                 |
| **403**   | Wrong role, or Segregation-of-Duties block                                                                                        | `FORBIDDEN`, `SEGREGATION_OF_DUTIES`                       |
| **404**   | Resource not found (incl. soft-deleted)                                                                                           | `NOT_FOUND`                                                |
| **409**   | Conflict / closed period / closed year / unique violation                                                                         | `CONFLICT`, `CLOSED_PERIOD`, `CLOSED_YEAR`                 |
| **422**   | **Domain-rule violation** — request was well-formed but breaks an accounting rule                                                 | `VALIDATION_FAILED`, `UNBALANCED_ENTRY`, `INVALID_ACCOUNT` |
| **429**   | Rate-limited                                                                                                                      | (throttler)                                                |
| 500       | Unexpected server error                                                                                                           | `INTERNAL_ERROR`                                           |

#### 400 vs 422 — the important split

- **400** = the request is _shaped_ wrong. A field is missing, the wrong type, a
  malformed UUID, a non-numeric `fiscalYear`, etc. Fix the payload and the same
  request will be accepted. The frontend should usually have caught these client-side.
  - **`null` on `PATCH`:** omit a field to keep its value. Sending `null` for a field
    whose column cannot be empty (e.g. user `name`/`role`/`isActive`, account
    `name`/`cashFlowCategory`/`isActive`, tax-code `name`/`rate`/`isActive`, partner
    `name`/`isCustomer`/`isVendor`/`isActive`, company `legalName`/
    `fiscalYearStartMonth`/`segregationOfDutiesEnabled`/`isPkp`, invoice/bill
    `date`/`lines`) is a `400` ("`<field>` must not be null"). `null` **clears** only
    the documented nullable fields: `dueDate`, `vendorInvoiceNo`, document
    `description`, partner `npwp`/`email`/`phone`/`address`, company `npwp`/`address`.
  - **Length caps** (`400` when exceeded): codes 32, `npwp` 32, `phone` 32,
    `vendorInvoiceNo` 64, account/tax-code names 128, user name 120, partner name
    160, company `legalName` 200, document/line/payment descriptions 255, partner
    address 255, company address 500, journal entry and journal line descriptions
    500, `?q=` 100, refresh token 2048.
- **422** = the request is _well-formed_ but breaks an **accounting rule**. Examples:
  a journal entry whose debits ≠ credits (`UNBALANCED_ENTRY`), posting to a
  non-postable / invalid account (`INVALID_ACCOUNT`), a report range where
  `from > to` (`VALIDATION_FAILED`). These are domain errors the user must resolve
  by changing _what_ they are doing, not the request format.

#### Domain error codes (from the source)

These are the typed domain errors the API raises (`src/common/errors/domain-errors.ts`):

| `code`                  | HTTP | When                                                          |
| ----------------------- | ---- | ------------------------------------------------------------- |
| `VALIDATION_FAILED`     | 422  | Generic domain-rule violation (e.g. report `from > to`)       |
| `UNBALANCED_ENTRY`      | 422  | Journal debits ≠ credits                                      |
| `INVALID_ACCOUNT`       | 422  | Account missing / non-postable / wrong type for the operation |
| `NOT_FOUND`             | 404  | Entity does not exist (or is soft-deleted)                    |
| `CONFLICT`              | 409  | Generic conflict / unique violation                           |
| `CLOSED_PERIOD`         | 409  | Posting into a closed monthly period                          |
| `CLOSED_YEAR`           | 409  | Posting into a closed fiscal year                             |
| `UNAUTHORIZED`          | 401  | Auth failure raised in the domain layer                       |
| `FORBIDDEN`             | 403  | Role not permitted for the operation                          |
| `SEGREGATION_OF_DUTIES` | 403  | Same user tried to both create and approve/post (see SoD)     |

Prisma-level failures are normalized too: a unique conflict surfaces as `409 CONFLICT`,
a missing row as `404 NOT_FOUND`, malformed input as `400 INVALID_INPUT`.
A database **deadlock, serialization failure or lock timeout** (a concurrent
transaction won, or held a lock too long — e.g. a company start-month change waits at
most 5s for its table locks), or a **transaction that could not start or finish in time**
(posting/reversal/draft-post/year-end transactions wait at most 5s for a connection and run
at most 20s; report snapshots wait at most 5s and run at most 25s), or a **statement
cancelled by the database's 30s statement timeout**, surfaces as `409 CONFLICT` with
`details: { retryable: true }`: nothing was committed and the idempotency key was
released, so retry the same request (same `Idempotency-Key`) after a short back-off.
This also applies to GET reports (retry the GET; if a heavy report keeps timing out,
narrow its date range).

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
- **Year-end close:** `POST /v1/close/year-end`,
  `POST /v1/close/year-end/:fiscalYear/reopen`.

Behavior:

- **Replay** — a repeated call with the same key and identical body returns the
  original response (201/200) without re-executing the write. Safe to retry.
- **Retry after a timeout (408), a 5xx, or a network failure — reuse the SAME key.**
  A 408/500 does _not_ mean the write failed: the server may have committed it
  (or may still finish it) after responding. A same-key retry **never executes
  the write twice**. It gets one of:
  - the original response (replay) — done;
  - `409 CONFLICT` "in progress" while the first request is still running — back
    off and retry the same key;
  - `409 CONFLICT` with `details.committed: true` ("…committed its write, but its
    response is unavailable") — the write **did** happen but its response was
    lost. **Stop retrying** (this key is spent and will keep returning this 409);
    reload the list/resource to find the created or updated record;
  - the normal outcome of a fresh attempt, if the first request failed without
    committing anything (its key was released).

  **After a 408 specifically, don't expect a replay.** The timeout abandons the
  original request without recording its response, so a same-key retry gets
  `409` "in progress" while the original is still running, then either the
  committed-`409` (`details.committed: true` — it did commit: stop and reload) or,
  if it ultimately failed, keeps getting "in progress" until the reservation
  expires (~2 minutes), after which the retry executes fresh. Keep backing off
  on "in progress"; never switch to a new key.
  A retry that takes over an expired reservation while the original is, in fact,
  still finishing makes the original roll back (it no longer owns the key), so
  exactly one of them writes (the original's response is then `409 CONFLICT` with
  `details: { key, reclaimed: true }`).

  Retrying with a _new_ key can create a duplicate invoice/payment.
- **Keys are scoped per user** — two different users may use the same key
  independently; a key never replays another user's response.
- **Body/endpoint mismatch** — same key with a different request body or a different
  endpoint → **`422 VALIDATION_FAILED`**.
- **In-flight** — same key while the first request is still being processed →
  **`409 CONFLICT`**.
- **Committed, response lost** — same key after the first request's write
  committed but its response could not be recorded → **`409 CONFLICT`** with
  `details: { key, committed: true }`. Don't retry; reload the resource.
- **Missing header** — omitting `Idempotency-Key` on a covered endpoint →
  **`422 VALIDATION_FAILED`**.

> **Not covered:** `POST /v1/partners`, `POST /v1/ledger/accounts`,
> `POST /v1/tax/codes` — these are already idempotent by virtue of their unique
> `code` constraint (duplicate → `409 CONFLICT`). `POST /v1/ledger/periods/generate`
> and non-create mutations (`PATCH`, `DELETE`, `*/deactivate`, period `*/reopen`) are
> also not covered. (Year-end close reopen **is** covered — see above.)

### Pagination

Pagination is **not uniform** — check per endpoint:

- **`GET /v1/ledger/journal-entries` and the four transactional lists are enveloped:**

  ```json
  { "data": [ ... ], "total": 123, "limit": 50, "offset": 0 }
  ```

  `limit` default **50**, **max 200**; `offset` default 0, **max 100000** (`400` above).

  The **enveloped** endpoints are:
  - `GET /v1/ledger/journal-entries` (filters: `q, status, sourceType, fiscalYear, from, to, limit, offset`)
  - `GET /v1/partners` (filters: `q, limit, offset`)
  - `GET /v1/sales-invoices` (filters: `q, partnerId, status, limit, offset`)
  - `GET /v1/purchase-bills` (filters: `q, partnerId, status, limit, offset`)
  - `GET /v1/payments` (filters: `q, partnerId, direction, status, limit, offset`)
  - `GET /v1/users` (ADMIN-only)

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

| Endpoint                         | `q` matches                                                             |
| -------------------------------- | ----------------------------------------------------------------------- |
| `GET /v1/partners`               | partner `name`, `code`, `npwp`, `email`                                 |
| `GET /v1/sales-invoices`         | `invoiceRef`, `description`, **customer** `name` + `code`               |
| `GET /v1/purchase-bills`         | `billRef`, `vendorInvoiceNo`, `description`, **vendor** `name` + `code` |
| `GET /v1/payments`               | `ref`, `description`, **partner** `name` + `code`                       |
| `GET /v1/ledger/journal-entries` | `entryRef`, `description`                                               |

`GET /v1/ledger/accounts`, `GET /v1/tax/codes`, `GET /v1/ledger/periods`, and
`GET /v1/audit` do **not** support `?q=` (accounts and tax-codes are small bounded sets
— fetch and filter them client-side).

### Dates

- Accounting dates are **date-only**, `YYYY-MM-DD` (no time component). Send them as
  `YYYY-MM-DD` strings. If a full ISO timestamp is sent for a business date (journal,
  document, due, payment, void/reverse date, report `asOf`/`from`/`to`), the server takes
  the **calendar day from its first 10 characters** and ignores the time and offset —
  `2026-07-01T00:30+07:00` is **July 1** (never shifted to June 30 by UTC conversion).
  An impossible day (e.g. `2026-02-30`) → `400`, like any malformed date. (Audit-log
  `from`/`to` filters are timestamps and keep their time.)
- Report query parameters:
  - `?asOf=YYYY-MM-DD` — **balance sheet**, **AR/AP aging**, **trial balance**,
    account balance. Defaults to **today in WIB** (UTC+7; server-configurable via
    `REPORT_UTC_OFFSET_MINUTES`) if omitted — still, prefer sending an explicit
    `asOf` computed client-side so the user's own clock wins.
  - `?from=YYYY-MM-DD&to=YYYY-MM-DD` — **income statement**, **cash flow**,
    **general ledger**. `from` must be on or before `to` (else `422 VALIDATION_FAILED`);
    the general-ledger span is capped at 366 days.
- Periods are **monthly**, grouped by fiscal year (an integer like `2026`).

### traceId

The **`X-Request-Id` response header** equals the error envelope's `traceId`.
Capture it and surface it on error screens ("Reference: `<traceId>`") so support /
operators can correlate the client error with server logs.

The id is **always generated by the server** (a UUID) — an `X-Request-Id` you send
is **not** reused as the trace id. If your value is a safe shape
(`^[\w.-]{1,128}$`, i.e. letters, digits, `_`, `.`, `-`, at most 128 chars) it is
kept for correlation only: logged as `clientRequestId` and stored on the audit row
(`clientRequestId` in `GET /v1/audit`); any other value is dropped. Always show
users the **response** header / `traceId`, not the id you sent.

### Soft-delete

`DELETE` and the `*/deactivate` actions are **soft deletes**, not hard removals:

- After deletion the resource returns **404** and **disappears from list endpoints**.
- Unique codes (account code, tax code, partner code) are **tombstoned and become
  reusable** — you can create a new record with the same code afterward.
- Treat a 404 on a previously-known id as "it was deleted", not necessarily a bug.

### Forced password change

Admin `POST /v1/users` (create) and `POST /v1/users/:id/reset-password` return
`{ user, tempPassword }` — the **`tempPassword` is visible exactly once**, in that
response. Store it nowhere; show it to the operator once (e.g. a copy-to-clipboard
field) and let it go. That user is created/reset with `mustChangePassword: true`.

- While `mustChangePassword` is `true`, **every** endpoint returns
  **`403` with code `PASSWORD_CHANGE_REQUIRED`** except `POST /v1/auth/change-password`,
  `GET /auth/me`, `POST /auth/logout`, and `POST /auth/logout-all`.
- Handle this 403 globally (same place you handle 401-refresh): redirect to a
  change-password screen. Submit `POST /v1/auth/change-password
  { "currentPassword": "<the temp password>", "newPassword": "..." }`
  (`newPassword` 8–128 chars, `currentPassword` ≤ 128). A wrong `currentPassword`
  is `401`; a `newPassword` equal to `currentPassword` is **`422 VALIDATION_FAILED`**.
- Success revokes **all** of the user's refresh sessions — other devices are signed
  out immediately; the tab that just changed the password keeps working until its
  current access token expires (≤15 min), since the access token itself isn't a
  refresh family.
- `GET /auth/me` includes `mustChangePassword` — check it on app load so you can
  route straight to the change-password screen instead of waiting for the first 403.

---

## 3. Role matrix

Four roles exist: **VIEWER, ACCOUNTANT, APPROVER, ADMIN**.

**All read (`GET`) endpoints are available to any authenticated user**, including
VIEWER — reads carry no `@Roles` restriction — **except `/v1/users/*`, which is
ADMIN-only end-to-end, reads included** (see the table below). `POST /v1/tax/calculate`
and `POST /v1/journal-entries/preview` are pure, read-only previews and are likewise
available to any authenticated user. The table below therefore
lists the **mutating / privileged** endpoints — plus `/v1/users/*` reads, the one
place a `GET` is role-gated — where the role actually gates access. All paths below
are under `/v1` (e.g. `POST /partners` means `POST /v1/partners`).

A "✓" means that role is allowed. `403 FORBIDDEN` is returned otherwise. The 403
body is `{ code: "FORBIDDEN", message: "Insufficient role", traceId }` — it does
**not** say which roles would be accepted (no `details`); use this matrix, or
`GET /auth/me`'s `role`, to gate UI.

| Endpoint (mutation)                                                                                              | VIEWER | ACCOUNTANT | APPROVER | ADMIN |
| ---------------------------------------------------------------------------------------------------------------- | :----: | :--------: | :------: | :---: |
| Create / update **accounts** (`POST /ledger/accounts`, `PATCH /ledger/accounts/:id`)                             |        |     ✓      |    ✓     |   ✓   |
| Deactivate / delete **account** (`POST /ledger/accounts/:id/deactivate`, `DELETE /ledger/accounts/:id`)          |        |            |          |   ✓   |
| Create / update **partners** (`POST /partners`, `PATCH /partners/:id`)                                           |        |     ✓      |    ✓     |   ✓   |
| Deactivate / delete **partner** (`POST /partners/:id/deactivate`, `DELETE /partners/:id`)                        |        |            |          |   ✓   |
| Create / update **tax codes** (`POST /tax/codes`, `PATCH /tax/codes/:id`)                                        |        |     ✓      |    ✓     |   ✓   |
| Deactivate / delete **tax code** (`POST /tax/codes/:id/deactivate`, `DELETE /tax/codes/:id`)                     |        |            |          |   ✓   |
| Create / update **sales invoice** (`POST /sales-invoices`, `PATCH /sales-invoices/:id`)                          |        |     ✓      |    ✓     |   ✓   |
| Delete draft **sales invoice** (`DELETE /sales-invoices/:id`)                                                    |        |     ✓      |    ✓     |   ✓   |
| Post / void **sales invoice** (`POST /sales-invoices/:id/post`, `POST /sales-invoices/:id/void`)                 |        |            |    ✓     |   ✓   |
| Create / update **purchase bill** (`POST /purchase-bills`, `PATCH /purchase-bills/:id`)                          |        |     ✓      |    ✓     |   ✓   |
| Delete draft **purchase bill** (`DELETE /purchase-bills/:id`)                                                    |        |     ✓      |    ✓     |   ✓   |
| Post / void **purchase bill** (`POST /purchase-bills/:id/post`, `POST /purchase-bills/:id/void`)                 |        |            |    ✓     |   ✓   |
| Create **payment** (`POST /payments`)                                                                            |        |     ✓      |    ✓     |   ✓   |
| Delete draft **payment** (`DELETE /payments/:id`)                                                                |        |     ✓      |    ✓     |   ✓   |
| Post / void **payment** (`POST /payments/:id/post`, `POST /payments/:id/void`)                                   |        |            |    ✓     |   ✓   |
| Create draft / delete draft **journal** (`POST /ledger/journal-entries`, `DELETE /ledger/journal-entries/:id`)   |        |     ✓      |    ✓     |   ✓   |
| Post / reverse **journal** (`POST /ledger/journal-entries/:id/post`, `POST /ledger/journal-entries/:id/reverse`) |        |            |    ✓     |   ✓   |
| Generate **periods** (`POST /ledger/periods/generate`)                                                           |        |            |    ✓     |   ✓   |
| Close **period** (`POST /ledger/periods/:id/close`)                                                              |        |            |    ✓     |   ✓   |
| Reopen **period** (`POST /ledger/periods/:id/reopen`)                                                            |        |            |          |   ✓   |
| Post **opening balances** (`POST /ledger/opening-balances`)                                                      |        |            |          |   ✓   |
| Run / reopen **year-end close** (`POST /close/year-end`, `POST /close/year-end/:fy/reopen`)                      |        |            |          |   ✓   |
| Update **company settings** (`PATCH /company/settings`)                                                          |        |            |          |   ✓   |
| Manage **users** — all of `/users` (`GET`/`POST`/`PATCH`/`DELETE`, incl. `:id/reset-password`)                   |        |            |          |   ✓   |
| Read **audit log** (`GET /audit`)                                                                                |        |            |          |   ✓   |
| `GET /auth/admin-only` (RBAC smoke)                                                                              |        |            |          |   ✓   |

> **Note on `POST /ledger/journal-entries?post=true`:** ACCOUNTANT may create drafts
> but **cannot create-and-post in one call** — passing `?post=true` as an ACCOUNTANT
> is rejected with `403 FORBIDDEN`. Create-and-post requires APPROVER/ADMIN.

### Segregation of Duties (SoD)

When SoD enforcement is enabled, **the user who created a document cannot be the same
user who posts/approves it**. Such an attempt returns **`403 SEGREGATION_OF_DUTIES`**.
In the UI, a creator should hand off to a different APPROVER/ADMIN for posting; handle
this 403 distinctly from a plain role error (it is _not_ fixed by elevating the role).

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
- A manual entry may not touch the **AR/AP control accounts** (`role` `AR_CONTROL` /
  `AP_CONTROL`) — on create (draft or `?post=true`) and on `/:id/post` you get
  `422 VALIDATION_FAILED` with message
  `"AR/AP control accounts can only be posted through sales invoices, purchase bills and payments"`
  and `details: { accountId, role }`. Hide those accounts from the manual-entry account
  picker. Opening balances (`POST /ledger/opening-balances`) are still allowed on them.
- **Draft create validates accounts exactly like post.** An unknown, soft-deleted,
  header (non-postable) or inactive `accountId` on `POST /ledger/journal-entries` (draft)
  → `422 INVALID_ACCOUNT` `{ accountId }` — the same error `/:id/post` gives (previously
  an unknown id surfaced as `409`).
- **Opening balances are balance-sheet only.** A `REVENUE` or `EXPENSE` account in
  `balances` → `422 VALIDATION_FAILED` with `details: { accountId, reason: 'PNL_IN_OPENING' }`
  (nothing is written). Enter mid-year year-to-date revenue/expense as a normal MANUAL
  journal entry instead; hide P&L accounts from the opening-balance account picker.
- **Discover drafts awaiting approval** via `GET /v1/ledger/journal-entries?status=DRAFT`
  — this is your approval queue.
- `POST /v1/ledger/journal-entries`, `/:id/post`, `/:id/reverse`, and
  `POST /v1/ledger/opening-balances` all **require an `Idempotency-Key` header** —
  pass a unique UUID on each new request; retries with the same key replay the original
  response safely (see [§2 Idempotency](#idempotency)).
- **Reverse** accepts an optional body `{ "date": "YYYY-MM-DD" }` — the reversal date.
  Omit the body (or `date`) to reverse on the original entry's date (unchanged
  behaviour). The date must be **on/after** the original date (`422 VALIDATION_FAILED`
  otherwise, `details: { entryId, date, originalDate }`) and fall in an OPEN period of a
  non-closed year (`409 CLOSED_PERIOD` / `409 CLOSED_YEAR`); a non `YYYY-MM-DD` value is
  `400`. ⚠️ The document **void** endpoints use a *different* detail shape for the same
  kind of error — see [Void date](#sales-invoice--purchase-bill).
- Only `MANUAL` and `OPENING` entries can be reversed here. Reversing a document-owned
  entry (`SALES_INVOICE`, `PURCHASE_BILL`, `PAYMENT`) — or a `REVERSAL`/`CLOSING`
  entry — returns `422 VALIDATION_FAILED` with message
  `"Only MANUAL or OPENING entries can be reversed here; void the source document instead"`
  and `details: { entryId, sourceType }`. Void the invoice/bill/payment instead (a year-end
  closing entry is undone by reopening the year).

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

**Edit/delete vs post.** `PATCH`, `DELETE` and `/post` on the same draft serialize on
the document row. An edit or delete that loses to a post gets `422 VALIDATION_FAILED`
(`Only a DRAFT invoice can be edited` / `... can be deleted`); a post always posts the
lines stored at that moment (it restarts internally if the draft was edited mid-post).
If the draft keeps changing across several internal restarts the post returns
`409 CONFLICT` (`Invoice was edited while being posted; retry`) — reload and retry.

**Post re-validates tax and partner under the lock.** Inside the post transaction the
tax is recomputed from the current tax codes and company settings; if a tax code's
rate/account changed after the draft was read, the post restarts internally and posts
the **current** rate (the posted totals may differ from the draft's stored totals —
re-read the response). A tax code deactivated/deleted in the meantime, or `isPkp`
switched off for a PPN document, → `422 VALIDATION_FAILED` (same message as create).
The partner is re-checked too: deactivated / no longer a customer (vendor) / deleted
→ `422 VALIDATION_FAILED` `Partner is not an active customer` (`vendor`)
`{ partnerId }`. The document stays `DRAFT` in every `422` case.

**Line accounts.** On create, `PATCH` and `/post`, each line's `accountId` is checked;
violations return `422 VALIDATION_FAILED`:

| Violation | `details` |
| --- | --- |
| Line on an AR/AP control or `CASH` account | `{ accountId, role }` (`AR_CONTROL` / `AP_CONTROL` / `CASH`) |
| Line on a tax account (used by any tax code, e.g. PPN Keluaran/Masukan) — apply a tax code instead | `{ accountId, reason: "TAX_ACCOUNT" }` |
| Sales line not a revenue account (`type` `REVENUE` or subtype `OTHER_INCOME`); purchase line not `EXPENSE`/`ASSET` | `{ accountId, reason: "ACCOUNT_TYPE" }` |
| Purchase line on a **contra-asset** (`ASSET` with `normalBalance` `CREDIT`, e.g. Akumulasi Penyusutan) | `{ accountId, reason: "CONTRA_ASSET" }` |
| Sales line on a **contra-revenue** (`REVENUE` with `normalBalance` `DEBIT`, e.g. Retur/Potongan Penjualan) — returns need credit notes (not yet supported) | `{ accountId, reason: "CONTRA_REVENUE" }` |

**Other document rules** (create, `PATCH` and — where noted — `/post`):

- **Free lines.** A line may have `unitPrice` (or `quantity`) `0` — a free item. It is
  stored and shown on the document but produces no journal line (nor does a tax code
  whose base is only free lines). A document whose **total is 0** (every line free) is
  rejected: `422 VALIDATION_FAILED` "Document total must be greater than zero" (create,
  `PATCH`, `/post`, tax/journal preview).
- **Due date.** `dueDate` must be on/after `date` → else `422 VALIDATION_FAILED`
  `{ date, dueDate }`. On `PATCH` the effective (merged) values are checked, so moving
  only `date` past the stored `dueDate` is rejected too.
- **Clearing fields on `PATCH`.** `dueDate` (invoice + bill) and `vendorInvoiceNo` (bill)
  are nullable: send `null` to clear the stored value; omit the field to keep it.
- **Size caps.** `lines` holds at most **100** items on create *and* `PATCH`; each line's
  `taxCodeIds` at most **10** (also on `POST /tax/calculate` and the journal preview) →
  else `400`.
- **PPN needs a PKP company.** When company settings `isPkp` is `false`, a sales invoice
  using a `PPN_OUTPUT` code **and a purchase bill using a `PPN_INPUT` code** (a non-PKP
  company cannot credit input VAT) → `422 VALIDATION_FAILED` `{ taxCodeId, kind }`
  (create, `PATCH`, `/post`, `POST /tax/calculate` and the journal preview). PPh codes
  are unaffected.
- **Tax accounts re-checked at `/post`.** Each account a tax line posts to must still
  satisfy the tax-code account rule (see *Tax codes* below) → else `422
  VALIDATION_FAILED` `{ taxAccountId, reason, … }`.
- **Tax rounding.** Each tax code's amount is `DPP × rate` computed exactly and rounded
  **once** to whole rupiah (half-up), e.g. `100004.5450 × 0.11 = 11000.49995 → 11000`.
- **Vendor invoice number (bills).** Trimmed on write (a blank value is stored as
  `null`). A `vendorInvoiceNo` may appear on at most one **live** bill per vendor (not
  deleted, not `VOID`), compared **case-insensitively and ignoring surrounding spaces**
  (`INV-1` = `inv-1` = ` INV-1 `) → a duplicate on create or `PATCH` is `409 CONFLICT`
  `{ partnerId, vendorInvoiceNo }`. Voiding or deleting the bill frees the number;
  another vendor may use the same number.

**Void date.** Every void endpoint (invoice, bill, payment) accepts an optional body
`{ "date": "YYYY-MM-DD" }` — the void (reversal) date. Omit it to void on the document's
own date (unchanged behaviour). Pass a later date to void a document whose own period is
already closed: the reversal entry is posted on that date. Rules:

- `date` before the document date → `422 VALIDATION_FAILED`
  `details: { id, date, documentDate }`; not `YYYY-MM-DD` → `400`. (Journal **reverse**
  reports the same rule as `details: { entryId, date, originalDate }` — two shapes, so
  key your UI off `code` + the field names, not one shared parser.)
- `date` must fall in an OPEN period of a non-closed year → else `409 CLOSED_PERIOD` /
  `409 CLOSED_YEAR` (this is also what a body-less void of a closed-period document gets).
- Invoice/bill only: `date` before the void date of a payment that was allocated to the
  document and voided on a later date than its own → `422 VALIDATION_FAILED`
  `details: { id, date, paymentRef, paymentVoidedOn }` — void on/after `paymentVoidedOn`.
- The response carries `voidedOn` (the void date; `null` unless `status` is `VOID`).
  AR/AP aging honours it: a voided document/payment still counts for `asOf` dates before
  its `voidedOn`.

### Payment

```
POST /payments            create DRAFT, direction = RECEIPT | DISBURSEMENT,
                          with full allocation across invoices/bills   (ACCOUNTANT+)
POST /payments/:id/post   post the payment                            (APPROVER/ADMIN)
POST /payments/:id/void   void a posted payment                       (APPROVER/ADMIN)
DELETE /payments/:id      delete a DRAFT                               (ACCOUNTANT+)
```

Payment void takes the same optional `{ "date" }` body and rules as invoice/bill void
(above); allocations are unwound and `voidedOn` is returned.

A payment must allocate its full amount against open documents. RECEIPT = money in
(against AR), DISBURSEMENT = money out (against AP).

`cashAccountId` must be a **`CASH`-role** account (Kas / Bank) — otherwise, on create and
on `/post`, `422 VALIDATION_FAILED` with `details: { accountId, role }` (`role` is the
account's actual role, possibly `null`).

The payment `date` must be **on/after the date of every invoice/bill it allocates to** —
otherwise, on create (and re-checked on `/post`), `422 VALIDATION_FAILED` with
`details: { paymentDate, documentId, documentDate }`.

The partner is re-checked on `/post` too: it must still exist, be active and carry the
direction's flag (customer for RECEIPT, vendor for DISBURSEMENT) → else `422
VALIDATION_FAILED` `details: { partnerId }` ("Partner is inactive" / "Receipt requires a
customer" / "Disbursement requires a vendor").

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
  `409 CLOSED_YEAR`. After year-end close, the year is locked against new posting. The
  code is the same whether the period was already closed or closed while your request
  was in flight.
- Periods for the **current and next** fiscal year (judged on today's WIB date) exist
  from server start. Posting (or previewing with a `date` — the preview may create them
  too) into the **current or next** fiscal year when it has no periods generates its 12
  periods automatically and proceeds. An **earlier** year without periods, or a date
  further in the future, still gets `409 CLOSED_PERIOD` (backfill earlier years with
  `POST /ledger/periods/generate`). A date in an existing but closed period is never
  regenerated.
- Year-end close zeroes the cumulative P&L into Laba Ditahan (retained earnings).
- **Year-end close (and reopen) need the fiscal year's LAST period OPEN**: the closing
  entry is dated on the fiscal year-end and its reopen reversal on the same date. Close
  the year first, then close the last month — or reopen that month before running
  close/reopen; otherwise → `409 CLOSED_PERIOD`.
- **Deactivated P&L accounts are still closed.** A revenue/expense account deactivated
  mid-year keeps its movement in the closing entry (close, reopen and re-close all work);
  only the year-end close may post to an inactive account — any other post → `422
  INVALID_ACCOUNT`.

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
writes nothing, and needs **no `Idempotency-Key`**. An optional **`date`**
(`YYYY-MM-DD`) makes the preview also reproduce the **`409`** a real post would give
when that date falls in a closed period or closed fiscal year — send the document's
date to catch that error at preview time instead of at post time. The request is
discriminated by `nature`:

- **`SALE` / `PURCHASE`** — same body as `POST /tax/calculate`:

  ```jsonc
  {
    "nature": "SALE", // or "PURCHASE"
    // "settlementAccountId": DEPRECATED — accepted but ignored (see below)
    "lines": [
      {
        "accountId": "<uuid>",
        "amount": "1000000.0000",
        "taxCodeIds": ["<uuid>"],
      },
    ],
  }
  ```

  The settlement side is always the **AR control** (SALE) / **AP control** (PURCHASE)
  account resolved by role — exactly what the invoice/bill post writes.
  `settlementAccountId` is **deprecated and ignored** (still accepted, must be a UUID if
  sent); stop sending it.

- **`PAYMENT`** — its own shape (a payment has no tax lines; its entry is cash ↔ AR/AP
  control for the allocation total):

  ```jsonc
  {
    "nature": "PAYMENT",
    "direction": "RECEIPT", // or "DISBURSEMENT"
    "cashAccountId": "<uuid>",
    "allocations": [{ "salesInvoiceId": "<uuid>", "amount": "500000.0000" }],
  }
  // DISBURSEMENT allocations use "purchaseBillId" instead
  ```

Response (`JournalPreviewResponseDto`) — each line carries a human-readable
`accountCode`/`accountName`; the non-active side is `"0.0000"` (never null):

```jsonc
{
  "lines": [
    {
      "accountId": "<uuid>",
      "accountCode": "1-1200",
      "accountName": "Piutang Usaha",
      "debit": "1110000.0000",
      "credit": "0.0000",
    },
    {
      "accountId": "<uuid>",
      "accountCode": "4-1000",
      "accountName": "Pendapatan",
      "debit": "0.0000",
      "credit": "1000000.0000",
    },
    {
      "accountId": "<uuid>",
      "accountCode": "2-1100",
      "accountName": "PPN Keluaran",
      "debit": "0.0000",
      "credit": "110000.0000",
    },
  ],
  "totalDebit": "1110000.0000",
  "totalCredit": "1110000.0000",
  "balanced": true,
}
```

It validates the same way a real post does, so the user sees problems early: **`422`**
for a non-postable/unknown account, unknown/inactive tax code, non-positive settlement
(withholding ≥ gross), a missing AR/AP control account, or a wrong-type / non-positive
allocation, plus the same line-account / cash-account rules as the documents (a line on a
control/cash/tax or wrong-type account, a non-`CASH` payment `cashAccountId`); **`400`**
for a malformed body. It does **not** run period-lock,
segregation-of-duties, or the deeper payment-allocation checks (partner-match /
target-POSTED / outstanding) — those stay at real post time.

---

## 5. Glossary

### SAK chart-of-accounts ranges (seeded)

Codes are `N-NNNN`; the `N-0000` rows are non-postable headers. Seeded leaves include:

| Code     | Name (ID)             | English                          |
| -------- | --------------------- | -------------------------------- |
| `1-1000` | Kas                   | Cash                             |
| `1-1100` | Bank                  | Bank                             |
| `1-1200` | Piutang Usaha         | Accounts receivable (AR control) |
| `1-1300` | Persediaan            | Inventory                        |
| `1-1400` | PPN Masukan           | Input VAT                        |
| `1-1500` | Uang Muka PPh         | Prepaid withholding tax          |
| `2-1000` | Utang Usaha           | Accounts payable (AP control)    |
| `2-1100` | PPN Keluaran          | Output VAT                       |
| `2-1200` | Utang PPh             | Withholding tax payable          |
| `3-1000` | Modal                 | Capital / equity                 |
| `3-2000` | Laba Ditahan          | Retained earnings                |
| `3-9000` | Saldo Awal            | Opening-balance equity (plug)    |
| `4-1000` | Pendapatan Penjualan  | Sales revenue                    |
| `5-1000` | Harga Pokok Penjualan | Cost of goods sold (HPP / COGS)  |

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
- `GET    /auth/me` · any · current user `{ id, email, role, mustChangePassword }`
- `GET    /auth/admin-only` · ADMIN · RBAC smoke endpoint
- `POST   /auth/change-password` · any (authenticated) · self-service `{currentPassword, newPassword}`; revokes **all** the caller's refresh sessions (see [Forced password change](#forced-password-change)). If an admin resets the same account's password while the change is in flight, the reset wins and the change answers `401` "Current password is incorrect" (sessions are revoked by the reset anyway) — send the user to login

### Users (ADMIN)

- `POST   /v1/users` · ADMIN · create `{email, name, role}` → `201 { user, tempPassword }` (temp password shown once)
- `GET    /v1/users` · ADMIN · **enveloped** list `{ data, total, limit, offset }` (filters: `role, isActive, limit, offset`; no `?q=`)
- `GET    /v1/users/:id` · ADMIN · get one user
- `PATCH  /v1/users/:id` · ADMIN · update `{name?, role?, isActive?}` — role change / deactivation revokes the target's refresh sessions and takes effect on the target's **next request**
- `POST   /v1/users/:id/reset-password` · ADMIN · issue a new temp password → `200 { user, tempPassword }` (temp password shown once); revokes the target's refresh sessions
- `DELETE /v1/users/:id` · ADMIN · soft-delete (204); revokes the target's refresh sessions

### Health / ops (public, unauthenticated, version-neutral — no `/v1` prefix)

- `GET    /health` · public · liveness
- `GET    /ready` · internal · readiness (503 if DB down) — **404 through the public edge** (Caddy); container healthchecks call the api directly
- `GET    /metrics` · internal · Prometheus metrics — **404 through the public edge**; scraped in-network (token-gated)

### Ledger — accounts

- `GET    /v1/ledger/accounts` · any · list chart of accounts (**envelope** `{data,total,limit,offset}`; supports `?limit`/`?offset`)
- `GET    /v1/ledger/accounts/:id` · any · get one account
- `GET    /v1/ledger/accounts/:id/balance` · any · account balance (`?asOf=`)
- `POST   /v1/ledger/accounts` · ACCOUNTANT+ · create account. With `role: 'CASH'` the same rule as PATCH applies: the account must be a postable (`isPostable` not `false`), debit-normal `ASSET` → otherwise `422 VALIDATION_FAILED`
- `PATCH  /v1/ledger/accounts/:id` · ACCOUNTANT+ · update account `{name?, cashFlowCategory?, isActive?, role?}` (`isActive: false` follows the deactivate rules). `role` accepts **only `'CASH'`**: it marks an existing postable, debit-normal `ASSET` account with no role as a cash/bank account so payments can use it; any other role value — including `null` (a role cannot be cleared) — → `400`, a credit-normal/non-ASSET/header account or one that already holds a singleton role → `422 VALIDATION_FAILED`; an account used by any tax code (including a deleted one) → `422 VALIDATION_FAILED` `{ id, reason: "TAX_ACCOUNT" }`. Singleton roles (AR/AP control, retained earnings, opening-balance equity, tax expense) are create-only.
- `POST   /v1/ledger/accounts/:id/deactivate` · ADMIN · soft-deactivate account. Singleton system accounts (non-null `role` other than `CASH`) → `422`. A `CASH` account → `422` unless its balance is zero (`details.balance`) **and** another active, postable `CASH` account remains (`details.otherActiveCashAccounts: 0`). A reversal or document void may still post to an already-deactivated `CASH` account (it only undoes an earlier movement), which can leave it with a non-zero balance; move that balance with a manual entry after reactivating it (`PATCH { isActive: true }`)
- `DELETE /v1/ledger/accounts/:id` · ADMIN · soft-delete account (same system-account / `CASH` rules as deactivate; accounts with posted lines → `422`)

### Ledger — journal

- `GET    /v1/ledger/journal-entries` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, status, sourceType, fiscalYear, from, to, limit, offset`)
- `GET    /v1/ledger/journal-entries/:id` · any · get one entry
- `POST   /v1/ledger/journal-entries` · ACCOUNTANT+ · create draft (`?post=true` = create+post, APPROVER/ADMIN only) · **requires `Idempotency-Key`**
- `POST   /v1/ledger/journal-entries/:id/post` · APPROVER/ADMIN · post draft · **requires `Idempotency-Key`**
- `POST   /v1/ledger/journal-entries/:id/reverse` · APPROVER/ADMIN · reverse a posted MANUAL/OPENING entry (optional body `{ date }`; document-owned entries → `422`) · **requires `Idempotency-Key`**
- `DELETE /v1/ledger/journal-entries/:id` · ACCOUNTANT+ · delete draft
- `POST   /v1/ledger/opening-balances` · ADMIN · post opening balances · **requires `Idempotency-Key`**

### Ledger — periods & trial balance

- `GET    /v1/ledger/periods?fiscalYear=` · any · list monthly periods (bare array)
- `POST   /v1/ledger/periods/generate` · APPROVER/ADMIN · generate a year's periods
- `POST   /v1/ledger/periods/:id/close` · APPROVER/ADMIN · close a period
- `POST   /v1/ledger/periods/:id/reopen` · ADMIN · reopen a period
- `GET    /v1/ledger/trial-balance?asOf=` · any · trial balance

### Reports (all read, any auth)

Every report is **snapshot-consistent**: all of a report's queries read one
database snapshot (a read-only REPEATABLE READ transaction), so a posting that
commits while a report is being built is either entirely in it or entirely out
of it — never half (the next request sees it). Totals inside one response always
tie (`reconciles`, `balanced`, GL opening + lines = closing).

- `GET    /v1/reports/balance-sheet?asOf=` · any · Neraca — pre-closing view:
  a year-end closing entry dated **on** `asOf` is ignored, so Neraca at the
  fiscal year-end shows the year's profit as Laba (Rugi) Berjalan /
  `currentYearEarnings` (it moves into Laba Ditahan from the next day)
- `GET    /v1/reports/income-statement?from=&to=` · any · Laba Rugi — year-end
  closing entries (and their reopen reversals) are excluded, so figures are the
  same before and after a year is closed
- `GET    /v1/reports/general-ledger?accountId=&from=&to=` · any · Buku Besar —
  span capped at **366 days** (`422` beyond); response carries `truncated: true`
  when the 10,000-line cap cut the list (narrow the range; `closingBalance` stays
  correct either way)
- `GET    /v1/reports/ar-aging?asOf=` · any · AR aging — response carries a
  `truncated` flag (10,000 open-document cap)
- `GET    /v1/reports/ap-aging?asOf=` · any · AP aging — same `truncated` flag
- `GET    /v1/reports/cash-flow?from=&to=` · any · Arus Kas — closing entries
  excluded; opening-balance (Saldo Awal) entries dated inside the range are
  part of `kasAwal`, not operating/financing flows. **Intended:** `kasAwal` =
  cash balance at the day before `from` **plus** cash booked by OPENING entries
  dated inside `[from, to]`, so when the range contains Saldo Awal entries
  (e.g. a company that started bookkeeping mid-range) `kasAwal` is **not** the
  same as the Kas balance on `from − 1` — don't cross-check it against the
  trial balance of the previous day in that case. `reconciles` still ties.

### Sales invoices

- `GET    /v1/sales-invoices` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, status, limit, offset`)
- `GET    /v1/sales-invoices/:id` · any · get one
- `POST   /v1/sales-invoices` · ACCOUNTANT+ · create draft · **requires `Idempotency-Key`**
- `PATCH  /v1/sales-invoices/:id` · ACCOUNTANT+ · update draft
- `POST   /v1/sales-invoices/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/sales-invoices/:id/void` · APPROVER/ADMIN · void (optional body `{ date }` ≥ document date) · **requires `Idempotency-Key`**
- `DELETE /v1/sales-invoices/:id` · ACCOUNTANT+ · delete draft

### Purchase bills

- `GET    /v1/purchase-bills` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, status, limit, offset`)
- `GET    /v1/purchase-bills/:id` · any · get one
- `POST   /v1/purchase-bills` · ACCOUNTANT+ · create draft · **requires `Idempotency-Key`**
- `PATCH  /v1/purchase-bills/:id` · ACCOUNTANT+ · update draft
- `POST   /v1/purchase-bills/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/purchase-bills/:id/void` · APPROVER/ADMIN · void (optional body `{ date }` ≥ document date) · **requires `Idempotency-Key`**
- `DELETE /v1/purchase-bills/:id` · ACCOUNTANT+ · delete draft

### Payments

- `GET    /v1/payments` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, direction, status, limit, offset`)
- `GET    /v1/payments/:id` · any · get one
- `POST   /v1/payments` · ACCOUNTANT+ · create draft (RECEIPT/DISBURSEMENT + allocations) · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/void` · APPROVER/ADMIN · void (optional body `{ date }` ≥ document date) · **requires `Idempotency-Key`** · a payment whose partner has been deleted → `422 VALIDATION_FAILED` `{ id, partnerId, reason: 'PARTNER_DELETED' }` (voiding would reopen a balance on a deleted partner)
- `DELETE /v1/payments/:id` · ACCOUNTANT+ · delete draft

### Business partners

- `GET    /v1/partners` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, limit, offset`)
- `GET    /v1/partners/:id` · any · get one
- `POST   /v1/partners` · ACCOUNTANT+ · create
- `PATCH  /v1/partners/:id` · ACCOUNTANT+ · update
- `POST   /v1/partners/:id/deactivate` · ADMIN · deactivate
- `DELETE /v1/partners/:id` · ADMIN · delete. Refused while the partner has **open items** — a
  draft invoice/bill, a draft payment, or a `POSTED` invoice/bill with an outstanding balance
  → `422 VALIDATION_FAILED` `details: { id, reason: "OPEN_ITEMS", draftDocuments,
  outstandingDocuments, draftPayments }`. Settle/void/delete those first, or deactivate the
  partner instead.

### Tax

- `GET    /v1/tax/codes` · any · list tax codes (**envelope** `{data,total,limit,offset}`; supports `?limit`/`?offset`)
- `GET    /v1/tax/codes/:id` · any · get one
- `POST   /v1/tax/codes` · ACCOUNTANT+ · create. The `taxAccountId` must be a postable account
  with **no system role**, shaped for the `kind`: `PPN_INPUT`/`PPH_PREPAID` → a DEBIT-normal
  `TAX_RECEIVABLE` account; `PPN_OUTPUT`/`PPH_PAYABLE` → a CREDIT-normal `TAX_PAYABLE`
  account → else `422 VALIDATION_FAILED` `details: { taxAccountId, reason }` with `reason`
  `NOT_POSTABLE` | `SYSTEM_ROLE` (+`role`) | `NORMAL_BALANCE` (+`kind`, `normalBalance`) |
  `SUBTYPE` (+`kind`, `subtype`, `required`)
- `PATCH  /v1/tax/codes/:id` · ACCOUNTANT+ · update
- `POST   /v1/tax/codes/:id/deactivate` · ADMIN · deactivate
- `DELETE /v1/tax/codes/:id` · ADMIN · delete
- `POST   /v1/tax/calculate` · any · PPN/PPh preview (posts nothing)

### Journal-entry preview

- `POST   /v1/journal-entries/preview` · any · read-only balanced-JE dry run for a SALE/PURCHASE/PAYMENT document (posts nothing; **no `Idempotency-Key`**). Distinct from the manual-journal CRUD at `/v1/ledger/journal-entries`.

### Close

- `POST   /v1/close/year-end` · ADMIN · run year-end close (`{ fiscalYear }`) · **requires `Idempotency-Key`**
- `POST   /v1/close/year-end/:fy/reopen` · ADMIN · reopen a closed year · **requires `Idempotency-Key`**
- `GET    /v1/close/year-end/:fy` · any · close status (404 if none)

### Company

- `GET    /v1/company/settings` · any · company settings
- `PATCH  /v1/company/settings` · ADMIN · update company settings (changing `fiscalYearStartMonth` → `422` once any journal entry — even a draft —, closed period or year-end close exists; otherwise the OPEN periods are replaced by the current + next fiscal year for the new month)

### Audit

- `GET    /v1/audit` · ADMIN · audit log — **bare array** (no envelope) (filters: `userId, method, from, to, limit, offset`; `limit` default 50, **max 200**; `method` ∈ POST/PATCH/PUT/DELETE). One row per mutating request — including requests cut off with `408` and requests rejected by auth/role/throttle guards (`401`/`403`/`429`; rejection rows are capped at 60 per client IP and 600 in total per minute for anonymous callers, 60 per user per minute for signed-in ones). **`body`** is the sanitized request body, except: an **anonymous 4xx** row (no signed-in user — e.g. a failed refresh, any `401`) stores `{}`, except a **failed login** (`400`/`401`/`429` on `/v1/auth/login`), which stores only `{ "email": "<trimmed, lowercased>" }` (never the password); a body whose JSON exceeds **512 KiB** (signed-in callers — above any valid request, so an accepted write is always stored in full) or **8192 bytes** (anonymous) is stored as the object `{ "_truncated": true, "bytes": <n>, "preview": "<first 1024 chars of the JSON>" }` — always an object, render `preview` as text. **A `408` row does not mean nothing happened:** the timed-out handler may still commit afterwards (its record then exists with a later timestamp and no audit row of its own) — see *Retry after a timeout* under Idempotency. `path` (with query string) and `params` are truncated to 512 chars. `userId` filter must be a UUID (else `400`). `requestId` = the server trace id; `clientRequestId` = your sanitized `X-Request-Id` (or `null`)

### Response schema quick-map

Each endpoint's 2xx body resolves to a named schema in `openapi.json` — look up the
fields there; this is just the name to find. The seven enveloped list endpoints wrap
their items in `{ data, total, limit, offset }`; bare-array endpoints return the item
schema directly in an array.

| Domain           | Response schema(s)                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth             | `TokenPairDto` (login/refresh) · `AuthenticatedUserDto` (`/auth/me`, now incl. `mustChangePassword`) · `OkFlagDto` (`/auth/admin-only`, `/auth/change-password`)                                |
| Users            | single → `UserResponseDto` · list → `PaginatedUsersResponseDto` (envelope) · create / reset-password → `CreateUserResponseDto` (`{ user, tempPassword }`)                                      |
| Health / ops     | `HealthStatusDto` · `ReadinessStatusDto` · `/metrics` → `text/plain` (not JSON)                                                                                                                |
| Accounts         | list → `AccountListResponseDto` (envelope) · single → `AccountResponseDto` · balance → `AccountBalanceDto` · trial balance → `TrialBalanceDto`                                                 |
| Journal          | `JournalEntryResponseDto` (incl. `JournalLineResponseDto[]`) · list → `JournalEntryListResponseDto` (envelope; items `JournalEntryListItemDto`) · opening-balances → `JournalEntryResponseDto` |
| Periods          | `FiscalPeriodResponseDto` (bare array on list)                                                                                                                                                 |
| Tax              | list → `TaxCodeListResponseDto` (envelope) · single → `TaxCodeResponseDto` · calculate → `TaxCalculationDto` (`TaxBreakdownRowDto[]` + `CalculatedLineDto[]`)                                  |
| Journal preview  | `JournalPreviewResponseDto` (`JournalPreviewLineDto[]` + `totalDebit`/`totalCredit`/`balanced`)                                                                                                |
| Partners         | `BusinessPartnerResponseDto` (single) · list → `BusinessPartnerListResponseDto` (envelope)                                                                                                     |
| Sales invoices   | `SalesInvoiceResponseDto` (single; incl. optional `SalesInvoiceLineResponseDto[]`) · list → `SalesInvoiceListResponseDto` (envelope)                                                           |
| Purchase bills   | `PurchaseBillResponseDto` (single; incl. optional `PurchaseBillLineResponseDto[]`) · list → `PurchaseBillListResponseDto` (envelope)                                                           |
| Payments         | `PaymentResponseDto` (single; incl. optional `PaymentAllocationResponseDto[]`) · list → `PaymentListResponseDto` (envelope)                                                                    |
| Reports          | `BalanceSheetDto` · `IncomeStatementDto` · `GeneralLedgerDto` · `AgingReportDto` (AR & AP) · `CashFlowDto`                                                                                     |
| Close            | `YearEndClosingResponseDto`                                                                                                                                                                    |
| Company          | `CompanySettingsDto`                                                                                                                                                                           |
| Audit            | `AuditEntryDto` (bare array)                                                                                                                                                                   |
| Errors (4xx/5xx) | `ErrorEnvelopeDto`                                                                                                                                                                             |

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
- **User admin** — `/v1/users/*` CRUD + reset-password, ADMIN-only screen; surface the one-time temp password with a copy button.

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
- **Pagination helpers** — build one reusable envelope reader for the eight enveloped
  lists (`accounts`, `tax-codes`, `journal-entries`, `partners`, `sales-invoices`,
  `purchase-bills`, `payments`, `users`); treat remaining bare-array lists (`periods`, `audit`)
  as plain arrays. **BREAKING (from prior guide):** `accounts` and `tax-codes` now
  return the envelope — unwrap `.data` instead of using the response directly as an array.
