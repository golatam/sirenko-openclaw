CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  identity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  account_label TEXT NOT NULL,
  thread_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  text TEXT,
  ts TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_source_ts_idx ON messages (source, ts DESC);
CREATE INDEX IF NOT EXISTS messages_account_ts_idx ON messages (account_label, ts DESC);
CREATE INDEX IF NOT EXISTS messages_text_idx ON messages USING GIN (to_tsvector('simple', coalesce(text, '')));
