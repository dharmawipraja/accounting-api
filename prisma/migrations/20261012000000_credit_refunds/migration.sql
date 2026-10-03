-- Refunds of unapplied customer/vendor credit; opening (go-live) credit.
--   * payment_applications gains a third target, cash_account_id: a REFUND of
--     a holder's unapplied credit (payment advance / credit-or-debit-note
--     excess) in cash instead of an application onto a document. Same row,
--     locks, reversal shape and void guard as an application; its journal is
--     Dr Uang Muka Pelanggan / Cr cash (customer) or Dr cash / Cr Uang Muka
--     Pembelian (vendor).
--   * payments.opening: a go-live deposit/prepayment — no cash moves, the
--     counter account (cash_account_id) is Saldo Awal (OPENING_BALANCE_EQUITY).
-- Existing rows: no refunds, no opening payments, so the defaults are exact.
-- payment_applications already has TRUNCATE protection and app-role grants.

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "opening" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payment_applications" ADD COLUMN     "cash_account_id" TEXT;

-- CreateIndex
CREATE INDEX "payment_applications_cash_account_id_idx" ON "payment_applications"("cash_account_id");

-- AddForeignKey
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_cash_account_id_fkey" FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one target: an invoice, a bill, or (refund) a cash account.
ALTER TABLE "payment_applications" DROP CONSTRAINT "payment_applications_one_target";
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_one_target"
  CHECK (num_nonnulls("sales_invoice_id", "purchase_bill_id", "cash_account_id") = 1);

-- Exactly one source; a credit note never onto a bill, a debit note never onto
-- an invoice (either may be refunded in cash).
ALTER TABLE "payment_applications" DROP CONSTRAINT "payment_applications_one_source";
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_one_source"
  CHECK (num_nonnulls("payment_id", "sales_credit_note_id", "purchase_debit_note_id") = 1
         AND ("sales_credit_note_id" IS NULL OR "purchase_bill_id" IS NULL)
         AND ("purchase_debit_note_id" IS NULL OR "sales_invoice_id" IS NULL));

-- An opening credit is a pure advance: a draft's whole amount is unapplied.
ALTER TABLE "payments" ADD CONSTRAINT "payments_opening_unallocated"
  CHECK (NOT "opening" OR "status" <> 'DRAFT' OR "unapplied_amount" = "amount");
