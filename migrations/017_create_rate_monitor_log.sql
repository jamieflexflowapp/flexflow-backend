-- Migration 017: rate_monitor_log
-- Log of every rate monitoring run
-- Tracks when the system last checked for rate changes

CREATE TABLE IF NOT EXISTS rate_monitor_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at          TIMESTAMPTZ DEFAULT NOW(),
  tax_year        VARCHAR(9) NOT NULL,
  status          VARCHAR(20) NOT NULL,                     -- 'ok'|'changes_found'|'error'
  changes_found   INTEGER DEFAULT 0,
  error_message   TEXT,
  duration_ms     INTEGER
);

CREATE INDEX idx_rate_monitor_log_date ON rate_monitor_log(run_at DESC);
