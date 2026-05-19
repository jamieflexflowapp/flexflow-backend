-- Migration 012: runway_snapshots
-- Daily runway trend data (Task 7 — Runway Calculator)
--
-- CRITICAL (Build Note 8):
--   available_balance = bank_balance - tax_pot_balance
--   The tax pot is ALWAYS excluded from available balance
--   Runway denominator = Tier 1 committed outgoings (NOT total projected_expenses)

CREATE TABLE IF NOT EXISTS runway_snapshots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  snapshot_date         DATE NOT NULL,

  -- Balances
  bank_balance          DECIMAL(12,2) NOT NULL,             -- Total current bank balance
  tax_pot_balance       DECIMAL(12,2) NOT NULL,             -- Tax pot (excluded from available)
  available_balance     DECIMAL(12,2) NOT NULL,             -- bank_balance - tax_pot_balance

  -- Runway calculation
  tier1_monthly         DECIMAL(12,2) NOT NULL,             -- Committed outgoings (Tier 1 total)
  runway_weeks          DECIMAL(8,2) NOT NULL,              -- available_balance / (tier1_monthly / 4.33)
  runway_status         VARCHAR(10) NOT NULL,               -- 'GREEN'|'AMBER'|'RED'
  -- RED:   conservative income < 80% of Tier 1 monthly
  -- AMBER: conservative income < Tier 1 monthly
  -- GREEN: conservative income >= Tier 1 monthly

  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_runway_snapshots_user_date ON runway_snapshots(user_id, snapshot_date DESC);
CREATE UNIQUE INDEX idx_runway_snapshots_user_day ON runway_snapshots(user_id, snapshot_date);
