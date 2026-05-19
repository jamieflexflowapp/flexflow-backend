-- Migration 003: transactions
-- All imported transaction data from TrueLayer

CREATE TABLE IF NOT EXISTS transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_connection_id    UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,

  -- TrueLayer data
  truelayer_id          VARCHAR(255) UNIQUE NOT NULL,       -- TrueLayer transaction ID (dedup)
  amount                DECIMAL(12,2) NOT NULL,             -- Positive = credit, negative = debit
                                                            -- For CIS: this is NET (after deduction)
  currency              VARCHAR(10) DEFAULT 'GBP',
  description           TEXT,
  merchant_name         VARCHAR(255),
  transaction_date      DATE NOT NULL,
  transaction_type      VARCHAR(50),                        -- TrueLayer type field

  -- TCE v1 classification (set after import)
  category              VARCHAR(50),                        -- 'income'|'expense'|'transfer'|'tax_payment'|'unknown'
  sub_category          VARCHAR(50),                        -- e.g. 'se_income'|'paye'|'cis'|'rental'|'dividend'
  is_classified         BOOLEAN DEFAULT false,
  classification_source VARCHAR(20) DEFAULT 'auto',         -- 'auto'|'manual'|'rule'

  -- Income flags
  is_income             BOOLEAN DEFAULT false,
  income_source_id      UUID,                               -- FK set after income_sources populated

  -- CIS flag (Build Note 2 — critical)
  is_cis                BOOLEAN DEFAULT false,              -- True = CIS net payment received

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_date ON transactions(transaction_date);
CREATE INDEX idx_transactions_category ON transactions(category);
CREATE INDEX idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
