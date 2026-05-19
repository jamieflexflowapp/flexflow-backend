-- Migration 010: notifications
-- Notification log (NAE v1.1)

CREATE TABLE IF NOT EXISTS notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Alert type (from NAE v1.1)
  alert_type        VARCHAR(50) NOT NULL,
  -- Tax pot: 'TPVE_GOOD' | 'TPVE_AMBER' | 'TPVE_RED'
  -- Tax alerts: 'SA_DEADLINE' | 'VAT_DEADLINE' | 'CLASS2_DUE'
  -- Income: 'LOW_INCOME_MONTH' | 'INCOME_SOURCE_GONE_QUIET'
  -- Budget: 'BUDGET_80PCT' | 'BUDGET_EXCEEDED'
  -- Runway: 'RUNWAY_RED' | 'RUNWAY_AMBER'
  -- Forecast: 'DANGER_MONTH_AHEAD'
  -- Options: 'SALARY_REVIEW_DUE' | 'DIVIDEND_REVIEW_DUE'
  -- Rental: 'SECTION_24_DISCLOSURE' | 'MTD_REQUIRED' | 'FIN_COSTS_CARRIED_FWD' | 'FINANCE_ACT_2026'
  -- Compliance: 'MTD_REQUIRED'

  severity          VARCHAR(10) NOT NULL DEFAULT 'INFO',    -- 'INFO'|'AMBER'|'RED'
  title             VARCHAR(255) NOT NULL,
  body              TEXT NOT NULL,                          -- From compliance_copy table — no directive language
  action_url        VARCHAR(255),                           -- Deep link in app

  -- Delivery
  is_read           BOOLEAN DEFAULT false,
  read_at           TIMESTAMPTZ,
  is_dismissed      BOOLEAN DEFAULT false,
  dismissed_at      TIMESTAMPTZ,

  -- Dedup — don't fire same alert twice in same period
  dedup_key         VARCHAR(255),                           -- e.g. 'TPVE_RED_2026/27'
  valid_until       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read, is_dismissed);
CREATE UNIQUE INDEX idx_notifications_dedup ON notifications(user_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND is_dismissed = false;
