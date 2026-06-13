# Typed OpenAPI Response Schemas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every endpoint in `docs/api/openapi.json` a named, accurate response-body schema (67 endpoints currently have none), document-only, with no runtime behavior change.

**Architecture:** Add decorated response DTO classes (`@ApiProperty`) and annotate each controller method with `@ApiOkResponse/@ApiCreatedResponse/@ApiNoContentResponse({ type })`. The NestJS Swagger plugin reads these into the exported spec. Controllers keep returning exactly what they return today. A guard test asserts every 2xx response carries a body schema, so the work is test-driven and regression-proof.

**Tech Stack:** NestJS 11, `@nestjs/swagger`, Prisma 7, Jest. Spec is produced by `npm run openapi:export` (`nest build` + `node dist/scripts/export-openapi.js`, preview mode, no DB).

---

## Conventions (apply in every DTO)

- **Money fields** → use the `@ApiMoney()` decorator (Task 1). All money serializes as a fixed 4-dp **string** (`src/common/money/money.ts`), never a number. This includes invoice/bill line `quantity`, `unitPrice`, `amount`; tax `rate` is a 6-dp decimal string — use `@ApiProperty({ type: String, example: '0.110000' })` for `rate`, `@ApiMoney()` for currency amounts.
- **Enums** → `@ApiProperty({ enum: [ ...literal values... ] })` with the exact strings (listed per DTO). Do **not** import Prisma enum objects — list the literals so the spec is self-contained.
- **DB-nullable but always present** (e.g. `entryNumber`, `dueDate`) → `@ApiProperty({ ..., nullable: true })` (stays required, value or `null`).
- **Sometimes absent** (nested `lines`/`allocations`, present on detail, absent on list) → `@ApiPropertyOptional({ ... })`.
- **Omit** `deletedAt` and `deletedBy` from every response DTO. They are internal soft-delete bookkeeping, inconsistently present in raw output, and not part of the contract. OpenAPI schemas here are non-strict (no `additionalProperties: false`), so omitting them is correct and safe.
- **Dates** that the service slices to `YYYY-MM-DD` (`date`, `startDate`, `endDate`, report `from`/`to`/`asOf`) → `@ApiProperty({ type: String, format: 'date', example: '2026-01-31' })`. Full timestamps (`createdAt`, `updatedAt`, `postedAt`, `closedAt`, `timestamp`) → `@ApiProperty({ type: String, format: 'date-time' })`.

## File Structure

New response-DTO files (one per module, in each module's existing `dto/` folder):

- `src/common/openapi/api-money.decorator.ts` — `@ApiMoney()` helper
- `src/common/openapi/openapi.models.ts` — **extend** with `HealthStatusDto`, `ReadinessStatusDto`, `AuthenticatedUserDto`, `OkFlagDto`
- `src/common/openapi/openapi-contract.spec.ts` — the guard test (unit)
- `src/company/dto/company-settings-response.dto.ts`
- `src/ledger/accounts/dto/account-response.dto.ts`
- `src/ledger/balances/dto/balance-response.dto.ts` (new `dto/` folder)
- `src/ledger/periods/dto/period-response.dto.ts`
- `src/ledger/journal/dto/journal-response.dto.ts`
- `src/tax/dto/tax-code-response.dto.ts`
- `src/tax/dto/tax-calculation-response.dto.ts`
- `src/invoicing/dto/business-partner-response.dto.ts`
- `src/invoicing/dto/sales-invoice-response.dto.ts`
- `src/invoicing/dto/purchase-bill-response.dto.ts`
- `src/invoicing/dto/payment-response.dto.ts`
- `src/reporting/dto/report-response.dto.ts`
- `src/close/dto/closing-response.dto.ts`
- `src/audit/dto/audit-entry-response.dto.ts`

Modified controllers (decorators only): auth, health, metrics, company, accounts, balances, periods, journal, opening-balances, tax-codes, tax, business-partners, sales-invoices, purchase-bills, payments, reports, closing, audit.

---

## Task 1: `@ApiMoney()` decorator

**Files:**
- Create: `src/common/openapi/api-money.decorator.ts`
- Test: `src/common/openapi/api-money.decorator.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/common/openapi/api-money.decorator.spec.ts
import 'reflect-metadata';
import { ApiMoney } from './api-money.decorator';

class Sample {
  @ApiMoney() amount!: string;
  @ApiMoney({ description: 'Tax rate', example: '0.110000' }) rate!: string;
}

describe('ApiMoney', () => {
  it('registers the property in swagger metadata as a string', () => {
    const meta = Reflect.getMetadata(
      'swagger/apiModelPropertiesArray',
      Sample.prototype,
    ) as string[];
    expect(meta).toEqual(
      expect.arrayContaining([':amount', ':rate']),
    );
  });

  it('defaults the example to a 4-dp string', () => {
    const props = Reflect.getMetadata(
      'swagger/apiModelProperties',
      Sample.prototype,
      'amount',
    ) as { type: unknown; example: string };
    expect(props.example).toBe('1000.0000');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- api-money.decorator`
Expected: FAIL — `Cannot find module './api-money.decorator'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/common/openapi/api-money.decorator.ts
import { ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';

/**
 * Documents a monetary field. All money in this API serializes as a fixed
 * 4-decimal-place string (see common/money/money.ts) — never a JS number.
 */
export function ApiMoney(options: ApiPropertyOptions = {}): PropertyDecorator {
  return ApiProperty({
    type: String,
    example: '1000.0000',
    description: 'Decimal monetary amount as a string, fixed 4 decimal places.',
    ...options,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- api-money.decorator`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/openapi/api-money.decorator.ts src/common/openapi/api-money.decorator.spec.ts
git commit -m "feat(openapi): add ApiMoney property decorator"
```

---

## Task 2: Shared response models

**Files:**
- Modify: `src/common/openapi/openapi.models.ts`

- [ ] **Step 1: Append the shared models**

Append to `src/common/openapi/openapi.models.ts` (keep the existing `ErrorEnvelopeDto` and `TokenPairDto`):

```ts
/** GET /health */
export class HealthStatusDto {
  @ApiProperty({ example: 'ok' }) status!: string;
}

/** GET /ready */
export class ReadinessStatusDto {
  @ApiProperty({ example: 'ok' }) status!: string;
  @ApiProperty({ example: 'up' }) db!: string;
}

/** GET /auth/me — the authenticated principal derived from the JWT. */
export class AuthenticatedUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'admin@x.com' }) email!: string;
  @ApiProperty({ enum: ['ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'] })
  role!: string;
}

