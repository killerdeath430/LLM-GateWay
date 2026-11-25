-- 001_init: client API keys and per-request logs.
-- Applied once by scripts/migrate.ts inside a transaction; recorded in schema_migrations.

-- Gateway-issued client keys (decision D8). The raw key is shown once at creation and never
-- stored: only its hash. key_prefix (first few chars) lets a human tell keys apart in logs.
CREATE TABLE api_keys (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  key_prefix  text        NOT NULL,
  key_hash    text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

-- One row per request (decision D6). No raw prompt or response, only prompt_hash.
CREATE TABLE request_logs (
  request_id          uuid          PRIMARY KEY,
  -- Nullable: requests rejected by auth (401) have no key but are still logged.
  api_key_id          uuid          REFERENCES api_keys(id),
  requested_model     text          NOT NULL,
  -- Nullable: a request can fail before a provider is chosen (e.g. unknown model -> 400).
  provider            text,
  provider_model      text,
  stream              boolean       NOT NULL,
  status              integer       NOT NULL,  -- HTTP status returned to the client
  -- Fixed taxonomy (decision D4). NULL on success.
  error_type          text CHECK (error_type IN (
                        'invalid_request', 'auth_error', 'provider_rate_limited',
                        'provider_unavailable', 'provider_timeout', 'provider_bad_response',
                        'internal_error')),
  input_tokens        integer,
  output_tokens       integer,
  token_source        text CHECK (token_source IN ('provider', 'estimated')),
  ttfb_ms             double precision,
  latency_total_ms    double precision,
  gateway_overhead_ms double precision,
  -- numeric, not float: exact decimal so summed costs don't drift (decision D7).
  cost_usd            numeric(14, 8),
  prompt_hash         text,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX request_logs_created_at_idx ON request_logs (created_at);
