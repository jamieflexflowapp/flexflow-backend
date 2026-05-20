-- Migration 027: Budget tables
-- Supports adaptive budgeting — category % allocations and transaction categorisation

CREATE TABLE IF NOT EXISTS budget_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  icon          VARCHAR(10)  DEFAULT '📦',
  pct           INTEGER      NOT NULL CHECK (pct >= 1 AND pct <= 100),
  display_order INTEGER      DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT budget_categories_user_name UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS budget_transaction_categories (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_name  VARCHAR(100) NOT NULL,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW(),
  CONSTRAINT budget_txn_cat_unique UNIQUE (user_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_categories_user ON budget_categories(user_id);
CREATE INDEX IF NOT EXISTS idx_budget_txn_cat_user    ON budget_transaction_categories(user_id);
CREATE INDEX IF NOT EXISTS idx_budget_txn_cat_txn     ON budget_transaction_categories(transaction_id);
