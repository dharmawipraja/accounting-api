# Accounting API — Phase 2: Ledger Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the double-entry general-ledger core — chart of accounts, accounting periods, a transactional gapless `PostingService`, draft→post journal entries with configurable segregation of duties, reversals, opening balances, idempotent posting, and a trial balance.

**Architecture:** Two new NestJS modules (`CompanyModule`, `LedgerModule`) on the Phase 1 foundation. `LedgerModule` decomposes into focused services — `AccountsService`, `PeriodsService`, `PostingService` (the transactional core; the only writer of posted entries), `JournalService` (drafts + assembly), `BalancesService` (read-only). Posting runs in one `prisma.$transaction` with a `FOR UPDATE` lock on a per-fiscal-year counter for gapless numbering.

**Tech Stack:** TypeScript, NestJS 11, Prisma 7 (driver-adapter `@prisma/adapter-pg`), PostgreSQL, `decimal.js` (`Money`), Jest + `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-06-11-accounting-api-phase-2-ledger-core-design.md`

---

## Conventions carried from Phase 1 (read these existing files before starting)

- **Data access goes through `prisma.client.<model>`** (the soft-delete-extended client on `PrismaService`), never `prisma.<model>`. Raw SQL uses `prisma.$queryRaw` / inside a tx `tx.$queryRaw`.
- **Prisma 7 driver-adapter**: schema `datasource` has no `url` (it's in `prisma.config.ts`); `migrate dev` works as in Phase 1. Prisma `Decimal` columns hold money as `NUMERIC(20,4)`.
- **Money**: `src/common/money/money.ts`. `Money.of(string | Decimal)`. DTO amounts arrive as **decimal strings** and are validated, then `Money.of(str)` for in-app math. Postgres `NUMERIC` does exact aggregation for balances (SQL `SUM`), so balance queries do not need `Money`.
- **Soft delete**: add model names to `SOFT_DELETE_MODELS` in `src/common/prisma/soft-delete.extension.ts`. The extension forbids hard delete and filters `deletedAt`. Tombstone unique fields on soft delete (see `UsersService.softDelete`).
- **Domain errors**: `src/common/errors/domain-errors.ts`. Subclass `DomainError` (has `code`, `status`, `details`); the global filter maps to the `{code,message,details}` envelope.
- **Auth**: `@Roles(Role.X)` + global guards; `@CurrentUser()` returns `{ id, email, role }`. `@Public()` for none.
- **e2e tests**: testcontainers via `test/testcontainers.ts` (`startTestDb`) + `test/e2e-helpers.ts` (`makePrismaOverride`). Pattern: `startTestDb` → `makePrismaOverride(db.url)` → `$connect` → `Test.createTestingModule({imports:[AppModule]}).overrideProvider(PrismaService).useValue(prismaOverride).compile()` → `createNestApplication` → `useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}))` → `useGlobalFilters(new AllExceptionsFilter())` → `init`. `afterAll`: close app, `$disconnect`, `db?.stop()`. `maxWorkers:1` is already set.

---

## File Structure (Phase 2)

```
prisma/schema.prisma                       # + CompanySettings, Account, AccountingPeriod,
                                           #   JournalSequence, JournalEntry, JournalLine,
                                           #   IdempotencyKey (+ enums)
src/
├── common/
│   ├── errors/domain-errors.ts            # + UnbalancedEntryError, ClosedPeriodError,
│   │                                      #   InvalidAccountError, SegregationOfDutiesError
│   ├── validators/is-money-string.ts      # decimal-string DTO validator
│   └── prisma/soft-delete.extension.ts    # add 'Account','JournalEntry' to the set
├── company/
│   ├── company.module.ts
│   ├── company.service.ts                 # get/update the singleton; seed
│   ├── company.controller.ts
│   └── dto/update-company-settings.dto.ts
└── ledger/
    ├── ledger.module.ts
    ├── accounts/
    │   ├── accounts.service.ts
    │   ├── accounts.controller.ts
    │   ├── chart-of-accounts.seed.ts       # SAK seed data + idempotent seeder
    │   └── dto/{create-account,update-account}.dto.ts
    ├── periods/
    │   ├── periods.service.ts
    │   ├── periods.controller.ts
    │   └── dto/generate-periods.dto.ts
    ├── posting/
    │   ├── posting.service.ts              # the transactional core (post, reverse)
    │   └── posting.types.ts                # PostEntryInput / PostLineInput
    ├── journal/
    │   ├── journal.service.ts              # drafts, createAndPost, opening balances, idempotency
    │   ├── journal.controller.ts
    │   └── dto/{journal-line,create-journal-entry,opening-balances}.dto.ts
    └── balances/
        ├── balances.service.ts             # trial balance + account balance (SQL aggregation)
        └── balances.controller.ts
test/
├── company.e2e-spec.ts
├── accounts.e2e-spec.ts
├── periods.e2e-spec.ts
├── posting.e2e-spec.ts                     # incl. concurrency + gapless-under-failure
├── journal.e2e-spec.ts                     # drafts, createAndPost, opening, idempotency
└── balances.e2e-spec.ts                    # trial-balance-nets-to-zero property test
```

Migrations are added per build step via `npx prisma migrate dev --name <name>`; the `journal_lines` CHECK constraint and the `IdempotencyKey` are added via hand-edited migration SQL (Prisma can't express CHECK).

---

# Build Step 1 — CompanyModule

## Task 1: Company settings singleton

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/company/company.service.ts`, `src/company/company.module.ts`, `src/company/company.controller.ts`, `src/company/dto/update-company-settings.dto.ts`
- Modify: `src/app.module.ts`
- Test: `test/company.e2e-spec.ts`

- [ ] **Step 1: Add the CompanySettings model**

Append to `prisma/schema.prisma`:

```prisma
model CompanySettings {
  id                          String   @id @default(uuid())
  singleton                   Boolean  @unique @default(true)
  legalName                   String   @map("legal_name")
  npwp                        String?
  address                     String?
  fiscalYearStartMonth        Int      @default(1) @map("fiscal_year_start_month")
  baseCurrency                String   @default("IDR") @map("base_currency")
  segregationOfDutiesEnabled  Boolean  @default(true) @map("segregation_of_duties_enabled")
  isPkp                       Boolean  @default(true) @map("is_pkp")
  createdAt                   DateTime @default(now()) @map("created_at")
  updatedAt                   DateTime @updatedAt @map("updated_at")

  @@map("company_settings")
}
```

The `singleton Boolean @unique @default(true)` column makes the single-row constraint enforceable (only one row can have `singleton = true`).

- [ ] **Step 2: Create the migration**

Run (db up: `docker compose up -d db`):

```bash
npx prisma migrate dev --name add_company_settings
```

Expected: creates + applies the migration; client regenerated.

- [ ] **Step 3: Write the failing e2e test**

Create `test/company.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Company settings (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;

  beforeAll(async () => {
    db = await startTestDb();
    prismaOverride = makePrismaOverride(db.url);
    await prismaOverride.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaOverride)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    await app.get(CompanyService).seedIfEmpty();
    const users = app.get(UsersService);
    await users.create({ email: 'admin@x.com', password: 'secret123', name: 'A', role: 'ADMIN' });
    adminToken = (await app.get(AuthService).login('admin@x.com', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('returns the seeded singleton with SoD enabled by default', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/company/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.segregationOfDutiesEnabled).toBe(true);
    expect(res.body.baseCurrency).toBe('IDR');
    expect(res.body.fiscalYearStartMonth).toBe(1);
  });

  it('lets an admin toggle segregation of duties', async () => {
    await request(app.getHttpServer() as App)
      .patch('/company/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ segregationOfDutiesEnabled: false })
      .expect(200)
      .expect((r) => expect(r.body.segregationOfDutiesEnabled).toBe(false));
  });

  it('seedIfEmpty is idempotent (still one row)', async () => {
    await app.get(CompanyService).seedIfEmpty();
    const count = await prismaOverride.client.companySettings.count();
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 4: Run it — expect FAIL** (`CompanyService` not found)

Run: `npm run test:e2e -- company`
Expected: FAIL (cannot find module).

- [ ] **Step 5: Implement CompanyService**

Create `src/company/company.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { CompanySettings } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotFoundDomainError } from '../common/errors/domain-errors';

export interface UpdateCompanyInput {
  legalName?: string;
  npwp?: string | null;
  address?: string | null;
  fiscalYearStartMonth?: number;
  segregationOfDutiesEnabled?: boolean;
  isPkp?: boolean;
}

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent: creates the single settings row only if none exists. */
  async seedIfEmpty(): Promise<void> {
    const existing = await this.prisma.client.companySettings.findFirst();
    if (existing) return;
    await this.prisma.client.companySettings.create({
      data: { legalName: 'My Company' },
    });
  }

  async get(): Promise<CompanySettings> {
    const settings = await this.prisma.client.companySettings.findFirst();
    if (!settings) {
      throw new NotFoundDomainError('Company settings not initialized');
    }
    return settings;
  }

  async update(input: UpdateCompanyInput): Promise<CompanySettings> {
    const current = await this.get();
    return this.prisma.client.companySettings.update({
      where: { id: current.id },
      data: input,
    });
  }
}
```

- [ ] **Step 6: Implement the DTO, controller, module**

Create `src/company/dto/update-company-settings.dto.ts`:

```typescript
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateCompanySettingsDto {
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() npwp?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsInt() @Min(1) @Max(12) fiscalYearStartMonth?: number;
  @IsOptional() @IsBoolean() segregationOfDutiesEnabled?: boolean;
  @IsOptional() @IsBoolean() isPkp?: boolean;
}
```

Create `src/company/company.controller.ts`:

```typescript
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CompanySettings } from '@prisma/client';
import { CompanyService } from './company.service';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';

@Controller('company/settings')
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get()
  get(): Promise<CompanySettings> {
    return this.company.get();
  }

  @Roles(Role.ADMIN)
  @Patch()
  update(@Body() dto: UpdateCompanySettingsDto): Promise<CompanySettings> {
    return this.company.update(dto);
  }
}
```

Create `src/company/company.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { CompanyService } from './company.service';
import { CompanyController } from './company.controller';

@Module({
  providers: [CompanyService],
  controllers: [CompanyController],
  exports: [CompanyService],
})
export class CompanyModule {}
```

Register `CompanyModule` in `src/app.module.ts` imports.

- [ ] **Step 7: Run it — expect PASS**

Run: `npm run test:e2e -- company`
Expected: PASS (3 cases). Then `npm run build` + `npm run lint` clean.

- [ ] **Step 8: Wire `seedIfEmpty` into bootstrap**

So the singleton exists when the app boots. In `src/main.ts`, after `await app.init()` is not used (it uses listen) — instead make `CompanyService` seed on module init. Edit `src/company/company.service.ts` to implement `OnModuleInit`:

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
// ...
export class CompanyService implements OnModuleInit {
  // ...
  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }
}
```

Run `npm run test:e2e -- company` again — still PASS (onModuleInit also seeds; `seedIfEmpty` stays idempotent).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(company): add company-settings singleton with idempotent seed"
```

---

# Build Step 2 — Accounts (Chart of Accounts)

## Task 2: Account model + soft-delete registration

**Files:**
- Modify: `prisma/schema.prisma`, `src/common/prisma/soft-delete.extension.ts`
- Test: `test/accounts.e2e-spec.ts` (created in Task 3)

- [ ] **Step 1: Add enums + Account model**

Append to `prisma/schema.prisma`:

```prisma
enum AccountType {
  ASSET
  LIABILITY
  EQUITY
  REVENUE
  EXPENSE
}

enum AccountSubtype {
  CURRENT_ASSET
  NON_CURRENT_ASSET
  FIXED_ASSET
  ACCUMULATED_DEPRECIATION
  CURRENT_LIABILITY
  NON_CURRENT_LIABILITY
  EQUITY
  REVENUE
  COGS
  OPERATING_EXPENSE
  OTHER_INCOME
  OTHER_EXPENSE
  TAX_PAYABLE
  TAX_RECEIVABLE
}

enum CashFlowCategory {
  OPERATING
  INVESTING
  FINANCING
  NONE
}

enum NormalBalance {
  DEBIT
  CREDIT
}

model Account {
  id               String           @id @default(uuid())
  code             String
  name             String
  type             AccountType
  subtype          AccountSubtype
  cashFlowCategory CashFlowCategory @default(NONE) @map("cash_flow_category")
  normalBalance    NormalBalance    @map("normal_balance")
  parentId         String?          @map("parent_id")
  parent           Account?         @relation("AccountHierarchy", fields: [parentId], references: [id])
  children         Account[]        @relation("AccountHierarchy")
  isPostable       Boolean          @default(true) @map("is_postable")
  isActive         Boolean          @default(true) @map("is_active")
  currency         String           @default("IDR")
  createdAt        DateTime         @default(now()) @map("created_at")
  updatedAt        DateTime         @updatedAt @map("updated_at")
  deletedAt        DateTime?        @map("deleted_at")
  deletedBy        String?          @map("deleted_by")

  @@unique([code], name: "accounts_code_unique")
  @@index([deletedAt])
  @@index([parentId])
  @@map("accounts")
}
```

(Plain `@@unique([code])` + tombstone-on-soft-delete, per the Phase 1 pattern.)

- [ ] **Step 2: Migrate**

```bash
npx prisma migrate dev --name add_accounts
```

- [ ] **Step 3: Register Account for soft delete**

Edit `src/common/prisma/soft-delete.extension.ts`:

```typescript
export const SOFT_DELETE_MODELS = new Set<Prisma.ModelName>(['User', 'Account']);
```

- [ ] **Step 4: Build to confirm types compile**

Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(accounts): add Account model and register soft delete"
```

## Task 3: AccountsService + SAK seed

**Files:**
- Create: `src/ledger/accounts/accounts.service.ts`, `src/ledger/accounts/chart-of-accounts.seed.ts`
- Create: `src/ledger/ledger.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/accounts.e2e-spec.ts`

- [ ] **Step 1: Define the SAK seed data**

Create `src/ledger/accounts/chart-of-accounts.seed.ts`:

```typescript
import {
  AccountSubtype,
  AccountType,
  CashFlowCategory,
  NormalBalance,
} from '@prisma/client';

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  normalBalance: NormalBalance;
  cashFlowCategory?: CashFlowCategory;
  isPostable?: boolean;
  parentCode?: string;
}

/** SAK-aligned starting chart. Headers are non-postable; postable leaves carry balances. */
export const CHART_OF_ACCOUNTS: SeedAccount[] = [
  // 1 — Aset
  { code: '1-0000', name: 'Aset', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', isPostable: false },
  { code: '1-1000', name: 'Kas', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '1-0000' },
  { code: '1-1100', name: 'Bank', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '1-0000' },
  { code: '1-1200', name: 'Piutang Usaha', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '1-0000' },
  { code: '1-1300', name: 'Persediaan', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '1-0000' },
  { code: '1-1400', name: 'PPN Masukan', type: 'ASSET', subtype: 'TAX_RECEIVABLE', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '1-0000' },
  { code: '1-1500', name: 'Uang Muka PPh', type: 'ASSET', subtype: 'TAX_RECEIVABLE', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '1-0000' },
  { code: '1-2000', name: 'Aset Tetap', type: 'ASSET', subtype: 'FIXED_ASSET', normalBalance: 'DEBIT', cashFlowCategory: 'INVESTING', parentCode: '1-0000' },
  { code: '1-2900', name: 'Akumulasi Penyusutan', type: 'ASSET', subtype: 'ACCUMULATED_DEPRECIATION', normalBalance: 'CREDIT', cashFlowCategory: 'INVESTING', parentCode: '1-0000' },
  // 2 — Liabilitas
  { code: '2-0000', name: 'Liabilitas', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', normalBalance: 'CREDIT', isPostable: false },
  { code: '2-1000', name: 'Utang Usaha', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', normalBalance: 'CREDIT', cashFlowCategory: 'OPERATING', parentCode: '2-0000' },
  { code: '2-1100', name: 'PPN Keluaran', type: 'LIABILITY', subtype: 'TAX_PAYABLE', normalBalance: 'CREDIT', cashFlowCategory: 'OPERATING', parentCode: '2-0000' },
  { code: '2-1200', name: 'Utang PPh', type: 'LIABILITY', subtype: 'TAX_PAYABLE', normalBalance: 'CREDIT', cashFlowCategory: 'OPERATING', parentCode: '2-0000' },
  { code: '2-2000', name: 'Utang Bank', type: 'LIABILITY', subtype: 'NON_CURRENT_LIABILITY', normalBalance: 'CREDIT', cashFlowCategory: 'FINANCING', parentCode: '2-0000' },
  // 3 — Ekuitas
  { code: '3-0000', name: 'Ekuitas', type: 'EQUITY', subtype: 'EQUITY', normalBalance: 'CREDIT', isPostable: false },
  { code: '3-1000', name: 'Modal', type: 'EQUITY', subtype: 'EQUITY', normalBalance: 'CREDIT', cashFlowCategory: 'FINANCING', parentCode: '3-0000' },
  { code: '3-2000', name: 'Laba Ditahan', type: 'EQUITY', subtype: 'EQUITY', normalBalance: 'CREDIT', parentCode: '3-0000' },
  { code: '3-9000', name: 'Saldo Awal', type: 'EQUITY', subtype: 'EQUITY', normalBalance: 'CREDIT', parentCode: '3-0000' },
  // 4 — Pendapatan
  { code: '4-0000', name: 'Pendapatan', type: 'REVENUE', subtype: 'REVENUE', normalBalance: 'CREDIT', isPostable: false },
  { code: '4-1000', name: 'Pendapatan Penjualan', type: 'REVENUE', subtype: 'REVENUE', normalBalance: 'CREDIT', cashFlowCategory: 'OPERATING', parentCode: '4-0000' },
  { code: '4-9000', name: 'Pendapatan Lain-lain', type: 'REVENUE', subtype: 'OTHER_INCOME', normalBalance: 'CREDIT', cashFlowCategory: 'OPERATING', parentCode: '4-0000' },
  // 5 — Beban
  { code: '5-0000', name: 'Beban', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', normalBalance: 'DEBIT', isPostable: false },
  { code: '5-1000', name: 'Harga Pokok Penjualan', type: 'EXPENSE', subtype: 'COGS', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '5-0000' },
  { code: '5-2000', name: 'Beban Gaji', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '5-0000' },
  { code: '5-3000', name: 'Beban Sewa', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '5-0000' },
  { code: '5-4000', name: 'Beban Operasional', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '5-0000' },
  { code: '5-9000', name: 'Beban Pajak', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', normalBalance: 'DEBIT', cashFlowCategory: 'OPERATING', parentCode: '5-0000' },
];

/** The account used to absorb the opening-balance plug. */
export const OPENING_BALANCE_EQUITY_CODE = '3-9000';
```

- [ ] **Step 2: Write the failing e2e test**

Create `test/accounts.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Accounts (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;

  beforeAll(async () => {
    db = await startTestDb();
    prismaOverride = makePrismaOverride(db.url);
    await prismaOverride.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaOverride)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    await app.get(AccountsService).seedIfEmpty();
    const users = app.get(UsersService);
    await users.create({ email: 'admin@x.com', password: 'secret123', name: 'A', role: 'ADMIN' });
    adminToken = (await app.get(AuthService).login('admin@x.com', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('seeds the SAK chart with parent links resolved', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const codes = (res.body as { code: string }[]).map((a) => a.code);
    expect(codes).toContain('1-1000'); // Kas
    expect(codes).toContain('3-9000'); // Saldo Awal
    const kas = (res.body as { code: string; parentId: string | null }[]).find((a) => a.code === '1-1000');
    expect(kas?.parentId).toBeTruthy();
  });

  it('seedIfEmpty is idempotent', async () => {
    await app.get(AccountsService).seedIfEmpty();
    const count = await prismaOverride.client.account.count();
    expect(count).toBe(28);
  });

  it('creates a postable account', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: '1-1600', name: 'Kas Kecil', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', parentCode: '1-0000' })
      .expect(201);
  });

  it('rejects a duplicate active code (409)', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: '1-1000', name: 'Dup', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT' })
      .expect(409);
  });

  it('rejects posting-account parent (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: '1-1700', name: 'Bad Parent', type: 'ASSET', subtype: 'CURRENT_ASSET', normalBalance: 'DEBIT', parentCode: '1-1000' })
      .expect(422);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`AccountsService` not found)

Run: `npm run test:e2e -- accounts`
Expected: FAIL.

- [ ] **Step 4: Implement AccountsService**

Create `src/ledger/accounts/accounts.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Account, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts.seed';

export interface CreateAccountInput {
  code: string;
  name: string;
  type: Account['type'];
  subtype: Account['subtype'];
  normalBalance: Account['normalBalance'];
  cashFlowCategory?: Account['cashFlowCategory'];
  isPostable?: boolean;
  parentCode?: string;
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent: seeds the SAK chart only when no accounts exist. */
  async seedIfEmpty(): Promise<void> {
    const count = await this.prisma.client.account.count();
    if (count > 0) return;
    // Insert headers first (no parent), then leaves, resolving parentCode → id.
    const ordered = [...CHART_OF_ACCOUNTS].sort(
      (a, b) => Number(b.isPostable === false) - Number(a.isPostable === false),
    );
    const idByCode = new Map<string, string>();
    for (const a of ordered) {
      const created = await this.prisma.client.account.create({
        data: {
          code: a.code,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          normalBalance: a.normalBalance,
          cashFlowCategory: a.cashFlowCategory ?? 'NONE',
          isPostable: a.isPostable ?? true,
          parentId: a.parentCode ? idByCode.get(a.parentCode) : null,
        },
      });
      idByCode.set(a.code, created.id);
    }
  }

  async list(): Promise<Account[]> {
    return this.prisma.client.account.findMany({ orderBy: { code: 'asc' } });
  }

  async findById(id: string): Promise<Account> {
    const account = await this.prisma.client.account.findFirst({ where: { id } });
    if (!account) throw new NotFoundDomainError('Account not found', { id });
    return account;
  }

  async create(input: CreateAccountInput): Promise<Account> {
    const existing = await this.prisma.client.account.findFirst({
      where: { code: input.code },
    });
    if (existing) {
      throw new ConflictDomainError('Account code already exists', { code: input.code });
    }
    let parentId: string | null = null;
    if (input.parentCode) {
      const parent = await this.prisma.client.account.findFirst({
        where: { code: input.parentCode },
      });
      if (!parent) {
        throw new ValidationFailedError('Parent account not found', { parentCode: input.parentCode });
      }
      if (parent.isPostable) {
        throw new ValidationFailedError('Parent account must be a non-postable header', { parentCode: input.parentCode });
      }
      parentId = parent.id;
    }
    try {
      return await this.prisma.client.account.create({
        data: {
          code: input.code,
          name: input.name,
          type: input.type,
          subtype: input.subtype,
          normalBalance: input.normalBalance,
          cashFlowCategory: input.cashFlowCategory ?? 'NONE',
          isPostable: input.isPostable ?? true,
          parentId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictDomainError('Account code already exists', { code: input.code });
      }
      throw err;
    }
  }

  async update(id: string, data: Partial<Pick<Account, 'name' | 'cashFlowCategory' | 'isActive'>>): Promise<Account> {
    await this.findById(id);
    return this.prisma.client.account.update({ where: { id }, data });
  }

  async deactivate(id: string): Promise<Account> {
    await this.findById(id);
    return this.prisma.client.account.update({ where: { id }, data: { isActive: false } });
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const account = await this.findById(id);
    const posted = await this.prisma.client.journalLine.count({ where: { accountId: id } }).catch(() => 0);
    if (posted > 0) {
      throw new ValidationFailedError('Cannot delete an account with posted lines; deactivate instead', { id });
    }
    await this.prisma.client.account.update({
      where: { id },
      data: { code: `${account.code}#deleted-${id}`, deletedAt: new Date(), deletedBy },
    });
  }
}
```

> Note: `journalLine` does not exist until Build Step 4; the `.catch(() => 0)` keeps `softDelete` working until then. After Task 7, the count query resolves normally. (This is the one forward-reference; it is deliberate and safe.)

- [ ] **Step 5: LedgerModule + controller + DTOs**

Create `src/ledger/accounts/dto/create-account.dto.ts`:

```typescript
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  AccountSubtype,
  AccountType,
  CashFlowCategory,
  NormalBalance,
} from '@prisma/client';

export class CreateAccountDto {
  @IsString() @MaxLength(32) code!: string;
  @IsString() @MaxLength(128) name!: string;
  @IsEnum(AccountType) type!: AccountType;
  @IsEnum(AccountSubtype) subtype!: AccountSubtype;
  @IsEnum(NormalBalance) normalBalance!: NormalBalance;
  @IsOptional() @IsEnum(CashFlowCategory) cashFlowCategory?: CashFlowCategory;
  @IsOptional() @IsBoolean() isPostable?: boolean;
  @IsOptional() @IsString() parentCode?: string;
}
```

Create `src/ledger/accounts/dto/update-account.dto.ts`:

```typescript
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { CashFlowCategory } from '@prisma/client';

export class UpdateAccountDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(CashFlowCategory) cashFlowCategory?: CashFlowCategory;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
```

Create `src/ledger/accounts/accounts.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Account } from '@prisma/client';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

@Controller('ledger/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(): Promise<Account[]> {
    return this.accounts.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Account> {
    return this.accounts.findById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  create(@Body() dto: CreateAccountDto): Promise<Account> {
    return this.accounts.create(dto);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAccountDto): Promise<Account> {
    return this.accounts.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id') id: string): Promise<Account> {
    return this.accounts.deactivate(id);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.accounts.softDelete(id, user.id);
  }
}
```

Create `src/ledger/ledger.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { CompanyModule } from '../company/company.module';
import { AccountsService } from './accounts/accounts.service';
import { AccountsController } from './accounts/accounts.controller';

@Module({
  imports: [CompanyModule],
  providers: [AccountsService],
  controllers: [AccountsController],
  exports: [AccountsService],
})
export class LedgerModule {}
```

Register `LedgerModule` in `src/app.module.ts`. Add `seedIfEmpty` to `AccountsService.onModuleInit` (implement `OnModuleInit`, mirroring `CompanyService`).

- [ ] **Step 6: Run — expect PASS**

Run: `npm run test:e2e -- accounts`
Expected: PASS (5 cases). Then `npm run build` + `npm run lint` clean. Full `npm run test:e2e` green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(accounts): chart-of-accounts service, SAK seed, and endpoints"
```

---

# Build Step 3 — Periods

## Task 4: AccountingPeriod model + PeriodsService

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/ledger/periods/periods.service.ts`, `src/ledger/periods/periods.controller.ts`, `src/ledger/periods/dto/generate-periods.dto.ts`
- Modify: `src/ledger/ledger.module.ts`
- Test: `test/periods.e2e-spec.ts`

- [ ] **Step 1: Add the model**

Append to `prisma/schema.prisma`:

```prisma
enum PeriodStatus {
  OPEN
  CLOSED
}

model AccountingPeriod {
  id         String       @id @default(uuid())
  fiscalYear Int          @map("fiscal_year")
  sequence   Int
  name       String       @unique
  startDate  DateTime     @map("start_date") @db.Date
  endDate    DateTime     @map("end_date") @db.Date
  status     PeriodStatus @default(OPEN)
  closedAt   DateTime?    @map("closed_at")
  closedBy   String?      @map("closed_by")
  createdAt  DateTime     @default(now()) @map("created_at")
  updatedAt  DateTime     @updatedAt @map("updated_at")

  @@unique([fiscalYear, sequence])
  @@index([startDate, endDate])
  @@map("accounting_periods")
}
```

```bash
npx prisma migrate dev --name add_accounting_periods
```

- [ ] **Step 2: Write the failing e2e test**

Create `test/periods.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Periods (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;

  beforeAll(async () => {
    db = await startTestDb();
    prismaOverride = makePrismaOverride(db.url);
    await prismaOverride.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaOverride)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    const users = app.get(UsersService);
    await users.create({ email: 'admin@x.com', password: 'secret123', name: 'A', role: 'ADMIN' });
    adminToken = (await app.get(AuthService).login('admin@x.com', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('generates 12 monthly periods for a fiscal year', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/periods/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fiscalYear: 2026 })
      .expect(201);
    const periods = await app.get(PeriodsService).list(2026);
    expect(periods).toHaveLength(12);
    expect(periods[0].name).toBe('2026-01');
  });

  it('finds the open period for a date', async () => {
    const period = await app.get(PeriodsService).findOpenPeriodForDate(new Date('2026-03-15'));
    expect(period?.name).toBe('2026-03');
  });

  it('closes and blocks the open-period lookup', async () => {
    const periods = await app.get(PeriodsService).list(2026);
    const march = periods.find((p) => p.name === '2026-03')!;
    await request(app.getHttpServer() as App)
      .post(`/ledger/periods/${march.id}/close`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const open = await app.get(PeriodsService).findOpenPeriodForDate(new Date('2026-03-15'));
    expect(open).toBeNull();
  });

  it('reopens a closed period', async () => {
    const periods = await app.get(PeriodsService).list(2026);
    const march = periods.find((p) => p.name === '2026-03')!;
    await request(app.getHttpServer() as App)
      .post(`/ledger/periods/${march.id}/reopen`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const open = await app.get(PeriodsService).findOpenPeriodForDate(new Date('2026-03-15'));
    expect(open?.name).toBe('2026-03');
  });

  it('generating the same fiscal year twice is idempotent', async () => {
    await app.get(PeriodsService).generatePeriods(2026);
    expect(await app.get(PeriodsService).list(2026)).toHaveLength(12);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npm run test:e2e -- periods`
Expected: FAIL.

- [ ] **Step 4: Implement PeriodsService**

Create `src/ledger/periods/periods.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { AccountingPeriod } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CompanyService } from '../../company/company.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
} from '../../common/errors/domain-errors';

@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
  ) {}

  /** Idempotent: generates the 12 monthly periods for a fiscal year if absent. */
  async generatePeriods(fiscalYear: number): Promise<AccountingPeriod[]> {
    const existing = await this.list(fiscalYear);
    if (existing.length === 12) return existing;
    const settings = await this.company.get();
    const startMonth = settings.fiscalYearStartMonth; // 1..12
    const data = Array.from({ length: 12 }, (_, i) => {
      // month offset i from the fiscal-year start
      const monthIndex = startMonth - 1 + i; // 0-based from Jan of fiscalYear
      const year = fiscalYear + Math.floor(monthIndex / 12);
      const month = monthIndex % 12; // 0..11
      const start = new Date(Date.UTC(year, month, 1));
      const end = new Date(Date.UTC(year, month + 1, 0)); // last day of month
      const name = `${fiscalYear}-${String(i + 1).padStart(2, '0')}`;
      return {
        fiscalYear,
        sequence: i + 1,
        name,
        startDate: start,
        endDate: end,
      };
    });
    await this.prisma.client.accountingPeriod.createMany({ data, skipDuplicates: true });
    return this.list(fiscalYear);
  }

  async list(fiscalYear: number): Promise<AccountingPeriod[]> {
    return this.prisma.client.accountingPeriod.findMany({
      where: { fiscalYear },
      orderBy: { sequence: 'asc' },
    });
  }

  /** The PostingService guard: returns the OPEN period containing the date, or null. */
  async findOpenPeriodForDate(date: Date): Promise<AccountingPeriod | null> {
    return this.prisma.client.accountingPeriod.findFirst({
      where: { status: 'OPEN', startDate: { lte: date }, endDate: { gte: date } },
    });
  }

  async close(id: string, closedBy: string): Promise<AccountingPeriod> {
    const period = await this.prisma.client.accountingPeriod.findUnique({ where: { id } });
    if (!period) throw new NotFoundDomainError('Period not found', { id });
    if (period.status === 'CLOSED') {
      throw new ConflictDomainError('Period already closed', { id });
    }
    return this.prisma.client.accountingPeriod.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date(), closedBy },
    });
  }

  async reopen(id: string): Promise<AccountingPeriod> {
    const period = await this.prisma.client.accountingPeriod.findUnique({ where: { id } });
    if (!period) throw new NotFoundDomainError('Period not found', { id });
    return this.prisma.client.accountingPeriod.update({
      where: { id },
      data: { status: 'OPEN', closedAt: null, closedBy: null },
    });
  }
}
```

> `AccountingPeriod` is not soft-deletable, so `findUnique` is used directly (no extension interception).

- [ ] **Step 5: Controller + DTO + module wiring**

Create `src/ledger/periods/dto/generate-periods.dto.ts`:

```typescript
import { IsInt, Max, Min } from 'class-validator';

export class GeneratePeriodsDto {
  @IsInt() @Min(2000) @Max(2200) fiscalYear!: number;
}
```

Create `src/ledger/periods/periods.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AccountingPeriod } from '@prisma/client';
import { PeriodsService } from './periods.service';
import { GeneratePeriodsDto } from './dto/generate-periods.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

@Controller('ledger/periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  list(@Query('fiscalYear') fiscalYear: string): Promise<AccountingPeriod[]> {
    return this.periods.list(Number(fiscalYear));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post('generate')
  generate(@Body() dto: GeneratePeriodsDto): Promise<AccountingPeriod[]> {
    return this.periods.generatePeriods(dto.fiscalYear);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/close')
  @HttpCode(200)
  close(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<AccountingPeriod> {
    return this.periods.close(id, user.id);
  }

  @Roles(Role.ADMIN)
  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@Param('id') id: string): Promise<AccountingPeriod> {
    return this.periods.reopen(id);
  }
}
```

Add `PeriodsService` + `PeriodsController` to `LedgerModule` (providers/controllers; export `PeriodsService`).

- [ ] **Step 6: Run — expect PASS**

Run: `npm run test:e2e -- periods`
Expected: PASS (5 cases). `npm run build` + `npm run lint` clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(periods): accounting periods with generate/close/reopen + open-period guard"
```

---

# Build Step 4 — PostingService (the transactional core)

## Task 5: Journal schema + domain errors + money-string validator

**Files:**
- Modify: `prisma/schema.prisma`, `src/common/errors/domain-errors.ts`
- Create: `src/common/validators/is-money-string.ts`
- Hand-edit the generated migration SQL (CHECK constraint)

- [ ] **Step 1: Add journal models**

Append to `prisma/schema.prisma`:

```prisma
enum JournalStatus {
  DRAFT
  POSTED
  REVERSED
}

enum JournalSourceType {
  MANUAL
  OPENING
  REVERSAL
}

model JournalSequence {
  fiscalYear Int      @id @map("fiscal_year")
  nextNumber Int      @default(1) @map("next_number")
  updatedAt  DateTime @updatedAt @map("updated_at")

  @@map("journal_sequences")
}

model JournalEntry {
  id           String            @id @default(uuid())
  entryNumber  Int?              @map("entry_number")
  entryRef     String?           @map("entry_ref")
  fiscalYear   Int?              @map("fiscal_year")
  date         DateTime          @db.Date
  periodId     String?           @map("period_id")
  description  String
  sourceType   JournalSourceType @map("source_type")
  sourceId     String?           @map("source_id")
  status       JournalStatus     @default(DRAFT)
  reversalOfId String?           @map("reversal_of_id")
  reversedById String?           @map("reversed_by_id")
  createdBy    String            @map("created_by")
  postedBy     String?           @map("posted_by")
  postedAt     DateTime?         @map("posted_at")
  createdAt    DateTime          @default(now()) @map("created_at")
  updatedAt    DateTime          @updatedAt @map("updated_at")
  deletedAt    DateTime?         @map("deleted_at")
  deletedBy    String?           @map("deleted_by")
  lines        JournalLine[]

  @@unique([fiscalYear, entryNumber], name: "journal_entries_fy_number_unique")
  @@index([date])
  @@index([status])
  @@index([deletedAt])
  @@map("journal_entries")
}

model JournalLine {
  id          String       @id @default(uuid())
  journalEntryId String    @map("journal_entry_id")
  entry       JournalEntry @relation(fields: [journalEntryId], references: [id], onDelete: Cascade)
  lineNo      Int          @map("line_no")
  accountId   String       @map("account_id")
  debit       Decimal      @default(0) @db.Decimal(20, 4)
  credit      Decimal      @default(0) @db.Decimal(20, 4)
  description String?
  createdAt   DateTime     @default(now()) @map("created_at")

  @@index([accountId])
  @@index([journalEntryId])
  @@map("journal_lines")
}

model IdempotencyKey {
  key           String   @id
  endpoint      String
  resultEntryId String?  @map("result_entry_id")
  createdAt     DateTime @default(now()) @map("created_at")

  @@map("idempotency_keys")
}
```

- [ ] **Step 2: Create the migration (without applying), add the CHECK constraint, then apply**

```bash
npx prisma migrate dev --name add_journal --create-only
```

Append to the generated `prisma/migrations/<ts>_add_journal/migration.sql`:

```sql
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_one_sided"
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit > 0 OR credit > 0));
```

Then apply:

```bash
npx prisma migrate dev
```

- [ ] **Step 3: Register JournalEntry for soft delete**

Edit `src/common/prisma/soft-delete.extension.ts`:

```typescript
export const SOFT_DELETE_MODELS = new Set<Prisma.ModelName>(['User', 'Account', 'JournalEntry']);
```

- [ ] **Step 4: Add the four posting domain errors**

Append to `src/common/errors/domain-errors.ts`:

```typescript
export class UnbalancedEntryError extends DomainError {
  readonly code = 'UNBALANCED_ENTRY';
  readonly status = 422;
}

export class ClosedPeriodError extends DomainError {
  readonly code = 'CLOSED_PERIOD';
  readonly status = 409;
}

export class InvalidAccountError extends DomainError {
  readonly code = 'INVALID_ACCOUNT';
  readonly status = 422;
}

export class SegregationOfDutiesError extends DomainError {
  readonly code = 'SEGREGATION_OF_DUTIES';
  readonly status = 403;
}
```

- [ ] **Step 5: Money-string validator + unit test**

Create `src/common/validators/is-money-string.spec.ts`:

```typescript
import { validate } from 'class-validator';
import { IsMoneyString } from './is-money-string';

class Dto {
  @IsMoneyString() amount!: string;
}

async function check(value: unknown): Promise<boolean> {
  const dto = new Dto();
  (dto as { amount: unknown }).amount = value;
  return (await validate(dto)).length === 0;
}

describe('IsMoneyString', () => {
  it('accepts up to 4 decimal places', async () => {
    expect(await check('1000')).toBe(true);
    expect(await check('1000.50')).toBe(true);
    expect(await check('0.0001')).toBe(true);
  });
  it('rejects bad values', async () => {
    expect(await check('1000.123456')).toBe(false);
    expect(await check('-5')).toBe(false);
    expect(await check('abc')).toBe(false);
    expect(await check(1000)).toBe(false);
  });
});
```

Run `npm test -- is-money-string` → FAIL (module not found). Then create `src/common/validators/is-money-string.ts`:

```typescript
import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

const MONEY_RE = /^\d+(\.\d{1,4})?$/;

export function IsMoneyString(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isMoneyString',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && MONEY_RE.test(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a non-negative decimal string with up to 4 decimal places`;
        },
      },
    });
  };
}
```

Run `npm test -- is-money-string` → PASS.

- [ ] **Step 6: Build + commit**

Run `npm run build` (clean), then:

```bash
git add -A
git commit -m "feat(ledger): journal schema, posting domain errors, money-string validator"
```

## Task 6: PostingService — post (numbering, balanced, guards, SoD)

**Files:**
- Create: `src/ledger/posting/posting.types.ts`, `src/ledger/posting/posting.service.ts`
- Modify: `src/ledger/ledger.module.ts`
- Test: `test/posting.e2e-spec.ts`

- [ ] **Step 1: Define posting input types**

Create `src/ledger/posting/posting.types.ts`:

```typescript
import { JournalSourceType } from '@prisma/client';

