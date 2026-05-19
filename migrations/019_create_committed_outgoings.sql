-- Migration 019: committed_outgoings
-- Tier 1 committed outgoings — used as runway denominator (Build Note 3)
-- CRITICAL: Runway and danger detection use Tier 1 total, NOT total projected_expenses
-- next_due_date column required (used by forecast engine)

CREATE TABLE IF NOT EXISTS committed_outgoings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Outgoing details
  name            VARCHAR(255) NOT NULL,                    -- 'Rent', 'Council Tax', 'Phone' etc
  category        VARCHAR(50) NOT NULL,                     -- 'housing'|'utilities'|'insurance'|'transport'|'subscriptions'|'other'
  amount          DECIMAL(12,2) NOT NULL,                   -- Monthly amount

  -- Recurrence
  frequency       VARCHAR(20) NOT NULL DEFAULT 'monthly',   -- 'monthly'|'quarterly'|'annual'
  monthly_equiv   DECIMAL(12,2) NOT NULL,                   -- Always stored as monthly equivalent

  -- Dates — required for forecast engine
  next_due_date   DATE NOT NULL,
  last_paid_date  DATE,

  -- Classification
  is_tier1        BOOLEAN DEFAULT true,                     -- Tier 1 = non-negotiable committed
  is_active       BOOLEAN DEFAULT true,

  -- Source
  transaction_id  UUID REFERENCES transactions(id),         -- If auto-detected from bank data
  is_auto_detected BOOLEAN DEFAULT false,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_committed_outgoings_user_id ON committed_outgoings(user_id);
CREATE INDEX idx_committed_outgoings_due ON committed_outgoings(user_id, next_due_date);
