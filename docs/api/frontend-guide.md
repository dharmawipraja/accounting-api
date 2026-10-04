# Frontend Integration Guide — Indonesian Accounting API

This guide is the prose companion to [`openapi.json`](./openapi.json) (in this same
folder). The OpenAPI document carries the request/response **schemas**; this guide
carries the **conventions, role rules, lifecycles, and glossary** you need to build
a correct frontend. Everything here is derived from the API source code.

- Schemas / types → `openapi.json` (generate a typed client from it). Every 2xx response body is now fully typed under `components.schemas` as `*ResponseDto` / `*Dto` entries.
- Conventions / roles / lifecycles / glossary → this file.

---

> **Behaviour changes in this release (audit-3 iteration 8)**
>
> - **Blank names are rejected**: account and tax-code `name` (and `code`) that is
>   empty / whitespace-only → `400` on create and `PATCH` (partners already did);
>   a zero-width / format character in any partner / account / tax-code name → `400`.
> - **Identifier codes are normalized** (NFKC + trim; zero-width / control characters
>   → `400`) and **unique case-insensitively** — `dup` vs `DUP` → `409 CONFLICT`.
>   Existing codes that were untrimmed / full-width were normalized by the upgrade.
> - **Audit `from` / `to` are strict**: ISO date or date-time on a real day, year
>   1970–9999 — week/ordinal/basic forms and impossible days → `400`.
> - **(iteration 9)** More invisible characters are rejected in codes / names
>   (default-ignorable ones such as U+034F, Hangul fillers, variation selectors, tag
>   characters; in codes also an interior U+2028 / U+2029) — emoji keep working.
>   A code / name longer than 1024 characters is rejected by its length limit
>   without being normalized. Accounts: deleting / deactivating a header with
>   child accounts → `422 VALIDATION_FAILED` `details.reason: "HAS_CHILDREN"`; `parentCode` must name an **active**
>   header. `GET /v1/audit?method=MIGRATION` lists the codes / emails the upgrade
>   normalized. `Cache-Control: no-store` also on `/V1/...` spellings.
> - **`Cache-Control: no-store`** on every `/v1/*` response, and **no `ETag`**
>   headers (so no `304 Not Modified`) — don't rely on HTTP caching.
> - Emails are NFC-normalized (see *Login & tokens*); audit rows of idempotent
>   replays carry `replayed: true`.

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

- **Emails are case-insensitive.** The server trims, lowercases and Unicode
  NFC-normalizes the email on login and user creation (`' Budi@Example.COM '` logs in
  as `budi@example.com`; a decomposed `jose\u0301@…` is the same address as the
  precomposed `jos\u00e9@…`), and `GET /auth/me` / user responses always return that
  normalized form. Two users cannot differ only by case or Unicode composition (`409`). `password` is capped at **128** chars (`400`).
- Send the access token on every authenticated request:
  `Authorization: Bearer <accessToken>`.
- Tokens are typed (`typ: "access"` / `typ: "refresh"`): an access token is never
  accepted by `/auth/refresh` and vice versa. **Deploy note (2026-09):** tokens
  issued before this change carry no `typ` and are rejected with `401` — access
  tokens on the next request, refresh tokens on the next `/auth/refresh`. Handle
  it like any expired session: send the user back to login once.
- **Access tokens are short-lived** (~15 minutes; exact TTL is the server's
  `JWT_ACCESS_TTL`). **Refresh tokens last ~7 days** (`JWT_REFRESH_TTL`).
- **An access token dies with its session**, not only at expiry: after a logout of
  that session, logout-all, a password change (yours or an admin reset), a role
  change, deactivation or deletion, the next request with it is `401` — and so is
  the refresh. **Deploy note (2026-10):** access tokens issued before this change
  (no `sid` claim) are rejected with `401`; refresh once or log in again.
- **Concurrent refreshes are safe — two of them**: two tabs sending the same refresh
  token at once (within ~5s, server `REFRESH_REUSE_GRACE_MS`) both get a valid new
  pair. A THIRD use of that token, or a replay later than that, is treated as stolen:
  the whole session is revoked (`401`, back to login). Share one in-flight refresh
  across tabs (e.g. a lock / BroadcastChannel) and keep the newest pair.
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
| `GET /tax/coretax/faktur-keluaran` | 10 / min | authenticated user |
| Report file downloads (`?format=csv\|xlsx`) | 30 / min | authenticated user (JSON report calls not counted) |
| All other endpoints          | 300 / min | authenticated user |

Both login buckets apply at once: 10 attempts per account and 30 attempts per client
IP (whatever emails it tries), per minute. Either one returns **429**.

(Defaults; operators can override via `THROTTLE_LOGIN_LIMIT` / `THROTTLE_LOGIN_IP_LIMIT` / `THROTTLE_REFRESH_LIMIT`
/ `THROTTLE_CHANGE_PASSWORD_LIMIT` / `THROTTLE_CORETAX_EXPORT_LIMIT` / `THROTTLE_REPORT_EXPORT_LIMIT` / `THROTTLE_LIMIT`. Health/readiness/metrics probes
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
| **400**   | **Invalid characters** — a lone UTF-16 surrogate (e.g. a JSON `"\ud800"` escape, or a string sliced mid-emoji) or U+0000 (`\u0000`, `%00`) in any body key or string value, query key/value, or route path parameter; checked right after authentication and rate limiting, before role checks/validation (`details.location`: `"path"` / `"query"` / `"body"`). Precedence: without a valid token on a protected route you get **401** first; a login with a bad character still counts against the login rate limit; an unknown route (even with `%00`) is **404**. Emoji and all well-formed Unicode are fine — sanitize/strip the character client-side, never retry as-is | `INVALID_CHARACTERS`                                       |
| **401**   | Missing / expired / invalid token                                                                                                 | `UNAUTHORIZED`, `HTTP_401`                                 |
| **403**   | Wrong role, or Segregation-of-Duties block                                                                                        | `FORBIDDEN`, `SEGREGATION_OF_DUTIES`                       |
| **404**   | Resource not found (incl. soft-deleted)                                                                                           | `NOT_FOUND`                                                |
| **409**   | Conflict / closed period / closed year / unique violation                                                                         | `CONFLICT`, `CLOSED_PERIOD`, `CLOSED_YEAR`                 |
| **413**   | Request body over the 1 MB cap (rejected before auth/validation; the envelope has no `traceId`) — send smaller requests, never retry as-is | `PAYLOAD_TOO_LARGE`                                        |
| **415**   | Unsupported request charset (JSON must be UTF-8/`utf-*`) or `Content-Encoding` (rejected before auth/validation; no `traceId`) — fix the request, never retry as-is | `HTTP_415`                                                 |
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
  - **Non-blank** (`400` "`<field>` must not be blank"): partner / account / tax-code
    `code` and `name` on create, their `name` on `PATCH` —
    an empty or whitespace-only value is rejected.
  - **Identifier codes are normalized** (partner / account / tax-code `code`, account
    `parentCode`): the server applies Unicode **NFKC** (full-width `ＤＵＰ-１` → `DUP-1`)
    and trims surrounding white space, and **stores that form** (case kept — show what
    the response returns). A code containing an invisible **format** character (zero-width
    space U+200B, zero-width joiner U+200D, BOM U+FEFF, bidi controls, soft hyphen, tag
    characters …), a **control** character (tab, newline …), a line / paragraph
    separator (U+2028 / U+2029) inside it, or any other **default-ignorable** character
    (combining grapheme joiner U+034F, Hangul fillers U+115F / U+1160 / U+3164 / U+FFA0,
    variation selectors U+FE00–FE0F …) → `400`. Names are trimmed and reject format and
    default-ignorable characters the same way (no NFKC, no case change; control
    characters are allowed) — except inside emoji: the zero-width joiner of a sequence
    such as 👨‍👩‍👧 / 🏳️‍🌈 and the emoji-presentation selector VS16 (U+FE0F, ❤️, 1️⃣) are
    kept. (Subdivision flags built from tag characters, e.g. 🏴󠁧󠁢󠁥󠁮󠁧󠁿, are rejected.) A code or
    name longer than **1024** characters is not normalized at all — its length limit
    rejects it (`400`). **Codes are unique
    case-insensitively among live records:** `dup`, `DUP`, `DUP ` and `ＤＵＰ` are one
    code → `409 CONFLICT` for the second one. A deleted record's code is reusable in
    any case. Account `parentCode` matches the header's code case-insensitively too
    (`hdr-1` finds `HDR-1`).
  - **Tax-code `rate`** (create / `PATCH`): a decimal string with at most 3 integer
    digits and 6 decimals, at most 10 characters (`^\d{1,3}(\.\d{1,6})?$`, e.g. `0.11`)
    — else `400`; the `(0, 1)` range is still a `422` from the service.
  - **Malformed JSON body** (not parseable, e.g. a truncated `{"code": "X",`) →
    `400` `{ "code": "HTTP_400", "message": "<the JSON parser's message>" }` — the
    message is body-parser's own text (e.g. `Unexpected end of JSON input`; wording
    varies by runtime, never parse it) and there is **no** `details.errors`. It is
    raised before authentication, so it also has no field to highlight: treat it as a
    client bug (the frontend sent a broken body), not a user input error.
  - **Corrupt compressed body** (`Content-Encoding: gzip` / `deflate` whose bytes do not
    decompress) → the same `400` `{ "code": "HTTP_400", "message": "<zlib's message>" }`
    (e.g. `incorrect header check`), also before authentication (never a `500`).
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
| `INVALID_CHARACTERS`    | 400  | Lone UTF-16 surrogate or U+0000 in the path, query or body    |