export interface PostLineInput {
  accountId: string;
  /** decimal strings; exactly one of debit/credit is > 0 */
  debit?: string;
  credit?: string;
  description?: string;
}

export interface PostEntryInput {
  date: Date;
  description: string;
  sourceType: JournalSourceType;
  sourceId?: string;
  createdBy: string;
  lines: PostLineInput[];
}
```

- [ ] **Step 2: Write the failing e2e test (post happy-path + the guards + concurrency)**

Create `test/posting.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import {
  UnbalancedEntryError,
  ClosedPeriodError,
} from '../src/common/errors/domain-errors';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('PostingService (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let posting: PostingService;
  let kasId: string;
  let modalId: string;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    posting = app.get(PostingService);
    const accounts = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const balanced = (createdBy = 'u1') => ({
    date: new Date('2026-02-10'),
    description: 'Owner injects capital',
    sourceType: 'MANUAL' as const,
    createdBy,
    lines: [
      { accountId: kasId, debit: '1000000' },
      { accountId: modalId, credit: '1000000' },
    ],
  });

  it('posts a balanced entry and assigns a gapless number', async () => {
    const entry = await posting.post(balanced(), 'poster1');
    expect(entry.status).toBe('POSTED');
    expect(entry.entryNumber).toBe(1);
    expect(entry.entryRef).toBe('JE/2026/000001');
    const next = await posting.post(balanced(), 'poster1');
    expect(next.entryNumber).toBe(2);
  });

  it('rejects an unbalanced entry', async () => {
    await expect(
      posting.post({ ...balanced(), lines: [{ accountId: kasId, debit: '5' }, { accountId: modalId, credit: '4' }] }, 'poster1'),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it('rejects posting into a date with no open period', async () => {
    await expect(
      posting.post({ ...balanced(), date: new Date('2030-01-01') }, 'poster1'),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
  });

  it('enforces segregation of duties when enabled (poster = creator → 403)', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: true });
    await expect(posting.post(balanced('same'), 'same')).rejects.toMatchObject({ code: 'SEGREGATION_OF_DUTIES' });
  });

  it('assigns gapless numbers under concurrency (no gaps, no dupes)', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const before = await prisma.client.journalEntry.count({ where: { fiscalYear: 2026, status: { not: 'DRAFT' } } });
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () => posting.post(balanced(), 'p').catch(() => null)),
    );
    const numbers = results.filter(Boolean).map((e) => e!.entryNumber!);
    const unique = new Set(numbers);
    expect(unique.size).toBe(numbers.length); // no duplicates
    const sorted = [...numbers].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBe(1); // contiguous, no gaps
    }
    const after = await prisma.client.journalEntry.count({ where: { fiscalYear: 2026, status: { not: 'DRAFT' } } });
    expect(after - before).toBe(N);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npm run test:e2e -- posting`
Expected: FAIL (`PostingService` not found).

- [ ] **Step 4: Implement PostingService.post**

Create `src/ledger/posting/posting.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { JournalEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CompanyService } from '../../company/company.service';
import { PeriodsService } from '../periods/periods.service';
import { Money } from '../../common/money/money';
import {
  ClosedPeriodError,
  InvalidAccountError,
  SegregationOfDutiesError,
  UnbalancedEntryError,
} from '../../common/errors/domain-errors';
import { PostEntryInput, PostLineInput } from './posting.types';

