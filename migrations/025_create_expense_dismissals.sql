-- Migration 025: Expense dismissals
-- Tracks transactions the user has explicitly said are NOT business expenses
-- Allows undo — simply delete the row to move back to pending review
-- FlexFlow Phase 4 — Expense Review UI

CREATE TABLE IF NOT EXISTS expense_dismissals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id   UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  dismissed_at     TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT expense_dismissals_unique UNIQUE (user_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_dismissals_user ON expense_dismissals(user_id);
CREATE INDEX IF NOT EXISTS idx_expense_dismissals_txn  ON expense_dismissals(transaction_id);