Prisma-level failures are normalized too: a unique conflict surfaces as `409 CONFLICT`,
a missing row as `404 NOT_FOUND`, malformed input as `400 INVALID_INPUT`, and a
request that trips a database CHECK / NOT NULL rule the service validation missed as
`422 VALIDATION_FAILED` ("The request violates a data constraint" — a generic backstop,
no field details; treat like any other 422).
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
  line `quantity`, `unitPrice`, `discountPercent`, `discountAmount` and `amount`.
  Never `Number()` them.
- **Soft-delete bookkeeping is omitted.** `deletedAt` / `deletedBy` are intentionally
  absent from every response schema (a row you can read is, by definition, live).
- **Computed fields** appear on documents beyond their stored columns: sales invoices
  and purchase bills carry `outstanding` (= `total − amountPaid − creditedTotal`) and `paymentStatus`
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
  original response (201/200) without re-executing the write. Safe to retry. Its
  audit row (`GET /v1/audit`) carries **`replayed: true`** (same `entityId` as the
  original row) — it is not a second creation.
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
> `code` constraint (duplicate — compared case-insensitively after normalization,
> see *Identifier codes* above → `409 CONFLICT`). `POST /v1/ledger/periods/generate`
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

- Accounting dates are **date-only**, `YYYY-MM-DD` (no time component), and must be
  sent exactly so. A timestamp for a business date (journal, document, due, payment,
  void/reverse date, report `asOf`/`from`/`to`) → **`400`** — never send
  `new Date().toISOString()`: at 00:30 WIB on July 1 it reads `2026-06-30T17:30Z`. Format
  the user's local calendar day instead. An impossible day (e.g. `2026-02-30`) → `400`. (Audit-log
  `from`/`to` filters are timestamps and keep their time; they must be a strict ISO
  `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM]` on a real calendar day with a
  year in 1970–9999 — anything else, e.g. `0000-01-01`, `2026-02-30`, `2026-W01`,
  → `400`.)
- Report query parameters:
  - `?asOf=YYYY-MM-DD` — **balance sheet**, **AR/AP aging**, **trial balance**,
    account balance. Defaults to **today in WIB** (UTC+7; server-configurable via
    `REPORT_UTC_OFFSET_MINUTES`) if omitted — still, prefer sending an explicit
    `asOf` computed client-side so the user's own clock wins.
  - `?from=YYYY-MM-DD&to=YYYY-MM-DD` — **income statement**, **cash flow**,
    **general ledger**. `from` must be on or before `to` (else `422 VALIDATION_FAILED`);
    the general-ledger span is capped at 366 days.
- Periods are **monthly**, grouped by fiscal year (an integer like `2026`).

### Caching

Every `/v1/*` response (including auth and error responses) is sent with
**`Cache-Control: no-store`** and without an `ETag`: financial data is per-user and
must never be kept by a browser, proxy or CDN. Don't add client-side HTTP caching on
top; use your own in-memory state (e.g. a query cache) and refetch. The probes
(`/health`, `/ready`, `/metrics`) are not affected.

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
- Success revokes **all** of the user's sessions — every device, **including the
  tab that just changed the password**, is signed out immediately (its access token
  is `401` on the next request). Send the user to login with the new password.
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

- Debits must equal credits or you get `422 UNBALANCED_ENTRY` (checked at post /
  `?post=true`; a plain DRAFT may still be unbalanced while it is being worked on).
- **Every line needs exactly one side > 0** — enforced already on DRAFT create: a line
  with both `debit` and `credit`, with neither, or with only a zero amount (`"0"`) →
  `422 UNBALANCED_ENTRY` ("Each line must have exactly one of debit or credit > 0").
- A manual entry may not touch the **AR/AP control accounts** (`role` `AR_CONTROL` /
  `AP_CONTROL`) — on create (draft or `?post=true`) and on `/:id/post` you get
  `422 VALIDATION_FAILED` with message
  `"AR/AP control accounts can only be posted through sales invoices, purchase bills and payments"`
  and `details: { accountId, role }`. Hide those accounts from the manual-entry account
  picker. Opening balances (`POST /ledger/opening-balances`) are still allowed on them,
  but only until the first sales invoice, purchase bill or payment exists (any status):
  after that an AR/AP control line in opening balances → `422 VALIDATION_FAILED`
  `details: { accountId, role, reason: 'DOCUMENTS_EXIST' }`.
- **No advance accounts in opening balances.** A line on *Uang Muka Pelanggan* /
  *Uang Muka Pembelian* (`role` `CUSTOMER_ADVANCE` / `VENDOR_ADVANCE`) →
  `422 VALIDATION_FAILED` `details: { accountId, role, reason: 'ADVANCE_IN_OPENING' }`:
  a lump sum there belongs to no partner, so it could never be applied or refunded.
  Enter each go-live customer deposit / vendor prepayment as an **opening credit**
  (`POST /v1/payments` with `opening: true`, see Payment) instead.
