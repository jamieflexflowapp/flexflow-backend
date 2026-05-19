-- Migration 014: expense_rules
-- All HMRC expense categories and rates (EDE v2)
-- Seed before Task 6 begins

CREATE TABLE IF NOT EXISTS expense_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key    VARCHAR(100) NOT NULL UNIQUE,             -- e.g. 'mileage_car'
  category_name   VARCHAR(255) NOT NULL,                    -- 'Business mileage — car'
  hmrc_category   VARCHAR(100),                             -- HMRC classification
  rate_type       VARCHAR(20) NOT NULL,                     -- 'flat'|'mileage'|'percentage'|'actual'
  rate_value      DECIMAL(10,4),                            -- e.g. 0.45 for 45p/mile
  rate_threshold  DECIMAL(12,2),                            -- e.g. 10000 (first 10k miles at 45p)
  rate_above      DECIMAL(10,4),                            -- e.g. 0.25 above threshold
  applies_to      VARCHAR(50) DEFAULT 'all',                -- 'se'|'ltd'|'all'
  notes           TEXT,
  source          TEXT,                                     -- e.g. 'GOV.UK — Expenses if you''re self-employed'
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_expense_rules_key ON expense_rules(category_key);
