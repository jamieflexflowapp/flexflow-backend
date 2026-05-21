-- Migration 032: Ltd Director salary + dividend frequency fields
-- Stores annual salary and dividend frequency preference for Ltd Directors

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS director_salary_annual   NUMERIC(10,2)  DEFAULT 12570,
  ADD COLUMN IF NOT EXISTS dividend_frequency        VARCHAR(20)    DEFAULT 'quarterly'
    CHECK (dividend_frequency IN ('monthly','quarterly','annually','adhoc')),
  ADD COLUMN IF NOT EXISTS dividend_frequency_updated_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN users.director_salary_annual    IS 'Annual director salary — used for tax band stacking. Default £12,570 (NI threshold)';
COMMENT ON COLUMN users.dividend_frequency        IS 'How often director takes dividends — drives review prompts';