- **Only one live opening-balance entry.** Posting opening balances while an earlier
  opening entry is still posted (not reversed) → `409 CONFLICT`
  `details: { existingEntryId, entryRef }`. To correct opening balances, reverse that
  entry (`POST /v1/ledger/journal-entries/:existingEntryId/reverse`) and post again.
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
  otherwise, `details: { entryId, date, originalDate }`), may **not be in the future** —
  after `max(today's company date (WIB), the entry's own date)` → `422 VALIDATION_FAILED`
  "Reversal date cannot be in the future" `details: { date, today }` (plus
  `originalDate` when the entry itself is future-dated: it may always be reversed on its
  own date, exactly like a body-less reverse) — and must fall in an OPEN period of a
  non-closed year (`409 CLOSED_PERIOD` / `409 CLOSED_YEAR`); a non `YYYY-MM-DD` value is
  `400`. A body-less reverse (original date) is never refused as future. ⚠️ The document **void** endpoints use a *different* detail shape for the same
  kind of error — see [Void date](#sales-invoice--purchase-bill).
- Only `MANUAL` and `OPENING` entries can be reversed here. Reversing a document-owned
  entry (`SALES_INVOICE`, `PURCHASE_BILL`, `SALES_CREDIT_NOTE`, `PURCHASE_DEBIT_NOTE`, `PAYMENT`) — or a `REVERSAL`/`CLOSING`
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
`409 CONFLICT` (`Invoice was changed while being posted (document, tax code or partner
state); retry`) — reload and retry. The same `409` results when a tax code's rate/account
keeps changing across those restarts.

**Post re-validates tax and partner under the lock.** Inside the post transaction the
tax is recomputed from the current tax codes and company settings; if a tax code's
rate/account changed after the draft was read, the post restarts internally and posts
the **current** rate (the posted totals may differ from the draft's stored totals —
re-read the response). The same applies to a **journal preview** shown earlier: if a
tax rate changed between the preview and the post, the post uses the **new** rate, so
always display the totals from the post response, not the preview. A tax code deactivated/deleted in the meantime, or `isPkp`
switched off for a PPN document, → `422 VALIDATION_FAILED` (same message as create).
The partner is re-checked too: deactivated / no longer a customer (vendor) / deleted
→ `422 VALIDATION_FAILED` `Partner is not an active customer` (`vendor`)
`{ partnerId }`. The document stays `DRAFT` in every `422` case. **Deleted partner —
404 vs 422:** a partner already soft-deleted when the post starts fails the pre-check
with `404 NOT_FOUND` (partner not found); a partner deleted *while* the post is running
is caught by the in-transaction re-check and gives the `422` above. Treat both as
"partner no longer usable".

**Line accounts.** On create, `PATCH` and `/post`, each line's `accountId` is checked —
**every** line, including a free (zero-amount) line that produces no journal line, so a
draft that `PATCH` would reject is rejected by `/post` too.
First the same postable-account check as posting: an unknown / deleted account, a header
(non-postable) account or an inactive account → `422 INVALID_ACCOUNT`
`details: { accountId }` (never a `409` FK error). A `PATCH` re-checks the effective lines —
also the stored ones when `lines` is omitted, so a draft whose account was deactivated
since must have that line changed before any other edit (or post) succeeds. Then the
document line rules; violations return `422 VALIDATION_FAILED`.
**Scope — draft vs post (by design):** draft create / `PATCH` check only the
document's **line** accounts. The tax-code accounts and the AR/AP control account are
not part of a draft; they are checked when the full journal entry is derived — by
`/post` and by `POST /v1/journal-entries/preview` — so a draft can save cleanly and
still get `422` at post (e.g. a tax code whose account was deactivated, or a missing
AR/AP control account). Use the preview to surface those before posting.
Line-rule violations:

| Violation | `details` |
| --- | --- |
| Line on an AR/AP control or `CASH` account | `{ accountId, role }` (`AR_CONTROL` / `AP_CONTROL` / `CASH`) |
| Line on a tax account (used by any tax code, e.g. PPN Keluaran/Masukan) — apply a tax code instead | `{ accountId, reason: "TAX_ACCOUNT" }` |
| Sales line not a revenue account (`type` `REVENUE` or subtype `OTHER_INCOME`); purchase line not `EXPENSE`/`ASSET` | `{ accountId, reason: "ACCOUNT_TYPE" }` |
| Purchase line on a **contra-asset** (`ASSET` with `normalBalance` `CREDIT`, e.g. Akumulasi Penyusutan) | `{ accountId, reason: "CONTRA_ASSET" }` |
| Purchase line on a **contra-expense** (`EXPENSE` with `normalBalance` `CREDIT`, e.g. Potongan/Retur Pembelian) — purchase returns/discounts need debit notes (not yet supported) | `{ accountId, reason: "CONTRA_EXPENSE" }` |
| Sales line on a **contra-revenue** (`REVENUE` with `normalBalance` `DEBIT`, e.g. Retur/Potongan Penjualan) — returns need credit notes (not yet supported) | `{ accountId, reason: "CONTRA_REVENUE" }` |

**Other document rules** (create, `PATCH` and — where noted — `/post`):

- **Free lines.** A line may have `unitPrice` (or `quantity`) `0` — a free item. It is
  stored and shown on the document but produces no journal line (nor does a tax code
  whose base is only free lines). A document whose **total is 0** (every line free) is
  rejected: `422 VALIDATION_FAILED` "Document total must be greater than zero" (create,
  `PATCH`, `/post`, tax/journal preview).
- **Line discounts (before tax).** A line may carry an optional discount: **either**
  `discountPercent` (decimal string `0`–`100`, up to 4 dp, e.g. `"10"` or `"12.5"`)
  **or** `discountAmount` (money string). Sending both, a percent over `100` or a
  malformed value → `400`; a `discountAmount` above `quantity × unitPrice` → `422
  VALIDATION_FAILED` `{ lineNo, gross, discountAmount }`. The line's `amount` is the
  **net** DPP: `quantity × unitPrice` (4 dp, half-up) `− discountAmount`, where a
  percent resolves to `gross × percent / 100` rounded **once** to 4 dp (half-up). PPN /
  PPh are computed on that net amount, and revenue / expense posts at the net amount —
  there is no separate "Potongan" contra account. Responses echo each line's
  `discountPercent` (as entered, 4 dp, `null` for a fixed or no discount) and the
  resolved `discountAmount` (`"0.0000"` when none); the document carries `discountTotal`
  (sum of line discounts). `subtotal` stays the sum of the (net) line `amount`s, so gross
  = `subtotal + discountTotal`. A 100% line is a free line (below). On `PATCH` without
  `lines`, the stored discounts are kept; with `lines`, send each line's discount again.
  Documents without discounts are unchanged.
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
- `date` after **`max(today, document date)`** (today = the company's calendar day,
  WIB) → `422 VALIDATION_FAILED` "Void date cannot be in the future"
  `details: { date, today }` (today itself is fine). A **future-dated** document may be
  voided with an explicit `date` equal to (or before) its own date — the same date a
  body-less void uses; a later `date` gets the 422 with `details: { date, today,
  originalDate }`. Only an explicit `date` is checked — a body-less void (document date)
  is never refused as future. Default the date picker's max to `max(today, document
  date)` from the server's point of view (WIB).
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
                          optional amount + allocations to invoices/bills (ACCOUNTANT+)
POST /payments/:id/post   post the payment                            (APPROVER/ADMIN)
POST /payments/:id/apply  apply unapplied (advance) amount to documents (APPROVER/ADMIN)
POST /payments/:id/applications/:applicationId/reverse
                          reverse one application                     (APPROVER/ADMIN)
POST /payments/:id/refunds
                          refund unapplied amount in cash             (APPROVER/ADMIN)
POST /payments/:id/refunds/:refundId/reverse
                          reverse one refund                          (APPROVER/ADMIN)
POST /payments/:id/void   void a posted payment                       (APPROVER/ADMIN)
DELETE /payments/:id      delete a DRAFT                               (ACCOUNTANT+)
```

Payment void takes the same optional `{ "date" }` body and rules as invoice/bill void
(above); allocations are unwound and `voidedOn` is returned.

RECEIPT = money in (against AR), DISBURSEMENT = money out (against AP).

**Advances / unapplied payments (new).** `amount` is optional: omitted, it is the sum of
the allocations (a fully allocated payment, exactly as before). When `amount` is larger
than the allocations — including **no allocations at all** (`allocations` may be `[]` or
omitted) — the rest is an **advance**: it posts to *Uang Muka Pelanggan* (2-1300,
liability, receipts) or *Uang Muka Pembelian* (1-1600, asset, disbursements) instead of
AR/AP, and the payment's `unappliedAmount` shows it. Overpaying an invoice = allocate its
outstanding, the rest stays unapplied (an allocation still may not exceed a document's
outstanding). Errors on create: allocations > `amount` → `422 { amount, allocated }`;
neither a positive `amount` nor an allocation → `422`.

| Flow | Journal |
| --- | --- |
| RECEIPT, partly allocated | Dr Kas `amount` / Cr Piutang allocated, Cr Uang Muka Pelanggan unapplied |
| DISBURSEMENT, partly allocated | Dr Utang allocated, Dr Uang Muka Pembelian unapplied / Cr Kas `amount` |
| apply (receipt) | Dr Uang Muka Pelanggan / Cr Piutang — one entry per allocation |
| apply (disbursement) | Dr Utang / Cr Uang Muka Pembelian — one entry per allocation |

