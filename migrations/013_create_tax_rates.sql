-- Migration 013: tax_rates
-- ALL tax rate parameters — database-driven, zero hardcoded values in engine code
-- SEED this table before Task 5 begins (see seeds/001_tax_rates.sql)
-- Update via: npm run config:update-rates (never by editing code)

CREATE TABLE IF NOT EXISTS tax_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year        VARCHAR(9) NOT NULL,                      -- '2026/27'
  jurisdiction    VARCHAR(10) NOT NULL DEFAULT 'UK',        -- 'UK'|'SCO' (Scottish rates)
  parameter_key   VARCHAR(100) NOT NULL,                    -- e.g. 'personal_allowance'
  parameter_value DECIMAL(12,4) NOT NULL,                   -- Numeric value
  description     TEXT,                                     -- Human-readable description
  effective_from  DATE NOT NULL,
  effective_to    DATE,                                     -- NULL = still current
  source          TEXT,                                     -- e.g. 'GOV.UK Finance Act 2026 s.8'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(tax_year, jurisdiction, parameter_key)
);

CREATE INDEX idx_tax_rates_lookup ON tax_rates(tax_year, jurisdiction, parameter_key);