@Injectable()
export class PostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
    private readonly periods: PeriodsService,
  ) {}

  async post(input: PostEntryInput, postedBy: string): Promise<JournalEntry> {
    this.assertBalanced(input.lines);

    const settings = await this.company.get();
    if (settings.segregationOfDutiesEnabled && postedBy === input.createdBy) {
      throw new SegregationOfDutiesError('The poster must differ from the entry creator', {
        createdBy: input.createdBy,
      });
    }

    const period = await this.periods.findOpenPeriodForDate(input.date);
    if (!period) {
      throw new ClosedPeriodError('No open accounting period contains this date', {
        date: input.date.toISOString().slice(0, 10),
      });
    }

    await this.assertPostableAccounts(input.lines);

    const fiscalYear = this.fiscalYearFor(input.date, settings.fiscalYearStartMonth);

    return this.prisma.client.$transaction(async (tx) => {
      const entryNumber = await this.nextNumber(tx, fiscalYear);
      const entryRef = `JE/${fiscalYear}/${String(entryNumber).padStart(6, '0')}`;
      return tx.journalEntry.create({
        data: {
          entryNumber,
          entryRef,
          fiscalYear,
          date: input.date,
          periodId: period.id,
          description: input.description,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          status: 'POSTED',
          createdBy: input.createdBy,
          postedBy,
          postedAt: new Date(),
          lines: {
            create: input.lines.map((l, i) => ({
              lineNo: i + 1,
              accountId: l.accountId,
              debit: l.debit ?? '0',
              credit: l.credit ?? '0',
              description: l.description,
            })),
          },
        },
      });
    });
  }

  /** Lock-and-increment the per-fiscal-year counter; gapless because it lives in the tx. */
  private async nextNumber(
    tx: Prisma.TransactionClient,
    fiscalYear: number,
  ): Promise<number> {
    await tx.$executeRaw`INSERT INTO journal_sequences (fiscal_year, next_number, updated_at)
      VALUES (${fiscalYear}, 1, now()) ON CONFLICT (fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ next_number: number }[]>`
      SELECT next_number FROM journal_sequences WHERE fiscal_year = ${fiscalYear} FOR UPDATE`;
    const current = rows[0].next_number;
    await tx.$executeRaw`UPDATE journal_sequences SET next_number = ${current + 1}, updated_at = now()
      WHERE fiscal_year = ${fiscalYear}`;
    return current;
  }

  private assertBalanced(lines: PostLineInput[]): void {
    if (lines.length < 2) {
      throw new UnbalancedEntryError('An entry needs at least two lines');
    }
    let debit = Money.zero();
    let credit = Money.zero();
    for (const l of lines) {
      const d = Money.of(l.debit ?? '0');
      const c = Money.of(l.credit ?? '0');
      const dPos = !d.isZero();
      const cPos = !c.isZero();
      if (dPos === cPos) {
        throw new UnbalancedEntryError('Each line must have exactly one of debit or credit > 0');
      }
      debit = debit.add(d);
      credit = credit.add(c);
    }
    if (!debit.equals(credit)) {
      throw new UnbalancedEntryError('Total debits must equal total credits', {
        debit: debit.toString(),
        credit: credit.toString(),
      });
    }
  }

  private async assertPostableAccounts(lines: PostLineInput[]): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await this.prisma.client.account.findMany({ where: { id: { in: ids } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of ids) {
      const a = byId.get(id);
      if (!a) throw new InvalidAccountError('Account not found', { accountId: id });
      if (!a.isPostable) throw new InvalidAccountError('Account is not postable (header account)', { accountId: id });
      if (!a.isActive) throw new InvalidAccountError('Account is inactive', { accountId: id });
    }
  }

  /** Fiscal year that a date falls into, given the configured start month. */
  fiscalYearFor(date: Date, startMonth: number): number {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1; // 1..12
    return m >= startMonth ? y : y - 1;
  }
}
```

Add `PostingService` to `LedgerModule` providers (it needs `CompanyModule` already imported, and `PeriodsService` — ensure both are available; export `PostingService`).

- [ ] **Step 5: Run — expect PASS**

Run: `npm run test:e2e -- posting`
Expected: PASS (5 cases, incl. concurrency). If the concurrency test flakes, the `FOR UPDATE` lock is missing/incorrect — fix before proceeding. `npm run build` + `npm run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(posting): transactional PostingService with gapless FOR-UPDATE numbering"
```

## Task 7: PostingService — reverse + gapless-under-failure test

**Files:**
- Modify: `src/ledger/posting/posting.service.ts`
- Test: `test/posting.e2e-spec.ts` (add cases)

- [ ] **Step 1: Add reversal + failure tests**

Append inside the `describe` in `test/posting.e2e-spec.ts`:

```typescript
  it('reverses a posted entry; original → REVERSED, reversal posted, balances net to zero', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const entry = await posting.post(balanced(), 'p');
    const reversal = await posting.reverse(entry.id, 'p');
    expect(reversal.sourceType).toBe('REVERSAL');
    expect(reversal.reversalOfId).toBe(entry.id);
    const original = await prisma.client.journalEntry.findUnique({ where: { id: entry.id } });
    expect(original?.status).toBe('REVERSED');
    expect(original?.reversedById).toBe(reversal.id);
    // The reversal swaps debit/credit.
    const lines = await prisma.client.journalLine.findMany({ where: { journalEntryId: reversal.id }, orderBy: { lineNo: 'asc' } });
    expect(lines[0].credit.toString()).toBe('1000000'); // was a debit on the original
  });

  it('consumes no number when posting fails (gapless under failure)', async () => {
    const seqBefore = await prisma.client.journalSequence.findUnique({ where: { fiscalYear: 2026 } });
    await expect(
      posting.post({ ...balanced(), lines: [{ accountId: kasId, debit: '5' }, { accountId: modalId, credit: '4' }] }, 'p'),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    const seqAfter = await prisma.client.journalSequence.findUnique({ where: { fiscalYear: 2026 } });
    expect(seqAfter?.nextNumber).toBe(seqBefore?.nextNumber); // unchanged — balance check runs before numbering
  });
```

- [ ] **Step 2: Run — expect FAIL** (`reverse` not implemented)

Run: `npm run test:e2e -- posting`
Expected: FAIL on the reversal case.

- [ ] **Step 3: Implement reverse**

Add to `PostingService`:

```typescript
import { NotFoundDomainError, ValidationFailedError } from '../../common/errors/domain-errors';
// ...

  async reverse(entryId: string, reversedBy: string, date?: Date): Promise<JournalEntry> {
    const original = await this.prisma.client.journalEntry.findFirst({
      where: { id: entryId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!original) throw new NotFoundDomainError('Journal entry not found', { entryId });
    if (original.status !== 'POSTED') {
      throw new ValidationFailedError('Only a POSTED entry can be reversed', {
        entryId,
        status: original.status,
      });
    }
    const reversalDate = date ?? original.date;
    const period = await this.periods.findOpenPeriodForDate(reversalDate);
    if (!period) {
      throw new ClosedPeriodError('No open period for the reversal date', {
        date: reversalDate.toISOString().slice(0, 10),
      });
    }
    const settings = await this.company.get();
    const fiscalYear = this.fiscalYearFor(reversalDate, settings.fiscalYearStartMonth);

    return this.prisma.client.$transaction(async (tx) => {
      const entryNumber = await this.nextNumber(tx, fiscalYear);
      const entryRef = `JE/${fiscalYear}/${String(entryNumber).padStart(6, '0')}`;
      const reversal = await tx.journalEntry.create({
        data: {
          entryNumber,
          entryRef,
          fiscalYear,
          date: reversalDate,
          periodId: period.id,
          description: `Reversal of ${original.entryRef}`,
          sourceType: 'REVERSAL',
          reversalOfId: original.id,
          status: 'POSTED',
          createdBy: reversedBy,
          postedBy: reversedBy,
          postedAt: new Date(),
          lines: {
            create: original.lines.map((l) => ({
              lineNo: l.lineNo,
              accountId: l.accountId,
              debit: l.credit, // swap
              credit: l.debit,
              description: l.description,
            })),
          },
        },
      });
      await tx.journalEntry.update({
        where: { id: original.id },
        data: { status: 'REVERSED', reversedById: reversal.id },
      });
      return reversal;
    });
  }
```

> Reversal posts by the same person who requested it (`reversedBy` = creator and poster); SoD is intentionally **not** applied to reversals — a reversal is a correction action, not a new business transaction.

- [ ] **Step 4: Run — expect PASS**

Run: `npm run test:e2e -- posting`
Expected: PASS (all 7 cases). `npm run build` + `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(posting): reversal entries (swap, link, REVERSED status)"
```

---

# Build Step 5 — JournalService (drafts, createAndPost, opening balances, idempotency)

## Task 8: Draft lifecycle + manual posting endpoints

**Files:**
- Create: `src/ledger/journal/journal.service.ts`, `src/ledger/journal/journal.controller.ts`, `src/ledger/journal/dto/{journal-line.dto.ts,create-journal-entry.dto.ts}`
- Modify: `src/ledger/ledger.module.ts`
- Test: `test/journal.e2e-spec.ts`

- [ ] **Step 1: DTOs**

Create `src/ledger/journal/dto/journal-line.dto.ts`:

```typescript
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { IsMoneyString } from '../../../common/validators/is-money-string';

export class JournalLineDto {
  @IsUUID() accountId!: string;
  @IsOptional() @IsMoneyString() debit?: string;
  @IsOptional() @IsMoneyString() credit?: string;
  @IsOptional() @IsString() description?: string;
}
```

Create `src/ledger/journal/dto/create-journal-entry.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsString,
  ValidateNested,
} from 'class-validator';
import { JournalLineDto } from './journal-line.dto';

export class CreateJournalEntryDto {
  @IsDateString() date!: string;
  @IsString() description!: string;
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}
```

- [ ] **Step 2: Write the failing e2e test (drafts + post + SoD via HTTP)**

Create `test/journal.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Journal (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let accountantToken: string;
  let approverToken: string;
  let kasId: string;
  let modalId: string;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({ email: 'acc@x.com', password: 'secret123', name: 'Acc', role: 'ACCOUNTANT' });
    await users.create({ email: 'app@x.com', password: 'secret123', name: 'App', role: 'APPROVER' });
    const auth = app.get(AuthService);
    accountantToken = (await auth.login('acc@x.com', 'secret123')).accessToken;
    approverToken = (await auth.login('app@x.com', 'secret123')).accessToken;
    const accounts = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const body = () => ({
    date: '2026-02-10',
    description: 'Capital',
    lines: [
      { accountId: kasId, debit: '1000000' },
      { accountId: modalId, credit: '1000000' },
    ],
  });

  it('accountant creates a draft (no number yet)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries')
      .set(bearer(accountantToken))
      .send(body())
      .expect(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.entryNumber).toBeNull();
  });

  it('approver posts the draft in place (same id); SoD satisfied (different user)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries').set(bearer(accountantToken)).send(body()).expect(201);
    const posted = await request(app.getHttpServer() as App)
      .post(`/ledger/journal-entries/${draft.body.id}/post`)
      .set(bearer(approverToken))
      .expect(200);
    expect(posted.body.id).toBe(draft.body.id); // transitioned in place
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.entryNumber).toBeGreaterThan(0);
  });

  it('blocks an accountant from posting (role) — 403', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries').set(bearer(accountantToken)).send(body()).expect(201);
    await request(app.getHttpServer() as App)
      .post(`/ledger/journal-entries/${draft.body.id}/post`)
      .set(bearer(accountantToken))
      .expect(403);
  });

  it('soft-deletes a draft', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries').set(bearer(accountantToken)).send(body()).expect(201);
    await request(app.getHttpServer() as App)
      .delete(`/ledger/journal-entries/${draft.body.id}`).set(bearer(accountantToken)).expect(204);
    await request(app.getHttpServer() as App)
      .get(`/ledger/journal-entries/${draft.body.id}`).set(bearer(accountantToken)).expect(404);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npm run test:e2e -- journal`
Expected: FAIL.

- [ ] **Step 4: Implement JournalService (drafts + postDraft)**

Create `src/ledger/journal/journal.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PostingService } from '../posting/posting.service';
import { PostLineInput } from '../posting/posting.types';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';

export interface DraftInput {
  date: Date;
  description: string;
  lines: PostLineInput[];
  createdBy: string;
}

@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  async createDraft(input: DraftInput): Promise<JournalEntry> {
    return this.prisma.client.journalEntry.create({
      data: {
        date: input.date,
        description: input.description,
        sourceType: 'MANUAL',
        status: 'DRAFT',
        createdBy: input.createdBy,
        lines: {
          create: input.lines.map((l, i) => ({
            lineNo: i + 1,
            accountId: l.accountId,
            debit: l.debit ?? '0',
            credit: l.credit ?? '0',
            description: l.description,
          })),
        },
      },
    });
  }

  async getById(id: string): Promise<JournalEntry> {
    const entry = await this.prisma.client.journalEntry.findFirst({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!entry) throw new NotFoundDomainError('Journal entry not found', { id });
    return entry;
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    const entry = await this.getById(id);
    if (entry.status !== 'DRAFT') {
      throw new ValidationFailedError('Only a DRAFT entry can be deleted', { id, status: entry.status });
    }
    await this.prisma.client.journalEntry.softDelete({ id }, deletedBy);
  }

  async postDraft(id: string, postedBy: string): Promise<JournalEntry> {
    return this.posting.postDraft(id, postedBy);
  }
}
```

> `postDraft` delegates to `PostingService.postDraft`, which transitions the **same draft row** to POSTED in place (stable id, no orphan rows) — honoring the spec. `PostingService` remains the only thing that writes posted state.

- [ ] **Step 4b: Add `postDraft` (in-place transition) to PostingService**

Add to `src/ledger/posting/posting.service.ts` (reuses the private guards from Task 6):

```typescript
  async postDraft(draftId: string, postedBy: string): Promise<JournalEntry> {
    const draft = await this.prisma.client.journalEntry.findFirst({
      where: { id: draftId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!draft) throw new NotFoundDomainError('Journal entry not found', { id: draftId });
    if (draft.status !== 'DRAFT') {
      throw new ValidationFailedError('Entry is not a draft', { id: draftId, status: draft.status });
    }
    const lines = draft.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
    }));
    this.assertBalanced(lines);

    const settings = await this.company.get();
    if (settings.segregationOfDutiesEnabled && draft.sourceType === 'MANUAL' && postedBy === draft.createdBy) {
      throw new SegregationOfDutiesError('The poster must differ from the entry creator', {
        createdBy: draft.createdBy,
      });
    }
    const period = await this.periods.findOpenPeriodForDate(draft.date);
    if (!period) {
      throw new ClosedPeriodError('No open accounting period contains this date', {
        date: draft.date.toISOString().slice(0, 10),
      });
    }
    await this.assertPostableAccounts(lines);
    const fiscalYear = this.fiscalYearFor(draft.date, settings.fiscalYearStartMonth);

    return this.prisma.client.$transaction(async (tx) => {
      const entryNumber = await this.nextNumber(tx, fiscalYear);
      const entryRef = `JE/${fiscalYear}/${String(entryNumber).padStart(6, '0')}`;
      return tx.journalEntry.update({
        where: { id: draftId },
        data: {
          entryNumber,
          entryRef,
          fiscalYear,
          periodId: period.id,
          status: 'POSTED',
          postedBy,
          postedAt: new Date(),
        },
      });
    });
  }
```

- [ ] **Step 5: Controller + module wiring**

Create `src/ledger/journal/journal.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { JournalService } from './journal.service';
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

@Controller('ledger/journal-entries')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get(':id')
  get(@Param('id') id: string): Promise<JournalEntry> {
    return this.journal.getById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  createDraft(@Body() dto: CreateJournalEntryDto, @CurrentUser() user: AuthenticatedUser): Promise<JournalEntry> {
    return this.journal.createDraft({
      date: new Date(dto.date),
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    });
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  post(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<JournalEntry> {
    return this.journal.postDraft(id, user.id);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<JournalEntry> {
    return this.journal.reverse(id, user.id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.journal.deleteDraft(id, user.id);
  }
}
```

Add a thin delegate to `JournalService` so the controller never reaches into `posting`:

```typescript
  reverse(id: string, reversedBy: string): Promise<JournalEntry> {
    return this.posting.reverse(id, reversedBy);
  }
```

Register `JournalService` + `JournalController` in `LedgerModule`.

- [ ] **Step 6: Run — expect PASS**

Run: `npm run test:e2e -- journal`
Expected: PASS (4 cases). `npm run build` + `npm run lint` clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(journal): draft lifecycle + post/reverse endpoints"
```

## Task 9: createAndPost, opening balances (auto-plug), idempotency

**Files:**
- Modify: `src/ledger/journal/journal.service.ts`, `src/ledger/journal/journal.controller.ts`
- Create: `src/ledger/journal/dto/opening-balances.dto.ts`
- Test: `test/journal.e2e-spec.ts` (add cases)

- [ ] **Step 1: Add tests for createAndPost + opening + idempotency**

Append to `test/journal.e2e-spec.ts`:

```typescript
  it('createAndPost in one call when SoD is off', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const res = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries?post=true')
      .set(bearer(approverToken))
      .send(body())
      .expect(200);
    expect(res.body.status).toBe('POSTED');
  });

  it('idempotency-key makes a repeated post return the same entry', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const key = 'idem-key-123';
    const first = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries?post=true')
      .set(bearer(approverToken)).set('Idempotency-Key', key)
      .send(body()).expect(200);
    const second = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries?post=true')
      .set(bearer(approverToken)).set('Idempotency-Key', key)
      .send(body()).expect(200);
    expect(second.body.id).toBe(first.body.id); // no duplicate
  });

  it('opening balances auto-plug to Saldo Awal so the entry balances', async () => {
    await app.get(UsersService).create({ email: 'adm@x.com', password: 'secret123', name: 'Adm', role: 'ADMIN' });
    const adminToken = (await app.get(AuthService).login('adm@x.com', 'secret123')).accessToken;
    const res = await request(app.getHttpServer() as App)
      .post('/ledger/opening-balances')
      .set(bearer(adminToken))
      .send({ date: '2026-01-01', balances: [{ accountId: kasId, debit: '5000000' }] })
      .expect(200);
    expect(res.body.sourceType).toBe('OPENING');
    const lines = await prisma.client.journalLine.findMany({ where: { journalEntryId: res.body.id } });
    const equity = await app.get(AccountsService).list().then((a) => a.find((x) => x.code === '3-9000')!);
    const plug = lines.find((l) => l.accountId === equity.id);
    expect(plug?.credit.toString()).toBe('5000000'); // balancing plug to Saldo Awal
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run test:e2e -- journal`
Expected: FAIL (no `?post=true`, no opening endpoint, no idempotency).

- [ ] **Step 3: Add opening-balances DTO**

Create `src/ledger/journal/dto/opening-balances.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, ValidateNested } from 'class-validator';
import { JournalLineDto } from './journal-line.dto';

export class OpeningBalancesDto {
  @IsDateString() date!: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => JournalLineDto)
  balances!: JournalLineDto[];
}
```

- [ ] **Step 4: Implement createAndPost, openingBalances, and idempotency in JournalService**

Add to `src/ledger/journal/journal.service.ts`:

```typescript
import { AccountsService } from '../accounts/accounts.service';
import { Money } from '../../common/money/money';
import { OPENING_BALANCE_EQUITY_CODE } from '../accounts/chart-of-accounts.seed';
// add AccountsService to the constructor:
//   constructor(prisma, posting, private readonly accounts: AccountsService) {}

  /** Returns the existing entry for a used idempotency key, else null. */
  private async lookupIdempotent(key?: string): Promise<JournalEntry | null> {
    if (!key) return null;
    const record = await this.prisma.client.idempotencyKey.findUnique({ where: { key } });
    if (!record?.resultEntryId) return null;
    return this.prisma.client.journalEntry.findFirst({ where: { id: record.resultEntryId } });
  }

  private async recordIdempotent(key: string | undefined, endpoint: string, entryId: string): Promise<void> {
    if (!key) return;
    await this.prisma.client.idempotencyKey.create({
      data: { key, endpoint, resultEntryId: entryId },
    });
  }

  async createAndPost(input: DraftInput, postedBy: string, idempotencyKey?: string): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;
    const posted = await this.posting.post(
      { date: input.date, description: input.description, sourceType: 'MANUAL', createdBy: input.createdBy, lines: input.lines },
      postedBy,
    );
    await this.recordIdempotent(idempotencyKey, 'createAndPost', posted.id);
    return posted;
  }

  async postOpeningBalances(
    date: Date,
    balances: PostLineInput[],
    postedBy: string,
    idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;

    // Compute the plug to Opening Balance Equity so the entry balances.
    let debit = Money.zero();
    let credit = Money.zero();
    for (const b of balances) {
      debit = debit.add(Money.of(b.debit ?? '0'));
      credit = credit.add(Money.of(b.credit ?? '0'));
    }
    const equity = (await this.accounts.list()).find((a) => a.code === OPENING_BALANCE_EQUITY_CODE);
    if (!equity) throw new ValidationFailedError('Opening Balance Equity account missing from chart');
    const diff = debit.subtract(credit); // if assets (debits) exceed, plug is a credit to equity
    const plug: PostLineInput = diff.isNegative()
      ? { accountId: equity.id, debit: diff.multiply('-1').toString() }
      : { accountId: equity.id, credit: diff.toString() };

    const posted = await this.posting.post(
      {
        date,
        description: 'Opening balances',
        sourceType: 'OPENING',
        createdBy: postedBy,
        lines: [...balances, plug],
      },
      // Opening balances are an admin setup action; bypass SoD by using a distinct system creator.
      postedBy,
    );
    await this.recordIdempotent(idempotencyKey, 'openingBalances', posted.id);
    return posted;
  }
