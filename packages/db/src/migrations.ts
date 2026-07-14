import {
  ANONYMOUS_INTERNAL_REVOKED_AT,
  ANONYMOUS_INTERNAL_TOKEN_HASH,
  ANONYMOUS_UPLOAD_PRINCIPAL
} from "./internal-principals.js";

export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '["upload"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'unlisted',
  current_version_id TEXT,
  repo_org TEXT,
  repo_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT
);

CREATE TABLE IF NOT EXISTS draft_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  version_number INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_api_token_id TEXT NOT NULL REFERENCES api_tokens(id),
  source_ip TEXT,
  user_agent TEXT,
  cli_version TEXT,
  git_branch TEXT,
  git_commit_sha TEXT,
  original_filename TEXT,
  UNIQUE (draft_id, version_number)
);

CREATE TABLE IF NOT EXISTS upload_events (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  draft_version_id TEXT REFERENCES draft_versions(id),
  api_token_id TEXT NOT NULL REFERENCES api_tokens(id),
  event_type TEXT NOT NULL,
  source_ip TEXT,
  user_agent TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS draft_versions_draft_id_idx ON draft_versions(draft_id);
CREATE INDEX IF NOT EXISTS upload_events_draft_id_idx ON upload_events(draft_id);

INSERT INTO accounts (id, name)
VALUES ('${ANONYMOUS_UPLOAD_PRINCIPAL.accountId}', 'Anonymous Uploads')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    updated_at = now();

INSERT INTO api_tokens (id, account_id, name, token_hash, scopes, revoked_at)
VALUES (
  '${ANONYMOUS_UPLOAD_PRINCIPAL.apiTokenId}',
  '${ANONYMOUS_UPLOAD_PRINCIPAL.accountId}',
  'Anonymous Upload Audit Actor',
  '${ANONYMOUS_INTERNAL_TOKEN_HASH}',
  '[]'::jsonb,
  '${ANONYMOUS_INTERNAL_REVOKED_AT}'::timestamptz
)
ON CONFLICT (id) DO UPDATE
SET account_id = EXCLUDED.account_id,
    name = EXCLUDED.name,
    token_hash = EXCLUDED.token_hash,
    scopes = EXCLUDED.scopes,
    revoked_at = EXCLUDED.revoked_at;
`;
