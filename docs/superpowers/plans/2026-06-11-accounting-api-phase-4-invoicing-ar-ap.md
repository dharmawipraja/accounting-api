# Accounting API — Phase 4: Invoicing & AR/AP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the AR/AP subsystem — business partners, sales invoices, purchase bills, and payments with explicit full allocation — posting through `TaxService.calculate` → `PostingService` and reconciling per-partner outstanding to the AR/AP control accounts.

**Architecture:** A new `InvoicingModule` (`src/invoicing/`) imports `LedgerModule` (PostingService, AccountsService, CompanyService) and `TaxModule` (TaxService). Documents have a DRAFT→POSTED→VOID lifecycle; posting is atomic — the document number, its journal entry, and its status transition commit in one transaction via additive, transaction-composable `PostingService` methods.

**Tech Stack:** NestJS 11, Prisma 7 (driver-adapter), PostgreSQL, `Money` (roundToRupiah), class-validator DTOs, soft-delete extension (`prisma.client.<model>`), testcontainers e2e harness.

**Spec:** `docs/superpowers/specs/2026-06-11-accounting-api-phase-4-invoicing-ar-ap-design.md`

**Prisma 7 reminder:** `prisma migrate dev` needs a TTY and fails here — hand-author the migration SQL + `npx prisma migrate deploy` + `npx prisma generate`. DB up: `docker compose up -d db`. Never run `prisma format`.

---

## File structure

- `prisma/schema.prisma` — add enums + 7 models.
- `prisma/migrations/20260611050000_add_invoicing/migration.sql` — hand-authored.
- `src/common/prisma/soft-delete.extension.ts` — register 4 soft-delete models.
- `src/ledger/posting/posting.service.ts` — additive `preparePosting`/`createPostedEntryInTx`/`prepareReversal`/`reverseInTx`; existing methods become wrappers. Export `LedgerTx`.
- `src/invoicing/invoicing.module.ts` — module.
- `src/invoicing/document-number.service.ts` — gapless per-(type, fiscal-year) numbering.
- `src/invoicing/document-posting.service.ts` — shared "post a taxed document" helper (Task 3).
- `src/invoicing/business-partners.service.ts` + `.controller.ts` + `dto/`.
- `src/invoicing/sales-invoices.service.ts` + `.controller.ts` + `dto/`.
- `src/invoicing/purchase-bills.service.ts` + `.controller.ts` + `dto/`.
- `src/invoicing/payments.service.ts` + `.controller.ts` + `dto/`.
- `src/app.module.ts` — register `InvoicingModule`.
- `test/*.e2e-spec.ts` — partners, sales-invoices, purchase-bills, payments.

Tests are e2e (testcontainers), matching how Phase 2/3 tested DB-backed services.

---

## Task 1: Schema, migration, PostingService refactor, numbering, module skeleton

**Files:** `prisma/schema.prisma`, `prisma/migrations/20260611050000_add_invoicing/migration.sql`, `src/common/prisma/soft-delete.extension.ts`, `src/ledger/posting/posting.service.ts`, `src/invoicing/invoicing.module.ts`, `src/invoicing/document-number.service.ts`, `src/app.module.ts`

- [ ] **Step 1: Add enums + models to `prisma/schema.prisma`**

Extend the existing `JournalSourceType` enum (add three values) and add the new enums + models:

```prisma
enum DocumentStatus {
  DRAFT
  POSTED
  VOID
}

enum PaymentDirection {
  RECEIPT
  DISBURSEMENT
}
```

Add `SALES_INVOICE`, `PURCHASE_BILL`, `PAYMENT` to `enum JournalSourceType { ... }` (keep the existing MANUAL/REVERSAL/OPENING).

```prisma
model BusinessPartner {
  id         String    @id @default(uuid())
  code       String
  name       String
  npwp       String?
  email      String?
  phone      String?
  address    String?
  isCustomer Boolean   @default(false) @map("is_customer")
  isVendor   Boolean   @default(false) @map("is_vendor")
  isActive   Boolean   @default(true) @map("is_active")
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")
  deletedAt  DateTime? @map("deleted_at")
  deletedBy  String?   @map("deleted_by")

  @@unique([code], name: "business_partners_code_unique")
  @@index([deletedAt])
  @@map("business_partners")
}

model SalesInvoice {
  id              String             @id @default(uuid())
  invoiceNumber   Int?               @map("invoice_number")
  invoiceRef      String?            @map("invoice_ref")
  fiscalYear      Int?               @map("fiscal_year")
  partnerId       String             @map("partner_id")
  date            DateTime           @db.Date
  dueDate         DateTime?          @map("due_date") @db.Date
  description     String?
  status          DocumentStatus     @default(DRAFT)
  subtotal        Decimal            @default(0) @db.Decimal(20, 4)
  taxTotal        Decimal            @default(0) @map("tax_total") @db.Decimal(20, 4)
  withholdingTotal Decimal           @default(0) @map("withholding_total") @db.Decimal(20, 4)
  total           Decimal            @default(0) @db.Decimal(20, 4)
  amountPaid      Decimal            @default(0) @map("amount_paid") @db.Decimal(20, 4)
  journalEntryId  String?            @map("journal_entry_id")
  createdBy       String             @map("created_by")
  postedBy        String?            @map("posted_by")
  postedAt        DateTime?          @map("posted_at")
  createdAt       DateTime           @default(now()) @map("created_at")
  updatedAt       DateTime           @updatedAt @map("updated_at")
  deletedAt       DateTime?          @map("deleted_at")
  deletedBy       String?            @map("deleted_by")
  lines           SalesInvoiceLine[]

  @@unique([fiscalYear, invoiceNumber], name: "sales_invoices_fy_number_unique")
  @@index([deletedAt])
  @@index([partnerId])
  @@map("sales_invoices")
}

model SalesInvoiceLine {
  id             String       @id @default(uuid())
  salesInvoiceId String       @map("sales_invoice_id")
  invoice        SalesInvoice @relation(fields: [salesInvoiceId], references: [id], onDelete: Cascade)
  lineNo         Int          @map("line_no")
  description    String
  accountId      String       @map("account_id")
  quantity       Decimal      @db.Decimal(20, 4)
  unitPrice      Decimal      @map("unit_price") @db.Decimal(20, 4)
  amount         Decimal      @db.Decimal(20, 4)
  taxCodeIds     String[]     @map("tax_code_ids")

  @@unique([salesInvoiceId, lineNo])
  @@map("sales_invoice_lines")
}

model PurchaseBill {
  id              String             @id @default(uuid())
  billNumber      Int?               @map("bill_number")
  billRef         String?            @map("bill_ref")
  fiscalYear      Int?               @map("fiscal_year")
  partnerId       String             @map("partner_id")
  vendorInvoiceNo String?            @map("vendor_invoice_no")
  date            DateTime           @db.Date
  dueDate         DateTime?          @map("due_date") @db.Date
  description     String?
  status          DocumentStatus     @default(DRAFT)
  subtotal        Decimal            @default(0) @db.Decimal(20, 4)
  taxTotal        Decimal            @default(0) @map("tax_total") @db.Decimal(20, 4)
  withholdingTotal Decimal           @default(0) @map("withholding_total") @db.Decimal(20, 4)
  total           Decimal            @default(0) @db.Decimal(20, 4)
  amountPaid      Decimal            @default(0) @map("amount_paid") @db.Decimal(20, 4)
  journalEntryId  String?            @map("journal_entry_id")
  createdBy       String             @map("created_by")
  postedBy        String?            @map("posted_by")
  postedAt        DateTime?          @map("posted_at")
  createdAt       DateTime           @default(now()) @map("created_at")
  updatedAt       DateTime           @updatedAt @map("updated_at")
  deletedAt       DateTime?          @map("deleted_at")
  deletedBy       String?            @map("deleted_by")
  lines           PurchaseBillLine[]

  @@unique([fiscalYear, billNumber], name: "purchase_bills_fy_number_unique")
  @@index([deletedAt])
  @@index([partnerId])
  @@map("purchase_bills")
}

model PurchaseBillLine {
  id            String       @id @default(uuid())
  purchaseBillId String      @map("purchase_bill_id")
  bill          PurchaseBill @relation(fields: [purchaseBillId], references: [id], onDelete: Cascade)
  lineNo        Int          @map("line_no")
  description   String
  accountId     String       @map("account_id")
  quantity      Decimal      @db.Decimal(20, 4)
  unitPrice     Decimal      @map("unit_price") @db.Decimal(20, 4)
  amount        Decimal      @db.Decimal(20, 4)
  taxCodeIds    String[]     @map("tax_code_ids")

  @@unique([purchaseBillId, lineNo])
  @@map("purchase_bill_lines")
}

model Payment {
  id             String              @id @default(uuid())
  number         Int?
  ref            String?
  fiscalYear     Int?                @map("fiscal_year")
  direction      PaymentDirection
  partnerId      String              @map("partner_id")
  date           DateTime            @db.Date
  cashAccountId  String              @map("cash_account_id")
  amount         Decimal             @db.Decimal(20, 4)
  description    String?
  status         DocumentStatus      @default(DRAFT)
  journalEntryId String?             @map("journal_entry_id")
  createdBy      String              @map("created_by")
  postedBy       String?             @map("posted_by")
  postedAt       DateTime?           @map("posted_at")
  createdAt      DateTime            @default(now()) @map("created_at")
  updatedAt      DateTime            @updatedAt @map("updated_at")
  deletedAt      DateTime?           @map("deleted_at")
  deletedBy      String?             @map("deleted_by")
  allocations    PaymentAllocation[]

  @@unique([fiscalYear, number], name: "payments_fy_number_unique")
  @@index([deletedAt])
  @@index([partnerId])
  @@map("payments")
}

model PaymentAllocation {
  id             String   @id @default(uuid())
  paymentId      String   @map("payment_id")
  payment        Payment  @relation(fields: [paymentId], references: [id], onDelete: Cascade)
  salesInvoiceId String?  @map("sales_invoice_id")
  purchaseBillId String?  @map("purchase_bill_id")
  amount         Decimal  @db.Decimal(20, 4)

  @@index([salesInvoiceId])
  @@index([purchaseBillId])
  @@map("payment_allocations")
}

model DocumentSequence {
  documentType String   @map("document_type")
  fiscalYear   Int      @map("fiscal_year")
  nextNumber   Int      @default(1) @map("next_number")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@id([documentType, fiscalYear])
  @@map("document_sequences")
}
```