/** GET /auth/admin-only — RBAC smoke surface. */
export class OkFlagDto {
  @ApiProperty({ example: true }) ok!: boolean;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/common/openapi/openapi.models.ts
git commit -m "feat(openapi): add shared health/auth response models"
```

---

## Task 3: OpenAPI contract guard test (the driving failing test)

**Files:**
- Create: `src/common/openapi/openapi-contract.spec.ts`

This test reads the **exported** `docs/api/openapi.json`. The workflow for every later task is: edit → `npm run openapi:export` → `npm test -- openapi-contract`. It starts fully red and goes green as DTOs are wired.

- [ ] **Step 1: Write the guard test**

```ts
// src/common/openapi/openapi-contract.spec.ts
import { readFileSync } from 'fs';
import { join } from 'path';

interface OpenApiDoc {
  paths: Record<
    string,
    Record<
      string,
      { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
    >
  >;
}

// Endpoints whose 2xx body is legitimately not application/json.
const TEXT_PLAIN_PATHS = new Set(['/metrics']);

describe('OpenAPI response contract', () => {
  const doc = JSON.parse(
    readFileSync(join(process.cwd(), 'docs/api/openapi.json'), 'utf8'),
  ) as OpenApiDoc;

  it('every 2xx response declares a non-empty body schema', () => {
    const offenders: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        for (const [code, res] of Object.entries(op.responses ?? {})) {
          if (!code.startsWith('2')) continue;
          if (code === '204') continue; // no body by design
          const label = `${method.toUpperCase()} ${path} (${code})`;
          if (TEXT_PLAIN_PATHS.has(path)) {
            if (!res.content?.['text/plain']?.schema) offenders.push(label);
            continue;
          }
          const schema = res.content?.['application/json']?.schema as
            | Record<string, unknown>
            | undefined;
          const isBare =
            schema &&
            Object.keys(schema).length === 1 &&
            schema.type === 'object';
          if (!schema || isBare) offenders.push(label);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Regenerate the spec and run the guard — confirm it fails**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: FAIL. The `offenders` array lists ~67 endpoints (this is the work-list). Keep this output for reference.

- [ ] **Step 3: Commit**

```bash
git add src/common/openapi/openapi-contract.spec.ts
git commit -m "test(openapi): add response-contract guard (currently red)"
```

---

## Task 4: Trivial controllers — health, metrics, auth, company

**Files:**
- Create: `src/company/dto/company-settings-response.dto.ts`
- Modify: `src/health/health.controller.ts`, `src/metrics/metrics.controller.ts`, `src/auth/auth.controller.ts`, `src/company/company.controller.ts`

- [ ] **Step 1: Create `CompanySettingsDto`**

```ts
// src/company/dto/company-settings-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class CompanySettingsDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: true }) singleton!: boolean;
  @ApiProperty({ example: 'PT Contoh' }) legalName!: string;
  @ApiProperty({ nullable: true, example: '01.234.567.8-901.000' }) npwp!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ example: 1 }) fiscalYearStartMonth!: number;
  @ApiProperty({ example: 'IDR' }) baseCurrency!: string;
  @ApiProperty({ example: true }) segregationOfDutiesEnabled!: boolean;
  @ApiProperty({ example: true }) isPkp!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
```

- [ ] **Step 2: Wire `health.controller.ts`**

Add imports and decorators:

```ts
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { HealthStatusDto, ReadinessStatusDto } from '../common/openapi/openapi.models';
```

Add `@ApiTags('Health')` on the class. Add `@ApiOkResponse({ type: HealthStatusDto })` above `liveness()` and `@ApiOkResponse({ type: ReadinessStatusDto })` above `readiness()`.

- [ ] **Step 3: Wire `metrics.controller.ts`**

Add imports and decorators:

```ts
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
```

Add `@ApiTags('Metrics')` on the class. Above `scrape()` add:

```ts
@ApiProduces('text/plain')
@ApiOkResponse({
  content: { 'text/plain': { schema: { type: 'string' } } },
  description: 'Prometheus exposition format.',
})
```

- [ ] **Step 4: Wire `auth.controller.ts` (me, admin-only)**

Add to the existing swagger import line: `ApiOkResponse` is already imported. Add imports:

```ts
import { AuthenticatedUserDto, OkFlagDto } from '../common/openapi/openapi.models';
```

Add `@ApiOkResponse({ type: AuthenticatedUserDto })` above `me()`, and `@ApiOkResponse({ type: OkFlagDto })` above `adminOnly()`.

- [ ] **Step 5: Wire `company.controller.ts`**

Add imports and decorators:

```ts
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CompanySettingsDto } from './dto/company-settings-response.dto';
```

Add `@ApiOkResponse({ type: CompanySettingsDto })` above both `get()` and `update()`.

- [ ] **Step 6: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: still FAIL, but `/health`, `/ready`, `/metrics`, `/auth/me`, `/auth/admin-only`, `/company/settings` (GET+PATCH) are gone from the offenders list.

- [ ] **Step 7: Commit**

```bash
git add src/company/dto src/health src/metrics src/auth/auth.controller.ts src/company/company.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for health, metrics, auth, company"
```

---

## Task 5: Accounts & Balances

**Files:**
- Create: `src/ledger/accounts/dto/account-response.dto.ts`
- Create: `src/ledger/balances/dto/balance-response.dto.ts`
- Modify: `src/ledger/accounts/accounts.controller.ts`, `src/ledger/balances/balances.controller.ts`

- [ ] **Step 1: Create `AccountResponseDto`**

```ts
// src/ledger/accounts/dto/account-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class AccountResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '1-1000' }) code!: string;
  @ApiProperty({ example: 'Kas' }) name!: string;
  @ApiProperty({ enum: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] })
  type!: string;
  @ApiProperty({
    enum: [
      'CURRENT_ASSET', 'NON_CURRENT_ASSET', 'FIXED_ASSET',
      'ACCUMULATED_DEPRECIATION', 'CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY',
      'EQUITY', 'REVENUE', 'COGS', 'OPERATING_EXPENSE', 'OTHER_INCOME',
      'OTHER_EXPENSE', 'TAX_PAYABLE', 'TAX_RECEIVABLE',
    ],
  })
  subtype!: string;
  @ApiProperty({ enum: ['OPERATING', 'INVESTING', 'FINANCING', 'NONE'] })
  cashFlowCategory!: string;
  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] }) normalBalance!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) parentId!: string | null;
  @ApiProperty({ example: true }) isPostable!: boolean;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ example: 'IDR' }) currency!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
```

- [ ] **Step 2: Create balance DTOs**

```ts
// src/ledger/balances/dto/balance-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../../common/openapi/api-money.decorator';

export class AccountBalanceDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiMoney({ description: 'normalBalance-signed net, 4 dp' }) balance!: string;
}

export class TrialBalanceRowDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiProperty({ example: '1-1000' }) code!: string;
  @ApiProperty({ example: 'Kas' }) name!: string;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiMoney() balance!: string;
}

export class TrialBalanceDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-01-31' }) asOf!: string;
  @ApiProperty({ type: [TrialBalanceRowDto] }) rows!: TrialBalanceRowDto[];
  @ApiMoney() totalDebit!: string;
  @ApiMoney() totalCredit!: string;
}
```

- [ ] **Step 3: Wire `accounts.controller.ts`**

Add imports:

```ts
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { AccountResponseDto } from './dto/account-response.dto';
import { AccountBalanceDto } from '../balances/dto/balance-response.dto';
```

Add decorators per method:
- `list()` → `@ApiOkResponse({ type: AccountResponseDto, isArray: true })`
- `balance()` → `@ApiOkResponse({ type: AccountBalanceDto })`
- `get()` → `@ApiOkResponse({ type: AccountResponseDto })`
- `create()` → `@ApiCreatedResponse({ type: AccountResponseDto })`
- `update()` → `@ApiOkResponse({ type: AccountResponseDto })`
- `deactivate()` → `@ApiOkResponse({ type: AccountResponseDto })`
- `remove()`/DELETE (204) → `@ApiNoContentResponse()`

- [ ] **Step 4: Wire `balances.controller.ts`**

```ts
import { ApiOkResponse } from '@nestjs/swagger';
import { TrialBalanceDto } from './dto/balance-response.dto';
```

Add `@ApiOkResponse({ type: TrialBalanceDto })` above `trialBalance()`.

- [ ] **Step 5: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: still FAIL, but all `/ledger/accounts*` and `/ledger/trial-balance` entries gone from offenders.

- [ ] **Step 6: Commit**

```bash
git add src/ledger/accounts/dto src/ledger/balances/dto src/ledger/accounts/accounts.controller.ts src/ledger/balances/balances.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for accounts and balances"
```

---

## Task 6: Periods

**Files:**
- Create: `src/ledger/periods/dto/period-response.dto.ts`
- Modify: `src/ledger/periods/periods.controller.ts`

- [ ] **Step 1: Create `FiscalPeriodResponseDto`**

```ts
// src/ledger/periods/dto/period-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class FiscalPeriodResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 2026 }) fiscalYear!: number;
  @ApiProperty({ example: 1 }) sequence!: number;
  @ApiProperty({ example: '2026-01' }) name!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-01' }) startDate!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-31' }) endDate!: string;
  @ApiProperty({ enum: ['OPEN', 'CLOSED'] }) status!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) closedAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) closedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
```

- [ ] **Step 2: Wire `periods.controller.ts`**

```ts
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { FiscalPeriodResponseDto } from './dto/period-response.dto';
```

- `list()` → `@ApiOkResponse({ type: FiscalPeriodResponseDto, isArray: true })`
- `generate()` → `@ApiCreatedResponse({ type: FiscalPeriodResponseDto, isArray: true })`
- `close()` → `@ApiOkResponse({ type: FiscalPeriodResponseDto })`
- `reopen()` → `@ApiOkResponse({ type: FiscalPeriodResponseDto })`

- [ ] **Step 3: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/ledger/periods*` gone from offenders.

- [ ] **Step 4: Commit**

```bash
git add src/ledger/periods/dto src/ledger/periods/periods.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for periods"
```

---

## Task 7: Journal entries & opening balances

**Files:**
- Create: `src/ledger/journal/dto/journal-response.dto.ts`
- Modify: `src/ledger/journal/journal.controller.ts`, `src/ledger/journal/opening-balances.controller.ts`

- [ ] **Step 1: Create journal DTOs**

```ts
// src/ledger/journal/dto/journal-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../../common/openapi/api-money.decorator';

const SOURCE_TYPES = [
  'MANUAL', 'OPENING', 'REVERSAL', 'SALES_INVOICE',
  'PURCHASE_BILL', 'PAYMENT', 'CLOSING',
];
const STATUSES = ['DRAFT', 'POSTED', 'REVERSED'];

export class JournalLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) journalEntryId!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class JournalEntryResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, example: 42 }) entryNumber!: number | null;
  @ApiProperty({ nullable: true, example: 'JE-2026-42' }) entryRef!: string | null;
  @ApiProperty({ nullable: true, example: 2026 }) fiscalYear!: number | null;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' }) date!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) periodId!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: SOURCE_TYPES }) sourceType!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) sourceId!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) reversalOfId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) reversedById!: string | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) postedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: [JournalLineResponseDto] }) lines!: JournalLineResponseDto[];
}

export class JournalEntryListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) entryRef!: string | null;
  @ApiProperty({ nullable: true }) entryNumber!: number | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' }) date!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ enum: SOURCE_TYPES }) sourceType!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) sourceId!: string | null;
  @ApiMoney() totalDebit!: string;
  @ApiProperty({ example: 2 }) lineCount!: number;
}

export class JournalEntryListResponseDto {
  @ApiProperty({ type: [JournalEntryListItemDto] }) data!: JournalEntryListItemDto[];
  @ApiProperty({ example: 137 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
```

- [ ] **Step 2: Wire `journal.controller.ts`**

```ts
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import {
  JournalEntryResponseDto,
  JournalEntryListResponseDto,
} from './dto/journal-response.dto';
```

- `list()` → `@ApiOkResponse({ type: JournalEntryListResponseDto })`
- `get()` → `@ApiOkResponse({ type: JournalEntryResponseDto })`
- create (`@Post()`) → `@ApiCreatedResponse({ type: JournalEntryResponseDto })`
- post (`@Post(':id/post')`) → `@ApiOkResponse({ type: JournalEntryResponseDto })`
- reverse (`@Post(':id/reverse')`) → `@ApiOkResponse({ type: JournalEntryResponseDto })`
- DELETE (204) → `@ApiNoContentResponse()`

- [ ] **Step 3: Wire `opening-balances.controller.ts`**

```ts
import { ApiOkResponse } from '@nestjs/swagger';
import { JournalEntryResponseDto } from '../journal/dto/journal-response.dto';
```

Add `@ApiOkResponse({ type: JournalEntryResponseDto })` above the post handler (POST /ledger/opening-balances returns the posted entry).

- [ ] **Step 4: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/ledger/journal-entries*` and `/ledger/opening-balances` gone from offenders.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/journal/dto src/ledger/journal/journal.controller.ts src/ledger/journal/opening-balances.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for journal entries and opening balances"
```

---

## Task 8: Tax codes & tax calculate

**Files:**
- Create: `src/tax/dto/tax-code-response.dto.ts`, `src/tax/dto/tax-calculation-response.dto.ts`
- Modify: `src/tax/tax-codes.controller.ts`, `src/tax/tax.controller.ts`

- [ ] **Step 1: Create `TaxCodeResponseDto`**

```ts
// src/tax/dto/tax-code-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class TaxCodeResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'PPN-OUT' }) code!: string;
  @ApiProperty({ example: 'PPN Keluaran 11%' }) name!: string;
  @ApiProperty({ enum: ['PPN_OUTPUT', 'PPN_INPUT', 'PPH_PAYABLE', 'PPH_PREPAID'] })
  kind!: string;
  @ApiProperty({
    type: String,
    example: '0.110000',
    description: 'Rate as a 6-dp decimal string (e.g. 0.110000 = 11%).',
  })
  rate!: string;
  @ApiProperty({ format: 'uuid' }) taxAccountId!: string;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
```

- [ ] **Step 2: Create tax-calculation DTOs**

```ts
// src/tax/dto/tax-calculation-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class TaxBreakdownRowDto {
  @ApiProperty({ format: 'uuid' }) taxCodeId!: string;
  @ApiProperty({ example: 'PPN-OUT' }) code!: string;
  @ApiProperty({ enum: ['PPN_OUTPUT', 'PPN_INPUT', 'PPH_PAYABLE', 'PPH_PREPAID'] })
  kind!: string;
  @ApiMoney({ description: 'Tax base (DPP), 4 dp string' }) base!: string;
  @ApiMoney({ description: 'Tax amount, rounded to rupiah' }) amount!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
}

export class CalculatedLineDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiPropertyOptional({ type: String, example: '1000.0000' }) debit?: string;
  @ApiPropertyOptional({ type: String, example: '1000.0000' }) credit?: string;
  @ApiPropertyOptional() description?: string;
}

export class TaxCalculationDto {
  @ApiMoney({ description: 'Sum of tax-exclusive base line amounts' }) subtotal!: string;
  @ApiProperty({ type: [TaxBreakdownRowDto] }) taxes!: TaxBreakdownRowDto[];
  @ApiMoney() settlementAmount!: string;
  @ApiProperty({ type: [CalculatedLineDto] }) journalLines!: CalculatedLineDto[];
}
```

- [ ] **Step 3: Wire `tax-codes.controller.ts`**

```ts
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { TaxCodeResponseDto } from './dto/tax-code-response.dto';
```

- list → `@ApiOkResponse({ type: TaxCodeResponseDto, isArray: true })`
- create → `@ApiCreatedResponse({ type: TaxCodeResponseDto })`
- get(:id) → `@ApiOkResponse({ type: TaxCodeResponseDto })`
- update → `@ApiOkResponse({ type: TaxCodeResponseDto })`
- deactivate → `@ApiOkResponse({ type: TaxCodeResponseDto })`
- DELETE (204) → `@ApiNoContentResponse()`

- [ ] **Step 4: Wire `tax.controller.ts`**

```ts
import { ApiOkResponse } from '@nestjs/swagger';
import { TaxCalculationDto } from './dto/tax-calculation-response.dto';
```

Add `@ApiOkResponse({ type: TaxCalculationDto })` above `calculate()`.

- [ ] **Step 5: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/tax/*` gone from offenders.

- [ ] **Step 6: Commit**

```bash
git add src/tax/dto src/tax/tax-codes.controller.ts src/tax/tax.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for tax codes and tax calculation"
```

---

## Task 9: Business partners

**Files:**
- Create: `src/invoicing/dto/business-partner-response.dto.ts`
- Modify: `src/invoicing/business-partners.controller.ts`

- [ ] **Step 1: Create `BusinessPartnerResponseDto`**

```ts
// src/invoicing/dto/business-partner-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class BusinessPartnerResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CUST-001' }) code!: string;
  @ApiProperty({ example: 'PT Pelanggan' }) name!: string;
  @ApiProperty({ nullable: true }) npwp!: string | null;
  @ApiProperty({ nullable: true, example: 'a@b.com' }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ nullable: true }) address!: string | null;
  @ApiProperty({ example: true }) isCustomer!: boolean;
  @ApiProperty({ example: false }) isVendor!: boolean;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
```

- [ ] **Step 2: Wire `business-partners.controller.ts`**

```ts
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { BusinessPartnerResponseDto } from './dto/business-partner-response.dto';
```

- list → `@ApiOkResponse({ type: BusinessPartnerResponseDto, isArray: true })`
- create → `@ApiCreatedResponse({ type: BusinessPartnerResponseDto })`
- get(:id) → `@ApiOkResponse({ type: BusinessPartnerResponseDto })`
- update → `@ApiOkResponse({ type: BusinessPartnerResponseDto })`
- deactivate → `@ApiOkResponse({ type: BusinessPartnerResponseDto })`
- DELETE (204) → `@ApiNoContentResponse()`

- [ ] **Step 3: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/partners*` gone from offenders.

- [ ] **Step 4: Commit**

```bash
git add src/invoicing/dto/business-partner-response.dto.ts src/invoicing/business-partners.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for business partners"
```

---

## Task 10: Sales invoices

**Files:**
- Create: `src/invoicing/dto/sales-invoice-response.dto.ts`
- Modify: `src/invoicing/sales-invoices.controller.ts`

- [ ] **Step 1: Create sales-invoice DTOs**

`lines` is present on detail/create/post/void and absent on the list rows → `@ApiPropertyOptional`. `outstanding` and `paymentStatus` are added by `present()`.

```ts
// src/invoicing/dto/sales-invoice-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class SalesInvoiceLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) salesInvoiceId!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney({ description: 'Quantity, 4 dp string' }) quantity!: string;
  @ApiMoney() unitPrice!: string;
  @ApiMoney() amount!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) taxCodeIds!: string[];
}

