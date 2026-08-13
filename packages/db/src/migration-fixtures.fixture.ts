/**
 * Fixtures the migration tests share: a database as the code before this
 * mechanism would have left it, and probe migrations that prove a step really
 * ran. Not shipped behavior — only the tests import this module.
 */
import { sha256 } from "@patchpage/core";
import type { SchemaMigration } from "./migrations.js";

export const LEGACY_ACCOUNT_ID = "acct_legacy";
export const LEGACY_API_TOKEN_ID = "tok_legacy";
export const LEGACY_TOKEN = "legacy-token";
export const LEGACY_DRAFT_ID = "legacydraft1";
export const LEGACY_VERSION_ID = "ver_legacy_one";
export const LEGACY_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * A verbatim snapshot of the single create-if-not-exists string this branch
 * replaces, sentinel values inlined. Deployed Postgres databases were built by
 * exactly this — no ledger table, no `drafts_account_id_idx` — so migrating it
 * is the real adoption case, not a ledger wiped from an already-migrated schema.
 */
export const DEPLOYED_POSTGRES_SCHEMA_SQL = `
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
VALUES ('acct_anonymous', 'Anonymous Uploads')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    updated_at = now();

INSERT INTO api_tokens (id, account_id, name, token_hash, scopes, revoked_at)
VALUES (
  'tok_anonymous',
  'acct_anonymous',
  'Anonymous Upload Audit Actor',
  'internal:anonymous:no-bearer-token',
  '[]'::jsonb,
  '1970-01-01T00:00:00.000Z'::timestamptz
)
ON CONFLICT (id) DO UPDATE
SET account_id = EXCLUDED.account_id,
    name = EXCLUDED.name,
    token_hash = EXCLUDED.token_hash,
    scopes = EXCLUDED.scopes,
    revoked_at = EXCLUDED.revoked_at;
`;

/** The rows a deployed database already holds, in the shape each driver stores. */
export const SEED_DEPLOYED_ROWS_SQL = `
INSERT INTO accounts (id, name) VALUES ('${LEGACY_ACCOUNT_ID}', 'Legacy Account');
INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
VALUES ('${LEGACY_API_TOKEN_ID}', '${LEGACY_ACCOUNT_ID}', 'Legacy API Token', '${sha256(
  LEGACY_TOKEN
)}', '["upload"]'::jsonb);
INSERT INTO drafts (id, account_id, title, current_version_id)
VALUES ('${LEGACY_DRAFT_ID}', '${LEGACY_ACCOUNT_ID}', 'Legacy draft', '${LEGACY_VERSION_ID}');
INSERT INTO draft_versions (
  id, draft_id, version_number, object_key, content_hash, file_size,
  created_by_api_token_id, original_filename
)
VALUES (
  '${LEGACY_VERSION_ID}', '${LEGACY_DRAFT_ID}', 1,
  'drafts/${LEGACY_DRAFT_ID}/versions/${LEGACY_VERSION_ID}.html',
  'sha256:one', 11, '${LEGACY_API_TOKEN_ID}', 'legacy.html'
);
`;

/**
 * A JSON state file at the schema deployed before migrations existed: the five
 * row collections, no ledger. `omitDraftField` drops a field the current guards
 * require, standing in for a state written by an earlier schema version.
 */
export function deployedJsonStateFixture(
  omitDraftField?: string
): Record<string, unknown> {
  const draft: Record<string, unknown> = {
    id: LEGACY_DRAFT_ID,
    accountId: LEGACY_ACCOUNT_ID,
    title: "Legacy draft",
    visibility: "unlisted",
    currentVersionId: LEGACY_VERSION_ID,
    repoOrg: null,
    repoName: null,
    createdAt: LEGACY_TIMESTAMP,
    updatedAt: LEGACY_TIMESTAMP,
    deletedAt: null,
    disabledAt: null,
    disabledReason: null
  };
  if (omitDraftField) delete draft[omitDraftField];

  return {
    accounts: [
      {
        id: LEGACY_ACCOUNT_ID,
        name: "Legacy Account",
        createdAt: LEGACY_TIMESTAMP,
        updatedAt: LEGACY_TIMESTAMP
      }
    ],
    apiTokens: [
      {
        id: LEGACY_API_TOKEN_ID,
        accountId: LEGACY_ACCOUNT_ID,
        name: "Legacy API Token",
        tokenHash: sha256(LEGACY_TOKEN),
        scopes: ["upload"],
        createdAt: LEGACY_TIMESTAMP,
        lastUsedAt: null,
        revokedAt: null
      }
    ],
    drafts: [draft],
    draftVersions: [
      {
        id: LEGACY_VERSION_ID,
        draftId: LEGACY_DRAFT_ID,
        versionNumber: 1,
        objectKey: `drafts/${LEGACY_DRAFT_ID}/versions/${LEGACY_VERSION_ID}.html`,
        contentHash: "sha256:one",
        fileSize: 11,
        createdByApiTokenId: LEGACY_API_TOKEN_ID,
        sourceIp: null,
        userAgent: null,
        cliVersion: null,
        gitBranch: null,
        gitCommitSha: null,
        originalFilename: "legacy.html",
        createdAt: LEGACY_TIMESTAMP
      }
    ],
    uploadEvents: []
  };
}

export const PROBE_ADD_MIGRATION_ID = "9990_probe_add_drafts_review_note";
export const PROBE_REQUIRE_MIGRATION_ID = "9991_probe_require_drafts_review_note";

/** Adds one nullable field on both drivers. */
export const PROBE_ADD_MIGRATION: SchemaMigration = {
  id: PROBE_ADD_MIGRATION_ID,
  postgres: "ALTER TABLE drafts ADD COLUMN IF NOT EXISTS review_note TEXT;",
  json(state) {
    const drafts = state.drafts;
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts) {
      if (draft && typeof draft === "object" && !("reviewNote" in draft)) {
        (draft as Record<string, unknown>).reviewNote = null;
      }
    }
  }
};

/**
 * Depends on the field the previous probe adds, and fails loudly without it.
 * Running this one alone is how a test proves the earlier step really ran,
 * rather than passing because neither step did anything observable.
 */
export const PROBE_REQUIRE_MIGRATION: SchemaMigration = {
  id: PROBE_REQUIRE_MIGRATION_ID,
  postgres: "ALTER TABLE drafts ALTER COLUMN review_note SET DEFAULT 'unreviewed';",
  json(state) {
    const drafts = state.drafts;
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts) {
      if (draft && typeof draft === "object" && !("reviewNote" in draft)) {
        throw new Error("Probe migration ran before the field it depends on existed.");
      }
    }
  }
};

/** Undoes both probes so a reused Postgres database stays at the shipped schema. */
export const REVERT_PROBE_MIGRATIONS_SQL =
  "ALTER TABLE drafts DROP COLUMN IF EXISTS review_note;";

/**
 * Backfills a field the current row guards require. A state missing it is only
 * readable because migrations run before the guards.
 */
export const BACKFILL_DISABLED_REASON_MIGRATION: SchemaMigration = {
  id: "9992_probe_backfill_disabled_reason",
  json(state) {
    const drafts = state.drafts;
    if (!Array.isArray(drafts)) return;
    for (const draft of drafts) {
      if (draft && typeof draft === "object" && !("disabledReason" in draft)) {
        (draft as Record<string, unknown>).disabledReason = null;
      }
    }
  }
};
