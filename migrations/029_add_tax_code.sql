-- Migration 029: Add tax code to user profile
-- Allows ISE/Tax engine to use actual tax code rather than assuming 1257L

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tax_code          VARCHAR(10)  DEFAULT '1257L',
  ADD COLUMN IF NOT EXISTS tax_code_updated_at TIMESTAMPTZ DEFAULT NULL;

-- Common UK tax codes for reference:
-- 1257L  = standard personal allowance (£12,570) — default
-- BR     = basic rate on all income, no allowance (second job etc)
-- D0     = higher rate on all income, no allowance
-- D1     = additional rate on all income
-- NT     = no tax
-- K codes = negative allowance (tax owed added to income)
-- S prefix = Scottish taxpayer rates apply (e.g. S1257L)
-- C prefix = Welsh taxpayer (e.g. C1257L)

COMMENT ON COLUMN users.tax_code           IS 'HMRC tax code — used for tax calculations. Default 1257L';
COMMENT ON COLUMN users.tax_code_updated_at IS 'Timestamp of last tax code update';