export class SalesInvoiceResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) invoiceNumber!: number | null;
  @ApiProperty({ nullable: true }) invoiceRef!: string | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' }) date!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true }) dueDate!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'VOID'] }) status!: string;
  @ApiMoney() subtotal!: string;
  @ApiMoney() taxTotal!: string;
  @ApiMoney() withholdingTotal!: string;
  @ApiMoney() total!: string;
  @ApiMoney() amountPaid!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) journalEntryId!: string | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) postedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiMoney({ description: 'total − amountPaid' }) outstanding!: string;
  @ApiProperty({ enum: ['UNPAID', 'PARTIAL', 'PAID'] }) paymentStatus!: string;
  @ApiPropertyOptional({ type: [SalesInvoiceLineResponseDto] })
  lines?: SalesInvoiceLineResponseDto[];
}
```

- [ ] **Step 2: Wire `sales-invoices.controller.ts`**

```ts
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { SalesInvoiceResponseDto } from './dto/sales-invoice-response.dto';
```

- list (`@Get()`) → `@ApiOkResponse({ type: SalesInvoiceResponseDto, isArray: true })`
- get(:id) → `@ApiOkResponse({ type: SalesInvoiceResponseDto })`
- create (`@Post()`) → `@ApiCreatedResponse({ type: SalesInvoiceResponseDto })`
- update (`@Patch(':id')`) → `@ApiOkResponse({ type: SalesInvoiceResponseDto })`
- post (`@Post(':id/post')`) → `@ApiOkResponse({ type: SalesInvoiceResponseDto })`
- void (`@Post(':id/void')`) → `@ApiOkResponse({ type: SalesInvoiceResponseDto })`
- DELETE (204) → `@ApiNoContentResponse()`

- [ ] **Step 3: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/sales-invoices*` gone from offenders.

