-- Migration 031: Plan-based bank account limits
-- Controls how many bank accounts each plan can connect

CREATE TABLE IF NOT EXISTS plan_config (
  plan            VARCHAR(20) PRIMARY KEY,  -- 'free', 'plus', 'pro'
  max_bank_accounts INTEGER NOT NULL,       -- -1 = unlimited
  max_income_sources INTEGER DEFAULT -1,
  display_name    VARCHAR(50) NOT NULL,
  monthly_price_gbp NUMERIC(6,2) DEFAULT 0
);

INSERT INTO plan_config (plan, max_bank_accounts, display_name, monthly_price_gbp)
VALUES
  ('free', 1,  'Free',  0.00),
  ('plus', 3,  'Plus',  4.99),
  ('pro',  -1, 'Pro',  12.99)
ON CONFLICT (plan) DO NOTHING;

-- Add plan column to users if not already there
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan VARCHAR(20) DEFAULT 'free'
  REFERENCES plan_config(plan);

COMMENT ON TABLE plan_config IS 'Plan configuration — bank account limits per plan';
COMMENT ON COLUMN plan_config.max_bank_accounts IS '-1 means unlimited (Pro plan)';