- [ ] **Step 2: Register the 4 soft-delete models**

In `src/common/prisma/soft-delete.extension.ts`, add to `SOFT_DELETE_MODELS`: `'BusinessPartner'`, `'SalesInvoice'`, `'PurchaseBill'`, `'Payment'` (keep the existing entries). (Lines/allocations are not independently soft-deleted; they cascade with their parent and are only touched while the parent is DRAFT.)

- [ ] **Step 3: Hand-author the migration**

Create `prisma/migrations/20260611050000_add_invoicing/migration.sql`:

```sql
-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'SALES_INVOICE';
ALTER TYPE "JournalSourceType" ADD VALUE 'PURCHASE_BILL';
ALTER TYPE "JournalSourceType" ADD VALUE 'PAYMENT';

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'POSTED', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('RECEIPT', 'DISBURSEMENT');

-- CreateTable
CREATE TABLE "business_partners" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "npwp" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "is_customer" BOOLEAN NOT NULL DEFAULT false,
    "is_vendor" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    CONSTRAINT "business_partners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_invoices" (
    "id" TEXT NOT NULL,
    "invoice_number" INTEGER,
    "invoice_ref" TEXT,
    "fiscal_year" INTEGER,
    "partner_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "due_date" DATE,
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "withholding_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "created_by" TEXT NOT NULL,
    "posted_by" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_invoice_lines" (
    "id" TEXT NOT NULL,
    "sales_invoice_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "tax_code_ids" TEXT[],
    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_bills" (
    "id" TEXT NOT NULL,
    "bill_number" INTEGER,
    "bill_ref" TEXT,
    "fiscal_year" INTEGER,
    "partner_id" TEXT NOT NULL,
    "vendor_invoice_no" TEXT,
    "date" DATE NOT NULL,
    "due_date" DATE,
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "withholding_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "created_by" TEXT NOT NULL,
    "posted_by" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    CONSTRAINT "purchase_bills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_bill_lines" (
    "id" TEXT NOT NULL,
    "purchase_bill_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "tax_code_ids" TEXT[],
    CONSTRAINT "purchase_bill_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "number" INTEGER,
    "ref" TEXT,
    "fiscal_year" INTEGER,
    "direction" "PaymentDirection" NOT NULL,
    "partner_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "cash_account_id" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "journal_entry_id" TEXT,
    "created_by" TEXT NOT NULL,
    "posted_by" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "sales_invoice_id" TEXT,
    "purchase_bill_id" TEXT,
    "amount" DECIMAL(20,4) NOT NULL,
    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_sequences" (
    "document_type" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("document_type","fiscal_year")
);

-- Indexes
CREATE UNIQUE INDEX "business_partners_code_key" ON "business_partners"("code");
CREATE INDEX "business_partners_deleted_at_idx" ON "business_partners"("deleted_at");
CREATE UNIQUE INDEX "sales_invoices_fiscal_year_invoice_number_key" ON "sales_invoices"("fiscal_year","invoice_number");
CREATE INDEX "sales_invoices_deleted_at_idx" ON "sales_invoices"("deleted_at");
CREATE INDEX "sales_invoices_partner_id_idx" ON "sales_invoices"("partner_id");
CREATE UNIQUE INDEX "sales_invoice_lines_sales_invoice_id_line_no_key" ON "sales_invoice_lines"("sales_invoice_id","line_no");
CREATE UNIQUE INDEX "purchase_bills_fiscal_year_bill_number_key" ON "purchase_bills"("fiscal_year","bill_number");
CREATE INDEX "purchase_bills_deleted_at_idx" ON "purchase_bills"("deleted_at");
CREATE INDEX "purchase_bills_partner_id_idx" ON "purchase_bills"("partner_id");
CREATE UNIQUE INDEX "purchase_bill_lines_purchase_bill_id_line_no_key" ON "purchase_bill_lines"("purchase_bill_id","line_no");
CREATE UNIQUE INDEX "payments_fiscal_year_number_key" ON "payments"("fiscal_year","number");
CREATE INDEX "payments_deleted_at_idx" ON "payments"("deleted_at");
CREATE INDEX "payments_partner_id_idx" ON "payments"("partner_id");
CREATE INDEX "payment_allocations_sales_invoice_id_idx" ON "payment_allocations"("sales_invoice_id");
CREATE INDEX "payment_allocations_purchase_bill_id_idx" ON "payment_allocations"("purchase_bill_id");

-- Foreign keys (parent-child only; partner/account refs follow the no-FK convention)
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_sales_invoice_id_fkey" FOREIGN KEY ("sales_invoice_id") REFERENCES "sales_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_purchase_bill_id_fkey" FOREIGN KEY ("purchase_bill_id") REFERENCES "purchase_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Note: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older Postgres; Prisma's `migrate deploy` runs each statement appropriately. If `migrate deploy` errors on the enum additions being in a transaction, split the three `ALTER TYPE` lines into a separate earlier migration folder `20260611045000_add_journal_source_types/migration.sql` containing only those three lines, and keep the rest here. (Try the combined file first.)

- [ ] **Step 4: Apply + regenerate**

```bash
docker compose up -d db
npx prisma migrate deploy
npx prisma generate
npx prisma migrate status   # expect: "Database schema is up to date!"
```

- [ ] **Step 5: Refactor `PostingService` into transaction-composable methods**

Edit `src/ledger/posting/posting.service.ts`. Add the `LedgerTx` type (after the `RawTxClient` type) and the four new methods, and rewrite `post`/`reverse` as thin wrappers. **`postDraft`, `nextNumber`, `assertBalanced`, `assertPostableAccounts`, `buildEntryRef`, `fiscalYearFor` stay exactly as they are.**

Add the import and type near the top:

```typescript
import { ExtendedPrismaClient } from '../../common/prisma/soft-delete.extension';

/** The interactive-transaction view of the soft-delete-extended client — what the
 *  `$transaction(async (tx) => …)` callback receives. Shared so document services
 *  can compose journal posting into their own transactions. */
export type LedgerTx = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'
>;
```

Replace the body of `post` with a wrapper and add `preparePosting` + `createPostedEntryInTx`:

```typescript
  async post(input: PostEntryInput, postedBy: string): Promise<JournalEntry> {
    const { periodId, fiscalYear } = await this.preparePosting(input, postedBy);
    return this.prisma.client.$transaction((tx) =>
      this.createPostedEntryInTx(tx, input, postedBy, periodId, fiscalYear),
    );
  }

  /** Pre-transaction validation shared by direct posts and document posting.
   *  Runs the balance, SoD, open-period, and postable-account checks (all reads
   *  stay OUT of the write transaction to avoid pool contention under concurrency)
   *  and returns the resolved period + fiscal year. */
  async preparePosting(
    input: PostEntryInput,
    postedBy: string,
  ): Promise<{ periodId: string; fiscalYear: number }> {
    this.assertBalanced(input.lines);
    const settings = await this.company.get();
    if (
      settings.segregationOfDutiesEnabled &&
      input.sourceType === 'MANUAL' &&
      postedBy === input.createdBy
    ) {
      throw new SegregationOfDutiesError(
        'The poster must differ from the entry creator',
        { createdBy: input.createdBy },
      );
    }
    const period = await this.periods.findOpenPeriodForDate(input.date);
    if (!period) {
      throw new ClosedPeriodError(
        'No open accounting period contains this date',
        { date: input.date.toISOString().slice(0, 10) },
      );
    }
    await this.assertPostableAccounts(input.lines);
    const fiscalYear = this.fiscalYearFor(
      input.date,
      settings.fiscalYearStartMonth,
    );
    return { periodId: period.id, fiscalYear };
  }

  /** Assigns the gapless JE number and writes the (already-validated, balanced)
   *  entry within a caller-provided transaction. */
  async createPostedEntryInTx(
    tx: LedgerTx,
    input: PostEntryInput,
    postedBy: string,
    periodId: string,
    fiscalYear: number,
  ): Promise<JournalEntry> {
    const entryNumber = await this.nextNumber(tx, fiscalYear);
    const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
    return tx.journalEntry.create({
      data: {
        entryNumber,
        entryRef,
        fiscalYear,
        date: input.date,
        periodId,
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
            debit: Money.of(l.debit ?? '0').toPersistence(),
            credit: Money.of(l.credit ?? '0').toPersistence(),
            description: l.description,
          })),
        },
      },
    });
  }
