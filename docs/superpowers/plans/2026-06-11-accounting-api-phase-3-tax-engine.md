# Accounting API — Phase 3: Tax Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Indonesian tax engine — a `tax_codes` reference table and a pure `TaxService.calculate` that turns a tax-exclusive taxable transaction into a fully balanced journal-line set (PPN added, PPh withheld, settlement plug), with a seed of the common codes and a `POST /tax/calculate` preview. No ledger persistence (Phase 4 invoicing consumes it).

**Architecture:** A new standalone `TaxModule` (`src/tax/`), peer of `CompanyModule`/`LedgerModule`, importing `LedgerModule` for `AccountsService` (account validation + seed resolution). `TaxCodesService` owns reference-data CRUD + idempotent seed; `TaxService` owns the pure read-only calculation. No dependency on `PostingService`.

**Tech Stack:** NestJS 11, Prisma 7 (driver-adapter), PostgreSQL, `Money` value object (`roundToRupiah`), class-validator DTOs, soft-delete extension (`prisma.client.<model>`), testcontainers e2e harness (`makePrismaOverride`, `maxWorkers:1`).

**Spec:** `docs/superpowers/specs/2026-06-11-accounting-api-phase-3-tax-engine-design.md`

---

## File structure

- Create `src/tax/tax.module.ts` — wires the module; imports `LedgerModule`.
- Create `src/tax/tax-codes.seed.ts` — the 6 seed code definitions (account by code).
- Create `src/tax/tax-codes.service.ts` — CRUD + validation + idempotent seed (`OnModuleInit`).
- Create `src/tax/tax-codes.controller.ts` — `/tax/codes` CRUD.
- Create `src/tax/tax.service.ts` — `calculate(taxableTransaction)`; pure.
- Create `src/tax/tax.controller.ts` — `POST /tax/calculate`.
- Create `src/tax/dto/create-tax-code.dto.ts`, `src/tax/dto/update-tax-code.dto.ts`, `src/tax/dto/calculate-tax.dto.ts`.
- Modify `prisma/schema.prisma` — add `TaxKind` enum + `TaxCode` model.
- Create `prisma/migrations/20260611040000_add_tax_codes/migration.sql` — hand-authored.
- Modify `src/common/prisma/soft-delete.extension.ts` — add `'TaxCode'` to `SOFT_DELETE_MODELS`.
- Modify `src/app.module.ts` — import `TaxModule`.
- Create `test/tax-codes.e2e-spec.ts`, `test/tax-calculate.e2e-spec.ts`.

**Note on tests:** like `PostingService`/`BalancesService` in Phase 2, the tax services depend on the DB (tax codes, accounts), so their tests are e2e (testcontainers), not pure unit specs. The balance property test calls `TaxService.calculate` directly (not over HTTP) for speed.

**Prisma 7 reminder:** `prisma migrate dev` needs a TTY and will fail in a non-interactive shell. Apply migrations with the hand-authored SQL + `npx prisma migrate deploy`, then **always** `npx prisma generate`. The DB must be up: `docker compose up -d db`.

---

## Task 1: TaxCode model, migration, module skeleton

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/common/prisma/soft-delete.extension.ts:15-19`
- Create: `prisma/migrations/20260611040000_add_tax_codes/migration.sql`
- Create: `src/tax/tax.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Add the `TaxKind` enum and `TaxCode` model to the schema**

Append to `prisma/schema.prisma` (after the existing enums/models; enum near the other enums, model after `Account`):

```prisma
enum TaxKind {
  PPN_OUTPUT
  PPN_INPUT
  PPH_PAYABLE
  PPH_PREPAID
}

model TaxCode {
  id           String    @id @default(uuid())
  code         String
  name         String
  kind         TaxKind
  rate         Decimal   @db.Decimal(9, 6)
  taxAccountId String    @map("tax_account_id")
  isActive     Boolean   @default(true) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")
  deletedAt    DateTime? @map("deleted_at")
  deletedBy    String?   @map("deleted_by")

  @@unique([code], name: "tax_codes_code_unique")
  @@index([deletedAt])
  @@map("tax_codes")
}
```