- [ ] **Step 4: Commit**

```bash
git add src/invoicing/dto/sales-invoice-response.dto.ts src/invoicing/sales-invoices.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for sales invoices"
```

---

## Task 11: Purchase bills

**Files:**
- Create: `src/invoicing/dto/purchase-bill-response.dto.ts`
- Modify: `src/invoicing/purchase-bills.controller.ts`

- [ ] **Step 1: Create purchase-bill DTOs**

```ts
// src/invoicing/dto/purchase-bill-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class PurchaseBillLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) purchaseBillId!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney({ description: 'Quantity, 4 dp string' }) quantity!: string;
  @ApiMoney() unitPrice!: string;
  @ApiMoney() amount!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) taxCodeIds!: string[];
}

export class PurchaseBillResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) billNumber!: number | null;
  @ApiProperty({ nullable: true }) billRef!: string | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty({ nullable: true }) vendorInvoiceNo!: string | null;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' }) date!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true }) dueDate!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'VOID'] }) status!: string;
  @ApiMoney() subtotal!: string;
  @ApiMoney() taxTotal!: string;
  @ApiMoney() withholdingTotal!: string;
  @ApiMoney() total!: string;
  @ApiMoney() amountPaid!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) journalEntryId!: string | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) postedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiMoney({ description: 'total − amountPaid' }) outstanding!: string;
  @ApiProperty({ enum: ['UNPAID', 'PARTIAL', 'PAID'] }) paymentStatus!: string;
  @ApiPropertyOptional({ type: [PurchaseBillLineResponseDto] })
  lines?: PurchaseBillLineResponseDto[];
}
```