```

Replace the body of `reverse` with a wrapper and add `prepareReversal` + `reverseInTx`:

```typescript
  async reverse(
    entryId: string,
    reversedBy: string,
    date?: Date,
  ): Promise<JournalEntry> {
    const { original, periodId, fiscalYear } = await this.prepareReversal(
      entryId,
      date,
    );
    try {
      return await this.prisma.client.$transaction((tx) =>
        this.reverseInTx(tx, original, reversedBy, periodId, fiscalYear),
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ValidationFailedError('Entry has already been reversed', {
          entryId,
        });
      }
      throw err;
    }
  }

  async prepareReversal(
    entryId: string,
    date?: Date,
  ): Promise<{
    original: JournalEntry & { lines: { lineNo: number; accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal; description: string | null }[] };
    periodId: string;
    fiscalYear: number;
  }> {
    const original = await this.prisma.client.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!original)
      throw new NotFoundDomainError('Journal entry not found', { entryId });
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
    const fiscalYear = this.fiscalYearFor(
      reversalDate,
      settings.fiscalYearStartMonth,
    );
    return { original, periodId: period.id, fiscalYear };
  }

  async reverseInTx(
    tx: LedgerTx,
    original: Awaited<ReturnType<PostingService['prepareReversal']>>['original'],
    reversedBy: string,
    periodId: string,
    fiscalYear: number,
  ): Promise<JournalEntry> {
    const entryNumber = await this.nextNumber(tx, fiscalYear);
    const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
    const reversal = await tx.journalEntry.create({
      data: {
        entryNumber,
        entryRef,
        fiscalYear,
        date: original.date,
        periodId,
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
            debit: l.credit,
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
  }
```

Note: `reverseInTx` uses `original.date` for the reversal date (the prior `reverse` used `reversalDate = date ?? original.date`; `prepareReversal` already resolved the period from that date, and the only caller passing a custom `date` is the public `reverse`, which is unchanged in behaviour because the reversal date still defaults to `original.date` when no date is given — Phase-4 callers never pass a date). This preserves all existing Phase-2 reverse tests.

- [ ] **Step 6: Verify the refactor preserves Phase 2 behaviour**

Run the existing ledger suites (they must stay green — this is the whole safety net for the refactor):
```bash
npm run build
npm run test:e2e -- "posting|journal|balances"
```
Expected: all pass (posting 10, journal 9, balances 3, etc.). Then `npm run lint`.

- [ ] **Step 7: DocumentNumberService**

Create `src/invoicing/document-number.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';

/** The raw-SQL subset of an interactive-tx client (same shape PostingService uses). */
type RawTx = {
  $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
  $queryRaw: <T = unknown>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
};

@Injectable()
export class DocumentNumberService {
  /** Lock-and-increment the per-(type, fiscal-year) counter inside the caller's
   *  transaction. Gapless because the increment and the document write share the tx. */
  async next(tx: RawTx, documentType: string, fiscalYear: number): Promise<number> {
    await tx.$executeRaw`INSERT INTO document_sequences (document_type, fiscal_year, next_number, updated_at)
      VALUES (${documentType}, ${fiscalYear}, 1, now()) ON CONFLICT (document_type, fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ next_number: number }[]>`
      SELECT next_number FROM document_sequences
      WHERE document_type = ${documentType} AND fiscal_year = ${fiscalYear} FOR UPDATE`;
    const current = rows[0].next_number;
    await tx.$executeRaw`UPDATE document_sequences SET next_number = ${current + 1}, updated_at = now()
      WHERE document_type = ${documentType} AND fiscal_year = ${fiscalYear}`;
    return current;
  }

  /** e.g. INV/2026/000042 */
  buildRef(prefix: string, fiscalYear: number, number: number): string {
    return `${prefix}/${fiscalYear}/${String(number).padStart(6, '0')}`;
  }
}
```

- [ ] **Step 8: InvoicingModule skeleton + wire into AppModule**

Create `src/invoicing/invoicing.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxModule } from '../tax/tax.module';
import { DocumentNumberService } from './document-number.service';

@Module({
  imports: [LedgerModule, TaxModule],
  providers: [DocumentNumberService],
  controllers: [],
  exports: [DocumentNumberService],
})
export class InvoicingModule {}
```

In `src/app.module.ts`, import `InvoicingModule` and add it to `imports` (after `TaxModule`). Confirm `LedgerModule` exports `PostingService`, `AccountsService`, `CompanyService` (it exports the first two already; add `CompanyService` to `LedgerModule`'s `exports` if not present — check `src/ledger/ledger.module.ts`; CompanyModule is imported there, so re-export `CompanyService` by adding `CompanyModule` to `LedgerModule`'s `exports`, or import `CompanyModule` directly in `InvoicingModule`). Simplest: add `CompanyModule` to `InvoicingModule`'s `imports`.

- [ ] **Step 9: Build, lint, commit**

```bash
npm run build && npm run lint
npm run test:e2e -- "posting|journal|balances"   # still green
git add prisma src/common/prisma/soft-delete.extension.ts src/ledger/posting/posting.service.ts src/invoicing src/app.module.ts
git commit -m "feat(invoicing): schema, tx-composable PostingService, numbering, module skeleton"
```

---

## Task 2: Business partners

**Files:** `src/invoicing/business-partners.service.ts`, `dto/create-business-partner.dto.ts`, `dto/update-business-partner.dto.ts`, `business-partners.controller.ts`, `invoicing.module.ts`; Test: `test/business-partners.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e** `test/business-partners.e2e-spec.ts`

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('BusinessPartners (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;

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
    await app.get(UsersService).create({ email: 'a@p.test', password: 'secret123', name: 'A', role: 'ADMIN' });
    token = (await app.get(AuthService).login('a@p.test', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('creates a customer partner (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/partners').set('Authorization', `Bearer ${token}`)
      .send({ code: 'CUST-1', name: 'PT Pelanggan', npwp: '01.234.567.8-901.000', isCustomer: true })
      .expect(201);
    expect((res.body as { isCustomer: boolean }).isCustomer).toBe(true);
  });

  it('rejects a partner that is neither customer nor vendor (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/partners').set('Authorization', `Bearer ${token}`)
      .send({ code: 'NEITHER', name: 'X', isCustomer: false, isVendor: false })
      .expect(422);
  });

  it('rejects a duplicate code (409)', async () => {
    const body = { code: 'DUP', name: 'Y', isVendor: true };
    await request(app.getHttpServer() as App).post('/partners').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    await request(app.getHttpServer() as App).post('/partners').set('Authorization', `Bearer ${token}`).send(body).expect(409);
  });

  it('soft-deletes a partner (204) then it is gone from the list', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/partners').set('Authorization', `Bearer ${token}`)
      .send({ code: 'DEL-1', name: 'Z', isCustomer: true }).expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App).delete(`/partners/${id}`).set('Authorization', `Bearer ${token}`).expect(204);
    const list = await request(app.getHttpServer() as App).get('/partners').set('Authorization', `Bearer ${token}`).expect(200);
    expect((list.body as { id: string }[]).some((p) => p.id === id)).toBe(false);
  });
});
```
Run `npm run test:e2e -- business-partners` → FAIL.

- [ ] **Step 2: Service** `src/invoicing/business-partners.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { BusinessPartner, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

export interface CreatePartnerInput {
  code: string;
  name: string;
  npwp?: string;
  email?: string;
  phone?: string;
  address?: string;
  isCustomer?: boolean;
  isVendor?: boolean;
}
export type UpdatePartnerInput = Partial<
  Omit<CreatePartnerInput, 'code'>
> & { isActive?: boolean };

@Injectable()
export class BusinessPartnersService {
  constructor(private readonly prisma: PrismaService) {}

  private assertRole(isCustomer?: boolean, isVendor?: boolean): void {
    if (!isCustomer && !isVendor) {
      throw new ValidationFailedError(
        'A partner must be a customer and/or a vendor',
      );
    }
  }

  async create(input: CreatePartnerInput): Promise<BusinessPartner> {
    this.assertRole(input.isCustomer, input.isVendor);
    const existing = await this.prisma.client.businessPartner.findFirst({
      where: { code: input.code },
    });
    if (existing)
      throw new ConflictDomainError('Partner code already exists', {
        code: input.code,
      });
    try {
      return await this.prisma.client.businessPartner.create({
        data: {
          code: input.code,
          name: input.name,
          npwp: input.npwp,
          email: input.email,
          phone: input.phone,
          address: input.address,
          isCustomer: input.isCustomer ?? false,
          isVendor: input.isVendor ?? false,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      )
        throw new ConflictDomainError('Partner code already exists', {
          code: input.code,
        });
      throw err;
    }
  }

  async list(): Promise<BusinessPartner[]> {
    return this.prisma.client.businessPartner.findMany({
      orderBy: { code: 'asc' },
    });
  }

  async findById(id: string): Promise<BusinessPartner> {
    const p = await this.prisma.client.businessPartner.findFirst({
      where: { id },
    });
    if (!p) throw new NotFoundDomainError('Partner not found', { id });
    return p;
  }

  async update(id: string, input: UpdatePartnerInput): Promise<BusinessPartner> {
    const current = await this.findById(id);
    const isCustomer = input.isCustomer ?? current.isCustomer;
    const isVendor = input.isVendor ?? current.isVendor;
    this.assertRole(isCustomer, isVendor);
    return this.prisma.client.businessPartner.update({
      where: { id },
      data: { ...input },
    });
  }

  async deactivate(id: string): Promise<BusinessPartner> {
    await this.findById(id);
    return this.prisma.client.businessPartner.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const p = await this.findById(id);
    await this.prisma.client.businessPartner.update({
      where: { id },
      data: { code: `${p.code}#deleted-${id}`, deletedAt: new Date(), deletedBy },
    });
  }
}
```

- [ ] **Step 3: DTOs**

`src/invoicing/dto/create-business-partner.dto.ts`:

```typescript
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBusinessPartnerDto {
  @IsString() @MaxLength(32) code!: string;
  @IsString() @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(32) npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsBoolean() isCustomer?: boolean;
  @IsOptional() @IsBoolean() isVendor?: boolean;
}
```

`src/invoicing/dto/update-business-partner.dto.ts`:

```typescript
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBusinessPartnerDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(32) npwp?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsBoolean() isCustomer?: boolean;
  @IsOptional() @IsBoolean() isVendor?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
```

- [ ] **Step 4: Controller** `src/invoicing/business-partners.controller.ts`

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { BusinessPartner } from '@prisma/client';
import { BusinessPartnersService } from './business-partners.service';
import { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@Controller('partners')
export class BusinessPartnersController {
  constructor(private readonly partners: BusinessPartnersService) {}

  @Get() list(): Promise<BusinessPartner[]> { return this.partners.list(); }
  @Get(':id') get(@Param('id') id: string): Promise<BusinessPartner> { return this.partners.findById(id); }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post() create(@Body() dto: CreateBusinessPartnerDto): Promise<BusinessPartner> { return this.partners.create(dto); }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateBusinessPartnerDto): Promise<BusinessPartner> { return this.partners.update(id, dto); }

  @Roles(Role.ADMIN)
  @Post(':id/deactivate') @HttpCode(200) deactivate(@Param('id') id: string): Promise<BusinessPartner> { return this.partners.deactivate(id); }

  @Roles(Role.ADMIN)
  @Delete(':id') @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> { await this.partners.softDelete(id, user.id); }
}
```

- [ ] **Step 5: Register** `BusinessPartnersService` (providers + exports) and `BusinessPartnersController` (controllers) in `InvoicingModule`.

- [ ] **Step 6: Run** `npm run test:e2e -- business-partners` → 4 PASS. `npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add src/invoicing test/business-partners.e2e-spec.ts
git commit -m "feat(invoicing): business partners CRUD"
```

---

## Task 3: Sales invoices

**Files:** `src/invoicing/document-posting.service.ts`, `src/invoicing/sales-invoices.service.ts`, `dto/create-sales-invoice.dto.ts`, `dto/update-sales-invoice.dto.ts`, `sales-invoices.controller.ts`, `invoicing.module.ts`; Test: `test/sales-invoices.e2e-spec.ts`

This task introduces the shared `DocumentPostingService` (reused by Task 4). It orchestrates: `TaxService.calculate` (pre-tx) → `PostingService.preparePosting` (pre-tx) → one transaction (caller-supplied lock + `DocumentNumberService.next` + `PostingService.createPostedEntryInTx` + caller-supplied finalize).

- [ ] **Step 1: Shared posting helper** `src/invoicing/document-posting.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService, LedgerTx } from '../ledger/posting/posting.service';
import { TaxService, TaxableLineInput } from '../tax/tax.service';
import { DocumentNumberService } from './document-number.service';

export interface PostTaxedDocParams {
  nature: 'SALE' | 'PURCHASE';
  settlementAccountId: string;
  date: Date;
  description: string;
  sourceType: 'SALES_INVOICE' | 'PURCHASE_BILL';
  sourceId: string;
  createdBy: string;
  postedBy: string;
  documentType: string; // 'INV' | 'BILL'
  lines: TaxableLineInput[];
}

export interface PostedDocContext {
  tx: LedgerTx;
  number: number;
  ref: string;
  entry: JournalEntry;
  fiscalYear: number;
}

@Injectable()
export class DocumentPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly tax: TaxService,
    private readonly docNumber: DocumentNumberService,
  ) {}

  /** Compute the tax breakdown for a draft (no posting). */
  async computeTotals(
    nature: 'SALE' | 'PURCHASE',
    settlementAccountId: string,
    lines: TaxableLineInput[],
  ): Promise<{ subtotal: string; taxTotal: string; withholdingTotal: string; total: string }> {
    const calc = await this.tax.calculate({ nature, settlementAccountId, lines });
    let taxTotal = Money.zero();
    let withholdingTotal = Money.zero();
    for (const t of calc.taxes) {
      if (t.kind === 'PPN_OUTPUT' || t.kind === 'PPN_INPUT') taxTotal = taxTotal.add(Money.of(t.amount));
      else withholdingTotal = withholdingTotal.add(Money.of(t.amount));
    }
    return {
      subtotal: calc.subtotal,
      taxTotal: taxTotal.toPersistence(),
      withholdingTotal: withholdingTotal.toPersistence(),
      total: calc.settlementAmount,
    };
  }

  /** Post a taxed document atomically. `lockDraft` must lock + re-check the row is
   *  still DRAFT (FOR UPDATE) BEFORE a number is consumed; `finalize` updates the
   *  document row to POSTED with the assigned number/ref + journal entry id. */
  async post(
    params: PostTaxedDocParams,
    lockDraft: (tx: LedgerTx) => Promise<void>,
    finalize: (ctx: PostedDocContext) => Promise<void>,
  ): Promise<void> {
    const calc = await this.tax.calculate({
      nature: params.nature,
      settlementAccountId: params.settlementAccountId,
      lines: params.lines,
    });
    const journalInput = {
      date: params.date,
      description: params.description,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      createdBy: params.createdBy,
      lines: calc.journalLines,
    };
    const { periodId, fiscalYear } = await this.posting.preparePosting(
      journalInput,
      params.postedBy,
    );
    await this.prisma.client.$transaction(async (tx) => {
      await lockDraft(tx);
      const number = await this.docNumber.next(tx, params.documentType, fiscalYear);
      const ref = this.docNumber.buildRef(params.documentType, fiscalYear, number);
      const entry = await this.posting.createPostedEntryInTx(
        tx,
        journalInput,
        params.postedBy,
        periodId,
        fiscalYear,
      );
      await finalize({ tx, number, ref, entry, fiscalYear });
    });
  }
}
```

- [ ] **Step 2: Write the failing e2e** `test/sales-invoices.e2e-spec.ts`

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('SalesInvoices (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string; // accountant token
  let appr: string; // approver token
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let customerId: string;

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
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({ email: 'acct@si.test', password: 'secret123', name: 'Acct', role: 'ACCOUNTANT' });
    await users.create({ email: 'appr@si.test', password: 'secret123', name: 'Appr', role: 'APPROVER' });
    acct = (await app.get(AuthService).login('acct@si.test', 'secret123')).accessToken;
    appr = (await app.get(AuthService).login('appr@si.test', 'secret123')).accessToken;
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const codes = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    customerId = (await app.get(BusinessPartnersService).create({ code: 'CUST-SI', name: 'Pelanggan', isCustomer: true })).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const draftBody = () => ({
    partnerId: customerId,
    date: '2026-02-10',
    description: 'Jual jasa',
    lines: [
      { description: 'Jasa konsultasi', accountId: acc['4-1000'], quantity: '1', unitPrice: '1000000', taxCodeIds: [code['PPN-OUT-11']] },
    ],
  });

  it('creates a DRAFT invoice with computed totals (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/sales-invoices').set('Authorization', `Bearer ${acct}`).send(draftBody()).expect(201);
    const body = res.body as { status: string; subtotal: string; taxTotal: string; total: string; invoiceNumber: number | null };
    expect(body.status).toBe('DRAFT');
    expect(body.subtotal).toBe('1000000.0000');
    expect(body.taxTotal).toBe('110000.0000');
    expect(body.total).toBe('1110000.0000');
    expect(body.invoiceNumber).toBeNull();
  });

  it('posts a DRAFT invoice → POSTED, gapless number, balanced GL entry hitting AR (1-1200)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/sales-invoices').set('Authorization', `Bearer ${acct}`).send(draftBody()).expect(201);
    const id = (draft.body as { id: string }).id;
    const posted = await request(app.getHttpServer() as App)
      .post(`/sales-invoices/${id}/post`).set('Authorization', `Bearer ${appr}`).expect(200);
    const body = posted.body as { status: string; invoiceNumber: number; invoiceRef: string; journalEntryId: string; outstanding: string; paymentStatus: string };
    expect(body.status).toBe('POSTED');
    expect(body.invoiceNumber).toBeGreaterThan(0);
    expect(body.invoiceRef).toMatch(/^INV\/2026\/\d{6}$/);
    expect(body.outstanding).toBe('1110000.0000');
    expect(body.paymentStatus).toBe('UNPAID');
    // GL entry balances and debits AR (Piutang 1-1200) by the total.
    const lines = await prisma.client.journalLine.findMany({ where: { journalEntryId: body.journalEntryId } });
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(credit);
    const ar = lines.find((l) => l.accountId === acc['1-1200']);
    expect(ar!.debit.toString()).toBe('1110000');
  });

  it('rejects an ACCOUNTANT trying to post (403)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/sales-invoices').set('Authorization', `Bearer ${acct}`).send(draftBody()).expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/sales-invoices/${id}/post`).set('Authorization', `Bearer ${acct}`).expect(403);
  });

  it('voids a POSTED unpaid invoice (200) → VOID and reverses the GL entry', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/sales-invoices').set('Authorization', `Bearer ${acct}`).send(draftBody()).expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App).post(`/sales-invoices/${id}/post`).set('Authorization', `Bearer ${appr}`).expect(200);
    const voided = await request(app.getHttpServer() as App)
      .post(`/sales-invoices/${id}/void`).set('Authorization', `Bearer ${appr}`).expect(200);
    expect((voided.body as { status: string }).status).toBe('VOID');
  });

  it('rejects posting a draft for a non-customer partner (422)', async () => {
    const vendor = await app.get(BusinessPartnersService).create({ code: 'VEND-ONLY', name: 'V', isVendor: true });
    await request(app.getHttpServer() as App)
      .post('/sales-invoices').set('Authorization', `Bearer ${acct}`)
      .send({ ...draftBody(), partnerId: vendor.id }).expect(422);
  });
});
```
Run `npm run test:e2e -- sales-invoices` → FAIL.