- [ ] **Step 2: Register `TaxCode` for soft delete**

In `src/common/prisma/soft-delete.extension.ts`, add `'TaxCode'` to the set:

```typescript
export const SOFT_DELETE_MODELS = new Set<Prisma.ModelName>([
  'User',
  'Account',
  'JournalEntry',
  'TaxCode',
]);
```

- [ ] **Step 3: Hand-author the migration**

Create `prisma/migrations/20260611040000_add_tax_codes/migration.sql` with exactly:

```sql
-- CreateEnum
CREATE TYPE "TaxKind" AS ENUM ('PPN_OUTPUT', 'PPN_INPUT', 'PPH_PAYABLE', 'PPH_PREPAID');

-- CreateTable
CREATE TABLE "tax_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TaxKind" NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "tax_account_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "tax_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_codes_code_key" ON "tax_codes"("code");

-- CreateIndex
CREATE INDEX "tax_codes_deleted_at_idx" ON "tax_codes"("deleted_at");
```

- [ ] **Step 4: Apply the migration and regenerate the client**

Run:
```bash
docker compose up -d db
npx prisma migrate deploy
npx prisma generate
```
Expected: `migrate deploy` prints the new migration applied; `generate` succeeds. Then `npx prisma migrate status` → "Database schema is up to date!" (no drift — the hand-authored SQL matches the model).

- [ ] **Step 5: Create the (empty) TaxModule**

Create `src/tax/tax.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  providers: [],
  controllers: [],
  exports: [],
})
export class TaxModule {}
```

- [ ] **Step 6: Wire TaxModule into AppModule**

In `src/app.module.ts`, add the import and register it after `LedgerModule`:

```typescript
import { TaxModule } from './tax/tax.module';
```
and add `TaxModule` to the `imports` array (after `LedgerModule`).

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: clean (the generated client now includes `TaxCode`/`TaxKind`; the empty module compiles).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/common/prisma/soft-delete.extension.ts src/tax/tax.module.ts src/app.module.ts
git commit -m "feat(tax): TaxCode model, migration, module skeleton"
```

---

## Task 2: TaxCodesService — CRUD, validation, seed, endpoints

**Files:**
- Create: `src/tax/tax-codes.seed.ts`
- Create: `src/tax/tax-codes.service.ts`
- Create: `src/tax/dto/create-tax-code.dto.ts`
- Create: `src/tax/dto/update-tax-code.dto.ts`
- Create: `src/tax/tax-codes.controller.ts`
- Modify: `src/tax/tax.module.ts`
- Test: `test/tax-codes.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `test/tax-codes.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('TaxCodes (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let adminToken: string;
  let ppnKeluaranId: string; // 2-1100, CREDIT-normal
  let kasId: string; // 1-1000, DEBIT-normal (wrong side for PPN_OUTPUT)

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

    await app.get(AccountsService).seedIfEmpty();
    await app.get(UsersService).create({
      email: 'admin@tax.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    adminToken = (await app.get(AuthService).login('admin@tax.test', 'secret123'))
      .accessToken;
    const accounts = await app.get(AccountsService).list();
    ppnKeluaranId = accounts.find((a) => a.code === '2-1100')!.id;
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('seeds the 6 standard tax codes on boot (idempotent)', async () => {
    // onModuleInit seeded; re-running seedIfEmpty keeps it at 6.
    await app.get(TaxCodesService).seedIfEmpty();
    const res = await request(app.getHttpServer() as App)
      .get('/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const codes = res.body as { code: string }[];
    expect(codes).toHaveLength(6);
    expect(codes.map((c) => c.code).sort()).toEqual([
      'PPH23-PAY',
      'PPH23-PRE',
      'PPH42-PAY',
      'PPH42-PRE',
      'PPN-IN-11',
      'PPN-OUT-11',
    ]);
  });

  it('creates a tax code with a matching-normal-balance account (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'PPN-OUT-12',
        name: 'PPN Keluaran 12%',
        kind: 'PPN_OUTPUT',
        rate: '0.12',
        taxAccountId: ppnKeluaranId,
      })
      .expect(201);
    expect((res.body as { kind: string }).kind).toBe('PPN_OUTPUT');
  });

  it('rejects a PPN_OUTPUT code pointed at a DEBIT-normal account (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'BAD-SIDE',
        name: 'Wrong side',
        kind: 'PPN_OUTPUT',
        rate: '0.11',
        taxAccountId: kasId,
      })
      .expect(422);
  });

  it('rejects a rate outside (0,1) (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'BAD-RATE',
        name: 'Bad rate',
        kind: 'PPN_OUTPUT',
        rate: '1.5',
        taxAccountId: ppnKeluaranId,
      })
      .expect(422);
  });

  it('soft-deletes a tax code (204) then it disappears from the list', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'TEMP-DEL',
        name: 'Temp',
        kind: 'PPN_OUTPUT',
        rate: '0.05',
        taxAccountId: ppnKeluaranId,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .delete(`/tax/codes/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    const list = await request(app.getHttpServer() as App)
      .get('/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((list.body as { id: string }[]).some((c) => c.id === id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- tax-codes`
Expected: FAIL (no `/tax/codes` routes; `TaxCodesService` doesn't exist).

- [ ] **Step 3: Write the seed definitions**

Create `src/tax/tax-codes.seed.ts`:

```typescript
import { TaxKind } from '@prisma/client';

export interface SeedTaxCode {
  code: string;
  name: string;
  kind: TaxKind;
  rate: string; // decimal fraction
  accountCode: string; // resolved to an account id at seed time
}

/** Common Indonesian tax codes. Editable via CRUD; seeded only when the table is empty. */
export const TAX_CODE_SEED: SeedTaxCode[] = [
  { code: 'PPN-OUT-11', name: 'PPN Keluaran 11%', kind: 'PPN_OUTPUT', rate: '0.11', accountCode: '2-1100' },
  { code: 'PPN-IN-11', name: 'PPN Masukan 11%', kind: 'PPN_INPUT', rate: '0.11', accountCode: '1-1400' },
  { code: 'PPH23-PAY', name: 'PPh 23 Jasa 2% (dipotong)', kind: 'PPH_PAYABLE', rate: '0.02', accountCode: '2-1200' },
  { code: 'PPH23-PRE', name: 'PPh 23 Jasa 2% (dipungut)', kind: 'PPH_PREPAID', rate: '0.02', accountCode: '1-1500' },
  { code: 'PPH42-PAY', name: 'PPh 4(2) Sewa 10% (dipotong)', kind: 'PPH_PAYABLE', rate: '0.10', accountCode: '2-1200' },
  { code: 'PPH42-PRE', name: 'PPh 4(2) Sewa 10% (dipungut)', kind: 'PPH_PREPAID', rate: '0.10', accountCode: '1-1500' },
];
```

- [ ] **Step 4: Write the TaxCodesService**

Create `src/tax/tax-codes.service.ts`:

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, TaxCode, TaxKind } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountsService } from '../ledger/accounts/accounts.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { TAX_CODE_SEED } from './tax-codes.seed';

export interface CreateTaxCodeInput {
  code: string;
  name: string;
  kind: TaxKind;
  rate: string;
  taxAccountId: string;
}

export interface UpdateTaxCodeInput {
  name?: string;
  rate?: string;
  isActive?: boolean;
}

