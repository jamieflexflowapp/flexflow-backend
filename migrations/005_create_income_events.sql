-- Migration 005: income_events
-- Individual income events — the core income record
--
-- CRITICAL (Build Note 2): TWO amount columns — read carefully
--   .amount       = NET amount (cash that hit the bank after any CIS deduction)
--                   Used by: RGE display, user-facing totals
--   .gross_amount = GROSS amount (pre-deduction)
--                   Used by: Tax Engine, ISE v1.5 calculations
-- For non-CIS income: amount === gross_amount
-- NEVER sum gross_amount as the income total shown to users.

CREATE TABLE IF NOT EXISTS income_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  income_source_id      UUID REFERENCES income_sources(id) ON DELETE SET NULL,
  transaction_id        UUID REFERENCES transactions(id) ON DELETE SET NULL,

  -- DUAL AMOUNT COLUMNS (Build Note 2 — critical)
  amount                DECIMAL(12,2) NOT NULL,             -- NET: cash received after deductions
  gross_amount          DECIMAL(12,2) NOT NULL,             -- GROSS: pre-deduction (= amount if non-CIS)

  currency              VARCHAR(10) DEFAULT 'GBP',
  income_date           DATE NOT NULL,

  -- Income type
  income_type           VARCHAR(30) NOT NULL,               -- 'se'|'paye'|'cis'|'rental'|'dividend'|'partnership'
  tax_year              VARCHAR(9) NOT NULL,                 -- e.g. '2026/27'

  -- Tax treatment
  tax_deducted          DECIMAL(12,2) DEFAULT 0.00,         -- CIS deduction or PAYE tax deducted
  cis_deduction_rate    DECIMAL(5,2),                       -- 20% or 30% if CIS
  is_cis                BOOLEAN DEFAULT false,

  -- Rental income specific
  is_rental             BOOLEAN DEFAULT false,

  -- ISE smoothing
  included_in_smoothing BOOLEAN DEFAULT true,               -- False = excluded from personal income calc
  smoothing_month       VARCHAR(7),                         -- 'YYYY-MM' — which month this was allocated to

  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_income_events_user_id ON income_events(user_id);
CREATE INDEX idx_income_events_tax_year ON income_events(user_id, tax_year);
CREATE INDEX idx_income_events_date ON income_events(income_date);
CREATE INDEX idx_income_events_type ON income_events(user_id, income_type);