- [ ] **Step 3: SalesInvoicesService** `src/invoicing/sales-invoices.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma, SalesInvoice } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService } from '../ledger/posting/posting.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentPostingService } from './document-posting.service';

const AR_CONTROL_CODE = '1-1200';

export interface InvoiceLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeIds: string[];
}
export interface CreateInvoiceInput {
  partnerId: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  lines: InvoiceLineInput[];
  createdBy: string;
}

@Injectable()
export class SalesInvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly docPosting: DocumentPostingService,
    private readonly posting: PostingService,
  ) {}

  private async arControlId(): Promise<string> {
    const acc = await this.prisma.client.account.findFirst({ where: { code: AR_CONTROL_CODE } });
    if (!acc) throw new ValidationFailedError('AR control account missing from chart', { code: AR_CONTROL_CODE });
    return acc.id;
  }

  private taxableLines(lines: { accountId: string; quantity: Prisma.Decimal | string; unitPrice: Prisma.Decimal | string; taxCodeIds: string[] }[]) {
    return lines.map((l) => ({
      accountId: l.accountId,
      amount: Money.of(l.unitPrice.toString()).multiply(l.quantity.toString()).toPersistence(),
      taxCodeIds: l.taxCodeIds,
    }));
  }

  async createDraft(input: CreateInvoiceInput): Promise<SalesInvoice> {
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isCustomer || !partner.isActive) {
      throw new ValidationFailedError('Partner is not an active customer', { partnerId: input.partnerId });
    }
    const settlementId = await this.arControlId();
    const totals = await this.docPosting.computeTotals('SALE', settlementId, this.taxableLines(input.lines));
    return this.prisma.client.salesInvoice.create({
      data: {
        partnerId: input.partnerId,
        date: input.date,
        dueDate: input.dueDate,
        description: input.description,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        withholdingTotal: totals.withholdingTotal,
        total: totals.total,
        createdBy: input.createdBy,
        lines: {
          create: input.lines.map((l, i) => ({
            lineNo: i + 1,
            description: l.description,
            accountId: l.accountId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amount: Money.of(l.unitPrice).multiply(l.quantity).toPersistence(),
            taxCodeIds: l.taxCodeIds,
          })),
        },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
  }

  async getById(id: string): Promise<SalesInvoice> {
    const inv = await this.prisma.client.salesInvoice.findFirst({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!inv) throw new NotFoundDomainError('Sales invoice not found', { id });
    return inv;
  }

  async list(filter: { partnerId?: string; status?: string }): Promise<SalesInvoice[]> {
    return this.prisma.client.salesInvoice.findMany({
      where: { partnerId: filter.partnerId, status: filter.status as never },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    const inv = await this.getById(id);
    if (inv.status !== 'DRAFT') {
      throw new ValidationFailedError('Only a DRAFT invoice can be deleted', { id, status: inv.status });
    }
    const res = await this.prisma.client.salesInvoice.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date(), deletedBy },
    });
    if (res.count !== 1) throw new ValidationFailedError('Only a DRAFT invoice can be deleted', { id });
  }

  async post(id: string, postedBy: string): Promise<SalesInvoice> {
    const inv = await this.getById(id);
    if (inv.status !== 'DRAFT') {
      throw new ValidationFailedError('Invoice is not a draft', { id, status: inv.status });
    }
    const partner = await this.partners.findById(inv.partnerId);
    if (!partner.isCustomer || !partner.isActive) {
      throw new ValidationFailedError('Partner is not an active customer', { partnerId: inv.partnerId });
    }
    const settlementId = await this.arControlId();
    const lines = (inv as SalesInvoice & { lines: { accountId: string; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; taxCodeIds: string[] }[] }).lines;

    await this.docPosting.post(
      {
        nature: 'SALE',
        settlementAccountId: settlementId,
        date: inv.date,
        description: inv.description ?? `Sales invoice ${id}`,
        sourceType: 'SALES_INVOICE',
        sourceId: id,
        createdBy: inv.createdBy,
        postedBy,
        documentType: 'INV',
        lines: this.taxableLines(lines),
      },
      async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM sales_invoices WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'DRAFT') {
          throw new ValidationFailedError('Invoice is no longer a draft', { id });
        }
      },
      async ({ tx, number, ref, entry, fiscalYear }) => {
        const totals = await this.docPosting.computeTotals('SALE', settlementId, this.taxableLines(lines));
        await tx.salesInvoice.update({
          where: { id },
          data: {
            status: 'POSTED',
            invoiceNumber: number,
            invoiceRef: ref,
            fiscalYear,
            journalEntryId: entry.id,
            postedBy,
            postedAt: new Date(),
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            withholdingTotal: totals.withholdingTotal,
            total: totals.total,
          },
        });
      },
    );
    return this.getById(id);
  }

  async void(id: string, voidedBy: string): Promise<SalesInvoice> {
    const inv = await this.getById(id);
    if (inv.status !== 'POSTED') {
      throw new ValidationFailedError('Only a POSTED invoice can be voided', { id, status: inv.status });
    }
    if (!Money.of(inv.amountPaid.toString()).isZero()) {
      throw new ConflictDomainError('Cannot void an invoice with payments; void the payments first', { id });
    }
    const { original, periodId, fiscalYear, reversalDate } = await this.posting.prepareReversal(inv.journalEntryId!);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ status: string; amount_paid: string }[]>`
          SELECT status, amount_paid FROM sales_invoices WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'POSTED') {
          throw new ValidationFailedError('Invoice is not posted', { id });
        }
        if (Number(locked[0].amount_paid) !== 0) {
          throw new ConflictDomainError('Cannot void an invoice with payments', { id });
        }
        await this.posting.reverseInTx(tx, original, voidedBy, periodId, fiscalYear, reversalDate);
        await tx.salesInvoice.update({ where: { id }, data: { status: 'VOID' } });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ValidationFailedError('Invoice journal entry was already reversed', { id });
      }
      throw err;
    }
    return this.getById(id);
  }

  /** Shape the API response with derived outstanding + paymentStatus. */
  present(inv: SalesInvoice): SalesInvoice & { outstanding: string; paymentStatus: string } {
    const total = Money.of(inv.total.toString());
    const paid = Money.of(inv.amountPaid.toString());
    const outstanding = total.subtract(paid);
    const paymentStatus = paid.isZero() ? 'UNPAID' : outstanding.isZero() || outstanding.isNegative() ? 'PAID' : 'PARTIAL';
    return { ...inv, outstanding: outstanding.toPersistence(), paymentStatus };
  }
}
```

- [ ] **Step 4: DTOs**

`src/invoicing/dto/create-sales-invoice.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

