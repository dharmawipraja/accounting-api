-- Seed the two advance system accounts on an EXISTING install (the boot seed
-- creates them, but seeding only runs on an EMPTY database):
--   2-1300 Uang Muka Pelanggan  LIABILITY, role CUSTOMER_ADVANCE, under 2-0000
--   1-1600 Uang Muka Pembelian  ASSET,     role VENDOR_ADVANCE,   under 1-0000
-- Per account: nothing to do when no accounts exist yet (the seed handles a
-- fresh database) or some account already holds the role (an operator created
-- one); when the code is already taken by another account, it is left alone
-- (NOTICE) — create a role-carrying account via POST /v1/ledger/accounts
-- instead. Until then an unallocated payment / application of that direction
-- is a 422 "Control account missing from chart" (fully allocated payments are
-- unaffected). Each insert is recorded as an audit_log row (method
-- 'MIGRATION', path = this migration's name). Re-running is a no-op.
DO $$
DECLARE
  m CONSTANT text := '20261008100001_payment_advance_accounts';
  spec record;
  header_id text;
  new_id text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts) THEN
    RETURN;
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('2-1300', 'Uang Muka Pelanggan', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 'CUSTOMER_ADVANCE', '2-0000'),
      ('1-1600', 'Uang Muka Pembelian', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 'VENDOR_ADVANCE', '1-0000')
    ) AS t(code, name, type, subtype, normal_balance, role, parent_code)
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM accounts WHERE role::text = spec.role);
    IF EXISTS (SELECT 1 FROM accounts WHERE lower(code) = spec.code) THEN
      RAISE NOTICE '%: code % is taken; no % account created', m, spec.code, spec.role;
      CONTINUE;
    END IF;
    SELECT id INTO header_id FROM accounts
      WHERE code = spec.parent_code AND deleted_at IS NULL AND is_postable = false;
    INSERT INTO accounts (id, code, name, type, subtype, cash_flow_category,
                          role, normal_balance, parent_id, is_postable, is_active,
                          currency, created_at, updated_at)
    VALUES (gen_random_uuid()::text, spec.code, spec.name, spec.type::"AccountType",
            spec.subtype::"AccountSubtype", 'OPERATING', spec.role::"AccountRole",
            spec.normal_balance::"NormalBalance", header_id, true, true,
            'IDR', now(), now())
    RETURNING id INTO new_id;
    INSERT INTO audit_log (id, method, path, body, status_code, duration_ms, entity_id)
    VALUES (gen_random_uuid()::text, 'MIGRATION', m,
            jsonb_build_object('table', 'accounts', 'id', new_id,
                               'created', spec.code || ' ' || spec.name,
                               'role', spec.role),
            200, 0, new_id);
  END LOOP;
END $$;
