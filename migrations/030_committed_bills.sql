-- Migration 030: Committed bills table (fixed — users.id is UUID)
-- Stores user's committed monthly bills for runway calculation

CREATE TABLE IF NOT EXISTS committed_bills (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  day_of_month    VARCHAR(10)  DEFAULT NULL,
  source          VARCHAR(20)  DEFAULT 'manual'
                  CHECK (source IN ('auto', 'manual', 'transaction')),
  transaction_id  VARCHAR(100) DEFAULT NULL,
  is_active       BOOLEAN      DEFAULT true,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_committed_bills_user   ON committed_bills(user_id);
CREATE INDEX IF NOT EXISTS idx_committed_bills_active ON committed_bills(user_id, is_active);

COMMENT ON TABLE committed_bills IS 'User committed monthly bills — used for runway weekly outgoings calculation';
