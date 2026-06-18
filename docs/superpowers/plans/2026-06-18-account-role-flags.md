# Account Role Flags Implementation Plan (Deepening D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the by-code chart-of-accounts coupling with an explicit `AccountRole` on the `Account` model, fixing the latent cash-flow bug (a new cash account whose code isn't in the hardcoded set is silently dropped).

**Architecture:** Add a nullable `role AccountRole?` column + a partial-unique index enforcing the five singleton roles (CASH is a set). Backfill the seeded chart in the migration (production) and set `role` in the seed (fresh installs) — behavior-preserving. Switch six lookups (cash-flow, income-statement, `BalancesService` row projection, control-account, year-end-close, journal opening-balance) from `code` to `role`. Optional `role` on the create-account DTO; singleton conflicts → 409.

**Tech Stack:** NestJS 11, Prisma 7 (adapter pattern, **hand-authored migrations**), TypeScript 5.9 (strict), Jest + ts-jest (unit), Jest + Testcontainers `postgres:16` (e2e), class-validator, `@nestjs/swagger`.

## Global Constraints

- **Behavior-preserving for the current seeded chart.** Role-based lookups must return exactly the accounts the code lookups did. The existing reporting/close e2e specs are the characterization net and must stay green — do NOT change their assertions.
- **Full gate per task:** `npm run db:generate && npm run typecheck` (0 errors), `npm run lint:ci` (0 problems), `npm test` (unit), and the relevant `npm run test:e2e -- <name>` — all green before commit. Docker must be running (Testcontainers `postgres:16`).
- **Hand-authored migrations** — no `prisma migrate dev` autogen. New migration dir: `prisma/migrations/20260618000000_account_role/migration.sql` (timestamp sorts after the latest, `20260617000001_audit_log_append_only`).
- **`enableVersioning` is mandatory** in every e2e `beforeAll`: `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`. Routes are under `/v1`.
- **Two independent `data:{...}` blocks** write accounts: `AccountsService.create()` AND `AccountsService.seedIfEmpty()` — both must thread `role`.
- **In e2e, the migration backfill is a no-op** (fresh DB seeded by `seedIfEmpty` after `migrate deploy`); test roles come from the SEED. The migration backfill is for existing production data — correct by construction.
- The six roles → current codes (the backfill/seed mapping): `CASH`=`1-1000`,`1-1100`; `AR_CONTROL`=`1-1200`; `AP_CONTROL`=`2-1000`; `RETAINED_EARNINGS`=`3-2000`; `OPENING_BALANCE_EQUITY`=`3-9000`; `TAX_EXPENSE`=`5-9000`.
- Money is 4dp strings; `cashFlowCategory` (OPERATING/INVESTING/FINANCING/NONE) is a SEPARATE column and is NOT touched.

---

## Task 1: Schema + migration + seed role assignment

**Files:**
- Modify: `prisma/schema.prisma` (add `AccountRole` enum + `role` field on `Account`)
- Create: `prisma/migrations/20260618000000_account_role/migration.sql`
- Modify: `src/ledger/accounts/chart-of-accounts.seed.ts` (`SeedAccount.role` + 7 entries)
- Modify: `src/ledger/accounts/accounts.service.ts` (`seedIfEmpty()` `data` block)
- Test: `test/accounts.e2e-spec.ts` (assert seeded roles)

**Interfaces:**
- Produces: `enum AccountRole { CASH, AR_CONTROL, AP_CONTROL, RETAINED_EARNINGS, OPENING_BALANCE_EQUITY, TAX_EXPENSE }` (in `@prisma/client` after generate); `Account.role: AccountRole | null`; `SeedAccount.role?: AccountRole`.

- [ ] **Step 1: Add the enum + column to `prisma/schema.prisma`**

