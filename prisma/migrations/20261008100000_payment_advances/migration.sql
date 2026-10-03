-- Customer & vendor advances (unallocated payments).
--   * AccountRole gains CUSTOMER_ADVANCE (Uang Muka Pelanggan, a liability) and
--     VENDOR_ADVANCE (Uang Muka Pembelian, an asset); both are singletons via the
--     existing accounts_singleton_role partial unique index.
--   * payments.unapplied_amount: the part of a payment not settling a document
--     (amount − allocations − live applications). Existing payments are fully
--     allocated (amount was always the allocation sum), so the default 0 is exact.
--   * payment_applications: later moves of unapplied amount onto invoices/bills,
--     each with its own posted journal entry; live on [date, reversed_on).
-- The accounts themselves are created by 20261008100001_payment_advance_accounts
-- (a separate migration: a value added by ALTER TYPE ... ADD VALUE cannot be used
-- in the same transaction).

-- AlterEnum
ALTER TYPE "AccountRole" ADD VALUE 'CUSTOMER_ADVANCE';
ALTER TYPE "AccountRole" ADD VALUE 'VENDOR_ADVANCE';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "unapplied_amount" DECIMAL(20,4) NOT NULL DEFAULT 0;
ALTER TABLE "payments" ADD CONSTRAINT "payments_unapplied_amount_range"
  CHECK ("unapplied_amount" >= 0 AND "unapplied_amount" <= "amount");

-- CreateTable
CREATE TABLE "payment_applications" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "sales_invoice_id" TEXT,
    "purchase_bill_id" TEXT,
    "amount" DECIMAL(20,4) NOT NULL,
    "date" DATE NOT NULL,
    "journal_entry_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_on" DATE,
    "reversed_by" TEXT,

    CONSTRAINT "payment_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_applications_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "payment_applications_one_target"
      CHECK (num_nonnulls("sales_invoice_id", "purchase_bill_id") = 1),
    CONSTRAINT "payment_applications_reversal_shape"
      CHECK (("reversed_on" IS NULL) = ("reversed_by" IS NULL)
             AND ("reversed_on" IS NULL OR "reversed_on" >= "date"))
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_applications_journal_entry_id_key" ON "payment_applications"("journal_entry_id");

-- CreateIndex
CREATE INDEX "payment_applications_payment_id_idx" ON "payment_applications"("payment_id");

-- CreateIndex
CREATE INDEX "payment_applications_sales_invoice_id_idx" ON "payment_applications"("sales_invoice_id");

-- CreateIndex
CREATE INDEX "payment_applications_purchase_bill_id_idx" ON "payment_applications"("purchase_bill_id");

-- AddForeignKey
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_sales_invoice_id_fkey" FOREIGN KEY ("sales_invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_purchase_bill_id_fkey" FOREIGN KEY ("purchase_bill_id") REFERENCES "purchase_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Financial history: no TRUNCATE (same guard as payment_allocations).
CREATE TRIGGER payment_applications_no_truncate BEFORE TRUNCATE ON payment_applications
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