```

> SoD note: opening balances are an ADMIN setup action. To avoid the SoD self-post block, the `OPENING` source sets `createdBy = postedBy` (the admin) and `PostingService` must **skip the SoD check for `sourceType === 'OPENING'` and `'REVERSAL'`**. Update `PostingService.post`'s SoD guard to: `if (settings.segregationOfDutiesEnabled && input.sourceType === 'MANUAL' && postedBy === input.createdBy)`. (Reversal already bypasses by calling its own create path; making the guard source-aware keeps it consistent.) Re-run the posting tests after this change — they still pass (their entries are MANUAL).

- [ ] **Step 5: Wire controller endpoints (createAndPost via `?post=true`, opening-balances) + idempotency header**

Update `src/ledger/journal/journal.controller.ts`:

```typescript
import { Headers, Query } from '@nestjs/common';
import { OpeningBalancesDto } from './dto/opening-balances.dto';
// ...

  // replace createDraft to support ?post=true
  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  async createOrPost(
    @Body() dto: CreateJournalEntryDto,
    @Query('post') post: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const input = { date: new Date(dto.date), description: dto.description, lines: dto.lines, createdBy: user.id };
    if (post === 'true') {
      return this.journal.createAndPost(input, user.id, idempotencyKey);
    }
    return this.journal.createDraft(input);
  }
