-- Migration 004: income_sources
-- Identified income streams per user (ISE v1.5)
-- Each distinct income source gets a record with reliability tracking

CREATE TABLE IF NOT EXISTS income_sources (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Source identity
  name                  VARCHAR(255) NOT NULL,              -- e.g. 'Freelance Design', 'PAYE - Acme Ltd'
  source_type           VARCHAR(30) NOT NULL,               -- 'se'|'paye'|'cis'|'rental'|'dividend'|'partnership'
  provider_name         VARCHAR(255),                       -- Client or employer name if identifiable

  -- Income data
  first_seen_at         DATE,
  last_seen_at          DATE,
  total_received        DECIMAL(12,2) DEFAULT 0.00,
  average_monthly       DECIMAL(12,2) DEFAULT 0.00,

  -- Reliability score (ISE v1.5)
  -- GREEN = regular and reliable | AMBER = irregular but present | RED = declining/absent
  reliability_score     VARCHAR(10) DEFAULT 'AMBER',        -- 'GREEN'|'AMBER'|'RED'
  reliability_updated_at TIMESTAMPTZ,

  -- Tax treatment
  tax_deducted_at_source BOOLEAN DEFAULT false,             -- True for PAYE (already taxed)
  cis_rate              DECIMAL(5,2),                       -- 20% or 30% if CIS

  -- Rental income specific fields (Tax Engine v3.5 Part 1d)
  is_rental             BOOLEAN DEFAULT false,
  property_count        INTEGER DEFAULT 0,
  gross_rental_income   DECIMAL(12,2),                      -- Annual gross before expenses
  allowable_expenses    DECIMAL(12,2),                      -- Allowable expenses (ex finance costs)
  finance_costs         DECIMAL(12,2),                      -- Mortgage interest (Section 24)
  loss_carried_fwd      DECIMAL(12,2) DEFAULT 0.00,         -- Loss b/f from prior years
  fin_costs_carried_fwd DECIMAL(12,2) DEFAULT 0.00,         -- Unused S24 fin costs b/f (SA105 Box 45)

  is_active             BOOLEAN DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_income_sources_user_id ON income_sources(user_id);
CREATE INDEX idx_income_sources_type ON income_sources(user_id, source_type);