export class SalesInvoiceLineDto {
  @IsString() @MaxLength(255) description!: string;
  @IsUUID() accountId!: string;
  @Matches(/^\d+(\.\d{1,4})?$/, { message: 'quantity must be a positive decimal' }) quantity!: string;
  @Matches(/^\d+(\.\d{1,4})?$/, { message: 'unitPrice must be a decimal' }) unitPrice!: string;
  @IsArray() @IsUUID('all', { each: true }) taxCodeIds!: string[];
}

export class CreateSalesInvoiceDto {
  @IsUUID() partnerId!: string;
  @IsDateString() date!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SalesInvoiceLineDto) lines!: SalesInvoiceLineDto[];
}
```

`src/invoicing/dto/update-sales-invoice.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { SalesInvoiceLineDto } from './create-sales-invoice.dto';

export class UpdateSalesInvoiceDto {
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => SalesInvoiceLineDto) lines?: SalesInvoiceLineDto[];
}
```

(The `update` service method — DRAFT-only re-edit that replaces lines and recomputes totals — mirrors `createDraft`; implement it analogously: load the draft, assert DRAFT, delete existing lines, create new ones, recompute totals, update header. Include a test if time permits; the core lifecycle is draft/post/void.)

- [ ] **Step 5: Controller** `src/invoicing/sales-invoices.controller.ts`

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { SalesInvoicesService } from './sales-invoices.service';
import { CreateSalesInvoiceDto } from './dto/create-sales-invoice.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@Controller('sales-invoices')
export class SalesInvoicesController {
  constructor(private readonly invoices: SalesInvoicesService) {}

  @Get()
  async list(@Query('partnerId') partnerId?: string, @Query('status') status?: string) {
    const rows = await this.invoices.list({ partnerId, status });
    return rows.map((r) => this.invoices.present(r));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.invoices.present(await this.invoices.getById(id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  async create(@Body() dto: CreateSalesInvoiceDto, @CurrentUser() user: AuthenticatedUser) {
    const inv = await this.invoices.createDraft({
      partnerId: dto.partnerId,
      date: new Date(dto.date),
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    });
    return this.invoices.present(inv);
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/post')
  @HttpCode(200)
  async post(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.present(await this.invoices.post(id, user.id));
  }

  @Roles(Role.APPROVER, Role.ADMIN)
  @Post(':id/void')
  @HttpCode(200)
  async void(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.invoices.present(await this.invoices.void(id, user.id));
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.invoices.deleteDraft(id, user.id);
  }
}
```

