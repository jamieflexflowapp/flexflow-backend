-- Migration 015: compliance_copy
-- Options Engine + all alert wording strings (NAE v1.1)
-- FCA compliance: factual language only, no directive language
-- All user-facing copy lives here — update without code deployment

CREATE TABLE IF NOT EXISTS compliance_copy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  copy_key        VARCHAR(100) NOT NULL UNIQUE,             -- e.g. 'TPVE_RED_title'
  copy_type       VARCHAR(30) NOT NULL,                     -- 'alert'|'options'|'disclosure'|'label'
  title           VARCHAR(255),
  body            TEXT NOT NULL,
  cta_label       VARCHAR(100),
  cta_url         VARCHAR(255),
  notes           TEXT,                                     -- Internal guidance on usage
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_compliance_copy_key ON compliance_copy(copy_key);
CREATE INDEX idx_compliance_copy_type ON compliance_copy(copy_type);
