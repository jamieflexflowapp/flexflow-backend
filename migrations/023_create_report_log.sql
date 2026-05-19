-- Migration 023: report_log table
-- Tracks all generated reports per user (RGE v1.3)
-- S3 keys for retrieval. 7-year retention via S3 lifecycle policy.

CREATE TABLE IF NOT EXISTS report_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_type      VARCHAR(30) NOT NULL,    -- 'monthly_pdf'|'quarterly_pdf'|'annual_pdf'|'csv'
  report_year      INTEGER NOT NULL,
  report_month     INTEGER,                 -- NULL for quarterly/annual
  report_quarter   VARCHAR(5),             -- 'Q1'|'Q2'|'Q3'|'Q4' — NULL for monthly
  s3_key           TEXT,                   -- S3 object key for retrieval
  generated_at     TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, report_type, report_year, report_month, report_quarter)
);

CREATE INDEX idx_report_log_user ON report_log(user_id, generated_at DESC);