`POST /payments/:id/apply` `{ "date": "YYYY-MM-DD", "allocations": [{ "salesInvoiceId" |
"purchaseBillId", "amount" }] }` (requires `Idempotency-Key`; 1–100 allocations) moves
unapplied amount onto POSTED invoices (receipt) / bills (disbursement) of the same
partner. `date` must be on/after the payment date (`422 { id, date, paymentDate }`) and
each document date, in an open period/year (`409` otherwise). Allocation rules are those
of create (same partner, POSTED, within outstanding, backdated-void rule). More than
`unappliedAmount` → `422 { id, unappliedAmount, requested }` (also when a concurrent apply
won). SoD: the entry's creator is the payment's creator, so with segregation of duties on,
whoever created the payment cannot apply it (`403`). Each application is listed in the
payment's `applications` (`{ id, salesInvoiceId, purchaseBillId, amount, date,
journalEntryId, createdBy, reversedOn, reversedBy }`).

`POST /payments/:id/applications/:applicationId/reverse` (optional `{ "date" }`, default
the application date; not before it, not after today WIB) reverses that application's
journal entry and returns the amount to the document's outstanding and to
`unappliedAmount`. Twice → `422`.

**Refunds (new).** Unapplied credit can also be paid back in cash instead of applied:
`POST /payments/:id/refunds` `{ "date": "YYYY-MM-DD", "amount", "cashAccountId",
"description"? }` (requires `Idempotency-Key`; APPROVER/ADMIN; same SoD as apply — the
payment's creator cannot refund it, `403`). `cashAccountId` is any CASH-role (cash/bank)
account, checked like a payment's. Rules: POSTED holder; `date` on/after the payment
date (`422 { id, date, paymentDate }`), not after today WIB (`422 { date, today }`), in
an open period/year (`409`); `amount` > 0 and ≤ `unappliedAmount` →
`422 { id, unappliedAmount, requested }` (also when a concurrent apply/refund won — both
serialize on the payment row); the partner must be active with the customer/vendor flag.

| Flow | Journal |
| --- | --- |
| refund (receipt — we pay the customer back) | Dr Uang Muka Pelanggan / Cr Kas/Bank |
| refund (disbursement — the vendor pays us back) | Dr Kas/Bank / Cr Uang Muka Pembelian |

Refunds are listed in the payment's `refunds` (same row shape as `applications`, with
`cashAccountId` set and no document id); `applications` only holds applications onto
documents. `POST /payments/:id/refunds/:refundId/reverse` (optional `{ "date" }`, same
rules as an application reversal) reverses the refund's journal and returns the amount
to `unappliedAmount`. An application id on the refund route (or the reverse) → `404`. A
fully refunded payment (`unappliedAmount` 0) is no longer an open item of its partner.
In the cash-flow report a refund is an operating flow (the advance accounts are
OPERATING).

**Opening credit (go-live deposits / prepayments, new).** `POST /payments` with
`"opening": true`, `amount` required, **no** `cashAccountId` and no `allocations`
(`422 { reason: "OPENING_CREDIT_SHAPE" }` otherwise) creates a payment whose counter
account is *Saldo Awal* (role `OPENING_BALANCE_EQUITY`, returned as `cashAccountId`) —
no cash moves, so the cash already in the opening-balance entry is not counted twice.
Post it as usual (`/post`); journal: RECEIPT Dr Saldo Awal / Cr Uang Muka Pelanggan,
DISBURSEMENT Dr Uang Muka Pembelian / Cr Saldo Awal. The whole amount is
`unappliedAmount`, applied or refunded like any advance; `opening: true` marks it in
responses. It is excluded from the cash-flow report (a beginning balance, like the
opening entry); its later applications/refunds are not.

**Void with applications:** a payment with a live (unreversed) application or refund
cannot be voided → `422 { id, reason: "HAS_APPLICATIONS", applications }` (the count
covers both); reverse them first. The
void date must also be on/after the latest application reversal date → `422 { id, date,
applicationReversedOn }`. A voided payment shows `unappliedAmount: "0.0000"`.

**Open credit per partner:** `GET /payments?partnerId=…&unapplied=true` lists the POSTED
payments with an unapplied balance (`unapplied=false` the rest). Advances are **not**
AR/AP, so they never appear in aging; a partner with an unapplied advance cannot be
deleted (`OPEN_ITEMS` with `unappliedPayments`). **PPN on advances (faktur uang muka) is
out of scope:** no tax is computed on an advance; tax is on the invoice it is applied to.
The journal preview (`nature: "PAYMENT"`) covers fully allocated payments only.

`cashAccountId` must first be an existing, postable (not a header) and **active**
account — otherwise, on create, on `/post` and in the journal preview,
`422 INVALID_ACCOUNT` `details: { accountId }` (changed: payment **create** used to
answer `422 VALIDATION_FAILED` "Cash account is not postable" `{ cashAccountId }`) — and
then a **`CASH`-role** account (Kas / Bank) — otherwise `422 VALIDATION_FAILED` with
`details: { accountId, role }` (`role` is the account's actual role, possibly `null`).

The payment `date` must be **on/after the date of every invoice/bill it allocates to** —
otherwise, on create (and re-checked on `/post`), `422 VALIDATION_FAILED` with
`details: { paymentDate, documentId, documentDate }`.

**Backdating next to a later-voided payment.** A payment voided on a later date than its
own still counts as paid for `asOf` dates before its `voidedOn` (AR/AP aging honours
it). A new payment dated inside such a window must still fit beside it: for every day
from the new payment's date on, the document's as-of paid amount (posted payments plus
voided-but-still-live ones) plus the new allocation must not exceed the document total —
otherwise, on create (and re-checked under the document lock on `/post`; the payment
stays `DRAFT`), `422 VALIDATION_FAILED` with `details: { documentId, paymentDate,
conflictingVoidedOn }`. Dating the payment **on/after `conflictingVoidedOn`** (the
latest such void date) always clears this rule; a smaller amount may too. Example:
invoice 100 dated the 1st, payment A 100 dated the 10th voided on the 12th → a new
payment of 100 dated the 11th is rejected, dated the 12th it is accepted. Plain
over-allocation against the current outstanding keeps its own error (`422` on create,
`409 CONFLICT` "Allocation now exceeds outstanding" on `/post`).

The partner is re-checked on `/post` too: it must still exist, be active and carry the
direction's flag (customer for RECEIPT, vendor for DISBURSEMENT) → else `422
VALIDATION_FAILED` `details: { partnerId }` ("Partner is inactive" / "Receipt requires a
customer" / "Disbursement requires a vendor").

### Credit note / debit note (nota retur)

```
POST /sales-credit-notes          → DRAFT (ACCOUNTANT+)   — or /purchase-debit-notes
PATCH /sales-credit-notes/:id     edit draft
POST /sales-credit-notes/:id/post → POSTED (APPROVER/ADMIN)
POST /sales-credit-notes/:id/void → VOID   (APPROVER/ADMIN)
POST /sales-credit-notes/:id/apply  apply its partner credit to invoices (APPROVER/ADMIN)
```

A note returns part of **one POSTED** invoice (credit note) / bill (debit note):
`originalId`, dated on/after it; its partner is the original's. Lines are `{
originalLineId, quantity }` only — description, account, unit price and tax codes are
copied from the original line; a percent discount keeps its percent, a fixed discount is
pro-rated by quantity (4 dp, half-up). The returned quantity per original line, summed
over every live (draft or posted) note, may not exceed the original quantity → `422
VALIDATION_FAILED` "Returned quantity exceeds the quantity still returnable" `details: {
originalLineId, quantity, returnable }` (on create, edit and post). Other `422`s: the
original is not POSTED, a line of another document, the same line twice, a zero quantity,
a date before the original's.

Posting books the **mirror** of the original's journal for the returned part (tax
recomputed on the returned DPP). The note `total` first settles the original:
`creditedAmount` on the note and `creditedTotal` on the invoice/bill, whose `outstanding`
is now `total − amountPaid − creditedTotal` (and `paymentStatus` counts credit as
settled). If the original was already (partly) paid, the **excess** becomes partner
credit on Uang Muka Pelanggan / Pembelian — the note's `unappliedAmount` — applied to
other invoices/bills with `POST …/:id/apply` exactly like a payment advance (`applications`
rows carry `salesCreditNoteId` / `purchaseDebitNoteId`; `paymentId` is `null`), or
refunded in cash with `POST …/:id/refunds` / reversed with
`POST …/:id/refunds/:refundId/reverse` — same body, rules and journals as payment
refunds (listed in the note's `refunds`).

**Void:** only a POSTED note, only while none of its credit is applied (`422 { id,
reason: "HAS_APPLICATIONS" }` — reverse the applications first; the void date must be
on/after the latest reversal). It gives the credit back to the original. An invoice/bill
with a live (draft or posted) note cannot be voided → `422 { id, reason: "HAS_NOTES",
notes }`; void/delete its notes first. Journal entries list with
`?sourceType=SALES_CREDIT_NOTE` / `PURCHASE_DEBIT_NOTE`.

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
- **Only a fiscal year that has ended can be closed**: its last day must be strictly before
  today (company calendar day, WIB) — not on the year's last day itself (that day's
  documents can still arrive); close from the next day on.
  A year still running (or a future one) → `422 VALIDATION_FAILED`
  `details: { fiscalYear, yearEnd }` (`yearEnd` = `YYYY-MM-DD`). Reopen is unaffected.
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
user is editing an invoice/bill. Its line `amount` (like the journal-entry preview's)
is the **net** line amount: for a discounted line send `quantity × unitPrice −
discountAmount` (see *Line discounts* above), exactly what the document stores.

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

- **`SALE` / `PURCHASE`** — the `POST /tax/calculate` line shape, plus `nature`; unlike
  `/tax/calculate` (where `settlementAccountId` is **required** and used), the preview
  does **not** take a settlement account — `settlementAccountId` is deprecated and
  ignored **for the preview only**:

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

- **`PAYMENT`** — its own shape, the same `amount` / `allocations` as `POST
  /payments` (a payment has no tax lines; its entry is cash ↔ AR/AP control for the
  allocation total, plus a customer/vendor **advance** line for any `amount` above it):

  ```jsonc
  {
    "nature": "PAYMENT",
    "direction": "RECEIPT", // or "DISBURSEMENT"
    "cashAccountId": "<uuid>",
    "amount": "800000.0000", // optional; defaults to the allocation sum
    "allocations": [{ "salesInvoiceId": "<uuid>", "amount": "500000.0000" }],
  }
  // DISBURSEMENT allocations use "purchaseBillId" instead
  // A pure advance: "amount" with no / empty "allocations"
  ```

  Same `422`s as payment create: no `amount` and no allocations, or allocations
  above `amount`.

- **Fields of the other shape are rejected.** A `SALE`/`PURCHASE` body carrying
  `direction`, `cashAccountId` or `allocations`, and a `PAYMENT` body carrying `lines`
  or `settlementAccountId`, is a `400` (`HTTP_400`, per-field message "`<field>` is
  only allowed when nature is …") — never silently ignored. Send only the fields of
  the chosen `nature` (e.g. clear the payment fields when the user switches the
  preview from a payment to an invoice).

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
allocation, plus the same line-account / cash-account rules, in the same order, as the
documents — every SALE/PURCHASE line account (a free zero-amount line included) must
exist, be postable and active (`422 INVALID_ACCOUNT`) before the document line rules run
(a line on a control/cash/tax or wrong-type account → `422 VALIDATION_FAILED`); a payment
`cashAccountId` gets `INVALID_ACCOUNT` then the `CASH`-role rule; **`400`**
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
| `5-9100` | Beban PPh Final       | Final PPh 4(2) withheld by customers (expense) |

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
- `POST   /auth/change-password` · any (authenticated) · self-service `{currentPassword, newPassword}`; revokes **all** the caller's sessions, the calling access token included — log in again (see [Forced password change](#forced-password-change)). If an admin resets the same account's password while the change is in flight, the reset wins and the change answers `401` "Current password is incorrect" (sessions are revoked by the reset anyway) — send the user to login

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
- `POST   /v1/ledger/accounts` · ACCOUNTANT+ · create account. With `role: 'CASH'` the same rule as PATCH applies: the account must be a postable (`isPostable` not `false`), debit-normal `ASSET` → otherwise `422 VALIDATION_FAILED`. A singleton role (AR/AP control, retained earnings, opening-balance equity, tax expense) already held by another account → `409 CONFLICT` "That account role is already assigned" `{ role }` (also when two requests race for it). `parentCode` must name a live, **active**, non-postable header → otherwise `422 VALIDATION_FAILED` ("Parent account not found" / "… must be a non-postable header" / "Parent account must be active", `details.parentCode`)
- `PATCH  /v1/ledger/accounts/:id` · ACCOUNTANT+ · update account `{name?, cashFlowCategory?, isActive?, role?}` (`isActive: false` follows the deactivate rules; `isActive: true` under an inactive parent header → `422 VALIDATION_FAILED` `{ id, reason: "PARENT_INACTIVE", parentId }` — reactivate the header first). `role` accepts **only `'CASH'`**: it marks an existing postable, debit-normal `ASSET` account with no role as a cash/bank account so payments can use it; any other role value — including `null` (a role cannot be cleared) — → `400`, a credit-normal/non-ASSET/header account or one that already holds a singleton role → `422 VALIDATION_FAILED`; an account used by any tax code (including a deleted one) → `422 VALIDATION_FAILED` `{ id, reason: "TAX_ACCOUNT" }`. Singleton roles (AR/AP control, retained earnings, opening-balance equity, tax expense) are create-only.
- `POST   /v1/ledger/accounts/:id/deactivate` · ADMIN · soft-deactivate account. Singleton system accounts (non-null `role` other than `CASH`) → `422`. A `CASH` account → `422` unless its balance is zero (`details.balance`) **and** another active, postable `CASH` account remains (`details.otherActiveCashAccounts: 0`). A reversal or document void may still post to an already-deactivated `CASH` account (it only undoes an earlier movement), which can leave it with a non-zero balance; move that balance with a manual entry after reactivating it (`PATCH { isActive: true }`)
- `DELETE /v1/ledger/accounts/:id` · ADMIN · soft-delete account (same system-account / `CASH` rules as deactivate; accounts with posted lines → `422`). A header with any live (not deleted) child account → `422 VALIDATION_FAILED` `{ id, reason: "HAS_CHILDREN", children }` — delete the children first (or deactivate the header instead). Deactivating (`POST …/deactivate` or `PATCH { isActive: false }`) a header with **active** children → the same `422` (`reason: "HAS_CHILDREN"`) — deactivate the children first

### Ledger — journal

- `GET    /v1/ledger/journal-entries` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, status, sourceType, fiscalYear, from, to, limit, offset`)
- `GET    /v1/ledger/journal-entries/:id` · any · get one entry
- `POST   /v1/ledger/journal-entries` · ACCOUNTANT+ · create draft (`?post=true` = create+post, APPROVER/ADMIN only) · **requires `Idempotency-Key`**
- `POST   /v1/ledger/journal-entries/:id/post` · APPROVER/ADMIN · post draft · **requires `Idempotency-Key`**
- `POST   /v1/ledger/journal-entries/:id/reverse` · APPROVER/ADMIN · reverse a posted MANUAL/OPENING entry (optional body `{ date }`: original date ≤ date ≤ max(today WIB, original date) — `422 { date, today[, originalDate] }`; document-owned entries → `422`) · **requires `Idempotency-Key`**
- `DELETE /v1/ledger/journal-entries/:id` · ACCOUNTANT+ · delete draft
- `POST   /v1/ledger/opening-balances` · ADMIN · post opening balances · **requires `Idempotency-Key`** · one live opening entry at a time (`409 CONFLICT { existingEntryId, entryRef }`); AR/AP control lines only before the first document (`422 { accountId, role, reason: "DOCUMENTS_EXIST" }`); advance accounts (Uang Muka) never (`422 { accountId, role, reason: "ADVANCE_IN_OPENING" }` — use opening-credit payments)

