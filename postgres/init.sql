CREATE TABLE IF NOT EXISTS usage_requests (
  fingerprint TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  time_created TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  plan TEXT NOT NULL,
  session_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens BIGINT NOT NULL CHECK (reasoning_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_5m_tokens BIGINT NOT NULL CHECK (cache_write_5m_tokens >= 0),
  cache_write_1h_tokens BIGINT NOT NULL CHECK (cache_write_1h_tokens >= 0),
  raw_cost NUMERIC(30, 0) NOT NULL CHECK (raw_cost >= 0),
  cost_usd NUMERIC(20, 8) NOT NULL CHECK (cost_usd >= 0),
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_requests_time_idx ON usage_requests (time_created DESC);
CREATE INDEX IF NOT EXISTS usage_requests_model_idx ON usage_requests (model);
CREATE INDEX IF NOT EXISTS usage_requests_provider_idx ON usage_requests (provider);
CREATE INDEX IF NOT EXISTS usage_requests_plan_idx ON usage_requests (plan);
CREATE INDEX IF NOT EXISTS usage_requests_workspace_idx ON usage_requests (workspace_id);

CREATE TABLE IF NOT EXISTS collector_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  auto_refresh_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_success BOOLEAN,
  last_error TEXT,
  last_reason TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
  rows_added BIGINT NOT NULL DEFAULT 0 CHECK (rows_added >= 0),
  invalid_rows BIGINT NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  total_rows BIGINT NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  next_run_at TIMESTAMPTZ,
  last_rill_status TEXT,
  last_rill_trigger_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
