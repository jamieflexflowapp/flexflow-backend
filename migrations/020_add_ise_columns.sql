-- Migration 020: Add ISE v1.5 columns to users table
-- Personal Income smoothing fields

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS personal_income           NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence_level          VARCHAR(10)   DEFAULT 'LOW',
  ADD COLUMN IF NOT EXISTS gross_avg_monthly_se      NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserve_amount            NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserve_buffer_pct        NUMERIC(5,4)  DEFAULT 0.15,
  ADD COLUMN IF NOT EXISTS rolling_window_months     INTEGER       DEFAULT 6,
  ADD COLUMN IF NOT EXISTS months_of_data            INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_smoothing_calculated TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tax_pot_target            NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS employer_name             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS company_name              VARCHAR(255),
  ADD COLUMN IF NOT EXISTS receives_pension          BOOLEAN       DEFAULT false,
  ADD COLUMN IF NOT EXISTS partnership_profit_share_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS partnership_utr           VARCHAR(20);
