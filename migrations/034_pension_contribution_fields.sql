-- ════════════════════════════════════════════════════════════════════════════
-- Migration 034 — Pension Contribution Fields
-- ════════════════════════════════════════════════════════════════════════════
-- Purpose:
--   Adds the user-facing pension contribution fields required by Tax Engine
--   v4.0 (Pension Contributions Engine). Supports both flows:
--     Sole Traders   — personal contributions only (RAS at 20%)
--     Ltd Directors  — employer contributions + personal contributions
--
--   Also adds MPAA flag and contribution frequency for UI display.
--
--   All fields default to safe values (zero contributions, no MPAA, annual
--   frequency) so existing users get correct calculations without any
--   onboarding update.
--
-- Verified against: FlexFlow Tax Engine Specification v4.0, Part 1e.4.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Personal pension contribution (NET — what user pays from bank) ──────
-- Used by BOTH sole traders AND Ltd directors making personal contributions.
-- Engine grosses this up at 20% basic rate relief at source.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS annual_personal_pension_net NUMERIC(10,2) DEFAULT 0.00;

ALTER TABLE users
  ADD CONSTRAINT users_personal_pension_net_check
  CHECK (annual_personal_pension_net >= 0);

COMMENT ON COLUMN users.annual_personal_pension_net IS
  'Annual personal pension contribution NET amount (user pays this from bank). Engine grosses up at 20%% relief at source. Capped at relevant UK earnings (trading profit for ST, salary for Ltd director). Used by sole traders AND Ltd directors making personal contributions.';

-- ── 2. Employer pension contribution (GROSS — company pays direct) ─────────
-- Ltd directors ONLY. Allowable business expense under BIM46035 — reduces
-- Corporation Tax. NOT limited by director salary.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS annual_employer_pension_contribution NUMERIC(10,2) DEFAULT 0.00;

ALTER TABLE users
  ADD CONSTRAINT users_employer_pension_check
  CHECK (annual_employer_pension_contribution >= 0);

COMMENT ON COLUMN users.annual_employer_pension_contribution IS
  'Annual employer pension contribution GROSS amount (company pays direct to scheme). Allowable business expense under BIM46035 — reduces Corporation Tax. NOT capped by director salary. Ltd directors only — should be 0 for sole traders.';

-- ── 3. MPAA triggered flag ─────────────────────────────────────────────────
-- Money Purchase Annual Allowance triggered when user flexibly accesses a
-- defined contribution pension. Reduces AA from £60,000 to £10,000.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mpaa_triggered BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN users.mpaa_triggered IS
  'Money Purchase Annual Allowance triggered (user has flexibly accessed a DC pension). When TRUE, annual allowance drops to £10,000 regardless of income. Cannot use carry-forward when MPAA applies.';

-- ── 4. MPAA trigger date (optional, for reporting) ─────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mpaa_trigger_date DATE;

COMMENT ON COLUMN users.mpaa_trigger_date IS
  'Date when MPAA was first triggered (if user has flexibly accessed pension). Used for reporting and audit trail. Nullable — only set when mpaa_triggered = TRUE.';

-- ── 5. Pension contribution frequency (UI display only) ────────────────────
-- Annual figures still drive the calculation — this is for UX presentation.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pension_contribution_frequency TEXT DEFAULT 'annual';

ALTER TABLE users
  ADD CONSTRAINT users_pension_frequency_check
  CHECK (pension_contribution_frequency IN ('monthly', 'quarterly', 'annual'));

COMMENT ON COLUMN users.pension_contribution_frequency IS
  'How the user thinks about their contribution. UI display only — annual figures drive the calculation. Values: monthly | quarterly | annual.';

-- ── 6. Verification ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'annual_personal_pension_net'
  ) THEN
    RAISE EXCEPTION 'Migration 034 failed: annual_personal_pension_net column not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'annual_employer_pension_contribution'
  ) THEN
    RAISE EXCEPTION 'Migration 034 failed: annual_employer_pension_contribution column not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'mpaa_triggered'
  ) THEN
    RAISE EXCEPTION 'Migration 034 failed: mpaa_triggered column not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'pension_contribution_frequency'
  ) THEN
    RAISE EXCEPTION 'Migration 034 failed: pension_contribution_frequency column not created';
  END IF;
  RAISE NOTICE 'Migration 034 verified: 5 pension columns created successfully';
END$$;

COMMIT;
