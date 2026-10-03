-- Credit/debit notes carry a void date iff they are VOID — the same CHECK
-- invoices, bills and payments got in 20260925100000_add_voided_on.
-- Hand-authored (CHECKs are not modelled in schema.prisma).
--
-- Pre-check: the app always sets voided_on together with status VOID, so no
-- row should violate this. If one does, the deploy fails here (nothing
-- changed) listing table + id; fix the row(s), then
-- `prisma migrate resolve --rolled-back 20261011000000_note_voided_on_check`
-- and re-run `prisma migrate deploy`.
DO $$
DECLARE
  t text;
  r record;
  problems text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_credit_notes', 'purchase_debit_notes'] LOOP
    FOR r IN EXECUTE format($q$
      SELECT id, status::text AS status, voided_on FROM %I
      WHERE (status = 'VOID') <> (voided_on IS NOT NULL)
      ORDER BY id$q$, t)
    LOOP
      problems := problems || format(E'\n  %s id %s: status %s, voided_on %s',
        t, r.id, r.status, coalesce(r.voided_on::text, 'NULL'));
    END LOOP;
  END LOOP;
  IF problems <> '' THEN
    RAISE EXCEPTION 'note voided_on check aborted (voided_on must be set iff status = VOID):%', problems
      USING HINT = 'Set voided_on to the reversal entry date on each VOID note (or NULL on a non-VOID note), then prisma migrate resolve --rolled-back 20261011000000_note_voided_on_check and re-run prisma migrate deploy. Nothing was changed by this run.';
  END IF;
END $$;

ALTER TABLE "sales_credit_notes" ADD CONSTRAINT "sales_credit_notes_voided_on_iff_void"
  CHECK (("status" = 'VOID') = ("voided_on" IS NOT NULL));
ALTER TABLE "purchase_debit_notes" ADD CONSTRAINT "purchase_debit_notes_voided_on_iff_void"
  CHECK (("status" = 'VOID') = ("voided_on" IS NOT NULL));
