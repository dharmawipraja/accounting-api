-- AUDIT3-8: a vendor's invoice number may back at most one live purchase bill,
-- so the same supplier invoice cannot be booked (and paid) twice. Live = not
-- soft-deleted and not VOID (voiding or deleting a bill frees its number).
-- Bills without a vendor invoice number are unaffected.

-- Fail LOUDLY (no silent renumbering) if existing data already violates it —
-- an operator must void/delete or correct the duplicates, then re-run.
DO $$
DECLARE
  dups text;
BEGIN
  SELECT string_agg(partner_id || ' / ' || vendor_invoice_no, ', '
                    ORDER BY partner_id, vendor_invoice_no) INTO dups
  FROM (
    SELECT partner_id, vendor_invoice_no
    FROM purchase_bills
    WHERE deleted_at IS NULL AND status <> 'VOID' AND vendor_invoice_no IS NOT NULL
    GROUP BY partner_id, vendor_invoice_no
    HAVING count(*) > 1
  ) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'purchase_bills vendor invoice uniqueness aborted: duplicate live (partner_id / vendor_invoice_no) pairs exist: %. Void, delete or correct the duplicate bills, then re-run the migration.', dups;
  END IF;
END $$;

-- Partial unique index: not expressible in schema.prisma (see the comment on
-- PurchaseBill there). A violation surfaces as P2002 → 409 via mapUniqueViolation.
CREATE UNIQUE INDEX purchase_bills_partner_vendor_invoice_live_key
  ON purchase_bills (partner_id, vendor_invoice_no)
  WHERE deleted_at IS NULL AND status <> 'VOID' AND vendor_invoice_no IS NOT NULL;
