-- Migration 022: Forecast tables (FCE v1.4 + FSBE v1.1)

-- forecast_snapshots — daily forecast archive
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_date   DATE NOT NULL,
  forecast_json   JSONB NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, snapshot_date)
);
CREATE INDEX idx_forecast_snapshots_user ON forecast_snapshots(user_id, snapshot_date DESC);

-- scenario_sessions — ephemeral FSBE sessions (2hr TTL)
-- Build Note 4: NEVER feeds into Tax Engine. Purged by cron after expiry.
CREATE TABLE IF NOT EXISTS scenario_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scenario_type         VARCHAR(30) NOT NULL,     -- 'client_pause'|'month_off'|'new_project'|'custom'
  scenario_params       JSONB NOT NULL,
  base_forecast_json    JSONB NOT NULL,
  scenario_forecast_json JSONB NOT NULL,
  impact_json           JSONB NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,     -- 2 hours from creation (Build Note 4)
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_scenario_sessions_user ON scenario_sessions(user_id, expires_at);
CREATE INDEX idx_scenario_sessions_expiry ON scenario_sessions(expires_at);
