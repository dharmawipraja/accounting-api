# Frontend-Enablement Documentation — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete + production-hardened accounting API. This produces **documentation artifacts** that let an AI agent (or developer) build a frontend against this API — it does **not** build the frontend.

## 1. Context & decisions

The API has ~71 endpoints across 18 controllers but **no consumable API reference**: Swagger is wired (`/docs`, opt-in in prod via `ENABLE_SWAGGER`) yet has **zero annotations**, so the generated OpenAPI is shallow; and the cross-cutting conventions an FE needs (error envelope, money format, pagination, roles, lifecycles, throttle) are documented nowhere.

Decisions (from brainstorming): **enrich the in-app OpenAPI to emit a faithful `openapi.json` PLUS a hand-written markdown guide** for the semantics OpenAPI can't carry; **stack-agnostic** (the agent picks the FE framework).

## 2. Deliverables (all in this repo; the FE is a separate project that consumes them)

- `docs/api/openapi.json` — committed, machine-readable contract (codegen-able).
- `docs/api/frontend-guide.md` — conventions, roles, lifecycles, glossary, catalog, recommended screens.
- `docs/api/frontend-agent-brief.md` — a concise `AGENTS.md`-style briefing the user copies into the FE repo root.

## 3. Part A — Enrich the in-app OpenAPI

