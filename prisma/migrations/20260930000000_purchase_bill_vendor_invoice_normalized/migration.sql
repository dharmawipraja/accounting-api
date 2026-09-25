-- AUDIT3 iteration-2 (Task 13): vendor invoice uniqueness is NORMALIZED — the
-- same supplier invoice typed as 'INV-1', 'inv-1' or ' INV-1 ' is one number.
-- Replaces the exact-match partial unique index from 20260926200000 with one
-- on (partner_id, lower(btrim(vendor_invoice_no))). The API also trims on
-- write (and stores a blank number as NULL); blank legacy values are left out
-- of the index. Live = not soft-deleted and not VOID, as before.

-- Fail LOUDLY (no silent renumbering) if existing live bills already collide
-- under the normalized key — an operator must void/delete or correct them,
-- then re-run.
DO $$
DECLARE
  dups text;
BEGIN
  SELECT string_agg(partner_id || ' / ' || norm_no, ', '
                    ORDER BY partner_id, norm_no) INTO dups
  FROM (
    SELECT partner_id, lower(btrim(vendor_invoice_no)) AS norm_no
    FROM purchase_bills
    WHERE deleted_at IS NULL AND status <> 'VOID'
      AND vendor_invoice_no IS NOT NULL AND btrim(vendor_invoice_no) <> ''
    GROUP BY partner_id, lower(btrim(vendor_invoice_no))
    HAVING count(*) > 1
  ) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'purchase_bills normalized vendor invoice uniqueness aborted: live bills share a (partner_id / lower(btrim(vendor_invoice_no))) pair: %. Void, delete or correct the duplicate bills, then re-run the migration.', dups;
  END IF;
END $$;

DROP INDEX IF EXISTS purchase_bills_partner_vendor_invoice_live_key;

-- Partial expression unique index: not expressible in schema.prisma (see the
-- comment on PurchaseBill there). A violation surfaces as P2002 → 409 via
-- mapUniqueViolation.
CREATE UNIQUE INDEX purchase_bills_partner_vendor_invoice_norm_live_key
  ON purchase_bills (partner_id, lower(btrim(vendor_invoice_no)))
  WHERE deleted_at IS NULL AND status <> 'VOID'
    AND vendor_invoice_no IS NOT NULL AND btrim(vendor_invoice_no) <> '';
