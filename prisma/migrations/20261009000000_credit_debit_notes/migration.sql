-- Sales credit notes (nota retur penjualan) and purchase debit notes (nota
-- retur pembelian), each linked to exactly ONE posted original document.
--   * JournalSourceType gains SALES_CREDIT_NOTE / PURCHASE_DEBIT_NOTE (not used
--     by any statement below, so ADD VALUE in this transaction is fine).
--   * sales_invoices / purchase_bills.credited_total: the part settled by
--     POSTED notes. Existing rows get 0, so outstanding (total − amount_paid −
--     credited_total) and the new range CHECK hold for them unchanged.
--   * sales_credit_notes / purchase_debit_notes (+ lines): a note's lines each
--     reference one line of the original (original_line_id) with the returned
--     quantity; price/discount/account/tax codes are copied by the app.
--     credited_amount = what settled the original at post; unapplied_amount =
--     the remaining excess (partner credit on the advance account).
--   * payment_applications may now apply a note's excess instead of a
--     payment's advance: payment_id becomes nullable and exactly one source
--     (payment / sales credit note / purchase debit note) is required, a credit
--     note only onto a sales invoice and a debit note only onto a purchase bill.

-- AlterEnum


ALTER TYPE "JournalSourceType" ADD VALUE 'SALES_CREDIT_NOTE';
ALTER TYPE "JournalSourceType" ADD VALUE 'PURCHASE_DEBIT_NOTE';

