-- Migration 021: EDE v2 tables + taxable_profit column on users

-- Add taxable_profit and total_deductions to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS taxable_profit    NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_deductions  NUMERIC(12,2) DEFAULT 0;

-- Expense records — confirmed allowable expenses
CREATE TABLE IF NOT EXISTS expense_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,
  tax_year        VARCHAR(9) NOT NULL,
  hmrc_category   VARCHAR(100) NOT NULL,
  business_pct    NUMERIC(5,2) DEFAULT 100,
  deduct_amount   NUMERIC(12,2) NOT NULL,
  auto_detected   BOOLEAN DEFAULT false,
  hmrc_ref        VARCHAR(20),                  -- e.g. 'BIM35820'
  confirmed       BOOLEAN DEFAULT false,         -- true = included in taxable profit
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, transaction_id)
);
CREATE INDEX idx_expense_records_user_year ON expense_records(user_id, tax_year);

-- User expense overrides — stored merchant confirmations
CREATE TABLE IF NOT EXISTS user_expense_overrides (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_pattern VARCHAR(255) NOT NULL,
  business_pct     NUMERIC(5,2) NOT NULL,
  hmrc_category    VARCHAR(100),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, merchant_pattern)
);

-- Home office configuration
CREATE TABLE IF NOT EXISTS home_office_config (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monthly_hours     NUMERIC(6,2) NOT NULL,
  method            VARCHAR(20) DEFAULT 'flat_rate',
  monthly_deduction NUMERIC(10,2) DEFAULT 0,
  annual_deduction  NUMERIC(10,2) DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Mileage log
CREATE TABLE IF NOT EXISTS mileage_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  miles           NUMERIC(8,2) NOT NULL,
  purpose         TEXT NOT NULL,
  journey_date    DATE NOT NULL,
  tax_year        VARCHAR(9) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_mileage_log_user_year ON mileage_log(user_id, tax_year);
