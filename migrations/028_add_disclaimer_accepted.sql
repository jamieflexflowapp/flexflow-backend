-- Migration 028: Add disclaimer acceptance tracking
-- Required for FCA audit trail — records when user accepted the disclaimer

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS disclaimer_accepted      BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS disclaimer_accepted_at   TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS disclaimer_version       VARCHAR(10) DEFAULT NULL;

-- disclaimer_version allows us to re-prompt if we update the disclaimer text
-- Current version: '1.0' (launched May 2026)

COMMENT ON COLUMN users.disclaimer_accepted    IS 'Whether user has accepted the FlexFlow disclaimer';
COMMENT ON COLUMN users.disclaimer_accepted_at IS 'Timestamp of disclaimer acceptance — FCA audit trail';
COMMENT ON COLUMN users.disclaimer_version     IS 'Version of disclaimer accepted — allows re-prompting on updates';
