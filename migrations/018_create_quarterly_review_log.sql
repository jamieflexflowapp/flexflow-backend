-- Migration 018: quarterly_review_log
-- Quarterly salary/dividend review prompt log (Task 6c)
-- Cron fires at 08:00 on 30 Jun, 30 Sep, 31 Dec, 31 Mar for S2/S3b/S3c users

CREATE TABLE IF NOT EXISTS quarterly_review_log (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Review period
  quarter                   VARCHAR(10) NOT NULL,           -- 'Q1'|'Q2'|'Q3'|'Q4'
  tax_year                  VARCHAR(9) NOT NULL,            -- '2026/27'
  review_date               DATE NOT NULL,

  -- Income comparison (what triggered the prompt)
  projected_annual_income   DECIMAL(12,2),
  last_salary               DECIMAL(12,2),
  last_dividend             DECIMAL(12,2),
  income_shift_pct          DECIMAL(5,2),                   -- % shift from last saved split

  -- Prompt status
  prompt_sent               BOOLEAN DEFAULT false,
  prompt_sent_at            TIMESTAMPTZ,
  notification_id           UUID REFERENCES notifications(id),

  -- User response
  user_responded            BOOLEAN DEFAULT false,
  user_responded_at         TIMESTAMPTZ,
  new_salary                DECIMAL(12,2),
  new_dividend              DECIMAL(12,2),

  -- Suppression (don't prompt twice in same quarter)
  suppressed                BOOLEAN DEFAULT false,
  suppression_reason        TEXT,

  created_at                TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, quarter, tax_year)
);

CREATE INDEX idx_quarterly_review_user ON quarterly_review_log(user_id, tax_year);