- [ ] **Step 2: Wire `purchase-bills.controller.ts`**

```ts
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { PurchaseBillResponseDto } from './dto/purchase-bill-response.dto';
```

Mirror the sales-invoices mapping: list → array; get/update/post/void → `@ApiOkResponse({ type: PurchaseBillResponseDto })`; create → `@ApiCreatedResponse`; DELETE (204) → `@ApiNoContentResponse()`.

- [ ] **Step 3: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/purchase-bills*` gone from offenders.

- [ ] **Step 4: Commit**

```bash
git add src/invoicing/dto/purchase-bill-response.dto.ts src/invoicing/purchase-bills.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for purchase bills"
```

---

## Task 12: Payments

**Files:**
- Create: `src/invoicing/dto/payment-response.dto.ts`
- Modify: `src/invoicing/payments.controller.ts`

- [ ] **Step 1: Create payment DTOs**

```ts
// src/invoicing/dto/payment-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class PaymentAllocationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) salesInvoiceId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) purchaseBillId!: string | null;
  @ApiMoney() amount!: string;
}

export class PaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) number!: number | null;
  @ApiProperty({ nullable: true }) ref!: string | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ enum: ['RECEIPT', 'DISBURSEMENT'] }) direction!: string;
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' }) date!: string;
  @ApiProperty({ format: 'uuid' }) cashAccountId!: string;
  @ApiMoney() amount!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'VOID'] }) status!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) journalEntryId!: string | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) postedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({ type: [PaymentAllocationResponseDto] })
  allocations?: PaymentAllocationResponseDto[];
}
```

- [ ] **Step 2: Wire `payments.controller.ts`**

```ts
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { PaymentResponseDto } from './dto/payment-response.dto';
```

- list → `@ApiOkResponse({ type: PaymentResponseDto, isArray: true })`
- get(:id) → `@ApiOkResponse({ type: PaymentResponseDto })`
- create → `@ApiCreatedResponse({ type: PaymentResponseDto })`
- post → `@ApiOkResponse({ type: PaymentResponseDto })`
- void → `@ApiOkResponse({ type: PaymentResponseDto })`
- DELETE (204) → `@ApiNoContentResponse()`

- [ ] **Step 3: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/payments*` gone from offenders.

