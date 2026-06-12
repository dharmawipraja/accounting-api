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
   request/response **schemas**. **Generate a typed client from it** (e.g.
   `openapi-typescript`, `orval`) and import those types everywhere. Don't hand-write
   request/response shapes.
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
   once; if refresh fails, go to login. There is **no server logout** — discard tokens.
   On **429**, back off.
4. **Respect the role matrix** (VIEWER / ACCOUNTANT / APPROVER / ADMIN; see the guide).
   Reads are open to any authenticated user. Hide/disable actions a role can't do —
   **but still handle `403 FORBIDDEN` and `403 SEGREGATION_OF_DUTIES`** on every
   mutation (the creator of a document may be barred from posting it themselves).
5. **Dates are `YYYY-MM-DD`** (date-only). Reports use `?asOf=` (balance sheet, aging,
   trial balance) or `?from=&to=` (income statement, cash flow, general ledger).
6. **Pagination is mixed:** only `GET /ledger/journal-entries` returns the
   `{ data, total, limit, offset }` envelope (limit default 50, max 200). **Every
   other list endpoint — including `GET /audit` — returns a bare array** (don't look
   for `.data`); `/audit` still takes `limit`/`offset` (limit default 50, max 500).
7. **Soft-delete → 404.** Deleting/deactivating makes a resource 404 and removes it
   from lists; unique codes are reusable afterward. Don't treat that 404 as a crash.
8. **Draft → post approval flow.** Documents (journals, invoices, bills, payments) are
   created as drafts by ACCOUNTANT+, then **posted by APPROVER/ADMIN**. Build an
   approval queue (e.g. `GET /ledger/journal-entries?status=DRAFT`). Pass an
   `Idempotency-Key` header on post/reverse to make retries safe.

## Do / Don't

**Do**
- Generate and commit a typed client from `openapi.json`; regenerate when the API changes.
- Centralize fetch in one wrapper (auth header, 401-refresh, 429 backoff, envelope parsing).
- Keep money as decimal strings end-to-end; format only at the view layer.
- Gate UI by role from `GET /auth/me`, and still handle server 403s.

**Don't**
- Don't `parseFloat` money. Don't do float math on amounts.
- Don't assume `/docs` (Swagger UI) exists in production — it's gated behind
  `ENABLE_SWAGGER` there. Rely on the committed `openapi.json`.
- Don't expect a logout endpoint, a pagination envelope on any non-journal list
  (including `/audit`), or that a creator can self-approve.
- Don't branch on `message` strings — branch on `code`.

## Regenerating `openapi.json`

The committed spec lives at `docs/api/openapi.json` in the **API repo**. To refresh it,
run in that repo:

```bash
npm run openapi:export
```

(builds the app and writes the OpenAPI document). Re-run your client codegen against
the updated file afterward.
