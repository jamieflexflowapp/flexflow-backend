-- Migration 016: tax_rate_changes
-- Immutable audit log — every rate change ever. Never deleted.
-- Every call to npm run config:update-rates writes here

CREATE TABLE IF NOT EXISTS tax_rate_changes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year        VARCHAR(9) NOT NULL,
  jurisdiction    VARCHAR(10) NOT NULL DEFAULT 'UK',
  parameter_key   VARCHAR(100) NOT NULL,
  old_value       DECIMAL(12,4),
  new_value       DECIMAL(12,4) NOT NULL,
  change_reason   TEXT NOT NULL,                            -- Required — why was this changed?
  changed_by      VARCHAR(100) DEFAULT 'admin',
  source          TEXT,                                     -- Legislative source
  effective_from  DATE NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
  -- NOTE: No updated_at — this table is append-only, never modified
);

CREATE INDEX idx_tax_rate_changes_lookup ON tax_rate_changes(tax_year, jurisdiction, parameter_key);
CREATE INDEX idx_tax_rate_changes_date ON tax_rate_changes(created_at DESC);
