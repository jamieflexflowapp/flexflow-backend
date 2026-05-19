-- Migration 008: budget_categories
-- User budget category settings (Budgeting Engine v5.3)
-- Budgets are set as PERCENTAGES of take-home income, not fixed amounts
-- This is the core FlexFlow differentiator — adaptive budgets

CREATE TABLE IF NOT EXISTS budget_categories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Category
  category_name         VARCHAR(100) NOT NULL,              -- 'Eating out', 'Transport' etc
  category_key          VARCHAR(50) NOT NULL,               -- 'eating_out', 'transport' etc

  -- Budget as percentage of take-home (NOT fixed amount)
  budget_pct            DECIMAL(5,2) NOT NULL,              -- e.g. 8.00 = 8% of take-home
  budget_amount         DECIMAL(12,2),                      -- Calculated amount for current month

  -- Spending this month
  spent_amount          DECIMAL(12,2) DEFAULT 0.00,
  spent_pct             DECIMAL(5,2) DEFAULT 0.00,          -- % of budget used

  -- Alert thresholds
  alert_at_pct          DECIMAL(5,2) DEFAULT 80.00,         -- Alert when 80% spent

  -- Display
  icon                  VARCHAR(50),
  colour                VARCHAR(20),
  display_order         INTEGER DEFAULT 0,

  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, category_key)
);

CREATE INDEX idx_budget_categories_user_id ON budget_categories(user_id);