@Injectable()
export class TaxCodesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  /** PPN_INPUT/PPH_PREPAID post as debits (assets); the rest as credits (liabilities). */
  private requiredNormalBalance(kind: TaxKind): 'DEBIT' | 'CREDIT' {
    return kind === 'PPN_INPUT' || kind === 'PPH_PREPAID' ? 'DEBIT' : 'CREDIT';
  }

  private validateRate(rate: string): void {
    const r = Number(rate);
    if (!(r > 0 && r < 1)) {
      throw new ValidationFailedError(
        'Rate must be greater than 0 and less than 1',
        { rate },
      );
    }
  }

  private async validateAccountForKind(
    taxAccountId: string,
    kind: TaxKind,
  ): Promise<void> {
    const account = await this.accounts.findById(taxAccountId); // 404 if missing
    if (!account.isPostable) {
      throw new ValidationFailedError('Tax account must be postable', {
        taxAccountId,
      });
    }
    const required = this.requiredNormalBalance(kind);
    if (account.normalBalance !== required) {
      throw new ValidationFailedError(
        `Tax kind ${kind} requires a ${required}-normal account`,
        { taxAccountId, kind, normalBalance: account.normalBalance },
      );
    }
  }

  async create(input: CreateTaxCodeInput): Promise<TaxCode> {
    this.validateRate(input.rate);
    await this.validateAccountForKind(input.taxAccountId, input.kind);
    const existing = await this.prisma.client.taxCode.findFirst({
      where: { code: input.code },
    });
    if (existing) {
      throw new ConflictDomainError('Tax code already exists', {
        code: input.code,
      });
    }
    return this.prisma.client.taxCode.create({
      data: {
        code: input.code,
        name: input.name,
        kind: input.kind,
        rate: input.rate,
        taxAccountId: input.taxAccountId,
      },
    });
  }

  async list(): Promise<TaxCode[]> {
    return this.prisma.client.taxCode.findMany({ orderBy: { code: 'asc' } });
  }

  async findById(id: string): Promise<TaxCode> {
    const code = await this.prisma.client.taxCode.findFirst({ where: { id } });
    if (!code) throw new NotFoundDomainError('Tax code not found', { id });
    return code;
  }

  async update(id: string, input: UpdateTaxCodeInput): Promise<TaxCode> {
    await this.findById(id);
    if (input.rate !== undefined) this.validateRate(input.rate);
    return this.prisma.client.taxCode.update({
      where: { id },
      data: { name: input.name, rate: input.rate, isActive: input.isActive },
    });
  }

  async deactivate(id: string): Promise<TaxCode> {
    await this.findById(id);
    return this.prisma.client.taxCode.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const code = await this.findById(id);
    // Tombstone the unique `code` so the same code can be reused later.
    await this.prisma.client.taxCode.update({
      where: { id },
      data: {
        code: `${code.code}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
  }

  async seedIfEmpty(): Promise<void> {
    const count = await this.prisma.client.taxCode.count();
    if (count > 0) return;
    const accounts = await this.accounts.list();
    const idByCode = new Map(accounts.map((a) => [a.code, a.id]));
    try {
      await this.prisma.client.$transaction(async (tx) => {
        for (const s of TAX_CODE_SEED) {
          const taxAccountId = idByCode.get(s.accountCode);
          if (!taxAccountId) {
            throw new Error(
              `Seed: account ${s.accountCode} not found for tax code ${s.code}`,
            );
          }
          await tx.taxCode.create({
            data: {
              code: s.code,
              name: s.name,
              kind: s.kind,
              rate: s.rate,
              taxAccountId,
            },
          });
        }
      });
    } catch (err) {
      // Another instance seeded first (whole tx rolled back); codes exist.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }
}
```

- [ ] **Step 5: Write the DTOs**

Create `src/tax/dto/create-tax-code.dto.ts`:

```typescript
import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';
import { IsUUID } from 'class-validator';
import { TaxKind } from '@prisma/client';

export class CreateTaxCodeDto {
  @IsString() @MaxLength(32) code!: string;
  @IsString() @MaxLength(128) name!: string;
  @IsEnum(TaxKind) kind!: TaxKind;
  // A decimal fraction in [0,1): "0", "0.11", "0.020000". Service rejects 0 and >=1.
  @Matches(/^0(\.\d{1,6})?$/, {
    message: 'rate must be a decimal fraction like 0.11',
  })
  rate!: string;
  @IsUUID() taxAccountId!: string;
}
```

Create `src/tax/dto/update-tax-code.dto.ts`:

```typescript
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateTaxCodeDto {
  @IsOptional() @IsString() @MaxLength(128) name?: string;
  @IsOptional()
  @Matches(/^0(\.\d{1,6})?$/, {
    message: 'rate must be a decimal fraction like 0.11',
  })
  rate?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
```

- [ ] **Step 6: Write the TaxCodesController**

Create `src/tax/tax-codes.controller.ts`:

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
import { TaxCode } from '@prisma/client';
import { TaxCodesService } from './tax-codes.service';
import { CreateTaxCodeDto } from './dto/create-tax-code.dto';
import { UpdateTaxCodeDto } from './dto/update-tax-code.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@Controller('tax/codes')
export class TaxCodesController {
  constructor(private readonly taxCodes: TaxCodesService) {}

  @Get()
  list(): Promise<TaxCode[]> {
    return this.taxCodes.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<TaxCode> {
    return this.taxCodes.findById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  create(@Body() dto: CreateTaxCodeDto): Promise<TaxCode> {
    return this.taxCodes.create(dto);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTaxCodeDto,
  ): Promise<TaxCode> {
    return this.taxCodes.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id') id: string): Promise<TaxCode> {
    return this.taxCodes.deactivate(id);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.taxCodes.softDelete(id, user.id);
  }
}
```

- [ ] **Step 7: Register the service + controller in TaxModule**

Update `src/tax/tax.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxCodesService } from './tax-codes.service';
import { TaxCodesController } from './tax-codes.controller';

@Module({
  imports: [LedgerModule],
  providers: [TaxCodesService],
  controllers: [TaxCodesController],
  exports: [TaxCodesService],
})
export class TaxModule {}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run test:e2e -- tax-codes`
Expected: PASS (5 cases). Also run `npm run lint` → clean.

- [ ] **Step 9: Commit**

```bash
git add src/tax test/tax-codes.e2e-spec.ts
git commit -m "feat(tax): tax-code CRUD, validation, idempotent seed, endpoints"
```

---

## Task 3: TaxService.calculate — engine + preview endpoint

**Files:**
- Create: `src/tax/tax.service.ts`
- Create: `src/tax/dto/calculate-tax.dto.ts`
- Create: `src/tax/tax.controller.ts`
- Modify: `src/tax/tax.module.ts`
- Test: `test/tax-calculate.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `test/tax-calculate.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { TaxService } from '../src/tax/tax.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Tax calculate (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;
  let acc: Record<string, string>; // code -> id
  let code: Record<string, string>; // tax code -> id

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

    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(UsersService).create({
      email: 'v@tax.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@tax.test', 'secret123'))
      .accessToken;

    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const codes = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const findLine = (
    lines: { accountId: string; debit?: string; credit?: string }[],
    accountId: string,
  ) => lines.find((l) => l.accountId === accountId)!;

  it('purchase: DPP 1,000,000 + PPN Masukan 11% + PPh 23 payable 2% → balanced', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'], // Utang Usaha (AP)
        lines: [
          {
            accountId: acc['5-2000'], // an expense account
            amount: '1000000',
            taxCodeIds: [code['PPN-IN-11'], code['PPH23-PAY']],
          },
        ],
      })
      .expect(200);
    const body = res.body as {
      subtotal: string;
      settlementAmount: string;
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
    expect(body.subtotal).toBe('1000000.0000');
    expect(body.settlementAmount).toBe('1090000.0000'); // 1,000,000 + 110,000 − 20,000
    const ppn = findLine(body.journalLines, acc['1-1400']);
    expect(ppn.debit).toBe('110000.0000');
    const pph = findLine(body.journalLines, acc['2-1200']);
    expect(pph.credit).toBe('20000.0000');
    const ap = findLine(body.journalLines, acc['2-1000']);
    expect(ap.credit).toBe('1090000.0000');
    const totalDebit = body.journalLines.reduce(
      (s, l) => s + Number(l.debit ?? 0),
      0,
    );
    const totalCredit = body.journalLines.reduce(
      (s, l) => s + Number(l.credit ?? 0),
      0,
    );
    expect(totalDebit).toBe(totalCredit);
  });

  it('sale: DPP 1,000,000 + PPN Keluaran 11% + customer withholds PPh 23 2% → balanced', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'], // Piutang Usaha (AR)
        lines: [
          {
            accountId: acc['4-1000'], // a revenue account
            amount: '1000000',
            taxCodeIds: [code['PPN-OUT-11'], code['PPH23-PRE']],
          },
        ],
      })
      .expect(200);
    const body = res.body as {
      settlementAmount: string;
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
    expect(body.settlementAmount).toBe('1090000.0000');
    const ar = findLine(body.journalLines, acc['1-1200']);
    expect(ar.debit).toBe('1090000.0000');
    const ppnOut = findLine(body.journalLines, acc['2-1100']);
    expect(ppnOut.credit).toBe('110000.0000');
    const prepaid = findLine(body.journalLines, acc['1-1500']);
    expect(prepaid.debit).toBe('20000.0000');
  });

  it('rejects a PPN_INPUT code on a SALE (422 kind-vs-nature)', async () => {
    await request(app.getHttpServer() as App)
      .post('/tax/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [
          { accountId: acc['4-1000'], amount: '500000', taxCodeIds: [code['PPN-IN-11']] },
        ],
      })
      .expect(422);
  });

  it('always balances for random valid purchase transactions (property test)', async () => {
    const tax = app.get(TaxService);
    for (let i = 0; i < 50; i++) {
      const nLines = 1 + (i % 4);
      const lines = Array.from({ length: nLines }, (_, j) => ({
        accountId: acc['5-2000'],
        amount: String(1000 + ((i * 37 + j * 911) % 9_000_000)),
        taxCodeIds:
          (i + j) % 2 === 0
            ? [code['PPN-IN-11'], code['PPH23-PAY']]
            : [code['PPN-IN-11']],
      }));
      const result = await tax.calculate({
        nature: 'PURCHASE',
        settlementAccountId: acc['2-1000'],
        lines,
      });
      const debit = result.journalLines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
      const credit = result.journalLines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
      expect(debit).toBeCloseTo(credit, 4);
    }
  });
});
```

Note: the account codes used are verified to exist as postable leaves in `src/ledger/accounts/chart-of-accounts.seed.ts` — `2-1000` Utang Usaha (AP), `1-1200` Piutang Usaha (AR), `4-1000` Pendapatan Penjualan (revenue base), `5-2000` Beban Gaji (expense base), plus the tax accounts `1-1400`/`1-1500`/`2-1100`/`2-1200`. The settlement and base accounts only need to exist; `TaxService` does not validate them (it passes them through — `PostingService` validates at post time in Phase 4).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- tax-calculate`
Expected: FAIL (no `/tax/calculate` route; `TaxService` doesn't exist).

- [ ] **Step 3: Write the TaxService**

Create `src/tax/tax.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { TaxKind } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { ValidationFailedError } from '../common/errors/domain-errors';

export type TaxNature = 'SALE' | 'PURCHASE';

export interface TaxableLineInput {
  accountId: string;
  amount: string; // DPP, tax-exclusive
  taxCodeIds: string[];
}

export interface TaxableTransaction {
  nature: TaxNature;
  settlementAccountId: string;
  lines: TaxableLineInput[];
}

export interface TaxBreakdownRow {
  taxCodeId: string;
  code: string;
  kind: TaxKind;
  base: string;
  amount: string;
  accountId: string;
}

export interface CalculatedLine {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string;
}

export interface TaxCalculation {
  subtotal: string;
  taxes: TaxBreakdownRow[];
  settlementAmount: string;
  journalLines: CalculatedLine[];
}

const ALLOWED_KINDS: Record<TaxNature, TaxKind[]> = {
  SALE: ['PPN_OUTPUT', 'PPH_PREPAID'],
  PURCHASE: ['PPN_INPUT', 'PPH_PAYABLE'],
};

@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(input: TaxableTransaction): Promise<TaxCalculation> {
    if (input.lines.length === 0) {
      throw new ValidationFailedError(
        'A taxable transaction needs at least one line',
      );
    }

    // 1. Load + validate the referenced tax codes.
    const ids = [...new Set(input.lines.flatMap((l) => l.taxCodeIds))];
    const codes = await this.prisma.client.taxCode.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(codes.map((c) => [c.id, c]));
    for (const id of ids) {
      const c = byId.get(id);
      if (!c) throw new ValidationFailedError('Unknown tax code', { taxCodeId: id });
      if (!c.isActive) {
        throw new ValidationFailedError('Tax code is inactive', { taxCodeId: id });
      }
    }

    // 2. kind-vs-nature.
    const allowed = ALLOWED_KINDS[input.nature];
    for (const c of byId.values()) {
      if (!allowed.includes(c.kind)) {
        throw new ValidationFailedError(
          `Tax kind ${c.kind} is not allowed for a ${input.nature}`,
          { taxCodeId: c.id, kind: c.kind, nature: input.nature },
        );
      }
    }

    // 3. subtotal.
    const subtotal = Money.sum(input.lines.map((l) => Money.of(l.amount)));

    // 4. aggregate base per tax code, round the tax once.
    const baseByCode = new Map<string, Money>();
    for (const line of input.lines) {
      for (const id of line.taxCodeIds) {
        baseByCode.set(
          id,
          (baseByCode.get(id) ?? Money.zero()).add(Money.of(line.amount)),
        );
      }
    }
    const taxes: TaxBreakdownRow[] = [...baseByCode.entries()]
      .map(([id, base]) => {
        const c = byId.get(id)!;
        const amount = base.multiply(c.rate).roundToRupiah();
        return {
          taxCodeId: id,
          code: c.code,
          kind: c.kind,
          base: base.toPersistence(),
          amount: amount.toPersistence(),
          accountId: c.taxAccountId,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code)); // deterministic output

    // 5. assemble journal lines.
    const journalLines: CalculatedLine[] = [];
    for (const line of input.lines) {
      const amt = Money.of(line.amount).toPersistence();
      journalLines.push(
        input.nature === 'SALE'
          ? { accountId: line.accountId, credit: amt }
          : { accountId: line.accountId, debit: amt },
      );
    }
    let ppnTotal = Money.zero(); // added to settlement
    let pphTotal = Money.zero(); // withheld from settlement
    for (const t of taxes) {
      const isDebit = t.kind === 'PPN_INPUT' || t.kind === 'PPH_PREPAID';
      journalLines.push(
        isDebit
          ? { accountId: t.accountId, debit: t.amount }
          : { accountId: t.accountId, credit: t.amount },
      );
      const amt = Money.of(t.amount);
      if (t.kind === 'PPN_OUTPUT' || t.kind === 'PPN_INPUT') {
        ppnTotal = ppnTotal.add(amt);
      } else {
        pphTotal = pphTotal.add(amt);
      }
    }
    const settlement = subtotal.add(ppnTotal).subtract(pphTotal);
    journalLines.push(
      input.nature === 'SALE'
        ? { accountId: input.settlementAccountId, debit: settlement.toPersistence() }
        : { accountId: input.settlementAccountId, credit: settlement.toPersistence() },
    );

    // 6. safety net: must balance by construction.
    const totalDebit = Money.sum(
      journalLines.map((l) => Money.of(l.debit ?? '0')),
    );
    const totalCredit = Money.sum(
      journalLines.map((l) => Money.of(l.credit ?? '0')),
    );
    if (!totalDebit.equals(totalCredit)) {
      throw new Error(
        `Tax calculation did not balance: ${totalDebit.toString()} != ${totalCredit.toString()}`,
      );
    }

    return {
      subtotal: subtotal.toPersistence(),
      taxes,
      settlementAmount: settlement.toPersistence(),
      journalLines,
    };
  }
}
```

- [ ] **Step 4: Write the calculate DTO**

Create `src/tax/dto/calculate-tax.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsMoneyString } from '../../common/validators/is-money-string';
import { TaxNature } from '../tax.service';

export class TaxableLineDto {
  @IsUUID() accountId!: string;
  @IsMoneyString() amount!: string;
  @IsArray() @IsUUID('all', { each: true }) taxCodeIds!: string[];
}

export class CalculateTaxDto {
  @IsIn(['SALE', 'PURCHASE']) nature!: TaxNature;
  @IsUUID() settlementAccountId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines!: TaxableLineDto[];
}
```

Note: `@IsUUID('all', { each: true })` on an empty array passes (a tax-free line has `taxCodeIds: []`).

- [ ] **Step 5: Write the TaxController**

Create `src/tax/tax.controller.ts`:

```typescript
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { TaxService, TaxCalculation } from './tax.service';
import { CalculateTaxDto } from './dto/calculate-tax.dto';

@Controller('tax')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Post('calculate')
  @HttpCode(200)
  calculate(@Body() dto: CalculateTaxDto): Promise<TaxCalculation> {
    return this.tax.calculate(dto);
  }
}
```

- [ ] **Step 6: Register TaxService + TaxController in TaxModule**

Update `src/tax/tax.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxCodesService } from './tax-codes.service';
import { TaxCodesController } from './tax-codes.controller';
import { TaxService } from './tax.service';
import { TaxController } from './tax.controller';

@Module({
  imports: [LedgerModule],
  providers: [TaxCodesService, TaxService],
  controllers: [TaxCodesController, TaxController],
  exports: [TaxCodesService, TaxService],
})
export class TaxModule {}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test:e2e -- tax-calculate`
Expected: PASS (4 cases incl. the property test). Then `npm run lint` → clean.

- [ ] **Step 8: Full verification**

Run, expecting all green:
```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

- [ ] **Step 9: Commit**

```bash
git add src/tax test/tax-calculate.e2e-spec.ts
git commit -m "feat(tax): calculate engine (PPN/PPh, settlement plug) + /tax/calculate"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §2 module layout → Task 1 (module skeleton, imports LedgerModule, no PostingService) ✓
- §3 data model (`tax_codes`, `TaxKind`, rate NUMERIC(9,6), soft-delete, tombstone) → Task 1 (schema/migration/soft-delete) + Task 2 (tombstone in `softDelete`) ✓
- §4 calculate (input/output types, 6-step algorithm, kind-vs-nature, per-code rounding, settlement plug, balance assertion, worked examples) → Task 3 ✓
- §5 seed (6 codes, idempotent, account-code resolution) → Task 2 ✓
- §6 API (CRUD roles, kind-vs-normal-balance + postable + rate validation, `/tax/calculate` all-auth 200) → Task 2 + Task 3 ✓
- §7 testing (CRUD, seed idempotency, wrong-side 422, kind-vs-nature 422, worked sale+purchase, balance property test) → Tasks 2 & 3 ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `TaxKind` (Prisma enum) used consistently; `CreateTaxCodeInput`/`UpdateTaxCodeInput` match the DTOs; `TaxableTransaction`/`TaxCalculation`/`CalculatedLine` defined in `tax.service.ts` and imported by the DTO + controller; `Money` methods (`of`, `sum`, `zero`, `add`, `subtract`, `multiply`, `roundToRupiah`, `equals`, `toPersistence`, `toString`) all exist in the codebase; `accounts.findById`/`list` and `account.normalBalance`/`isPostable` match the real `AccountsService`/`Account` model; `prisma.client.taxCode` matches the soft-delete-extended client convention.