- [ ] **Step 6: Register** `DocumentPostingService`, `SalesInvoicesService` (providers; export `SalesInvoicesService`) and `SalesInvoicesController` in `InvoicingModule`.

- [ ] **Step 7: Run** `npm run test:e2e -- sales-invoices` → 5 PASS; re-run `-- posting|journal` (regression). `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/invoicing test/sales-invoices.e2e-spec.ts
git commit -m "feat(invoicing): sales invoices draft/post/void + shared posting helper"
```

---

## Task 4: Purchase bills

Mirror Task 3 for AP. **Files:** `src/invoicing/purchase-bills.service.ts`, `dto/create-purchase-bill.dto.ts`, `dto/update-purchase-bill.dto.ts`, `purchase-bills.controller.ts`, `invoicing.module.ts`; Test: `test/purchase-bills.e2e-spec.ts`.

Differences from sales invoices:
- Partner must be `isVendor`.
- `nature: 'PURCHASE'`, settlement = AP control `2-1000`, sourceType `PURCHASE_BILL`, documentType `'BILL'`, number/ref fields `billNumber`/`billRef`, ref prefix `BILL`.
- Header has `vendorInvoiceNo?`.
- The posted GL entry **credits** AP (`2-1000`) by the total.

- [ ] **Step 1: Write the failing e2e** `test/purchase-bills.e2e-spec.ts` — same structure as the sales-invoices spec, but: create the partner as `{ code: 'VEND-PB', name: 'Pemasok', isVendor: true }`; draft line `{ description: 'Beli jasa', accountId: acc['5-2000'], quantity: '1', unitPrice: '1000000', taxCodeIds: [code['PPN-IN-11']] }`; POST `/purchase-bills`; on post assert `billRef` matches `/^BILL\/2026\/\d{6}$/`, the GL entry balances and **credits** `acc['2-1000']` by `1110000`; the void + non-vendor (422) cases mirror the sales ones. Run → FAIL.

- [ ] **Step 2: PurchaseBillsService** `src/invoicing/purchase-bills.service.ts` — copy the `SalesInvoicesService` structure with the differences above. Full code:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma, PurchaseBill } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService } from '../ledger/posting/posting.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentPostingService } from './document-posting.service';

const AP_CONTROL_CODE = '2-1000';

export interface BillLineInput { description: string; accountId: string; quantity: string; unitPrice: string; taxCodeIds: string[]; }
export interface CreateBillInput { partnerId: string; vendorInvoiceNo?: string; date: Date; dueDate?: Date; description?: string; lines: BillLineInput[]; createdBy: string; }

@Injectable()
export class PurchaseBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly docPosting: DocumentPostingService,
    private readonly posting: PostingService,
  ) {}

  private async apControlId(): Promise<string> {
    const acc = await this.prisma.client.account.findFirst({ where: { code: AP_CONTROL_CODE } });
    if (!acc) throw new ValidationFailedError('AP control account missing from chart', { code: AP_CONTROL_CODE });
    return acc.id;
  }
  private taxableLines(lines: { accountId: string; quantity: Prisma.Decimal | string; unitPrice: Prisma.Decimal | string; taxCodeIds: string[] }[]) {
    return lines.map((l) => ({ accountId: l.accountId, amount: Money.of(l.unitPrice.toString()).multiply(l.quantity.toString()).toPersistence(), taxCodeIds: l.taxCodeIds }));
  }

  async createDraft(input: CreateBillInput): Promise<PurchaseBill> {
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isVendor || !partner.isActive) throw new ValidationFailedError('Partner is not an active vendor', { partnerId: input.partnerId });
    const settlementId = await this.apControlId();
    const totals = await this.docPosting.computeTotals('PURCHASE', settlementId, this.taxableLines(input.lines));
    return this.prisma.client.purchaseBill.create({
      data: {
        partnerId: input.partnerId, vendorInvoiceNo: input.vendorInvoiceNo, date: input.date, dueDate: input.dueDate, description: input.description,
        subtotal: totals.subtotal, taxTotal: totals.taxTotal, withholdingTotal: totals.withholdingTotal, total: totals.total, createdBy: input.createdBy,
        lines: { create: input.lines.map((l, i) => ({ lineNo: i + 1, description: l.description, accountId: l.accountId, quantity: l.quantity, unitPrice: l.unitPrice, amount: Money.of(l.unitPrice).multiply(l.quantity).toPersistence(), taxCodeIds: l.taxCodeIds })) },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
  }

  async getById(id: string): Promise<PurchaseBill> {
    const bill = await this.prisma.client.purchaseBill.findFirst({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!bill) throw new NotFoundDomainError('Purchase bill not found', { id });
    return bill;
  }
  async list(filter: { partnerId?: string; status?: string }): Promise<PurchaseBill[]> {
    return this.prisma.client.purchaseBill.findMany({ where: { partnerId: filter.partnerId, status: filter.status as never }, orderBy: { createdAt: 'desc' } });
  }
  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    const bill = await this.getById(id);
    if (bill.status !== 'DRAFT') throw new ValidationFailedError('Only a DRAFT bill can be deleted', { id, status: bill.status });
    const res = await this.prisma.client.purchaseBill.updateMany({ where: { id, status: 'DRAFT', deletedAt: null }, data: { deletedAt: new Date(), deletedBy } });
    if (res.count !== 1) throw new ValidationFailedError('Only a DRAFT bill can be deleted', { id });
  }

  async post(id: string, postedBy: string): Promise<PurchaseBill> {
    const bill = await this.getById(id);
    if (bill.status !== 'DRAFT') throw new ValidationFailedError('Bill is not a draft', { id, status: bill.status });
    const partner = await this.partners.findById(bill.partnerId);
    if (!partner.isVendor || !partner.isActive) throw new ValidationFailedError('Partner is not an active vendor', { partnerId: bill.partnerId });
    const settlementId = await this.apControlId();
    const lines = (bill as PurchaseBill & { lines: { accountId: string; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; taxCodeIds: string[] }[] }).lines;
    await this.docPosting.post(
      { nature: 'PURCHASE', settlementAccountId: settlementId, date: bill.date, description: bill.description ?? `Purchase bill ${id}`, sourceType: 'PURCHASE_BILL', sourceId: id, createdBy: bill.createdBy, postedBy, documentType: 'BILL', lines: this.taxableLines(lines) },
      async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM purchase_bills WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'DRAFT') throw new ValidationFailedError('Bill is no longer a draft', { id });
      },
      async ({ tx, number, ref, entry, fiscalYear }) => {
        const totals = await this.docPosting.computeTotals('PURCHASE', settlementId, this.taxableLines(lines));
        await tx.purchaseBill.update({ where: { id }, data: { status: 'POSTED', billNumber: number, billRef: ref, fiscalYear, journalEntryId: entry.id, postedBy, postedAt: new Date(), subtotal: totals.subtotal, taxTotal: totals.taxTotal, withholdingTotal: totals.withholdingTotal, total: totals.total } });
      },
    );
    return this.getById(id);
  }

  async void(id: string, voidedBy: string): Promise<PurchaseBill> {
    const bill = await this.getById(id);
    if (bill.status !== 'POSTED') throw new ValidationFailedError('Only a POSTED bill can be voided', { id, status: bill.status });
    if (!Money.of(bill.amountPaid.toString()).isZero()) throw new ConflictDomainError('Cannot void a bill with payments; void the payments first', { id });
    const { original, periodId, fiscalYear, reversalDate } = await this.posting.prepareReversal(bill.journalEntryId!);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ status: string; amount_paid: string }[]>`SELECT status, amount_paid FROM purchase_bills WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'POSTED') throw new ValidationFailedError('Bill is not posted', { id });
        if (Number(locked[0].amount_paid) !== 0) throw new ConflictDomainError('Cannot void a bill with payments', { id });
        await this.posting.reverseInTx(tx, original, voidedBy, periodId, fiscalYear, reversalDate);
        await tx.purchaseBill.update({ where: { id }, data: { status: 'VOID' } });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ValidationFailedError('Bill journal entry was already reversed', { id });
      throw err;
    }
    return this.getById(id);
  }

  present(bill: PurchaseBill): PurchaseBill & { outstanding: string; paymentStatus: string } {
    const total = Money.of(bill.total.toString());
    const paid = Money.of(bill.amountPaid.toString());
    const outstanding = total.subtract(paid);
    const paymentStatus = paid.isZero() ? 'UNPAID' : outstanding.isZero() || outstanding.isNegative() ? 'PAID' : 'PARTIAL';
    return { ...bill, outstanding: outstanding.toPersistence(), paymentStatus };
  }
}
```

