-- ════════════════════════════════════════════════════════════════════════════
-- Migration 033 — Ltd Director associated companies & other PAYE income
-- ════════════════════════════════════════════════════════════════════════════
-- Purpose:
--   Adds the two remaining onboarding fields required by ISE v2.1 to fully
--   model Ltd Director smoothing:
--     1. associated_companies_count — divides CT marginal relief bands
--     2. other_paye_income — additional income shifting personal tax bands
--
-- Both default to safe values (1 company, £0 other PAYE) so existing users
-- get correct calculations without any onboarding update.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Associated companies count ──────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS associated_companies_count INTEGER DEFAULT 1;

ALTER TABLE users
  ADD CONSTRAINT users_associated_companies_check
  CHECK (associated_companies_count >= 1 AND associated_companies_count <= 50);

COMMENT ON COLUMN users.associated_companies_count IS
  'Number of associated companies for CT marginal relief calculation. Default 1 (sole company). HMRC limits divided by this count.';

-- ── 2. Other PAYE income (annual) ──────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS other_paye_income NUMERIC(10,2) DEFAULT 0.00;

ALTER TABLE users
  ADD CONSTRAINT users_other_paye_income_check
  CHECK (other_paye_income >= 0);

COMMENT ON COLUMN users.other_paye_income IS
  'Annual gross PAYE income from another employer (if director has dual income). Shifts personal tax bands for dividend tax calculation.';

-- ── 3. Verification ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'associated_companies_count'
  ) THEN
    RAISE EXCEPTION 'Migration 033 failed: associated_companies_count column not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'other_paye_income'
  ) THEN
    RAISE EXCEPTION 'Migration 033 failed: other_paye_income column not created';
  END IF;
  RAISE NOTICE 'Migration 033 verified: both columns created successfully';
END$$;

COMMIT;