- [ ] **Step 4: Commit**

```bash
git add src/invoicing/dto/payment-response.dto.ts src/invoicing/payments.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for payments"
```

---

## Task 13: Reports

**Files:**
- Create: `src/reporting/dto/report-response.dto.ts`
- Modify: `src/reporting/reports.controller.ts`

- [ ] **Step 1: Create report DTOs**

These mirror the exact service return shapes (all amounts are 4-dp strings).

```ts
// src/reporting/dto/report-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class ReportLineDto {
  @ApiProperty({ example: '4-1000' }) code!: string;
  @ApiProperty({ example: 'Pendapatan' }) name!: string;
  @ApiMoney() amount!: string;
}

export class ReportGroupDto {
  @ApiProperty({ example: 'CURRENT_ASSET' }) subtype!: string;
  @ApiProperty({ type: [ReportLineDto] }) lines!: ReportLineDto[];
  @ApiMoney() subtotal!: string;
}

export class ReportSectionDto {
  @ApiProperty({ type: [ReportGroupDto] }) groups!: ReportGroupDto[];
  @ApiMoney() total!: string;
}

export class BalanceSheetDto {
  @ApiProperty({ type: String, format: 'date', example: '2026-01-31' }) asOf!: string;
  @ApiProperty({ type: ReportSectionDto }) assets!: ReportSectionDto;
  @ApiProperty({ type: ReportSectionDto }) liabilities!: ReportSectionDto;
  @ApiProperty({ type: ReportSectionDto }) equity!: ReportSectionDto;
  @ApiMoney() totalAssets!: string;
  @ApiMoney() totalLiabilities!: string;
  @ApiMoney() totalEquity!: string;
  @ApiMoney() currentYearEarnings!: string;
  @ApiProperty({ example: true }) balanced!: boolean;
}

export class IncomeStatementDto {
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiMoney() revenue!: string;
  @ApiProperty({ type: [ReportLineDto] }) revenueLines!: ReportLineDto[];
  @ApiMoney() cogs!: string;
  @ApiProperty({ type: [ReportLineDto] }) cogsLines!: ReportLineDto[];
  @ApiMoney() grossProfit!: string;
  @ApiMoney() operatingExpense!: string;
  @ApiProperty({ type: [ReportLineDto] }) operatingExpenseLines!: ReportLineDto[];
  @ApiMoney() operatingProfit!: string;
  @ApiMoney() otherIncome!: string;
  @ApiMoney() otherExpense!: string;
  @ApiMoney() profitBeforeTax!: string;
  @ApiMoney() taxExpense!: string;
  @ApiMoney() netIncome!: string;
}

export class GeneralLedgerAccountDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '1-1000' }) code!: string;
  @ApiProperty({ example: 'Kas' }) name!: string;
  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] }) normalBalance!: string;
}

export class GeneralLedgerLineDto {
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ nullable: true }) entryRef!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiMoney() runningBalance!: string;
}

export class GeneralLedgerDto {
  @ApiProperty({ type: GeneralLedgerAccountDto }) account!: GeneralLedgerAccountDto;
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiMoney() openingBalance!: string;
  @ApiProperty({ type: [GeneralLedgerLineDto] }) lines!: GeneralLedgerLineDto[];
  @ApiMoney() closingBalance!: string;
}

export class AgingDocumentDto {
  @ApiProperty({ nullable: true }) ref!: string | null;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true }) dueDate!: string | null;
  @ApiMoney() total!: string;
  @ApiMoney() paidAsOf!: string;
  @ApiMoney() outstanding!: string;
  @ApiProperty({ enum: ['Current', '1-30', '31-60', '61-90', '>90'] }) bucket!: string;
}

export class AgingPartnerDto {
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty() partnerName!: string;
  @ApiProperty({ type: [AgingDocumentDto] }) documents!: AgingDocumentDto[];
  @ApiProperty({
    type: 'object',
    description: 'Outstanding per bucket, keyed by bucket name (money strings).',
    example: { Current: '0.0000', '1-30': '500.0000', '31-60': '0.0000', '61-90': '0.0000', '>90': '0.0000' },
    additionalProperties: { type: 'string' },
  })
  buckets!: Record<string, string>;
}

export class AgingReportDto {
  @ApiProperty({ enum: ['AR', 'AP'] }) kind!: string;
  @ApiProperty({ type: String, format: 'date' }) asOf!: string;
  @ApiProperty({ type: [AgingPartnerDto] }) partners!: AgingPartnerDto[];
  @ApiProperty({
    type: 'object',
    description: 'Grand totals per bucket (money strings).',
    additionalProperties: { type: 'string' },
  })
  totalsByBucket!: Record<string, string>;
  @ApiMoney() totalOutstanding!: string;
}

export class CashFlowLineDto {
  @ApiProperty({ example: '1-2000' }) code!: string;
  @ApiProperty({ example: 'Piutang Usaha' }) name!: string;
  @ApiMoney() amount!: string;
}

export class CashFlowOperatingDto {
  @ApiProperty({ type: [CashFlowLineDto] }) adjustments!: CashFlowLineDto[];
  @ApiMoney() total!: string;
}

export class CashFlowSectionDto {
  @ApiProperty({ type: [CashFlowLineDto] }) lines!: CashFlowLineDto[];
  @ApiMoney() total!: string;
}

export class CashFlowDto {
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiMoney() netIncome!: string;
  @ApiProperty({ type: CashFlowOperatingDto }) operating!: CashFlowOperatingDto;
  @ApiProperty({ type: CashFlowSectionDto }) investing!: CashFlowSectionDto;
  @ApiProperty({ type: CashFlowSectionDto }) financing!: CashFlowSectionDto;
  @ApiMoney() netChange!: string;
  @ApiMoney() kasAwal!: string;
  @ApiMoney() kasAkhir!: string;
  @ApiProperty({ example: true }) reconciles!: boolean;
}
```