### Ledger — periods & trial balance

- `GET    /v1/ledger/periods?fiscalYear=` · any · list monthly periods (bare array)
- `POST   /v1/ledger/periods/generate` · APPROVER/ADMIN · generate a year's periods
- `POST   /v1/ledger/periods/:id/close` · APPROVER/ADMIN · close a period
- `POST   /v1/ledger/periods/:id/reopen` · ADMIN · reopen a period
- `GET    /v1/ledger/trial-balance?asOf=&preClosing=` · any · trial balance.
  Default is post-closing: at a closed fiscal year-end the closing entry is counted
  and P&L accounts show 0. `preClosing=true` (only `true`/`false` accepted, else
  `400`) leaves out the closing entry dated **on** `asOf` (and its reopen reversal),
  so P&L accounts show their year-end balances — the TB as it was before the close,
  consistent with the Neraca. Balances (`totalDebit = totalCredit`) either way

### Reports (all read, any auth)

Every report is **snapshot-consistent**: all of a report's queries read one
database snapshot (a read-only REPEATABLE READ transaction), so a posting that
commits while a report is being built is either entirely in it or entirely out
of it — never half (the next request sees it). Totals inside one response always
tie (`reconciles`, `balanced`, GL opening + lines = closing on the last page).

- `GET    /v1/reports/balance-sheet?asOf=` · any · Neraca — pre-closing view:
  a year-end closing entry dated **on** `asOf` is ignored, so Neraca at the
  fiscal year-end shows the year's profit as Laba (Rugi) Berjalan /
  `currentYearEarnings` (it moves into Laba Ditahan from the next day).
  Laba (Rugi) Berjalan (equity group `CURRENT_EARNINGS`) is **only** the fiscal
  year containing `asOf`; profit of earlier fiscal years that were never closed
  (or were reopened) is shown as retained earnings in a separate equity group
  `UNCLOSED_PRIOR_EARNINGS` ("Laba Ditahan (tahun belum ditutup)", present only
  when non-zero) and in `unclosedPriorYearsEarnings` (`"0.0000"` once every
  prior year is closed)
- `GET    /v1/reports/income-statement?from=&to=` · any · Laba Rugi — year-end
  closing entries (and their reopen reversals) are excluded, so figures are the
  same before and after a year is closed. Every section has per-account lines
  summing to its total: `revenueLines`, `cogsLines`, `operatingExpenseLines`,
  `otherIncomeLines`, `otherExpenseLines`, `taxExpenseLines` (`{code, name, amount}`)
- **Comparatives** (both reports, optional): `income-statement?…&compareFrom=&compareTo=`
  (both or neither — one alone is `422`; same date rules as `from`/`to`) and
  `balance-sheet?…&compareAsOf=`. The response then also has:
  - `comparative` — the full report for the comparison period/date, exactly what
    requesting it on its own returns (no nested `comparative`/`variance`);
  - `variance` — current − comparative: every money total (Laba Rugi: `revenue` …
    `netIncome`; Neraca: `totalAssets`, `totalLiabilities`, `totalEquity`,
    `currentYearEarnings`, `unclosedPriorYearsEarnings`) plus line arrays
    (Laba Rugi: the six `*Lines` keys; Neraca: `assets`, `liabilities`, `equity`, each
    flattened across subtype groups) of `{code, name, current, comparative, variance}`
    (Neraca lines also carry `subtype`). Lines are the union of both sides — an account
    present on only one side shows `0.0000` on the other — in current-report order,
    then comparison-only lines.
  Both periods are read on one snapshot. Without the params the response is unchanged
  (no `comparative`/`variance` keys).
- `GET    /v1/reports/general-ledger?accountId=&from=&to=` · any · Buku Besar —
  span capped at **366 days** (`422` beyond); at most 10,000 lines per page.
  When the cap cuts the list the response has `truncated: true` and a
  `nextCursor` token — repeat the request with the same `accountId`/`from`/`to`
  plus `&cursor=<nextCursor>` until `nextCursor` is `null`. Each page's
  `openingBalance` is the previous page's last `runningBalance`, so running
  balances continue across pages; `closingBalance` is always the balance at `to`.
  Each page is its own snapshot: a back-dated post landing between page requests
  shows up in the next page's `openingBalance` (still correct as of that read).
  A malformed cursor, or one outside `from`/`to`, is `422`
