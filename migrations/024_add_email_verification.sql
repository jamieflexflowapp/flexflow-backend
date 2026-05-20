-- Migration 024: Email verification
-- Adds email verification columns to users table
-- FlexFlow Phase 4 — Auth Backend

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_code     VARCHAR(6),
  ADD COLUMN IF NOT EXISTS verification_expires  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_verification_code ON users(verification_code);
