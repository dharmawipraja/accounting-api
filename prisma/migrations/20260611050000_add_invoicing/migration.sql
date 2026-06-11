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