- [ ] **Step 3: DTOs** — `create-purchase-bill.dto.ts` mirrors the sales DTO plus `@IsOptional() @IsString() @MaxLength(64) vendorInvoiceNo?` and a `PurchaseBillLineDto` identical in shape to `SalesInvoiceLineDto`; `update-purchase-bill.dto.ts` mirrors the sales update DTO.

- [ ] **Step 4: Controller** `src/invoicing/purchase-bills.controller.ts` — copy `SalesInvoicesController`, swapping `@Controller('purchase-bills')`, the service, and threading `vendorInvoiceNo` in `create`.

- [ ] **Step 5: Register** in `InvoicingModule` (provider + export + controller).

- [ ] **Step 6: Run** `npm run test:e2e -- purchase-bills` → PASS; regression `-- posting|journal|sales-invoices`. `npm run lint`.

- [ ] **Step 7: Commit** `git commit -m "feat(invoicing): purchase bills draft/post/void"`

---

## Task 5: Payments & allocation

**Files:** `src/invoicing/payments.service.ts`, `dto/create-payment.dto.ts`, `payments.controller.ts`, `invoicing.module.ts`; Test: `test/payments.e2e-spec.ts`.

- [ ] **Step 1: Write the failing e2e** `test/payments.e2e-spec.ts`

Set up like the sales-invoices spec (seed accounts/tax/periods 2026, accountant+approver tokens, a customer). Helper to create+post a sales invoice of total 1,110,000 and return its id + total. Tests:
1. **Partial then full receipt:** create invoice (total 1,110,000). Create+post a RECEIPT payment allocating `600000` to it (cashAccount Kas `1-1000`) → invoice GET shows `paymentStatus=PARTIAL`, `outstanding=510000.0000`. Create+post a second RECEIPT allocating `510000` → `PAID`, `outstanding=0.0000`. Assert the payment GL entry debits Kas and credits AR (`1-1200`).
2. **Full-allocation rule:** a payment whose `amount`(implicit = Σalloc) is fine, but allocating `0` or an allocation amount exceeding the invoice outstanding → 422.
3. **Over-allocation:** allocate `2000000` to a `1,110,000` invoice → 422.
4. **Void restores outstanding:** post a receipt fully paying an invoice (`PAID`), then void the payment → invoice back to `UNPAID`, `outstanding=total`; and the invoice can then be voided.
5. **Reconciliation invariant:** after a mix of posted invoices + partial payments, assert the AR control (`1-1200`) GL balance (via `BalancesService.accountBalance`) equals Σ customer-invoice `outstanding`.

(Write concrete assertions with the exact rupiah figures above.) Run → FAIL.

- [ ] **Step 2: PaymentsService** `src/invoicing/payments.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { Payment, PaymentDirection, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService } from '../ledger/posting/posting.service';
import { ConflictDomainError, NotFoundDomainError, ValidationFailedError } from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentNumberService } from './document-number.service';

const AR_CONTROL_CODE = '1-1200';
const AP_CONTROL_CODE = '2-1000';

export interface AllocationInput { salesInvoiceId?: string; purchaseBillId?: string; amount: string; }
export interface CreatePaymentInput {
  direction: PaymentDirection;
  partnerId: string;
  date: Date;
  cashAccountId: string;
  description?: string;
  allocations: AllocationInput[];
  createdBy: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly posting: PostingService,
    private readonly docNumber: DocumentNumberService,
  ) {}

  private async controlId(code: string): Promise<string> {
    const a = await this.prisma.client.account.findFirst({ where: { code } });
    if (!a) throw new ValidationFailedError('Control account missing from chart', { code });
    return a.id;
  }

  /** Load the target document (sales invoice for RECEIPT, purchase bill for DISBURSEMENT). */
  private async loadTarget(direction: PaymentDirection, alloc: AllocationInput) {
    if (direction === 'RECEIPT') {
      if (!alloc.salesInvoiceId || alloc.purchaseBillId) throw new ValidationFailedError('A receipt allocation must reference a sales invoice', {});
      const inv = await this.prisma.client.salesInvoice.findFirst({ where: { id: alloc.salesInvoiceId } });
      if (!inv) throw new NotFoundDomainError('Sales invoice not found', { id: alloc.salesInvoiceId });
      return { id: inv.id, partnerId: inv.partnerId, status: inv.status, total: inv.total, amountPaid: inv.amountPaid };
    }
    if (!alloc.purchaseBillId || alloc.salesInvoiceId) throw new ValidationFailedError('A disbursement allocation must reference a purchase bill', {});
    const bill = await this.prisma.client.purchaseBill.findFirst({ where: { id: alloc.purchaseBillId } });
    if (!bill) throw new NotFoundDomainError('Purchase bill not found', { id: alloc.purchaseBillId });
    return { id: bill.id, partnerId: bill.partnerId, status: bill.status, total: bill.total, amountPaid: bill.amountPaid };
  }

  async createDraft(input: CreatePaymentInput): Promise<Payment> {
    if (input.allocations.length === 0) throw new ValidationFailedError('A payment needs at least one allocation', {});
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isActive) throw new ValidationFailedError('Partner is inactive', { partnerId: input.partnerId });
    if (input.direction === 'RECEIPT' && !partner.isCustomer) throw new ValidationFailedError('Receipt requires a customer', { partnerId: input.partnerId });
    if (input.direction === 'DISBURSEMENT' && !partner.isVendor) throw new ValidationFailedError('Disbursement requires a vendor', { partnerId: input.partnerId });
    const cash = await this.prisma.client.account.findFirst({ where: { id: input.cashAccountId } });
    if (!cash || !cash.isPostable || !cash.isActive) throw new ValidationFailedError('Cash account is not postable', { cashAccountId: input.cashAccountId });

    let total = Money.zero();
    for (const alloc of input.allocations) {
      const amt = Money.of(alloc.amount);
      if (amt.isZero() || amt.isNegative()) throw new ValidationFailedError('Allocation amount must be positive', {});
      const target = await this.loadTarget(input.direction, alloc);
      if (target.partnerId !== input.partnerId) throw new ValidationFailedError('Allocated document belongs to another partner', { documentId: target.id });
      if (target.status !== 'POSTED') throw new ValidationFailedError('Can only allocate to a POSTED document', { documentId: target.id, status: target.status });
      const outstanding = Money.of(target.total.toString()).subtract(Money.of(target.amountPaid.toString()));
      // amt > outstanding  ⟺  (outstanding − amt) < 0
      if (outstanding.subtract(amt).isNegative()) {
        throw new ValidationFailedError('Allocation exceeds the document outstanding', { documentId: target.id });
      }
      total = total.add(amt);
    }

    return this.prisma.client.payment.create({
      data: {
        direction: input.direction, partnerId: input.partnerId, date: input.date, cashAccountId: input.cashAccountId,
        amount: total.toPersistence(), description: input.description, createdBy: input.createdBy,
        allocations: { create: input.allocations.map((a) => ({ salesInvoiceId: a.salesInvoiceId, purchaseBillId: a.purchaseBillId, amount: a.amount })) },
      },
      include: { allocations: true },
    });
  }

  async getById(id: string): Promise<Payment> {
    const p = await this.prisma.client.payment.findFirst({ where: { id }, include: { allocations: true } });
    if (!p) throw new NotFoundDomainError('Payment not found', { id });
    return p;
  }
  async list(filter: { partnerId?: string; direction?: string; status?: string }): Promise<Payment[]> {
    return this.prisma.client.payment.findMany({ where: { partnerId: filter.partnerId, direction: filter.direction as never, status: filter.status as never }, orderBy: { createdAt: 'desc' } });
  }
  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    const p = await this.getById(id);
    if (p.status !== 'DRAFT') throw new ValidationFailedError('Only a DRAFT payment can be deleted', { id, status: p.status });
    const res = await this.prisma.client.payment.updateMany({ where: { id, status: 'DRAFT', deletedAt: null }, data: { deletedAt: new Date(), deletedBy } });
    if (res.count !== 1) throw new ValidationFailedError('Only a DRAFT payment can be deleted', { id });
  }

  async post(id: string, postedBy: string): Promise<Payment> {
    const payment = await this.getById(id);
    if (payment.status !== 'DRAFT') throw new ValidationFailedError('Payment is not a draft', { id, status: payment.status });
    const allocations = (payment as Payment & { allocations: { salesInvoiceId: string | null; purchaseBillId: string | null; amount: Prisma.Decimal }[] }).allocations;
    const isReceipt = payment.direction === 'RECEIPT';
    const controlId = await this.controlId(isReceipt ? AR_CONTROL_CODE : AP_CONTROL_CODE);
    const amount = Money.of(payment.amount.toString());

    // Build the 2-line journal: RECEIPT Dr cash / Cr AR ; DISBURSEMENT Dr AP / Cr cash.
    const journalInput = {
      date: payment.date,
      description: payment.description ?? `Payment ${id}`,
      sourceType: 'PAYMENT' as const,
      sourceId: id,
      createdBy: payment.createdBy,
      lines: isReceipt
        ? [
            { accountId: payment.cashAccountId, debit: amount.toPersistence() },
            { accountId: controlId, credit: amount.toPersistence() },
          ]
        : [
            { accountId: controlId, debit: amount.toPersistence() },
            { accountId: payment.cashAccountId, credit: amount.toPersistence() },
          ],
    };
    const { periodId, fiscalYear } = await this.posting.preparePosting(journalInput, postedBy);

    await this.prisma.client.$transaction(async (tx) => {
      // Lock + re-check the payment is still a draft.
      const lockedP = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM payments WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
      if (lockedP.length === 0 || lockedP[0].status !== 'DRAFT') throw new ValidationFailedError('Payment is no longer a draft', { id });

      // Lock each target document FOR UPDATE and re-verify outstanding (the real over-allocation guard).
      for (const a of allocations) {
        const amt = Money.of(a.amount.toString());
        if (isReceipt) {
          const rows = await tx.$queryRaw<{ status: string; total: string; amount_paid: string }[]>`
            SELECT status, total, amount_paid FROM sales_invoices WHERE id = ${a.salesInvoiceId} AND deleted_at IS NULL FOR UPDATE`;
          if (rows.length === 0 || rows[0].status !== 'POSTED') throw new ValidationFailedError('Allocated invoice is not posted', { id: a.salesInvoiceId });
          const outstanding = Money.of(rows[0].total).subtract(Money.of(rows[0].amount_paid));
          if (outstanding.subtract(amt).isNegative()) throw new ConflictDomainError('Allocation now exceeds outstanding', { id: a.salesInvoiceId });
          await tx.salesInvoice.update({ where: { id: a.salesInvoiceId! }, data: { amountPaid: { increment: a.amount } } });
        } else {
          const rows = await tx.$queryRaw<{ status: string; total: string; amount_paid: string }[]>`
            SELECT status, total, amount_paid FROM purchase_bills WHERE id = ${a.purchaseBillId} AND deleted_at IS NULL FOR UPDATE`;
          if (rows.length === 0 || rows[0].status !== 'POSTED') throw new ValidationFailedError('Allocated bill is not posted', { id: a.purchaseBillId });
          const outstanding = Money.of(rows[0].total).subtract(Money.of(rows[0].amount_paid));
          if (outstanding.subtract(amt).isNegative()) throw new ConflictDomainError('Allocation now exceeds outstanding', { id: a.purchaseBillId });
          await tx.purchaseBill.update({ where: { id: a.purchaseBillId! }, data: { amountPaid: { increment: a.amount } } });
        }
      }

      const number = await this.docNumber.next(tx, isReceipt ? 'PAY-RCV' : 'PAY-DSB', fiscalYear);
      const ref = this.docNumber.buildRef(isReceipt ? 'PAY-RCV' : 'PAY-DSB', fiscalYear, number);
      const entry = await this.posting.createPostedEntryInTx(tx, journalInput, postedBy, periodId, fiscalYear);
      await tx.payment.update({ where: { id }, data: { status: 'POSTED', number, ref, fiscalYear, journalEntryId: entry.id, postedBy, postedAt: new Date() } });
    });
    return this.getById(id);
  }

  async void(id: string, voidedBy: string): Promise<Payment> {
    const payment = await this.getById(id);
    if (payment.status !== 'POSTED') throw new ValidationFailedError('Only a POSTED payment can be voided', { id, status: payment.status });
    const allocations = (payment as Payment & { allocations: { salesInvoiceId: string | null; purchaseBillId: string | null; amount: Prisma.Decimal }[] }).allocations;
    const { original, periodId, fiscalYear, reversalDate } = await this.posting.prepareReversal(payment.journalEntryId!);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM payments WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'POSTED') throw new ValidationFailedError('Payment is not posted', { id });
        for (const a of allocations) {
          if (a.salesInvoiceId) await tx.salesInvoice.update({ where: { id: a.salesInvoiceId }, data: { amountPaid: { decrement: a.amount } } });
          if (a.purchaseBillId) await tx.purchaseBill.update({ where: { id: a.purchaseBillId }, data: { amountPaid: { decrement: a.amount } } });
        }
        await this.posting.reverseInTx(tx, original, voidedBy, periodId, fiscalYear, reversalDate);
        await tx.payment.update({ where: { id }, data: { status: 'VOID' } });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ValidationFailedError('Payment journal entry was already reversed', { id });
      throw err;
    }
    return this.getById(id);
  }
}
```