- `GET    /v1/reports/general-ledger/book?accountIds=|fromCode=&toCode=&from=&to=`
  · any · Buku Besar over several accounts (a printed ledger book) — select
  either `accountIds` (comma-separated, at most **200**; `400` beyond, unknown id
  `404`) **or** a code range `fromCode`/`toCode` (inclusive, either bound
  optional; **postable** accounts only; `422` if it selects more than 200);
  both at once is `422`; neither selects every postable account (same 200 cap).
  Response `{ from, to, accounts: [{ account, openingBalance, lines,
  closingBalance }], truncated, nextCursor }` — one section per account ordered
  by code, each exactly what the single-account endpoint returns for it
  (accounts with no lines in range still get a section). Same 366-day span. The
  10,000-line cap is shared by the whole page: a page holds the accounts from
  the cursor position through its last line, so one account can be split across
  pages — the next page's first section is then that account again, with
  `openingBalance` = the previous page's last `runningBalance` (merge sections
  with the same `account.id` across consecutive pages). Pass `&cursor=<nextCursor>`
  with the same selection/`from`/`to`; a cursor from the single-account endpoint,
  or for an account outside the selection, is `422`
- `GET    /v1/reports/ar-aging?asOf=` · any · AR aging — 10,000 open-document
  cap, cut at **partner boundaries** (every returned partner is complete;
  partners ordered by name). `truncated: true` means later partners were left
  out — fetch them with `&afterPartnerId=<nextAfterPartnerId>` (same `asOf`;
  repeat until `truncated: false`). `totalsByBucket`, `totalOutstanding` and
  `documentCount` always cover **all** open documents, on every page. Unknown
  `afterPartnerId` → `422`
- `GET    /v1/reports/ap-aging?asOf=` · any · AP aging — same cap and totals
- `GET    /v1/reports/cash-flow?from=&to=` · any · Arus Kas — closing entries
  excluded; opening-balance (Saldo Awal) entries dated inside the range are
  part of `kasAwal`, not operating/financing flows. **Intended:** `kasAwal` =
  cash balance at the day before `from` **plus** cash booked by OPENING entries
  dated inside `[from, to]`, so when the range contains Saldo Awal entries
  (e.g. a company that started bookkeeping mid-range) `kasAwal` is **not** the
  same as the Kas balance on `from − 1` — don't cross-check it against the
  trial balance of the previous day in that case. `reconciles` still ties.

- **File export (CSV / XLSX)** — every report above (balance sheet incl.
  comparative, income statement incl. comparative, trial balance incl.
  `preClosing`, general ledger, general-ledger book, AR/AP aging, cash flow)
  takes `&format=csv` or `&format=xlsx` with the same query params and roles;
  downloads count against their own per-user limit (30/min, `429` + `Retry-After`)
  — plain JSON report calls don't;
  absent = JSON (unchanged); any other value → `400`. The response is a download:
  `Content-Type: text/csv; charset=utf-8` (UTF-8 **BOM**, CRLF, RFC 4180 quoting)
  or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, with
  `Content-Disposition: attachment; filename="<report>-<asOf>.<ext>"` (or
  `<report>-<from>_<to>.<ext>`; names: `balance-sheet`, `income-statement`,
  `trial-balance`, `general-ledger`, `general-ledger-book`, `ar-aging`,
  `ap-aging`, `cash-flow`). `Content-Disposition` is CORS-exposed. Layout: title
  rows, a blank row, one header row (frozen in XLSX), then lines with bold
  subtotal/total rows (Indonesian labels: `Total ASET`, `Laba Bersih`,
  `Saldo Akhir`, `Total Sisa`, …); comparative exports have current /
  comparison / `Selisih` (variance) columns. Money cells are the exact JSON
  decimal strings in CSV; in XLSX they are numbers formatted
  `#,##0.00;(#,##0.00)` — except a value with more than 15 significant digits
  (beyond what a double / Excel holds exactly), which is written as the exact
  decimal **text**. Text cells starting with `= + - @`, tab or CR are prefixed
  with `'` in CSV (formula-injection guard); XLSX writes them as plain strings.
  Caps are kept: a truncated general ledger / aging exports the requested page
  and ends with a `TERPOTONG` note row naming the `cursor` / `afterPartnerId`
  for the next page. From a browser, fetch with the bearer token and save the
  blob (a plain link can't carry the `Authorization` header).

### Sales invoices

- `GET    /v1/sales-invoices` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, status, taxInvoiceStatus, limit, offset`)
- Coretax metadata routes (`…/:id/tax-invoice`, `…/:id/withholding-slip`): see *Coretax (e-Faktur)* below
- `GET    /v1/sales-invoices/:id` · any · get one
- `POST   /v1/sales-invoices` · ACCOUNTANT+ · create draft · **requires `Idempotency-Key`**
- `PATCH  /v1/sales-invoices/:id` · ACCOUNTANT+ · update draft
- `POST   /v1/sales-invoices/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/sales-invoices/:id/void` · APPROVER/ADMIN · void (optional body `{ date }`: document date ≤ date ≤ max(today WIB, document date) — `422 { date, today[, originalDate] }`) · **requires `Idempotency-Key`**
- `DELETE /v1/sales-invoices/:id` · ACCOUNTANT+ · delete draft

### Purchase bills

- `GET    /v1/purchase-bills` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, status, limit, offset`)
- `GET    /v1/purchase-bills/:id` · any · get one
- `POST   /v1/purchase-bills` · ACCOUNTANT+ · create draft · **requires `Idempotency-Key`**
- `PATCH  /v1/purchase-bills/:id` · ACCOUNTANT+ · update draft
- `POST   /v1/purchase-bills/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/purchase-bills/:id/void` · APPROVER/ADMIN · void (optional body `{ date }`: document date ≤ date ≤ max(today WIB, document date) — `422 { date, today[, originalDate] }`) · **requires `Idempotency-Key`**
- `DELETE /v1/purchase-bills/:id` · ACCOUNTANT+ · delete draft

### Sales credit notes / purchase debit notes

Same routes under `/v1/sales-credit-notes` (original = sales invoice, ref `CN/…`) and
`/v1/purchase-debit-notes` (original = purchase bill, ref `DN/…`):