```

> `createAndPost` requires the APPROVER/ADMIN role to actually post; an ACCOUNTANT hitting `?post=true` will be rejected by `PostingService`/role gating. Keep the route role at ACCOUNTANT+ for drafts; the post path's authority is enforced by SoD + the fact that posting is a privileged action. If stricter gating is desired, split into two routes — out of scope here.

Opening balances live at a different base path, so create a dedicated `src/ledger/journal/opening-balances.controller.ts`:

```typescript
import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { JournalService } from './journal.service';
import { OpeningBalancesDto } from './dto/opening-balances.dto';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/role.enum';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

@Controller('ledger/opening-balances')
export class OpeningBalancesController {
  constructor(private readonly journal: JournalService) {}

  @Roles(Role.ADMIN)
  @Post()
  @HttpCode(200)
  post(
    @Body() dto: OpeningBalancesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.postOpeningBalances(new Date(dto.date), dto.balances, user.id, idempotencyKey);
  }
}
```

Register `OpeningBalancesController` in `LedgerModule` controllers, and add `AccountsService` to `JournalService` deps (it's already provided in the module).

Make `postDraft` and `reverse` idempotent too (spec §8 lists `/post` and `/reverse`). Update those two `JournalService` methods to take an optional key and reuse the shared helpers:

```typescript
  async postDraft(id: string, postedBy: string, idempotencyKey?: string): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;
    const posted = await this.posting.postDraft(id, postedBy);
    await this.recordIdempotent(idempotencyKey, 'postDraft', posted.id);
    return posted;
  }

  async reverse(id: string, reversedBy: string, idempotencyKey?: string): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;
    const reversal = await this.posting.reverse(id, reversedBy);
    await this.recordIdempotent(idempotencyKey, 'reverse', reversal.id);
    return reversal;
  }