-- AlterTable
ALTER TABLE "payment_applications" ADD COLUMN     "purchase_debit_note_id" TEXT,
ADD COLUMN     "sales_credit_note_id" TEXT,
ALTER COLUMN "payment_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "purchase_bills" ADD COLUMN     "credited_total" DECIMAL(20,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN     "credited_total" DECIMAL(20,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sales_credit_notes" (
    "id" TEXT NOT NULL,
    "number" INTEGER,
    "ref" TEXT,
    "fiscal_year" INTEGER,
    "partner_id" TEXT NOT NULL,
    "original_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "withholding_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credited_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "unapplied_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "created_by" TEXT NOT NULL,
    "posted_by" TEXT,
    "posted_at" TIMESTAMP(3),
    "voided_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "sales_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_credit_note_lines" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "original_line_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "discount_percent" DECIMAL(7,4),
    "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(20,4) NOT NULL,
    "tax_code_ids" TEXT[],

    CONSTRAINT "sales_credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_debit_notes" (
    "id" TEXT NOT NULL,
    "number" INTEGER,
    "ref" TEXT,
    "fiscal_year" INTEGER,
    "partner_id" TEXT NOT NULL,
    "original_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "withholding_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "credited_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "unapplied_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "journal_entry_id" TEXT,
    "created_by" TEXT NOT NULL,
    "posted_by" TEXT,
    "posted_at" TIMESTAMP(3),
    "voided_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" TEXT,

    CONSTRAINT "purchase_debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_debit_note_lines" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "original_line_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "quantity" DECIMAL(20,4) NOT NULL,
    "unit_price" DECIMAL(20,4) NOT NULL,
    "discount_percent" DECIMAL(7,4),
    "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(20,4) NOT NULL,
    "tax_code_ids" TEXT[],

    CONSTRAINT "purchase_debit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_credit_notes_deleted_at_idx" ON "sales_credit_notes"("deleted_at");

-- CreateIndex
CREATE INDEX "sales_credit_notes_partner_id_idx" ON "sales_credit_notes"("partner_id");

-- CreateIndex
CREATE INDEX "sales_credit_notes_original_id_idx" ON "sales_credit_notes"("original_id");

-- CreateIndex
CREATE INDEX "sales_credit_notes_journal_entry_id_idx" ON "sales_credit_notes"("journal_entry_id");

-- CreateIndex
CREATE INDEX "sales_credit_notes_ref_trgm" ON "sales_credit_notes" USING GIN ("ref" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "sales_credit_notes_description_trgm" ON "sales_credit_notes" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "sales_credit_notes_fiscal_year_number_key" ON "sales_credit_notes"("fiscal_year", "number");

-- CreateIndex
CREATE INDEX "sales_credit_note_lines_account_id_idx" ON "sales_credit_note_lines"("account_id");

-- CreateIndex
CREATE INDEX "sales_credit_note_lines_original_line_id_idx" ON "sales_credit_note_lines"("original_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_credit_note_lines_note_id_line_no_key" ON "sales_credit_note_lines"("note_id", "line_no");

-- CreateIndex
CREATE INDEX "purchase_debit_notes_deleted_at_idx" ON "purchase_debit_notes"("deleted_at");

-- CreateIndex
CREATE INDEX "purchase_debit_notes_partner_id_idx" ON "purchase_debit_notes"("partner_id");

-- CreateIndex
CREATE INDEX "purchase_debit_notes_original_id_idx" ON "purchase_debit_notes"("original_id");

-- CreateIndex
CREATE INDEX "purchase_debit_notes_journal_entry_id_idx" ON "purchase_debit_notes"("journal_entry_id");

-- CreateIndex
CREATE INDEX "purchase_debit_notes_ref_trgm" ON "purchase_debit_notes" USING GIN ("ref" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "purchase_debit_notes_description_trgm" ON "purchase_debit_notes" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_debit_notes_fiscal_year_number_key" ON "purchase_debit_notes"("fiscal_year", "number");

-- CreateIndex
CREATE INDEX "purchase_debit_note_lines_account_id_idx" ON "purchase_debit_note_lines"("account_id");

-- CreateIndex
CREATE INDEX "purchase_debit_note_lines_original_line_id_idx" ON "purchase_debit_note_lines"("original_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_debit_note_lines_note_id_line_no_key" ON "purchase_debit_note_lines"("note_id", "line_no");

-- CreateIndex
CREATE INDEX "payment_applications_sales_credit_note_id_idx" ON "payment_applications"("sales_credit_note_id");

-- CreateIndex
CREATE INDEX "payment_applications_purchase_debit_note_id_idx" ON "payment_applications"("purchase_debit_note_id");

-- AddForeignKey
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_sales_credit_note_id_fkey" FOREIGN KEY ("sales_credit_note_id") REFERENCES "sales_credit_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_purchase_debit_note_id_fkey" FOREIGN KEY ("purchase_debit_note_id") REFERENCES "purchase_debit_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "business_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_original_id_fkey" FOREIGN KEY ("original_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_note_lines" ADD CONSTRAINT "sales_credit_note_lines_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "sales_credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_note_lines" ADD CONSTRAINT "sales_credit_note_lines_original_line_id_fkey" FOREIGN KEY ("original_line_id") REFERENCES "sales_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_credit_note_lines" ADD CONSTRAINT "sales_credit_note_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_debit_notes" ADD CONSTRAINT "purchase_debit_notes_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "business_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_debit_notes" ADD CONSTRAINT "purchase_debit_notes_original_id_fkey" FOREIGN KEY ("original_id") REFERENCES "purchase_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_debit_notes" ADD CONSTRAINT "purchase_debit_notes_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_debit_note_lines" ADD CONSTRAINT "purchase_debit_note_lines_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "purchase_debit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_debit_note_lines" ADD CONSTRAINT "purchase_debit_note_lines_original_line_id_fkey" FOREIGN KEY ("original_line_id") REFERENCES "purchase_bill_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_debit_note_lines" ADD CONSTRAINT "purchase_debit_note_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-authored invariants ---------------------------------------------------

-- What notes settled never exceeds what the payments left open.
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_credited_total_range"
  CHECK ("credited_total" >= 0 AND "amount_paid" + "credited_total" <= "total");
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_credited_total_range"
  CHECK ("credited_total" >= 0 AND "amount_paid" + "credited_total" <= "total");

-- Note money: non-negative; settled + still-unapplied never exceed the total.
ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_amounts_valid"
  CHECK ("subtotal" >= 0 AND "tax_total" >= 0 AND "withholding_total" >= 0
         AND "total" >= 0 AND "discount_total" >= 0
         AND "credited_amount" >= 0 AND "unapplied_amount" >= 0
         AND "credited_amount" + "unapplied_amount" <= "total");
ALTER TABLE "purchase_debit_notes" ADD CONSTRAINT "purchase_debit_notes_amounts_valid"
  CHECK ("subtotal" >= 0 AND "tax_total" >= 0 AND "withholding_total" >= 0
         AND "total" >= 0 AND "discount_total" >= 0
         AND "credited_amount" >= 0 AND "unapplied_amount" >= 0
         AND "credited_amount" + "unapplied_amount" <= "total");

-- Same document/journal link rule as invoices/bills/payments (20261002000000).
ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_journal_entry_iff_not_draft"
  CHECK (("status" = 'DRAFT') = ("journal_entry_id" IS NULL));
ALTER TABLE "purchase_debit_notes" ADD CONSTRAINT "purchase_debit_notes_journal_entry_iff_not_draft"
  CHECK (("status" = 'DRAFT') = ("journal_entry_id" IS NULL));

-- A returned quantity is positive; the discount rule matches document lines.
ALTER TABLE "sales_credit_note_lines" ADD CONSTRAINT "sales_credit_note_lines_valid" CHECK (
  quantity > 0 AND unit_price >= 0
  AND discount_amount >= 0
  AND discount_amount <= round(quantity * unit_price, 4)
  AND amount >= 0
  AND (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100))
);
ALTER TABLE "purchase_debit_note_lines" ADD CONSTRAINT "purchase_debit_note_lines_valid" CHECK (
  quantity > 0 AND unit_price >= 0
  AND discount_amount >= 0
  AND discount_amount <= round(quantity * unit_price, 4)
  AND amount >= 0
  AND (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100))
);

-- Exactly one credit source; a note's excess lands only on its own kind.
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_one_source"
  CHECK (num_nonnulls("payment_id", "sales_credit_note_id", "purchase_debit_note_id") = 1
         AND ("sales_credit_note_id" IS NULL OR "sales_invoice_id" IS NOT NULL)
         AND ("purchase_debit_note_id" IS NULL OR "purchase_bill_id" IS NOT NULL));

-- Financial history: no TRUNCATE (same guard as the other document tables).
CREATE TRIGGER sales_credit_notes_no_truncate BEFORE TRUNCATE ON sales_credit_notes
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER sales_credit_note_lines_no_truncate BEFORE TRUNCATE ON sales_credit_note_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER purchase_debit_notes_no_truncate BEFORE TRUNCATE ON purchase_debit_notes
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER purchase_debit_note_lines_no_truncate BEFORE TRUNCATE ON purchase_debit_note_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
