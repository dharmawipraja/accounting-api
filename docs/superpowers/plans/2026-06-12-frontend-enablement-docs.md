# Frontend-Enablement Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce agent-facing docs that let an AI agent build a frontend against this API — a faithful committed `openapi.json` plus a markdown conventions/flows guide and an agent brief.

**Architecture:** Task 1 enriches the in-app OpenAPI (CLI plugin + tags + bearer + a couple of shared response models) and a DB-free export script that writes `docs/api/openapi.json`. Task 2 writes `docs/api/frontend-guide.md` + `docs/api/frontend-agent-brief.md`, **derived from the code** (the role matrix/catalog/conventions are greppable facts, not guesses). No application behavior changes.

**Tech Stack:** `@nestjs/swagger@11` (CLI plugin), NestJS preview-mode bootstrap, markdown.

**Spec:** `docs/superpowers/specs/2026-06-12-frontend-enablement-docs-design.md`

**Ground rules:** NOT on `main` — create branch `frontend-enablement-docs` first. `verify` = `typecheck && lint:ci && test && test:e2e:cov`. Part A is additive (annotations/config/script) — the full 152 e2e must stay green. Never run `prisma format`.

## File structure
- `nest-cli.json` — enable the swagger CLI plugin (Task 1).
- the 13 authenticated controllers — `@ApiTags` + `@ApiBearerAuth` (Task 1).
- `src/common/openapi/openapi.models.ts` — shared response models (Task 1, new).
- `src/scripts/export-openapi.ts` — the export script (Task 1, new).
- `package.json` — `openapi:export` script (Task 1).
- `docs/api/openapi.json` — generated + committed (Task 1).
- `docs/api/frontend-guide.md`, `docs/api/frontend-agent-brief.md` — the guide + brief (Task 2, new).

---

## Task 1: Enrich OpenAPI + export `openapi.json`

**Files:** `nest-cli.json`, the controllers, `src/common/openapi/openapi.models.ts`, `src/scripts/export-openapi.ts`, `package.json`, `docs/api/openapi.json`.

- [ ] **Step 1: Branch**

```bash
git checkout -b frontend-enablement-docs
```

- [ ] **Step 2: Enable the swagger CLI plugin** in `nest-cli.json` — add to `compilerOptions`:

```jsonc
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "plugins": [
      { "name": "@nestjs/swagger", "options": { "introspectComments": true, "dtoFileNameSuffix": [".dto.ts"] } }
    ]
  }
}
```
(This transformer runs during `nest build` and auto-derives `@ApiProperty` for every DTO from its TS types + class-validator decorators + JSDoc.)

- [ ] **Step 3: Shared response models** `src/common/openapi/openapi.models.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';

/** The uniform error envelope returned by AllExceptionsFilter for every 4xx/5xx. */
export class ErrorEnvelopeDto {
  @ApiProperty({ example: 'NOT_FOUND' }) code!: string;
  @ApiProperty({ example: 'Resource not found' }) message!: string;
  @ApiProperty({ required: false, description: 'Optional structured detail' }) details?: Record<string, unknown>;
  @ApiProperty({ required: false, description: 'Correlates with the X-Request-Id response header' }) traceId?: string;
}

/** Access + refresh token pair from /auth/login and /auth/refresh. */
export class TokenPairDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
}
```