Note: `Money` has no `isPositive`/`gt`, so "amount exceeds outstanding" is expressed as `outstanding.subtract(amt).isNegative()` (i.e. `outstanding − amt < 0`). Use that idiom consistently for all over-allocation checks.

- [ ] **Step 3: DTO** `src/invoicing/dto/create-payment.dto.ts`

```typescript
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';

export class AllocationDto {
  @IsOptional() @IsUUID() salesInvoiceId?: string;
  @IsOptional() @IsUUID() purchaseBillId?: string;
  @Matches(/^\d+(\.\d{1,4})?$/, { message: 'amount must be a positive decimal' }) amount!: string;
}

export class CreatePaymentDto {
  @IsIn(['RECEIPT', 'DISBURSEMENT']) direction!: 'RECEIPT' | 'DISBURSEMENT';
  @IsUUID() partnerId!: string;
  @IsDateString() date!: string;
  @IsUUID() cashAccountId!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations!: AllocationDto[];
}
```

- [ ] **Step 4: Controller** `src/invoicing/payments.controller.ts` — `@Controller('payments')`; `GET` (filters), `GET :id`, `POST` (draft, ACCT+), `POST :id/post` (APPROVER+, 200), `POST :id/void` (APPROVER+, 200), `DELETE :id` (ACCT+, 204). Same shape as the sales-invoices controller; `create` maps `date` to `new Date(dto.date)` and passes `createdBy: user.id`.

- [ ] **Step 5: Register** `PaymentsService` + `PaymentsController` in `InvoicingModule`.

- [ ] **Step 6: Run** `npm run test:e2e -- payments` → PASS; full `npm run test:e2e`; `npm test`; build; lint.

- [ ] **Step 7: Commit** `git commit -m "feat(invoicing): payments with full allocation + AR/AP reconciliation"`

---

## Self-review (against the spec)

**Spec coverage:**
- §2 module layout (InvoicingModule → Ledger+Tax; separate models + shared helper) → Task 1 (module, LedgerTx) + Task 3 (DocumentPostingService) ✓
- §3 data model (7 models, enums, JournalSourceType extension, soft-delete, derived outstanding/paymentStatus) → Task 1 schema + each service's `present()` ✓
- §4 invoice/bill lifecycle (draft totals via TaxService; post via createPostedEntryInTx + gapless number + AR/AP control; void blocked if amountPaid>0) → Tasks 3 & 4 ✓
- §4 posting mechanism (additive createPostedEntryInTx/reverseInTx; existing methods → wrappers; Phase-2 e2e green) → Task 1 Step 5–6 ✓
- §5 payments (full allocation = Σ; over-allocation FOR UPDATE re-check; increment/decrement amountPaid; void restores) → Task 5 ✓
- §6 numbering (gapless per docType+fiscalYear) → Task 1 DocumentNumberService ✓
- §7 API surface + roles → Tasks 2–5 controllers ✓
- §8 testing incl. reconciliation invariant + Phase-1–3 regression → each task's e2e + Task 5 step 1.5 ✓

**Placeholder scan:** the `update` methods for invoices/bills and the purchase-bill DTO/controller are described as "mirror" with the exact differences enumerated and full sibling code shown (Task 3/4) rather than re-pasted verbatim — acceptable since the complete sales-invoice code is the template and every delta is explicit. No `TODO`/`TBD`.

**Type consistency:** `LedgerTx` (exported from posting.service) is used by `DocumentPostingService`, `SalesInvoicesService`, `PurchaseBillsService`, `PaymentsService`; `createPostedEntryInTx(tx, input, postedBy, periodId, fiscalYear)` / `reverseInTx(tx, original, reversedBy, periodId, fiscalYear)` / `preparePosting` / `prepareReversal` signatures match every call site; `TaxableLineInput`/`TaxCalculation` reused from `tax.service`; `Money` API (`of`, `zero`, `add`, `subtract`, `multiply`, `equals`, `isZero`, `isNegative`, `toPersistence`) matches the codebase; control-account codes `1-1200`/`2-1000`/`1-1000` exist in the chart.
