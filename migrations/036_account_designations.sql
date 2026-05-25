-- ════════════════════════════════════════════════════════════════════════════
-- Migration 036 — Account designations (Live Pot Designation feature)
--
-- v2 — fixed user_id type: UUID (matches users.id) — was INTEGER which caused
-- FK constraint failure on the original attempt.
--
-- Purpose: lets users designate what each TrueLayer-connected account/pot is
-- for: spending, tax, pension, or future earnings (pre-tax holding).
--
-- Many-to-many model:
--   - one account can hold MULTIPLE designations (e.g. a single current account
--     that doubles as Spending and Tax holder)
--   - one designation can span MULTIPLE accounts (e.g. tax split across two
--     savings pots)
--
-- Priority order when one pot has multiple jobs (enforced in engine, not DB):
--   Tax > Pension > Future Earnings > Spending (whatever's left)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS account_designations (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- bank_account_id refers to the TrueLayer account / pot identifier.
  -- TrueLayer returns these as opaque strings (e.g. "acc_xxx" or "pot_xxx")
  -- so we store as TEXT, not FK to bank_connections (which is per-institution).
  bank_account_id TEXT NOT NULL,
  account_label   TEXT,           -- human-readable name (e.g. "Monzo · Current", "Tax Pot")
  account_provider TEXT,          -- "monzo", "starling", "barclays" etc.
  designation_type TEXT NOT NULL  -- 'spending' | 'tax' | 'pension' | 'future_earnings'
    CHECK (designation_type IN ('spending', 'tax', 'pension', 'future_earnings')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A given account can only hold each designation type ONCE
  UNIQUE (user_id, bank_account_id, designation_type)
);

CREATE INDEX IF NOT EXISTS idx_account_designations_user
  ON account_designations(user_id);

CREATE INDEX IF NOT EXISTS idx_account_designations_type
  ON account_designations(user_id, designation_type);

-- ────────────────────────────────────────────────────────────────────────────
-- Helper view: latest designations summary per user
-- Returns one row per user/designation_type with comma-separated account list.
-- Used by the home page and engines to quickly fetch which account(s) hold
-- spending money, which hold tax money, etc.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_user_designations AS
SELECT
  user_id,
  designation_type,
  COUNT(*)                       AS account_count,
  ARRAY_AGG(bank_account_id)     AS account_ids,
  ARRAY_AGG(account_label)       AS account_labels,
  MAX(updated_at)                AS last_updated
FROM account_designations
GROUP BY user_id, designation_type;

COMMENT ON TABLE account_designations IS
  'Maps TrueLayer accounts/pots to their financial designation (spending/tax/pension/future_earnings). Many-to-many.';