1. **Enable the `@nestjs/swagger` CLI plugin** — in `nest-cli.json`, add `compilerOptions.plugins: [{ name: "@nestjs/swagger", options: { introspectComments: true, dtoFileNameSuffix: [".dto.ts"] } }]`. This auto-derives `@ApiProperty` for **every request/query DTO** from its TS types + class-validator decorators + JSDoc — documenting all request bodies and query DTOs with ~zero per-property work. (Verify the e2e build still works with the plugin; it transforms at compile time only.)
2. **`@ApiTags('<Domain>')` per controller** — group the endpoints: Auth, Company, Accounts, Periods, Journal, Tax, Business Partners, Sales Invoices, Purchase Bills, Payments, Reporting, Close, Audit. (Health/Metrics: tag or leave; they're ops.)
3. **`@ApiBearerAuth()`** on the authenticated controllers (keep `DocumentBuilder.addBearerAuth()`); the `@Public` routes (`/auth/login`, `/auth/refresh`, `/health`, `/ready`) are documented without the security requirement.
4. **Shared response shapes** documented once (not per-endpoint): the **error envelope** `{ code, message, details? }`, the **pagination envelope** `{ data, total, limit, offset }` (journal list), the **auth token** response `{ accessToken, refreshToken }`, and the money-string convention (4dp string fields). Apply via `@ApiResponse`/`@ApiExtraModels` + small response-model classes for these shared shapes, plus an `@ApiOkResponse` on the auth + list + report endpoints. **Scope:** do NOT hand-type a response DTO for all 71 endpoints — the markdown guide carries full response semantics; the plugin already covers every request.
5. **Export script** — `package.json` `"openapi:export": "ts-node scripts/export-openapi.ts"` (or a compiled equivalent). `scripts/export-openapi.ts` builds the Nest app **with `PrismaService` overridden by a no-op stub** (an empty `onModuleInit`/`onModuleDestroy`, no `$connect`) via `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(stub).compile()` → `createNestApplication()` → `app.init()` — so **no database is needed** to generate the document. Then `SwaggerModule.createDocument(app, config)`, write `docs/api/openapi.json` (pretty-printed), `await app.close()`. (This mirrors the e2e harness's PrismaService-override pattern; document generation only needs route/DTO metadata, not a live DB.) Commit the generated `openapi.json`. (A CI step can later regenerate + diff to catch drift — noted, not required here.)

## 4. Part B — The markdown guide + agent brief

**`docs/api/frontend-guide.md`** — sections:
1. **Overview & auth** — what the API is (single-company Indonesian accounting, SAK); base URL; where `openapi.json` + `/docs` are; login → `{accessToken, refreshToken}` (access ~15m / refresh 7d), `Authorization: Bearer`, **refresh-on-401** (`POST /auth/refresh`), `GET /auth/me`; no server logout (client discards tokens); throttle (login 10/min/IP, general 300/min/user).
2. **Conventions** — error envelope `{code,message,details?}` + a **status-code taxonomy** table (200/201; 400 input shape; 401 unauthenticated; 403 wrong role; 404 not found; 409 conflict / closed period / closed year; 422 domain-rule violation; 429 throttled) + the domain-error-code list (`VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `FORBIDDEN`, `CLOSED_PERIOD`, `CLOSED_YEAR`, `SEGREGATION_OF_DUTIES`, `INVALID_ACCOUNT`, `UNBALANCED_ENTRY`, `INVALID_INPUT`, `UNAUTHORIZED`, …) + the **400-vs-422** distinction (input shape vs domain rule); **money = 4dp strings** (decimal lib for math, never `parseFloat`; rupiah formatting for display); **pagination** (`{data,total,limit,offset}` on the journal list; bare arrays on the other lists — enumerate which); **dates** (`YYYY-MM-DD` date-only; `?asOf`, `?from`/`?to`; monthly periods); **`traceId`** = the `X-Request-Id` response header (== the error-envelope `traceId`) — surface for support; **soft-delete** (DELETE = soft → resource 404s afterward; codes are tombstoned/reusable).
3. **Role matrix** — ADMIN / ACCOUNTANT / APPROVER / VIEWER × each mutating endpoint, **derived from the actual `@Roles` decorators**; reads are any-authenticated; the **SoD** rule (when enabled, the poster must differ from the entry creator → 403 `SEGREGATION_OF_DUTIES`).
4. **Domain lifecycles** — journal entry (create draft → post [APPROVER+] → reverse; find pending via `GET /ledger/journal-entries?status=DRAFT`), sales invoices / purchase bills (draft → post → void-via-reversal), payments (RECEIPT/DISBURSEMENT, full allocation to documents), year-end close (`close(fy)` → `reopen`, the year-lock blocks new posting), tax preview (`POST /tax/calculate`). Each with its transition endpoints.
5. **Glossary** — SAK chart-code ranges (Kas 1-1000 … Laba Ditahan 3-2000 …), fiscal year/periods, PPN/PPh, Neraca/Laba Rugi/Buku Besar/Arus Kas/Jurnal/Saldo Awal (ID↔EN).
6. **Endpoint catalog** — grouped by domain: `METHOD · path · role · one-line purpose` (the human index; `openapi.json` has the schemas).
7. **Recommended FE surface (stack-agnostic)** — suggested screens mapped to endpoints (Login; Dashboard; Chart of Accounts; Journal register + create/post/reverse; Sales Invoices / Purchase Bills / Payments; Reports — Neraca, Laba Rugi, Buku Besar, AR/AP Aging, Arus Kas, Trial Balance; Periods + Year-end Close; Tax codes + calculator; Audit log; Company settings) + the cross-cutting concerns to implement (auth/refresh interceptor, error-envelope handling, money formatting, role-gated UI).

**`docs/api/frontend-agent-brief.md`** — a short briefing meant to be copied to the FE repo root as `AGENTS.md`/`CLAUDE.md`: the goal (build a frontend for this API), the sources of truth (`openapi.json` → codegen a typed client; `frontend-guide.md` → semantics), and the **non-negotiable rules** condensed (money = 4dp strings/decimal lib; errors = `{code,message,details}` + the taxonomy; `Bearer` + refresh-on-401; respect the role matrix; lists/dates conventions; soft-delete = 404; the draft→post approval flow), plus do's/don'ts and how to regenerate `openapi.json`.

## 5. Accuracy principle

The role matrix and endpoint catalog are **derived from the code** (grep `@Controller`/`@Get|@Post|@Patch|@Delete`/`@Roles`/`@Public`), never guessed. The documented conventions (envelope, money 4dp, pagination, status codes, lifecycles) are cross-checked against the actual filter/DTO/service code and a couple of real responses.

## 6. Testing / verification

- **Part A:** `npm run openapi:export` produces `docs/api/openapi.json` that (a) is valid JSON, (b) contains the `tags` (the domains), (c) contains request-DTO schemas (spot-check e.g. `LoginDto`, `CreateSalesInvoiceDto`, `JournalListQueryDto`), (d) declares the bearer security scheme. The app still boots and the **full 152 e2e + 38 unit stay green** (the plugin + decorators are additive — no behavior change). `npm run typecheck && npm run lint:ci` clean.
- **Part B:** an accuracy review — the role matrix matches every `@Roles` decorator; the endpoint catalog matches the routes; the conventions match the `AllExceptionsFilter`, the money/pagination shapes, and the throttle config; spot-check 2–3 documented request/response examples against real responses (curl a running instance or the e2e harness).

## 7. Build sequence (for the plan)

1. **OpenAPI enrichment** (Part A) — `nest-cli.json` plugin + `@ApiTags`/`@ApiBearerAuth` across controllers + shared response models + `scripts/export-openapi.ts` + `openapi:export` script + commit `docs/api/openapi.json`. Verify export + e2e green.
2. **Markdown guide + agent brief** (Part B) — `frontend-guide.md` + `frontend-agent-brief.md`, derived from the code. Accuracy review.

## 8. Out of scope / notes

- The frontend itself (a separate project that consumes these docs).
- A generated TypeScript SDK (the agent can codegen from `openapi.json` in the FE repo).
- Per-endpoint response DTOs for all 71 routes (the shared envelopes + the guide suffice; can be added incrementally later).
- No application behavior changes — Part A is additive annotations/config + a script; Part B is docs only.
