-- Migration 002: bank_connections
-- TrueLayer connection records per user

CREATE TABLE IF NOT EXISTS bank_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- TrueLayer connection data
  provider          VARCHAR(50) NOT NULL,                  -- 'monzo' | 'barclays' | 'hsbc' etc
  provider_id       VARCHAR(255) NOT NULL,                 -- TrueLayer provider ID
  account_id        VARCHAR(255) NOT NULL,                 -- TrueLayer account ID
  account_type      VARCHAR(50),                           -- 'current' | 'savings'
  account_name      VARCHAR(255),
  currency          VARCHAR(10) DEFAULT 'GBP',

  -- Tokens (encrypted in production)
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  TIMESTAMPTZ,

  -- Tax account designation
  is_tax_account    BOOLEAN DEFAULT false,                 -- True = this is where tax pot lives
  tax_pot_balance   DECIMAL(12,2) DEFAULT 0.00,           -- Current tax pot balance

  -- Status
  is_active         BOOLEAN DEFAULT true,
  last_synced_at    TIMESTAMPTZ,
  sync_status       VARCHAR(20) DEFAULT 'pending',         -- 'pending'|'syncing'|'ok'|'error'
  sync_error        TEXT,

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bank_connections_user_id ON bank_connections(user_id);
CREATE UNIQUE INDEX idx_bank_connections_account ON bank_connections(user_id, account_id);
