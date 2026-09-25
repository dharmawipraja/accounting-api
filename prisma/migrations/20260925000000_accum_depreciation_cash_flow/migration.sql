-- Accumulated depreciation (credit-normal contra-ASSET) is a non-cash
-- add-back on the cash-flow statement, not an investing flow. Re-tag existing
-- charts; the seed now creates it with cash_flow_category = 'NONE'.
UPDATE accounts
SET cash_flow_category = 'NONE'
WHERE cash_flow_category = 'INVESTING'
  AND normal_balance = 'CREDIT'
  AND type = 'ASSET';
