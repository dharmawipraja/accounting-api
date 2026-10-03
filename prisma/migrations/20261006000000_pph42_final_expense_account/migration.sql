-- Final PPh 4(2) withheld by customers is not creditable, so it is an expense
-- (Beban PPh Final), not the 1-1500 Uang Muka PPh prepaid asset. The boot seed
-- now creates 5-9100 and points PPH42-PRE at it, but seeding only runs on an
-- EMPTY database. This brings an existing install to the same state:
--   1. A fresh database (no accounts yet) → nothing to do; the seed handles it.
--   2. Create 5-9100 Beban PPh Final under the 5-0000 header if no account
--      (live or tombstoned) holds that code.
--   3. Repoint the live PPH42-PRE code from 1-1500 to 5-9100 — only when
--      5-9100 is a live, postable, role-less, DEBIT-normal expense (the
--      tax-account rule), so a customized chart is never forced into a shape
--      the API would reject. Posted history is untouched (journal lines keep
--      their accounts); drafts post to 5-9100 from now on.
-- Each change is recorded as an audit_log row (method 'MIGRATION', path = this
-- migration's name); `GET /v1/audit?method=MIGRATION` lists them. No change,
-- no row.
DO $$
DECLARE
  m CONSTANT text := '20261006000000_pph42_final_expense_account';
  header_id text;
  final_id text;
  prepaid_id text;
  code_id text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM accounts WHERE lower(code) = '5-9100') THEN
    SELECT id INTO header_id FROM accounts
      WHERE code = '5-0000' AND deleted_at IS NULL AND is_postable = false;
    INSERT INTO accounts (id, code, name, type, subtype, cash_flow_category,
                          normal_balance, parent_id, is_postable, is_active,
                          currency, created_at, updated_at)
    VALUES (gen_random_uuid()::text, '5-9100', 'Beban PPh Final', 'EXPENSE',
            'OTHER_EXPENSE', 'OPERATING', 'DEBIT', header_id, true, true,
            'IDR', now(), now())
    RETURNING id INTO final_id;
    INSERT INTO audit_log (id, method, path, body, status_code, duration_ms, entity_id)
    VALUES (gen_random_uuid()::text, 'MIGRATION', m,
            jsonb_build_object('table', 'accounts', 'id', final_id,
                               'created', '5-9100 Beban PPh Final'),
            200, 0, final_id);
  END IF;

  SELECT id INTO final_id FROM accounts
    WHERE code = '5-9100' AND deleted_at IS NULL AND is_postable AND role IS NULL
      AND type = 'EXPENSE' AND normal_balance = 'DEBIT'
      AND subtype IN ('OPERATING_EXPENSE', 'OTHER_EXPENSE');
  SELECT id INTO prepaid_id FROM accounts WHERE code = '1-1500';
  IF final_id IS NULL OR prepaid_id IS NULL THEN
    RAISE NOTICE '%: 5-9100 is not a usable expense account (or 1-1500 is missing); PPH42-PRE left unchanged', m;
    RETURN;
  END IF;

  UPDATE tax_codes
     SET tax_account_id = final_id, updated_at = now()
   WHERE code = 'PPH42-PRE' AND deleted_at IS NULL AND kind = 'PPH_PREPAID'
     AND tax_account_id = prepaid_id
  RETURNING id INTO code_id;
  IF code_id IS NOT NULL THEN
    INSERT INTO audit_log (id, method, path, body, status_code, duration_ms, entity_id)
    VALUES (gen_random_uuid()::text, 'MIGRATION', m,
            jsonb_build_object('table', 'tax_codes', 'id', code_id,
                               'old', '1-1500', 'new', '5-9100'),
            200, 0, code_id);
  END IF;
END $$;