- [ ] **Step 2: Wire `reports.controller.ts`**

```ts
import { ApiOkResponse } from '@nestjs/swagger';
import {
  BalanceSheetDto, IncomeStatementDto, GeneralLedgerDto,
  AgingReportDto, CashFlowDto,
} from './dto/report-response.dto';
```

- `balance-sheet` → `@ApiOkResponse({ type: BalanceSheetDto })`
- `income-statement` → `@ApiOkResponse({ type: IncomeStatementDto })`
- `general-ledger` → `@ApiOkResponse({ type: GeneralLedgerDto })`
- `ar-aging` → `@ApiOkResponse({ type: AgingReportDto })`
- `ap-aging` → `@ApiOkResponse({ type: AgingReportDto })`
- `cash-flow` → `@ApiOkResponse({ type: CashFlowDto })`

- [ ] **Step 3: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: `/reports/*` gone from offenders.

- [ ] **Step 4: Commit**

```bash
git add src/reporting/dto/report-response.dto.ts src/reporting/reports.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for the six reports"
```

---

## Task 14: Year-end close & audit

**Files:**
- Create: `src/close/dto/closing-response.dto.ts`, `src/audit/dto/audit-entry-response.dto.ts`
- Modify: `src/close/closing.controller.ts`, `src/audit/audit.controller.ts`