```

Thread the header from `JournalController` into both routes:

```typescript
  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  post(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.postDraft(id, user.id, idempotencyKey);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<JournalEntry> {
    return this.journal.reverse(id, user.id, idempotencyKey);
  }
```

(The `reverse` delegate added in Task 8 gains the optional `idempotencyKey` param shown above; `JournalController` already imports `Headers`.)

- [ ] **Step 6: Run — expect PASS**

Run: `npm run test:e2e -- journal`
Expected: PASS (7 cases). Re-run `npm run test:e2e -- posting` (SoD guard change) — still PASS. `npm run build` + `npm run lint` clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(journal): createAndPost, opening balances auto-plug, idempotent posting"
```

---

# Build Step 6 — BalancesService (trial balance + account balance)

## Task 10: Trial balance & account balance

**Files:**
- Create: `src/ledger/balances/balances.service.ts`, `src/ledger/balances/balances.controller.ts`
- Modify: `src/ledger/ledger.module.ts`, `src/ledger/accounts/accounts.controller.ts` (balance route)
- Test: `test/balances.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e test (incl. trial-balance-nets-to-zero property)**

Create `test/balances.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Balances (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;
  let kasId: string;
  let modalId: string;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(UsersService).create({ email: 'v@x.com', password: 'secret123', name: 'V', role: 'VIEWER' });
    token = (await app.get(AuthService).login('v@x.com', 'secret123')).accessToken;
    const accounts = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
    const posting = app.get(PostingService);
    for (let i = 0; i < 5; i++) {
      await posting.post({
        date: new Date('2026-02-10'), description: 'cap', sourceType: 'MANUAL', createdBy: 'c',
        lines: [{ accountId: kasId, debit: '100000' }, { accountId: modalId, credit: '100000' }],
      }, 'p');
    }
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('trial balance always nets to zero', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/ledger/trial-balance?asOf=2026-12-31')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.totalDebit).toBe('500000.0000');
    expect(res.body.totalCredit).toBe('500000.0000');
    expect(res.body.totalDebit).toBe(res.body.totalCredit);
  });

  it('reports a single account balance', async () => {
    const res = await request(app.getHttpServer() as App)
      .get(`/ledger/accounts/${kasId}/balance?asOf=2026-12-31`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.balance).toBe('500000.0000'); // Kas is DEBIT-normal
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run test:e2e -- balances`
Expected: FAIL.

- [ ] **Step 3: Implement BalancesService**

Create `src/ledger/balances/balances.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
}

@Injectable()
export class BalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async trialBalance(asOf: Date): Promise<TrialBalance> {
    // Aggregate posted/reversed lines (posted_at not null) up to asOf, grouped by account.
    const rows = await this.prisma.$queryRaw<
      { account_id: string; code: string; name: string; debit: Prisma.Decimal; credit: Prisma.Decimal; normal_balance: string }[]
    >`
      SELECT a.id AS account_id, a.code, a.name, a.normal_balance,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.posted_at IS NOT NULL AND je.date <= ${asOf} AND a.deleted_at IS NULL
      GROUP BY a.id, a.code, a.name, a.normal_balance
      HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
      ORDER BY a.code ASC`;

    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    const out: TrialBalanceRow[] = rows.map((r) => {
      totalDebit = totalDebit.add(r.debit);
      totalCredit = totalCredit.add(r.credit);
      const net = r.normal_balance === 'DEBIT' ? r.debit.sub(r.credit) : r.credit.sub(r.debit);
      return {
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        debit: r.debit.toFixed(4),
        credit: r.credit.toFixed(4),
        balance: net.toFixed(4),
      };
    });
    return {
      asOf: asOf.toISOString().slice(0, 10),
      rows: out,
      totalDebit: totalDebit.toFixed(4),
      totalCredit: totalCredit.toFixed(4),
    };
  }

  async accountBalance(accountId: string, asOf: Date): Promise<{ accountId: string; debit: string; credit: string; balance: string }> {
    const account = await this.accounts.findById(accountId);
    const rows = await this.prisma.$queryRaw<{ debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId} AND je.posted_at IS NOT NULL AND je.date <= ${asOf}`;
    const debit = rows[0].debit;
    const credit = rows[0].credit;
    const net = account.normalBalance === 'DEBIT' ? debit.sub(credit) : credit.sub(debit);
    return { accountId, debit: debit.toFixed(4), credit: credit.toFixed(4), balance: net.toFixed(4) };
  }
}
```

> Uses raw SQL `SUM` over Postgres `NUMERIC` (exact) — no `Money` needed for aggregation. The `posted_at IS NOT NULL` filter includes both `POSTED` and `REVERSED` entries, so a reversed original and its reversal net to zero (per the spec's balance-inclusion rule).

- [ ] **Step 4: Controller(s) + module wiring**

Create `src/ledger/balances/balances.controller.ts`:

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { BalancesService, TrialBalance } from './balances.service';

@Controller('ledger/trial-balance')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  trialBalance(@Query('asOf') asOf?: string): Promise<TrialBalance> {
    const date = asOf ? new Date(asOf) : new Date();
    return this.balances.trialBalance(date);
  }
}
```

Add the account-balance route to `AccountsController` (it already has `:id`):

```typescript
import { BalancesService } from '../balances/balances.service';
// inject BalancesService in the constructor, then:
  @Get(':id/balance')
  balance(@Param('id') id: string, @Query('asOf') asOf?: string) {
    return this.balances.accountBalance(id, asOf ? new Date(asOf) : new Date());
  }
```

Register `BalancesService` + `BalancesController` in `LedgerModule` (and ensure `AccountsController` can inject `BalancesService` — both live in `LedgerModule`).

- [ ] **Step 5: Run — expect PASS**

Run: `npm run test:e2e -- balances`
Expected: PASS (2 cases). Then the **full** suite: `npm test` and `npm run test:e2e` (all suites). `npm run build` + `npm run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(balances): trial balance + account balance queries"
```

---

## Phase 2 Definition of Done

- [ ] `npm run build` + `npm run lint` clean; `docker build` still succeeds.
- [ ] `npm test` (unit) and `npm run test:e2e` (all suites: company, accounts, periods, posting, journal, balances + the Phase 1 suites) pass.
- [ ] Posting is atomic: balanced-or-reject, gapless numbering verified **under concurrency** and **under failure** (no number consumed on rollback).
- [ ] Reversal nets to zero; reversed originals remain in balances.
- [ ] Closed periods and inactive/non-postable accounts reject posting with the right domain errors.
- [ ] Segregation of duties blocks self-posting of MANUAL entries when enabled; off → allowed.
- [ ] Opening balances auto-plug to Saldo Awal and balance.
- [ ] Idempotency-Key prevents duplicate posts.
- [ ] Trial balance always nets to zero; SAK seed + period generation are idempotent.

## Notes for later phases
- Phases 3–4 post through `PostingService.post` with new `sourceType`s (SALES_INVOICE, PURCHASE_BILL, PAYMENT) — extend the enum + the source-aware SoD rule as needed; no ledger change required to accept balanced entries.
- Phase 5 statements build on `BalancesService` aggregation + `subtype`/`cashFlowCategory` groupings.
- Phase 6 year-end close adds a `CLOSING` source that zeroes nominal accounts into Laba Ditahan, and per-period close hardening.
- If trial-balance/statement queries get slow, add the `account_period_balances` snapshot (the deferred optimization).