After the `enum NormalBalance { ... }` block add:
```prisma
enum AccountRole {
  CASH
  AR_CONTROL
  AP_CONTROL
  RETAINED_EARNINGS
  OPENING_BALANCE_EQUITY
  TAX_EXPENSE
}
```
In `model Account`, add this field directly after the `cashFlowCategory` line:
```prisma
  role             AccountRole?
```
(No `@map` — the field name `role` already matches the column.)

- [ ] **Step 2: Write the hand-authored migration**

Create `prisma/migrations/20260618000000_account_role/migration.sql`:
```sql
-- AccountRole: explicit system-account roles replacing by-code coupling.
CREATE TYPE "AccountRole" AS ENUM (
  'CASH', 'AR_CONTROL', 'AP_CONTROL', 'RETAINED_EARNINGS', 'OPENING_BALANCE_EQUITY', 'TAX_EXPENSE'
);

ALTER TABLE "accounts" ADD COLUMN "role" "AccountRole";

-- At most one account per singleton role; CASH may be held by many accounts.
CREATE UNIQUE INDEX "accounts_singleton_role"
  ON "accounts" ("role")
  WHERE "role" IS NOT NULL AND "role" <> 'CASH';

-- Behavior-preserving backfill of the seeded chart (production data; no-op on a fresh DB).
UPDATE "accounts" SET "role" = 'CASH'                   WHERE "code" IN ('1-1000', '1-1100');
UPDATE "accounts" SET "role" = 'AR_CONTROL'             WHERE "code" = '1-1200';
UPDATE "accounts" SET "role" = 'AP_CONTROL'             WHERE "code" = '2-1000';
UPDATE "accounts" SET "role" = 'RETAINED_EARNINGS'      WHERE "code" = '3-2000';
UPDATE "accounts" SET "role" = 'OPENING_BALANCE_EQUITY' WHERE "code" = '3-9000';
UPDATE "accounts" SET "role" = 'TAX_EXPENSE'            WHERE "code" = '5-9000';
```

- [ ] **Step 3: Add `role` to the seed (`chart-of-accounts.seed.ts`)**

Add `AccountRole` to the `@prisma/client` import at the top (alongside `AccountType`, `AccountSubtype`, etc.). Add to the `SeedAccount` interface (after `cashFlowCategory?`):
```ts
  role?: AccountRole;
```
Add a `role` field to these 7 entries (leave all other fields untouched):
- `1-1000` → `role: 'CASH',`
- `1-1100` → `role: 'CASH',`
- `1-1200` → `role: 'AR_CONTROL',`
- `2-1000` → `role: 'AP_CONTROL',`
- `3-2000` → `role: 'RETAINED_EARNINGS',`
- `3-9000` → `role: 'OPENING_BALANCE_EQUITY',`
- `5-9000` → `role: 'TAX_EXPENSE',`

- [ ] **Step 4: Thread `role` through `seedIfEmpty()` (`accounts.service.ts`)**

In `seedIfEmpty()`'s `tx.account.create({ data: { ... } })` block, add `role` after `cashFlowCategory`:
```ts
            cashFlowCategory: a.cashFlowCategory ?? 'NONE',
            role: a.role ?? null,
            isPostable: a.isPostable ?? true,
            parentId,
```

- [ ] **Step 5: Write the seeded-roles test**

