-- Migration 007: tax_verification
-- Tax Pot Verification Engine status (TPVE v1.2)
-- Tracks whether the user's tax pot is on track

CREATE TABLE IF NOT EXISTS tax_verification (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tax_year              VARCHAR(9) NOT NULL,

  -- Current status
  status                VARCHAR(20) NOT NULL DEFAULT 'TPVE_UNKNOWN',
  -- 'TPVE_GOOD'    — pot balance >= target (all good)
  -- 'TPVE_AMBER'   — pot balance 80-99% of target (monitor)
  -- 'TPVE_RED'     — pot balance < 80% of target (action needed)
  -- 'TPVE_UNKNOWN' — insufficient data

  -- Balances
  current_pot_balance   DECIMAL(12,2) DEFAULT 0.00,
  target_pot_balance    DECIMAL(12,2) DEFAULT 0.00,
  shortfall             DECIMAL(12,2) DEFAULT 0.00,         -- Negative = shortfall, positive = surplus
  coverage_pct          DECIMAL(5,2),                       -- % of target covered

  -- Monthly contribution tracking
  required_monthly      DECIMAL(12,2) DEFAULT 0.00,         -- What should be going in per month
  actual_monthly_avg    DECIMAL(12,2) DEFAULT 0.00,         -- What has been going in on average

  -- Dates
  verified_at           TIMESTAMPTZ DEFAULT NOW(),
  next_review_at        DATE,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, tax_year)
);

CREATE INDEX idx_tax_verification_user_year ON tax_verification(user_id, tax_year);
CREATE INDEX idx_tax_verification_status ON tax_verification(status);