- [ ] **Step 1: Create `YearEndClosingResponseDto`**

```ts
// src/close/dto/closing-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class YearEndClosingResponseDto {
  @ApiProperty({ example: 2026 }) fiscalYear!: number;
  @ApiProperty({ enum: ['OPEN', 'CLOSED'] }) status!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) closingEntryId!: string | null;
  @ApiMoney() netIncome!: string;
  @ApiProperty({ format: 'date-time' }) closedAt!: string;
  @ApiProperty({ format: 'uuid' }) closedBy!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) reopenedAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) reopenedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
```

- [ ] **Step 2: Create `AuditEntryDto`**

```ts
// src/audit/dto/audit-entry-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class AuditEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) userId!: string | null;
  @ApiProperty({ nullable: true, example: 'ADMIN' }) userRole!: string | null;
  @ApiProperty({ example: 'POST' }) method!: string;
  @ApiProperty({ example: '/ledger/journal-entries' }) path!: string;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  params!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  body!: Record<string, unknown> | null;
  @ApiProperty({ example: 201 }) statusCode!: number;
  @ApiProperty({ example: 42 }) durationMs!: number;
  @ApiProperty({ nullable: true, example: '127.0.0.1' }) ip!: string | null;
}
```

- [ ] **Step 3: Wire `closing.controller.ts`**

```ts
import { ApiOkResponse } from '@nestjs/swagger';
import { YearEndClosingResponseDto } from './dto/closing-response.dto';
```

Add `@ApiOkResponse({ type: YearEndClosingResponseDto })` above `run()`, `reopen()`, and `status()`.

- [ ] **Step 4: Wire `audit.controller.ts`**

```ts
import { ApiOkResponse } from '@nestjs/swagger';
import { AuditEntryDto } from './dto/audit-entry-response.dto';
```

Add `@ApiOkResponse({ type: AuditEntryDto, isArray: true })` above `list()` (the audit list is a bare array).

- [ ] **Step 5: Regenerate and check progress**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: PASS — the offenders list is now empty. If any remain, wire them following the same pattern.

- [ ] **Step 6: Commit**

```bash
git add src/close/dto src/audit/dto src/close/closing.controller.ts src/audit/audit.controller.ts docs/api/openapi.json
git commit -m "feat(openapi): response schemas for year-end close and audit"
```

---

## Task 15: Full verification & finalize

**Files:**
- Modify (optional): `docs/api/frontend-guide.md`

- [ ] **Step 1: Confirm the guard is green**

Run: `npm run openapi:export && npm test -- openapi-contract`
Expected: PASS, `offenders` empty.

- [ ] **Step 2: Spot-check accuracy against real output**

Confirm by reading the regenerated `docs/api/openapi.json`:
- `components.schemas.SalesInvoiceResponseDto.properties.total.type === 'string'` (money is a string).
- `JournalEntryListResponseDto` has `data`/`total`/`limit`/`offset`.
- `AuditEntryDto` response on `GET /audit` is an array (`responses.200.content.application/json.schema.type === 'array'`).
- No DTO declares `deletedAt`/`deletedBy`.

Run: `python3 -c "import json; d=json.load(open('docs/api/openapi.json')); s=d['components']['schemas']; print('total.type=', s['SalesInvoiceResponseDto']['properties']['total']['type']); print('has deletedAt:', any('deletedAt' in v.get('properties',{}) for v in s.values()))"`
Expected: `total.type= string` and `has deletedAt: False`.

- [ ] **Step 3: Run the full verify gate (proves zero behavior change)**

Run: `npm run verify`
Expected: exit 0 — typecheck + lint + 38 unit (now +3: the 2 ApiMoney tests and 1 contract test) + 147 e2e all green. No e2e assertion changes, because controllers still return identical bodies.

- [ ] **Step 4: (Optional) Cross-link the frontend guide**

If `docs/api/frontend-guide.md` hand-describes response shapes, add a one-line note near the top pointing readers to the now-authoritative schemas in `openapi.json` (e.g. "Response shapes are now fully typed in `openapi.json` under `components.schemas` — the `*ResponseDto` entries"). Keep edits minimal.

- [ ] **Step 5: Final commit**

```bash
git add docs/api/frontend-guide.md docs/api/openapi.json
git commit -m "docs(openapi): cross-link typed response schemas in frontend guide"
```

---

## Self-Review notes (for the implementer)

- **Coverage:** every one of the 67 originally-untyped endpoints is addressed across Tasks 4–14; the Task 3 guard test is the objective proof all are covered.
- **Money everywhere:** any field that is a Prisma `Decimal` at rest serializes as a string — never type these as `number`. Line `quantity`/`unitPrice` included.
- **List vs detail nesting:** invoice/bill `lines` and payment `allocations` are `@ApiPropertyOptional` because the list endpoints omit them.
- **Enum drift:** the literal enum arrays in the DTOs must match `prisma/schema.prisma`. If an enum changes later, update both.
- **No behavior change:** the only runtime additions are decorators and otherwise-unreferenced DTO classes; if `npm run verify` shows any e2e diff, something else changed — investigate before proceeding.