Add to `test/accounts.e2e-spec.ts` (after the existing seed test):
```ts
  it('seedIfEmpty assigns system-account roles', async () => {
    const byCode = async (code: string) =>
      prismaOverride.client.account.findFirst({ where: { code } });
    expect((await byCode('1-1000'))?.role).toBe('CASH');
    expect((await byCode('1-1100'))?.role).toBe('CASH');
    expect((await byCode('1-1200'))?.role).toBe('AR_CONTROL');
    expect((await byCode('2-1000'))?.role).toBe('AP_CONTROL');
    expect((await byCode('3-2000'))?.role).toBe('RETAINED_EARNINGS');
    expect((await byCode('3-9000'))?.role).toBe('OPENING_BALANCE_EQUITY');
    expect((await byCode('5-9000'))?.role).toBe('TAX_EXPENSE');
    // a non-system account has no role
    expect((await byCode('1-1300'))?.role).toBeNull();
  });
```
(`prismaOverride` is the spec's existing overridden PrismaService.)

- [ ] **Step 6: Generate, typecheck, run accounts e2e, commit**

Run: `npm run db:generate && npm run typecheck` → 0 errors.
Run: `npm run test:e2e -- accounts` → green (incl. the new role test; the hardcoded `count === 28` test is unaffected — we added no accounts).
Run: `npm run lint:ci` → 0 problems.
```bash
git add prisma/schema.prisma prisma/migrations/20260618000000_account_role src/ledger/accounts/chart-of-accounts.seed.ts src/ledger/accounts/accounts.service.ts test/accounts.e2e-spec.ts
git commit -m "feat(accounts): add AccountRole enum + role column, seed/backfill the chart"
```

---

## Task 2: Carry `role` on the balance-row projection (`BalancesService`)

**Files:**
- Modify: `src/ledger/balances/balances.service.ts`

**Interfaces:**
- Consumes: `Account.role` (Task 1).
- Produces: `AccountBalanceRow.role: string` (carries the account's role, `''`-or-null-safe) on the rows returned by `movementsBetween()` / `balancesAsOf()`.

This is enabling-only (no filter uses `role` yet) → behavior unchanged; the reporting e2e must stay green.

- [ ] **Step 1: Add `role` to both row interfaces**

In `RawBalanceRow` (after `cash_flow_category`):
```ts
  role: string | null;
```
In `AccountBalanceRow` (after `cashFlowCategory: string;`):
```ts
  role: string | null;
```

- [ ] **Step 2: Add `a.role` to the SQL SELECT + GROUP BY in `groupedBalances()`**

In the `Prisma.sql` template: add `a.role` to the SELECT list and to the `GROUP BY` (GROUP BY is mandatory — `role` is non-aggregated):
```ts
      SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
             a.normal_balance, a.cash_flow_category, a.role,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.posted_at IS NOT NULL AND je.deleted_at IS NULL AND a.deleted_at IS NULL AND ${dateFilter}
      GROUP BY a.id, a.code, a.name, a.type, a.subtype, a.normal_balance, a.cash_flow_category, a.role
      ORDER BY a.code ASC
```

- [ ] **Step 3: Map `role` in `toRow()`**

Add after `cashFlowCategory: r.cash_flow_category,`:
```ts
      role: r.role,
```

- [ ] **Step 4: Typecheck + reporting e2e (still green — nothing filters on role yet), commit**

Run: `npm run db:generate && npm run typecheck` → 0 errors.
Run: `npm run test:e2e -- "reporting|balances|close"` → green (behavior unchanged).
Run: `npm run lint:ci` → 0 problems.
```bash
git add src/ledger/balances/balances.service.ts
git commit -m "feat(balances): carry account role on balance-row projection"
```

---

## Task 3: Switch cash-flow + income-statement to role + the bug-fix test

**Files:**
- Modify: `src/reporting/cash-flow.service.ts` (replace `CASH_CODES`)
- Modify: `src/reporting/income-statement.service.ts` (replace `TAX_EXPENSE_CODE`)
- Create: `test/cash-flow-role.e2e-spec.ts` (the bug-fix proof)

**Interfaces:**
- Consumes: `AccountBalanceRow.role` (Task 2). The existing `reporting-cashflow`/`reporting-statements` e2e specs are the characterization net (do not modify their assertions).

- [ ] **Step 1: cash-flow — replace the two `CASH_CODES` uses with role checks**

Delete the `CASH_CODES` constant (and its now-obsolete comment block). In `cashBalance()` change the filter to:
```ts
      .filter((r) => r.role === 'CASH')
```
In `generate()` change the `nonCash` line to:
```ts
    const nonCash = movements.filter((r) => r.role !== 'CASH');
```
Leave everything else (P&L split, `cashFlowCategory` bucketing, `bucket()`, kasAwal/kasAkhir) unchanged.

- [ ] **Step 2: income-statement — replace `TAX_EXPENSE_CODE` with role**

Delete the `TAX_EXPENSE_CODE` constant. Change the two filters in `generate()` to:
```ts
    const taxRows = all.filter((r) => r.role === 'TAX_EXPENSE');
    const rows = all.filter((r) => r.role !== 'TAX_EXPENSE');
```

- [ ] **Step 3: Run the characterization specs (must stay green)**

Run: `npm run test:e2e -- "reporting-cashflow|reporting-statements"` → green. These pin the current numbers (`kasAkhir 11500000.0000`, `netIncome 1500000.0000`, etc.); role-based lookup returns the same seeded accounts, so they MUST pass unchanged. If any fails, the role backfill/seed (Task 1) is wrong — fix that, don't touch the assertions.

- [ ] **Step 4: Write the bug-fix test (a non-legacy cash account participates)**

Create `test/cash-flow-role.e2e-spec.ts` — model the bootstrap on `test/reporting-cashflow.e2e-spec.ts` (startTestDb → makePrismaOverride → overrideProvider(PrismaService) → `app.enableVersioning({type:VersioningType.URI, defaultVersion:'1'})` → ValidationPipe(whitelist,transform) + AllExceptionsFilter → `CompanyService.seedIfEmpty()` + `update({segregationOfDutiesEnabled:false})` → `AccountsService.seedIfEmpty()` → `PeriodsService.generatePeriods(2026)` → mint admin token). Then:
```ts
  it('a CASH-role account with a non-legacy code participates in cash flow', async () => {
    // A second bank account whose code is NOT in the old CASH_CODES set.
    // Created via raw Prisma (the role column exists after Task 1) so this test
    // does NOT depend on the create-DTO role threading (Task 6). parentId is
    // nullable and irrelevant to the cash-flow report, so it is omitted.
    const bank2 = await prismaOverride.client.account.create({
      data: {
        code: '1-1150',
        name: 'Bank Kedua',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        role: 'CASH',
      },
    });
    // Opening balance into the new bank: Dr 1-1150 1,000,000 / Cr 3-9000 (equity).
    const accounts = await app.get(AccountsService).listAll();
    const equity = accounts.find((a) => a.code === '3-9000')!;
    await app.get(PostingService).post(
      {
        date: new Date('2026-02-01'),
        description: 'Open Bank Kedua',
        sourceType: 'MANUAL',
        lines: [
          { accountId: bank2.id, debit: '1000000.0000' },
          { accountId: equity.id, credit: '1000000.0000' },
        ],
      },
      'admin',
    );
    const res = await request(app.getHttpServer() as App)
      .get('/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as { kasAkhir: string; reconciles: boolean };
    // Under the OLD code (CASH_CODES = {1-1000,1-1100}) the 1-1150 debit would be a
    // non-cash adjustment and kasAkhir would EXCLUDE it. Role-based, it is cash.
    expect(body.kasAkhir).toBe('1000000.0000');
    expect(body.reconciles).toBe(true);
  });
```
> Implementer note: confirm the exact `PostingService.post(input, actor)` input shape against an existing posting in `reporting-cashflow.e2e-spec.ts` (line/field names — `sourceType`, line `{accountId, debit|credit}`) and match it verbatim. This is a fresh DB with only this one entry, so `kasAkhir` is exactly the 1-1150 balance. `listAll()` is `AccountsService.listAll()` (unpaginated).

- [ ] **Step 5: Run the new test + full reporting e2e, lint, commit**

Run: `npm run db:generate && npm run typecheck` → 0 errors.
Run: `npm run test:e2e -- "cash-flow-role|reporting"` → all green.
Run: `npm run lint:ci` → 0 problems.
```bash
git add src/reporting/cash-flow.service.ts src/reporting/income-statement.service.ts test/cash-flow-role.e2e-spec.ts
git commit -m "fix(reporting): cash-flow & income-statement filter by account role (fixes silent cash drop)"
```

---

## Task 4: Switch control-account lookup to role (`document-helpers` + 7 callers)

**Files:**
- Modify: `src/invoicing/document-helpers.ts` (`findControlAccountId` signature; drop `AR_CONTROL_CODE`/`AP_CONTROL_CODE`)
- Modify: `src/invoicing/sales-invoices.service.ts` (3 call sites), `src/invoicing/purchase-bills.service.ts` (3), `src/invoicing/payments.service.ts` (1)

**Interfaces:**
- Produces: `findControlAccountId(prisma: PrismaService, role: AccountRole): Promise<string>`.

- [ ] **Step 1: Change `findControlAccountId` to look up by role**

In `document-helpers.ts`: delete the `AR_CONTROL_CODE` and `AP_CONTROL_CODE` constants. Add `AccountRole` to the `@prisma/client` import. Replace the function:
```ts
/** Resolves a control account's id by its role; 422 if it is missing. */
export async function findControlAccountId(
  prisma: PrismaService,
  role: AccountRole,
): Promise<string> {
  const acc = await prisma.client.account.findFirst({ where: { role } });
  if (!acc) {
    throw new ValidationFailedError('Control account missing from chart', {
      role,
    });
  }
  return acc.id;
}
```

- [ ] **Step 2: Update the 7 call sites**

In `sales-invoices.service.ts` (3 sites) replace `findControlAccountId(this.prisma, AR_CONTROL_CODE)` with `findControlAccountId(this.prisma, 'AR_CONTROL')`. Remove `AR_CONTROL_CODE` from its `./document-helpers` import.
In `purchase-bills.service.ts` (3 sites) replace `AP_CONTROL_CODE` → `'AP_CONTROL'`; remove the import.
In `payments.service.ts` (1 site) replace:
```ts
    const controlId = await findControlAccountId(
      this.prisma,
      isReceipt ? 'AR_CONTROL' : 'AP_CONTROL',
    );
```
and remove `AR_CONTROL_CODE`/`AP_CONTROL_CODE` from its `./document-helpers` import.
(Use the bare string literals — they're assignable to the `AccountRole` enum type; no `@prisma/client` import needed in the callers. If lint/types prefer the enum, import `AccountRole` and use `AccountRole.AR_CONTROL`.)

- [ ] **Step 3: Typecheck + invoicing e2e + lint + commit**

Run: `npm run db:generate && npm run typecheck` → 0 errors.
Run: `npm run test:e2e -- "sales-invoices|purchase-bills|payments"` → green (same seeded control accounts, now by role).
Run: `npm run lint:ci` → 0 problems.
```bash
git add src/invoicing/document-helpers.ts src/invoicing/sales-invoices.service.ts src/invoicing/purchase-bills.service.ts src/invoicing/payments.service.ts
git commit -m "refactor(invoicing): resolve AR/AP control accounts by role, not code"
```

---

## Task 5: Switch year-end-close + journal opening-balance to role

**Files:**
- Modify: `src/close/year-end-close.service.ts` (retained-earnings)
- Modify: `src/ledger/journal/journal.service.ts` (opening-balance-equity)
- Modify: `src/ledger/accounts/chart-of-accounts.seed.ts` (drop the `OPENING_BALANCE_EQUITY_CODE` export)

- [ ] **Step 1: year-end-close — look up retained earnings by role**

Delete the `const RETAINED_EARNINGS_CODE = '3-2000';` line. Replace the lookup + guard:
```ts
      const retained = await this.prisma.client.account.findFirst({
        where: { role: 'RETAINED_EARNINGS' },
      });
      if (!retained) {
        throw new ValidationFailedError(
          'Laba Ditahan account missing from chart',
          { role: 'RETAINED_EARNINGS' },
        );
      }
```
(Everything after — the `lines.push(...)` using `retained.id` — is unchanged.)

- [ ] **Step 2: journal — look up opening-balance equity by role (direct query)**

Remove the import `import { OPENING_BALANCE_EQUITY_CODE } from '../accounts/chart-of-accounts.seed';`. Replace the `listAll().find(...)` block:
```ts
    const equity = await this.prisma.client.account.findFirst({
      where: { role: 'OPENING_BALANCE_EQUITY' },
    });
    if (!equity) {
      throw new ValidationFailedError(
        'Opening Balance Equity account missing from chart',
      );
    }
```
(`equity.id` usage below is unchanged.) This was the file's only `this.accounts.listAll()` call — if `this.accounts` (AccountsService) is now unused anywhere else in `journal.service.ts`, remove the injection + import; otherwise leave it. Grep `this.accounts` in the file to decide.

- [ ] **Step 3: Drop the now-unused seed export**

In `chart-of-accounts.seed.ts` delete `export const OPENING_BALANCE_EQUITY_CODE = '3-9000';` (its only consumer was journal, now removed). Grep `OPENING_BALANCE_EQUITY_CODE` across `src` + `test` to confirm zero remaining references before deleting.

- [ ] **Step 4: Typecheck + close & journal e2e + lint + commit**

Run: `npm run db:generate && npm run typecheck` → 0 errors.
Run: `npm run test:e2e -- "close|journal|opening"` → green (retained `3-2000` close + opening-balance flows unchanged).
Run: `npm run lint:ci` → 0 problems.
```bash
git add src/close/year-end-close.service.ts src/ledger/journal/journal.service.ts src/ledger/accounts/chart-of-accounts.seed.ts
git commit -m "refactor: resolve retained-earnings & opening-balance-equity accounts by role"
```

---

## Task 6: Accept `role` on create + singleton-conflict 409 + response DTO

**Files:**
- Modify: `src/ledger/accounts/dto/create-account.dto.ts` (`role?`)
- Modify: `src/ledger/accounts/accounts.service.ts` (`CreateAccountInput.role`, `create()` data + singleton pre-check)
- Modify: `src/ledger/accounts/dto/account-response.dto.ts` (expose `role`)
- Test: `test/accounts.e2e-spec.ts` (create with role; second singleton → 409)
- Modify: `docs/api/openapi.json` (regenerated)

- [ ] **Step 1: Add `role` to the create DTO**

In `create-account.dto.ts` add `AccountRole` to the `@prisma/client` import and add (after `cashFlowCategory`):
```ts
  @IsOptional() @IsEnum(AccountRole) role?: AccountRole;
```

- [ ] **Step 2: Thread `role` through `CreateAccountInput` + `create()` + add the singleton pre-check**

In `accounts.service.ts`: add to `CreateAccountInput` (after `cashFlowCategory?`):
```ts
  role?: Account['role'];
```
In `create()`, after the existing code-uniqueness pre-check (the `existing` block), add a singleton-role pre-check:
```ts
    // Singleton roles (everything except CASH) may be held by at most one account.
    if (input.role && input.role !== 'CASH') {
      const roleHolder = await this.prisma.client.account.findFirst({
        where: { role: input.role },
      });
      if (roleHolder) {
        throw new ConflictDomainError('That account role is already assigned', {
          role: input.role,
        });
      }
    }
```
In the `create({ data: { ... } })` block, add after `cashFlowCategory`:
```ts
          role: input.role ?? null,
```
(The existing `mapUniqueViolation` catch remains the race backstop; the partial-unique index guarantees integrity. A rare concurrent singleton race would surface as the generic 409 — acceptable.)

- [ ] **Step 3: Expose `role` on the response DTO**

In `account-response.dto.ts` add (mirroring the nullable `parentId` style):
```ts
  @ApiProperty({
    enum: ['CASH', 'AR_CONTROL', 'AP_CONTROL', 'RETAINED_EARNINGS', 'OPENING_BALANCE_EQUITY', 'TAX_EXPENSE'],
    nullable: true,
  })
  role!: string | null;
```

- [ ] **Step 4: Tests — create-with-role + singleton 409**

Append these to `test/accounts.e2e-spec.ts` at the END of the describe block — they MUST run after the existing `expect(count).toBe(28)` test, since they create accounts (Jest runs tests in file order; placing them before the count assertion would make it see 29+ and fail):
```ts
  it('creates an account with a CASH role', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1700', name: 'Bank Ketiga', type: 'ASSET',
        subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', role: 'CASH',
        parentCode: '1-0000',
      })
      .expect(201);
    expect((res.body as { role: string }).role).toBe('CASH');
  });

  it('rejects a second holder of a singleton role with 409', async () => {
    // 1-1200 is already AR_CONTROL from the seed.
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1250', name: 'AR Control 2', type: 'ASSET',
        subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', role: 'AR_CONTROL',
        parentCode: '1-0000',
      })
      .expect(409);
  });
```

- [ ] **Step 5: Regenerate OpenAPI**

Run: `npm run openapi:export`. The expected `docs/api/openapi.json` change is additive: `role` added to `AccountResponseDto` + the `role` property on the create-account request body. Commit the regenerated file. Confirm the `openapi-contract` unit spec still passes (`npm test`).

- [ ] **Step 6: Full gate + commit**

Run: `npm run db:generate && npm run typecheck` → 0; `npm run lint:ci` → 0; `npm test` → green (incl. openapi-contract); `npm run test:e2e -- accounts` → green.
```bash
git add src/ledger/accounts/dto/create-account.dto.ts src/ledger/accounts/accounts.service.ts src/ledger/accounts/dto/account-response.dto.ts test/accounts.e2e-spec.ts docs/api/openapi.json
git commit -m "feat(accounts): accept role on create with singleton-role 409 + expose in response"
```

---

## Task 7: Final verification

- [ ] **Step 1: Confirm all by-code constants are gone**

Run: `grep -rnE "CASH_CODES|AR_CONTROL_CODE|AP_CONTROL_CODE|RETAINED_EARNINGS_CODE|OPENING_BALANCE_EQUITY_CODE|TAX_EXPENSE_CODE" src`
Expected: **no matches** (all six replaced by role lookups).

- [ ] **Step 2: Full gate**

Run: `npm run db:generate && npm run verify` → typecheck 0, lint:ci 0, unit all green, e2e 40+ suites green (now including `cash-flow-role`), coverage thresholds met.

- [ ] **Step 3: Regenerate OpenAPI (idempotent check) + commit any residue**

Run: `npm run openapi:export`; `git diff --stat docs/api/openapi.json` should be empty (already committed in Task 6). If clean, nothing to commit.

---

## Self-Review notes

- **Spec coverage:** schema/enum/index/migration/backfill (Task 1); seed roles (Task 1); BalancesService projection (Task 2); cash-flow + income-statement role filters + bug-fix test (Task 3); control-account by role (Task 4); retained-earnings + opening-balance by role (Task 5); create-DTO role + singleton 409 + response DTO (Task 6); dead-constant sweep + full gate (Task 7). Characterization-first: existing reporting/close e2e are the net (Tasks 3/5 must keep them green untouched). All six couplings + the bug fix covered.
- **Behavior-preserving:** seed + migration backfill map the exact current codes → roles; the characterization specs guard the numbers.
- **Watch-points:** (a) GROUP BY must include `a.role` (Task 2) or Postgres errors; (b) in e2e the migration backfill is a no-op — roles come from the seed; (c) the `accounts.e2e` `count === 28` test is unaffected (no accounts added to the chart); (d) confirm `PostingService.post` input shape against an existing spec before writing the bug-fix test.