- [ ] **Step 4: `@ApiTags` + `@ApiBearerAuth` on the authenticated controllers, typed auth response.** Add `import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';` and a class-level `@ApiTags('<Domain>')` + `@ApiBearerAuth()` to each authenticated controller, using these domain tags:
  - `auth.controller.ts` → `@ApiTags('Auth')` (no class `@ApiBearerAuth` — login/refresh are public; `me`/`admin-only` are authed; tag the controller); on `login` + `refresh` add `@ApiOkResponse({ type: TokenPairDto })`.
  - `company.controller.ts` → `Company`; `accounts.controller.ts` → `Accounts`; `periods.controller.ts` → `Periods`; `balances.controller.ts` → `Reporting`; `journal.controller.ts` → `Journal`; `opening-balances.controller.ts` → `Journal`; `tax-codes.controller.ts` → `Tax`; `tax.controller.ts` → `Tax`; `business-partners.controller.ts` → `Business Partners`; `sales-invoices.controller.ts` → `Sales Invoices`; `purchase-bills.controller.ts` → `Purchase Bills`; `payments.controller.ts` → `Payments`; `reports.controller.ts` → `Reporting`; `closing.controller.ts` → `Close`; `audit.controller.ts` → `Audit`.
  - Add `@ApiBearerAuth()` at the class level on every controller EXCEPT `auth` (mixed public/authed — fine to add it there too; it's advisory), `health`, `metrics` (public).
  - The `DocumentBuilder` (in the export script + `main.ts`) keeps `.addBearerAuth()`.
  (`ErrorEnvelopeDto` is referenced by the guide; optionally add `@ApiExtraModels(ErrorEnvelopeDto)` on one controller so it appears in `components.schemas` — include it so the error shape is in the contract.)

- [ ] **Step 5: The export script** `src/scripts/export-openapi.ts` (DB-free via preview mode):

```ts
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, getSchemaPath } from '@nestjs/swagger';
import { AppModule } from '../app.module';
import { ErrorEnvelopeDto } from '../common/openapi/openapi.models';

async function main(): Promise<void> {
  // preview mode builds the metadata graph WITHOUT instantiating providers,
  // so no DB connection / onModuleInit runs — generation needs only route/DTO metadata.
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  const config = new DocumentBuilder()
    .setTitle('Indonesian Accounting API')
    .setDescription('Conventions, roles, and lifecycles: see docs/api/frontend-guide.md')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Auth')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorEnvelopeDto],
  });
  void getSchemaPath; // ensure the import is used if referenced
  const outDir = join(process.cwd(), 'docs', 'api');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'openapi.json'), JSON.stringify(document, null, 2));
  await app.close();
  // eslint-disable-next-line no-console
  console.log('Wrote docs/api/openapi.json');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```
(If `createDocument` fails under `{ preview: true }` in this Nest version, fall back to the e2e-style build: `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue({ onModuleInit: async () => {}, onModuleDestroy: async () => {} } as unknown as PrismaService).compile()` → `createNestApplication()` **without `app.init()`** → `createDocument`. Report which path worked. Drop the unused `getSchemaPath` import if lint flags it.)

- [ ] **Step 6: The npm script** — add to `package.json`:
```jsonc
"openapi:export": "nest build && node dist/scripts/export-openapi.js"
```
(`nest build` first so the swagger plugin annotates the compiled DTOs; the script runs from `dist/`. Confirm the compiled path is `dist/scripts/export-openapi.js` — adjust if `nest build` emits a different layout.)

- [ ] **Step 7: Generate + verify the contract**

```bash
npm run openapi:export
node -e "const d=require('./docs/api/openapi.json'); const s=d.components?.schemas||{}; console.log('paths:', Object.keys(d.paths).length, '| tags:', (d.tags||[]).map(t=>t.name).join(',')); console.log('has LoginDto:', !!s.LoginDto, '| CreateSalesInvoiceDto:', !!s.CreateSalesInvoiceDto, '| JournalListQueryDto:', !!s.JournalListQueryDto, '| ErrorEnvelopeDto:', !!s.ErrorEnvelopeDto); console.log('bearer scheme:', !!d.components?.securitySchemes?.bearer || !!d.components?.securitySchemes?.['bearer'] || Object.keys(d.components?.securitySchemes||{}).join(','))"
```
Expected: `paths` ≈ 60+; `tags` lists the domains; the request DTO schemas (`LoginDto`, `CreateSalesInvoiceDto`, `JournalListQueryDto`) are present (proving the plugin worked); `ErrorEnvelopeDto` present; a bearer security scheme exists. If the DTO schemas are MISSING, the plugin didn't run — confirm Step 2 + that `npm run openapi:export` ran `nest build` (not a stale dist).

- [ ] **Step 8: Regression**

```bash
npm run typecheck && npm run lint:ci && npm test && npm run test:e2e
```
Expected: clean + full suite green (152 e2e / 38 unit) — the plugin + decorators are additive, no behavior change. (`main.ts`'s existing Swagger setup is unaffected; optionally add the same tags there, but the export script is the source of `openapi.json`.)

- [ ] **Step 9: Commit**

```bash
git add nest-cli.json src/common/openapi/openapi.models.ts src/scripts/export-openapi.ts package.json package-lock.json docs/api/openapi.json $(git diff --name-only src/**/*.controller.ts)
git add src   # ensure the annotated controllers are staged
git commit -m "docs(api): enrich OpenAPI (swagger plugin + tags + bearer) and export committed openapi.json"
```

---

## Task 2: Frontend guide + agent brief

**Files:** `docs/api/frontend-guide.md`, `docs/api/frontend-agent-brief.md` (both new).

- [ ] **Step 1: Re-derive the role matrix + catalog from the code** (so the docs are truthful, not guessed):

```bash
grep -rn "@Controller(" src/*/*.controller.ts src/*/*/*.controller.ts | sed 's#^.*/src/#src/#'
grep -rn "@Get\|@Post\|@Patch\|@Delete\|@Roles\|@Public" src/*/*.controller.ts src/*/*/*.controller.ts | sed 's#^.*/src/#src/#'
```
Use the output to build the catalog (METHOD · path · role · purpose) and the role matrix. The current truth (verify against the grep):
- **ADMIN only:** `GET /audit`; `POST /close/year-end` + `POST /close/year-end/:fy/reopen`; `PATCH /company`; partner deactivate/restore; tax-code deactivate/delete; account deactivate/delete; `POST /ledger/opening-balances`; `POST /ledger/periods` (generate); `GET /auth/admin-only`.
- **ACCOUNTANT, APPROVER, ADMIN:** create/update — partners, payments(create), bills(create+update), sales-invoices(create+update), tax-codes(create+update), accounts(create+update), journal(create/createOrPost + delete-draft).
- **APPROVER, ADMIN:** state transitions — post/void on payments/bills/invoices, journal post + reverse, period close + reopen.
- **Any authenticated (incl. VIEWER):** all `GET` reads (no `@Roles`) — accounts, journal get + **list** (`GET /ledger/journal-entries`), trial-balance, all `/reports/*`, periods list, tax-codes get/list, partners get/list, invoices/bills/payments get/list, company get, close status; plus `POST /tax/calculate` (a pure preview, any-auth).
- **Public (no auth):** `POST /auth/login`, `POST /auth/refresh`, `GET /health`, `GET /ready`, `GET /metrics`.

- [ ] **Step 2: Write `docs/api/frontend-guide.md`** with these sections (prose composed from the facts below — all verifiable in the code):
  1. **Overview & auth** — single-company Indonesian accounting API (SAK); `openapi.json` is in this folder, `/docs` Swagger UI in non-prod (`ENABLE_SWAGGER=true` in prod); `POST /auth/login {email,password}` → `{accessToken, refreshToken}` (access `JWT_ACCESS_TTL`≈15m, refresh 7d); send `Authorization: Bearer <accessToken>`; on **401** call `POST /auth/refresh {refreshToken}` for a new pair; `GET /auth/me` for the current user; no server logout (discard tokens client-side). Throttle: **login 10/min/IP, general 300/min per user** → on **429** back off.
  2. **Conventions:**
     - **Error envelope** `{ code, message, details? , traceId? }` on every 4xx/5xx. **Status taxonomy:** 200/201 success; **400** input-shape/validation (`ValidationPipe`, `ParseUUIDPipe`, malformed body/query/param); **401** missing/expired token (`UNAUTHORIZED`); **403** wrong role (`FORBIDDEN`) or SoD (`SEGREGATION_OF_DUTIES`); **404** not found (`NOT_FOUND`); **409** conflict / closed period (`CLOSED_PERIOD`) / closed year (`CLOSED_YEAR`) / unique (`CONFLICT`); **422** domain-rule violation (`VALIDATION_FAILED`, `UNBALANCED_ENTRY`, `INVALID_ACCOUNT`); **429** throttled. Note the **400 vs 422** split (shape vs domain).
     - **Money** — every monetary field is a **string with exactly 4 decimals** (e.g. `"2000000.0000"`). Never `parseFloat` for arithmetic; use a decimal library; format to rupiah for display. (Source: `Money.toPersistence()` / `.toFixed(4)`.)
     - **Pagination** — `GET /ledger/journal-entries` returns `{ data, total, limit, offset }` (limit default 50, max 200). The other list endpoints (sales-invoices, purchase-bills, payments, partners, audit) return **bare arrays**.
     - **Dates** — accounting dates are date-only `YYYY-MM-DD`. Reports take `?asOf=YYYY-MM-DD` (balance sheet, aging, trial balance) or `?from=&to=` (income statement, cash flow, general ledger). Periods are monthly per fiscal year.
     - **traceId** — the `X-Request-Id` response header equals the error envelope `traceId`; show it on error screens for support.
     - **Soft-delete** — `DELETE`/deactivate is a soft delete; the resource then returns 404 and disappears from lists; codes are tombstoned and reusable.
  3. **Role matrix** — a table from Step 1 (Role × endpoint), reads any-auth, the SoD note (poster ≠ creator when enabled → 403).
  4. **Domain lifecycles** — journal entry (`POST /ledger/journal-entries` create draft → `POST /:id/post` [APPROVER+] → `POST /:id/reverse`; discover drafts via `GET /ledger/journal-entries?status=DRAFT`); sales invoices / purchase bills (`POST` create draft → `POST /:id/post` → `POST /:id/void`); payments (`POST /payments` RECEIPT/DISBURSEMENT with full allocation → `POST /:id/post` → `POST /:id/void`); year-end close (`POST /close/year-end {fiscalYear}` → `POST /close/year-end/:fy/reopen`; the year-lock then blocks new posting into that year); tax preview (`POST /tax/calculate`).
  5. **Glossary** — SAK chart-code ranges (Kas 1-1000, Bank 1-1100, Piutang 1-1200, Utang 2-1000, Modal 3-1000, Laba Ditahan 3-2000, Pendapatan 4-1000, HPP 5-1000 …); fiscal year/period; PPN (VAT) / PPh (withholding); Neraca (balance sheet) / Laba Rugi (income statement) / Buku Besar (general ledger) / Arus Kas (cash flow) / Jurnal (journal) / Saldo Awal (opening balance).
  6. **Endpoint catalog** — grouped by tag: `METHOD · path · role · one-line purpose` (the human index; `openapi.json` has the schemas).
  7. **Recommended FE surface (stack-agnostic)** — screens → endpoints: Login (`/auth/*`); Dashboard (reports summary); Chart of Accounts (`/accounts`); Journal register (`/ledger/journal-entries` list + create/post/reverse + the DRAFT approval queue); Sales Invoices / Purchase Bills / Payments; Reports (`/reports/*` + `/ledger/trial-balance`); Periods + Year-end Close (`/ledger/periods`, `/close/year-end`); Tax (`/tax/codes`, `/tax/calculate`); Audit log (`/audit`, ADMIN); Company settings (`/company`, ADMIN). Plus the cross-cutting concerns to build: an auth/refresh fetch wrapper, error-envelope handling, money formatting, role-gated UI.

- [ ] **Step 3: Write `docs/api/frontend-agent-brief.md`** — a short briefing to copy into the FE repo root as `AGENTS.md`/`CLAUDE.md`:
  - Goal: build a frontend for this accounting API.
  - Sources of truth: `openapi.json` (codegen a typed client) + `frontend-guide.md` (conventions, roles, lifecycles, glossary).
  - **Non-negotiable rules** (condensed): money = 4dp **strings** (decimal lib, never floats); errors = `{code,message,details}` per the taxonomy; `Bearer` + **refresh on 401**; respect the **role matrix** (hide/disable actions the role can't do, but still handle 403); `YYYY-MM-DD` dates; journal list is paginated, other lists are bare arrays; **soft-delete → 404**; the **draft→post approval** flow.
  - Do's/don'ts + how to regenerate `openapi.json` (`npm run openapi:export` in the API repo).

- [ ] **Step 4: Accuracy cross-check** — re-run the Step 1 greps and confirm the matrix/catalog match every `@Roles`/`@Public`/route; confirm the money/pagination/status conventions match `AllExceptionsFilter` + the DTOs; spot-check 2 documented shapes against `docs/api/openapi.json` (e.g. the error envelope, the journal-list envelope). Fix any drift.

- [ ] **Step 5: Commit**

```bash
git add docs/api/frontend-guide.md docs/api/frontend-agent-brief.md
git commit -m "docs(api): frontend guide + agent brief (conventions, roles, lifecycles, glossary)"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §3.1 swagger CLI plugin → Task 1 Step 2 ✓
- §3.2 @ApiTags per controller → Step 4 ✓
- §3.3 @ApiBearerAuth + public routes → Step 4 ✓
- §3.4 shared response shapes (error envelope, token; pagination/money documented) → Step 3 + the guide ✓
- §3.5 DB-free export script (preview mode, PrismaService-stub fallback) + openapi:export → Steps 5-6 ✓
- §4 frontend-guide.md sections + frontend-agent-brief.md → Task 2 Steps 2-3 ✓
- §5 accuracy-from-code (grep-derived matrix/catalog) → Task 2 Steps 1, 4 ✓
- §6 verification (export valid + tags + DTO schemas + bearer; e2e green; accuracy review) → Task 1 Steps 7-8, Task 2 Step 4 ✓

**Placeholder scan:** none — full code for the plugin/models/export-script; the guide is specified by section + the concrete derived facts/tables to encode (role matrix, taxonomy, conventions, lifecycles, glossary) — content, not TBDs.

**Consistency:** `ErrorEnvelopeDto`/`TokenPairDto` names match across the models file, the export script's `extraModels`, and the guide; the domain tags match between Step 4 and the guide's catalog grouping; `docs/api/openapi.json` is the path written by the script (Step 5), verified (Step 7), referenced by the guide + brief, and committed (Step 9); the role matrix in Task 2 matches the `@Roles` grep in both Task 2 Step 1 and the verification (Step 4).
