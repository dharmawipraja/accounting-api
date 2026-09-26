-- AUDIT3 iteration-6 (Task 25): a business partner is a customer and/or a
-- vendor, at DB level. Every app path already enforces it
-- (BusinessPartnersService.create / update — the update re-checks against the
-- row locked FOR UPDATE); this CHECK is the backstop for any other writer.
-- Soft-deleted (tombstoned) rows are checked too — none can violate it.

-- Pre-flight: fail LOUDLY (no silent repair) if existing rows break the rule.
DO $$
DECLARE
  n bigint;
  ids text;
BEGIN
  SELECT count(*) INTO n FROM business_partners
    WHERE NOT (is_customer OR is_vendor);
  IF n > 0 THEN
    -- True count; the id list is capped at 20 for readability.
    SELECT string_agg(id || ' (' || code || ')', ', ') INTO ids FROM (
      SELECT id, code FROM business_partners
      WHERE NOT (is_customer OR is_vendor)
      ORDER BY id LIMIT 20) x;
    RAISE EXCEPTION 'business_partners_customer_or_vendor migration aborted — % partner row(s) are neither customer nor vendor: %. Set is_customer and/or is_vendor on them, then re-run the migration.',
      n, ids;
  END IF;
END $$;

ALTER TABLE "business_partners" ADD CONSTRAINT "business_partners_customer_or_vendor"
  CHECK ("is_customer" OR "is_vendor");