- `GET    /v1/sales-credit-notes` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, status, limit, offset`)
- `GET    /v1/sales-credit-notes/:id` · any · get one (with `lines` and `applications`)
- `POST   /v1/sales-credit-notes` · ACCOUNTANT+ · create draft `{ originalId, date, description?, lines: [{ originalLineId, quantity }] }` · **requires `Idempotency-Key`**
- `PATCH  /v1/sales-credit-notes/:id` · ACCOUNTANT+ · update draft (`date`, `description`, `lines`)
- `POST   /v1/sales-credit-notes/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/sales-credit-notes/:id/void` · APPROVER/ADMIN · void (optional `{ date }`, same rules as invoices) · **requires `Idempotency-Key`** · live applications → `422 { id, reason: 'HAS_APPLICATIONS', applications }`
- `POST   /v1/sales-credit-notes/:id/apply` · APPROVER/ADMIN · apply the note's unapplied credit `{ date, allocations }` (as payments) · **requires `Idempotency-Key`**
- `POST   /v1/sales-credit-notes/:id/applications/:applicationId/reverse` · APPROVER/ADMIN · reverse one application (optional `{ date }`) · **requires `Idempotency-Key`**
- `POST   /v1/sales-credit-notes/:id/refunds` · APPROVER/ADMIN · refund unapplied credit in cash `{ date, amount, cashAccountId, description? }` (as payments) · **requires `Idempotency-Key`**
- `POST   /v1/sales-credit-notes/:id/refunds/:refundId/reverse` · APPROVER/ADMIN · reverse one refund (optional `{ date }`) · **requires `Idempotency-Key`**
- `DELETE /v1/sales-credit-notes/:id` · ACCOUNTANT+ · delete draft

### Payments

- `GET    /v1/payments` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, partnerId, direction, status, unapplied, limit, offset`; `unapplied=true` → POSTED payments with `unappliedAmount > 0`)
- `GET    /v1/payments/:id` · any · get one
- `POST   /v1/payments` · ACCOUNTANT+ · create draft (RECEIPT/DISBURSEMENT, optional `amount` + allocations; excess = advance; `opening: true` = go-live credit against Saldo Awal, no `cashAccountId`) · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/post` · APPROVER/ADMIN · post · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/apply` · APPROVER/ADMIN · apply unapplied amount `{ date, allocations }` · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/applications/:applicationId/reverse` · APPROVER/ADMIN · reverse one application (optional `{ date }`) · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/refunds` · APPROVER/ADMIN · refund unapplied amount in cash `{ date, amount, cashAccountId, description? }` · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/refunds/:refundId/reverse` · APPROVER/ADMIN · reverse one refund (optional `{ date }`) · **requires `Idempotency-Key`**
- `POST   /v1/payments/:id/void` · APPROVER/ADMIN · void (optional body `{ date }`: document date ≤ date ≤ max(today WIB, document date) — `422 { date, today[, originalDate] }`) · **requires `Idempotency-Key`** · a payment whose partner has been deleted → `422 VALIDATION_FAILED` `{ id, partnerId, reason: 'PARTNER_DELETED' }` (voiding would reopen a balance on a deleted partner) · live applications → `422 { id, reason: 'HAS_APPLICATIONS', applications }`
- `DELETE /v1/payments/:id` · ACCOUNTANT+ · delete draft

### Business partners

- `GET    /v1/partners` · any · **enveloped** list `{ data, total, limit, offset }` (filters: `q, limit, offset`)
- `GET    /v1/partners/:id` · any · get one
- `POST   /v1/partners` · ACCOUNTANT+ · create
- `PATCH  /v1/partners/:id` · ACCOUNTANT+ · update
- `POST   /v1/partners/:id/deactivate` · ADMIN · deactivate
- `code` is stored normalized (NFKC + trimmed, create — unique case-insensitively among live partners, else `409`); `name` is stored trimmed (create and `PATCH`); zero-width / format characters → `400` (see *Identifier codes* under 400 vs 422).
- **Removing a role that still has open items is refused (changed):** `PATCH`
  `isCustomer: false` while the partner has a draft invoice, a `POSTED` invoice with an
  outstanding balance, or a draft RECEIPT — or `isVendor: false` with the same for
  bills / DISBURSEMENTs — → `422 VALIDATION_FAILED` `details: { id, reason: "OPEN_ITEMS",
  role: "CUSTOMER" | "VENDOR", draftDocuments, outstandingDocuments, draftPayments,
  unappliedPayments }` (`unappliedPayments`: POSTED payments with an unapplied advance)
  (the `DELETE` shape plus `role`). Items of the other role never block; re-sending the
  current value (`true`) never checks. **Caveat (documented, not blocked):** once the role
  is removed (no open items at that moment), **voiding** an already-posted RECEIPT
  (DISBURSEMENT) of that partner still works and **reopens** the invoice (bill) balance it
  had settled — but that balance cannot receive a new receipt (disbursement) until the
  role is re-enabled (`PATCH isCustomer: true` / `isVendor: true`): the payment is refused
  with "Receipt requires a customer" / "Disbursement requires a vendor". Offer to
  re-enable the role when voiding such a payment.
- **Deactivating a partner that still has open items is allowed** (`deactivate`, or
  `PATCH` `isActive: false`). Its posted documents stay open in AR/AP and aging, but new
  receipts (disbursements) against them — create **and** `/post` of an existing draft —
  return `422 VALIDATION_FAILED` `{ partnerId }` ("Partner is inactive"), as do new
  invoices/bills and posting their drafts, **until it is re-activated** (likewise
  "Receipt requires a customer" / "Disbursement requires a vendor" for a partner
  whose role was removed). Voiding an
  already-posted payment still works for an inactive partner. Warn before deactivating a
  partner with an outstanding balance.
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

Tax codes also carry the Coretax presentation fields `dppNilaiLain` (boolean) and
`coretaxVatRate` (statutory %, string, `null` = derived from `rate`) — **PPN_OUTPUT only**
(`422` on another kind). They never change the computed tax. The seeded `PPN-OUT-11`
(rate 0.11) is `dppNilaiLain: true, coretaxVatRate: "12"`: 12% on DPP Nilai Lain 11/12
(PMK 131/2024) = 11% of DPP.

### Coretax (e-Faktur) — faktur keluaran export, NSFP, bukti potong

Coretax DJP (mandatory since 2025; e-Faktur desktop retired) imports output tax invoices
as an XML file. The API produces that file and records what Coretax gives back — it
never changes amounts or postings.

**Operator flow**

1. One-time master data: `PATCH /v1/company/settings` `npwp` (16 digits; a legacy
   15-digit NPWP is accepted and stored as `0` + 15 digits), `nitkuSuffix` (6 digits,
   default `000000` → SellerIDTKU = npwp + suffix), `coretaxDefaultItemType` (`A` goods /
   `B` services), `coretaxDefaultItemCode` (default `000000`), `coretaxDefaultUnitCode`
   (`UM.xxxx`, e.g. `UM.0018` Unit). Per customer (`/v1/partners`): `npwp`, `address`
   (required by Coretax), `buyerDocumentType` (`TIN` default / `NATIONAL_ID` /
   `PASSPORT` / `OTHER`), `buyerDocumentNumber` (16-digit NIK for `NATIONAL_ID`),
   `nitkuSuffix`, `country` (ISO alpha-3, default `IDN`). Optional per sales-invoice line
   (create / draft update): `coretaxItemType`, `coretaxItemCode` (6 digits),
   `coretaxUnitCode`; per invoice: `trxCode` override (`01`–`06`, `09`, `10`).
2. **Export**: `GET /v1/tax/coretax/faktur-keluaran?from=YYYY-MM-DD&to=YYYY-MM-DD[&status=NONE|EXPORTED]`
   · any role · `application/xml` attachment (`Content-Disposition: attachment;
   filename="faktur-keluaran_<from>_<to>.xml"`, header `X-Coretax-Invoice-Count`).
   Includes every POSTED (not VOID) sales invoice dated in range whose
   `taxInvoiceStatus` is `NONE` or `EXPORTED` (or exactly `status`), one `TaxInvoice`
   each; APPROVED / CANCELLED fakturs are never re-exported. Only lines carrying a
   PPN Output code become `GoodService` rows; an invoice without PPN Output is not a
   faktur and is skipped. Range ≤ 366 days, ≤ 1000 invoices. The GET does **not**
   change anything.
   - `422 { reason: 'CORETAX_DATA_INCOMPLETE', problems: [{ invoiceId, invoiceRef, field, message }] }`
     lists **every** missing / inconsistent item (seller NPWP or not PKP; buyer NPWP /
     NIK / document number / address; line type or unit with no company default;
     invoice mixing DPP Nilai Lain and regular PPN lines without `trxCode`; a tax code
     whose `coretaxVatRate` × (11/12) ≠ `rate`; faktur VAT not reconciling with the
     posted PPN) — no partial file is produced.
   - `422 { reason: 'NOTHING_TO_EXPORT' }` when no invoice qualifies.
3. Upload the file in Coretax (e-Faktur → Pajak Keluaran → Impor), review, **sign**.
4. `POST /v1/tax/coretax/faktur-keluaran/mark-exported` `{ invoiceIds: uuid[] }` ·
   APPROVER/ADMIN · `200 { updated }` — sets `taxInvoiceStatus: EXPORTED` and
   `coretaxExportedAt`. All or nothing: `422 { invalid: [{ id, status, taxInvoiceStatus }] }`
   unless every id is a POSTED invoice in `NONE`/`EXPORTED`. Take the ids from
   `GET /v1/sales-invoices?status=POSTED&taxInvoiceStatus=NONE` (the export does not
   mutate, so marking is explicit and only touches what you uploaded).
5. Record the NSFP Coretax assigned: `PATCH /v1/sales-invoices/:id/tax-invoice`
   `{ taxInvoiceNumber: '<17 digits>', taxInvoiceDate: 'YYYY-MM-DD', status?, trxCode? }`
   · APPROVER/ADMIN · returns the invoice. A number without `status` → `APPROVED`
   (needs the date, else `422`). `status` can also be set alone (`EXPORTED`,
   `CANCELLED` when the faktur is cancelled in Coretax, `NONE`). Allowed status
   moves, else `422`: `NONE`→`EXPORTED`|`APPROVED`, `EXPORTED`→`NONE`|`APPROVED`,
   `APPROVED`→`CANCELLED`; `CANCELLED` is final (a replacement faktur goes on a new
   invoice); re-sending the current status is allowed (e.g. an `APPROVED` invoice's
   corrected NSFP). An `APPROVED` faktur can never return to `NONE`/`EXPORTED`, so it
   is never re-exported (duplicate upload to DJP). Invoice must be POSTED
   or VOID (DRAFT → `422`); same NSFP on another live invoice → `409`; `trxCode` cannot
   change once APPROVED. Financial fields stay immutable — `PATCH /v1/sales-invoices/:id`
   still refuses a POSTED invoice.

**Bukti potong / retur references** (APPROVER/ADMIN, body `{ number, date }` — both set,
or both `null` to clear; returns the document):

- `PATCH /v1/sales-invoices/:id/withholding-slip` — the bukti potong the customer gave
  you for PPh it withheld (`PPH_PREPAID`).
- `PATCH /v1/purchase-bills/:id/withholding-slip` — the BPPU number Coretax issued for
  PPh you withheld (`PPH_PAYABLE`).
  Both: POSTED only, and the document must carry withholding (`withholdingTotal > 0`),
  else `422 { reason: 'NO_WITHHOLDING' }`.
- `PATCH /v1/sales-credit-notes/:id/retur-reference`,
  `PATCH /v1/purchase-debit-notes/:id/retur-reference` — the Coretax retur number/date
  (POSTED or VOID note). Metadata only.

New response fields: sales invoice `trxCode`, `taxInvoiceNumber`, `taxInvoiceDate`,
`taxInvoiceStatus` (`NONE|EXPORTED|APPROVED|CANCELLED`), `coretaxExportedAt`,
`withholdingSlipNumber`, `withholdingSlipDate`, lines `coretaxItemType` /
`coretaxItemCode` / `coretaxUnitCode`; purchase bill `withholdingSlipNumber/Date`;
notes `returNumber/Date`; partner and company settings as above.

**XML mapping** (DJP template `TaxInvoiceBulk` v1.4): `TIN` = seller NPWP;
`TaxInvoiceDate` = invoice date; `TaxInvoiceOpt` = `Normal`; `TrxCode` = override, else
`04` when the lines' PPN code has DPP Nilai Lain, else `01`; `RefDesc` = invoice ref;
`AddInfo` / `CustomDoc` / `CustomDocMonthYear` / `FacilityStamp` empty (codes 07/08
not supported); `BuyerTin` = npwp (TIN) or `0000000000000000`; `BuyerDocument` =
`TIN` / `National ID` / `Passport` / `Other ID`; `BuyerDocumentNumber` empty for TIN;
`BuyerIDTKU` = npwp + suffix (TIN) or `000000`. Per line: `Price`, `Qty`,
`TotalDiscount` (the line discount), `TaxBase` = net line amount (DPP),
`OtherTaxBase` = TaxBase × 11/12 with DPP Nilai Lain else TaxBase, `VATRate` =
statutory %, `VAT` = OtherTaxBase × VATRate, `STLGRate`/`STLG` (PPnBM) `0`. Numbers:
≤ 2 dp, half-up, `.` decimal separator, no thousands separator. The sum of `VAT` must
equal the posted `taxTotal` within rounding (0.5 per PPN code + 0.01 per line), else
the invoice is refused.

**Sources** (fetched 2026-10-03): DJP "Template XML dan Converter Excel ke XML",
<https://www.pajak.go.id/en/node/112031> — *Sample Faktur PK Template v.1.4.xml*
(<https://pajak.go.id/sites/default/files/2025-03/Sample%20Faktur%20PK%20Template%20v.1.4.xml.zip>,
kept verbatim as the golden test fixture `src/coretax/fixtures/djp-sample-faktur-pk-v1.4.xml`)
and *ConverterEfakturCoretax v1.6*
(<https://pajak.go.id/sites/default/files/2026-01/ConverterEfakturCoretax__v1.6.zip>:
Excel template v1.6.1 reference sheets — TrxCode list, `BuyerDocument` values, `UM.*`
units, country codes — and its "Keterangan" rules). Kode transaksi 04 for DPP Nilai Lain
11/12: PMK 131/2024 + PER-1/PJ/2025 (e.g. <https://ikpi.or.id/?p=13685>,
<https://news.ddtc.co.id/berita/nasional/1808027/hitung-ppn-pakai-dpp-1112-harga-jual-perhatikan-lagi-kode-fakturnya>).

**Verified vs assumed.** Verified against the official sample (byte-identical golden
test): element names incl. `BuyerAdress` [sic], order, root attributes, date format
`yyyy-MM-dd`, empty elements as `<X/>`. From the Excel template: `BuyerDocument`
values, zero TIN / `000000` IDTKU for non-TIN buyers, `IDN` = Indonesia (DJP's XML
sample shows `IND`, which in its own country list is **India** — we emit `IDN`),
OtherTaxBase = TaxBase when no DPP Nilai Lain, VAT = rate × OtherTaxBase, 2-dp numbers.
**Assumed / unverified**: no XSD (`TaxInvoice.xsd`) is published, so required-ness comes
from the Excel "Keterangan" sheet; `BuyerDocumentNumber` is emitted empty for TIN
buyers as in the XML sample (the Excel template writes `-`); per-line 2-dp rounding of
OtherTaxBase / VAT (Coretax's own rounding is not documented); NSFP = 17 digits (from
DJP's retur sample `04002500000348920`). **BPPU (bukti potong unifikasi) XML export is
not implemented**: DJP publishes a `BpuBulk` template
(<https://pajak.go.id/sites/default/files/2024-12/bppu.zip>), but it needs a
`TaxObjectCode` (kode objek pajak), a `Document` type and the recipient NITKU per
withholding, which this API does not model yet — only the BPPU number is stored.

### Journal-entry preview

- `POST   /v1/journal-entries/preview` · any · read-only balanced-JE dry run for a SALE/PURCHASE/PAYMENT document (posts nothing; **no `Idempotency-Key`**). Distinct from the manual-journal CRUD at `/v1/ledger/journal-entries`.

### Close

- `POST   /v1/close/year-end` · ADMIN · run year-end close (`{ fiscalYear }`) · **requires `Idempotency-Key`**
- `POST   /v1/close/year-end/:fy/reopen` · ADMIN · reopen a closed year · **requires `Idempotency-Key`**
- `GET    /v1/close/year-end/:fy` · any · close status (404 if none)

### Company

- `GET    /v1/company/settings` · any · company settings
- `PATCH  /v1/company/settings` · ADMIN · update company settings (changing `fiscalYearStartMonth` → `422` once any journal entry — even a draft —, closed period or year-end close exists; otherwise the OPEN periods are replaced by the current + next fiscal year for the new month; **send `fiscalYearStartMonth` only when the user actually changed it** — any PATCH that includes the field, even with the unchanged value, takes the period-generation lock plus table locks on `journal_entries` / `accounting_periods` / `year_end_closings` and briefly blocks posting company-wide (up to 5 s, then `409` retryable))

### Audit

- `GET    /v1/audit` · ADMIN · audit log — **bare array** (no envelope) (filters: `userId, method, from, to, limit, offset`; `limit` default 50, **max 200**; `method` ∈ POST/PATCH/PUT/DELETE/CLI/MIGRATION — `CLI` = rows written by the operator `create-admin` script, path `scripts/create-admin`; `MIGRATION` = one row per record a database upgrade normalized, path = the migration name, `body` `{ table, id, old, new }`, `userId` `null`). One row per mutating request — including requests cut off with `408` and requests rejected by auth/role/throttle guards (`401`/`403`/`429`; rejection rows are capped at 60 per client IP and 600 in total per minute for anonymous callers — anonymous login/refresh/logout rows share those caps, except a successful login/refresh, which counts against the signed-in user's cap — 60 per user per minute for signed-in ones). **`body`** is the sanitized request body, except: an **anonymous** row (no signed-in user — e.g. a refresh, a logout, any `401`) stores `{}`, except a **login** (any outcome on `/v1/auth/login`), which stores only `{ "email": "<trimmed, lowercased, NFC-normalized>" }` (never the password); an endpoint that takes **no body** (e.g. `POST /v1/auth/logout-all`, `…/:id/post`, `DELETE`) stores `{}` for every row it writes itself — except a signed-in `403`/`429` guard rejection on such a route, which is written before routing and stores the body capped at 8192 bytes like any other rejection; a body whose JSON exceeds **512 KiB** (a signed-in caller's state-changing request that passed validation — a success, a `5xx` or a `408` — above any valid request, so an accepted write is always stored in full) or **8192 bytes** (every other row: signed-in rejections such as a `400`/`403`/`422`, and **every** row of the read-only POSTs `POST /v1/tax/calculate` and `POST /v1/journal-entries/preview`, which change nothing) is stored as the object `{ "_truncated": true, "bytes": <n>, "preview": "<first 1024 chars of the JSON>" }` — always an object, render `preview` as text. **A `408` row does not mean nothing happened:** the timed-out handler may still commit afterwards (its record then exists with a later timestamp and no audit row of its own) — see *Retry after a timeout* under Idempotency. `path` (with query string) and `params` are truncated to 512 chars. `userId` filter must be a UUID (else `400`). `requestId` = the server trace id; `clientRequestId` = your sanitized `X-Request-Id` (or `null`); `replayed` = `true` on the row of an idempotent **replay** (same `Idempotency-Key` + request answered with the stored response — no new write; `entityId` is the entity the original created), `null` otherwise

### Response schema quick-map

Each endpoint's 2xx body resolves to a named schema in `openapi.json` — look up the
fields there; this is just the name to find. The seven enveloped list endpoints wrap
their items in `{ data, total, limit, offset }`; bare-array endpoints return the item
schema directly in an array.

| Domain           | Response schema(s)                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth             | `TokenPairDto` (login/refresh) · `AuthenticatedUserDto` (`/auth/me`, now incl. `mustChangePassword`) · `OkFlagDto` (`/auth/change-password`)                                  |
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
| Reports          | `BalanceSheetDto` · `IncomeStatementDto` · `GeneralLedgerDto` · `GeneralLedgerBookResponseDto` · `AgingReportDto` (AR & AP) · `CashFlowDto`                                                               |
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
