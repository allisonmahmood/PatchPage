/**
 * The ordered schema-migration list both drivers share.
 *
 * A migration is one additive schema step with an optional part per driver:
 * `postgres` is idempotent DDL, `json` is an idempotent transform that
 * default-fills the new fields on rows written by any earlier schema version.
 * A step may be omitted when a driver has nothing to do — a Postgres index has
 * no JSON analogue, and a JSON default-fill is a Postgres column default.
 *
 * Both drivers keep a ledger of applied migration IDs (the `schema_migrations`
 * table, the `schemaMigrations` array), so a migration runs once and re-running
 * from any prior state is a no-op. Every step must still be idempotent on its
 * own: a database deployed before this ledger existed reaches the ledger by
 * having the baseline replayed over its live schema.
 *
 * See `packages/db/README.md` for how to add one.
 */
export interface SchemaMigration {
  /** Ordered, immutable once merged. Zero-padded so ID order is apply order. */
  readonly id: string;
  /** Idempotent DDL. Omit when the migration does not touch Postgres. */
  readonly postgres?: string;
  /**
   * Idempotent in-place transform of the parsed JSON state. Runs before the
   * row guards, so it is what teaches them a row shape they don't know yet.
   * Omit when the migration does not touch the JSON driver.
   */
  readonly json?: (state: JsonMigrationState) => void;
}

/**
 * The JSON state as a migration sees it: parsed but not yet guarded, so every
 * field is untrusted. Migrations read defensively and write concrete values.
 */
export type JsonMigrationState = Record<string, unknown>;

/** The name of the JSON state's migration ledger. */
export const JSON_MIGRATION_LEDGER_KEY = "schemaMigrations";

const JSON_ROW_COLLECTIONS = [
  "accounts",
  "apiTokens",
  "drafts",
  "draftVersions",
  "uploadEvents"
] as const;

/**
 * The retention window as of `0003_drafts_expiry_columns`, frozen here on
 * purpose. A merged migration's behavior must not follow a later retuning of
 * the live policy, so this deliberately does not read `retention.ts` — and the
 * Postgres step spells the same 90 days out in SQL.
 */
const MIGRATION_0003_BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    id: "0001_baseline_schema",
    postgres: `
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
    `,
    json(state) {
      for (const collection of JSON_ROW_COLLECTIONS) {
        if (!Array.isArray(state[collection])) state[collection] = [];
      }
    }
  },
  {
    id: "0002_drafts_account_id_index",
    // Ownership lookups (a principal's live drafts) scan by account today.
    // JSON has no index concept, so this migration has no JSON step.
    postgres: `CREATE INDEX IF NOT EXISTS drafts_account_id_idx ON drafts(account_id);`
  },
  {
    id: "0003_drafts_expiry_columns",
    // The retention clock's anchor. Backfilling to migration time + the full
    // window is what keeps the deploy itself from expiring anything: every
    // pre-existing draft leaves this step with a whole window ahead of it.
    // The default is a floor, not the path — the drivers write the anchor from
    // their injected clock so a test can move it.
    postgres: `
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      UPDATE drafts SET expires_at = now() + interval '90 days' WHERE expires_at IS NULL;
      ALTER TABLE drafts ALTER COLUMN expires_at SET NOT NULL;
      ALTER TABLE drafts ALTER COLUMN expires_at SET DEFAULT now() + interval '90 days';
      CREATE INDEX IF NOT EXISTS drafts_expires_at_idx ON drafts(expires_at);
    `,
    json(state) {
      const drafts = state.drafts;
      if (!Array.isArray(drafts)) return;

      const backfill = new Date(Date.now() + MIGRATION_0003_BACKFILL_WINDOW_MS).toISOString();
      for (const draft of drafts) {
        if (!draft || typeof draft !== "object") continue;
        const row = draft as Record<string, unknown>;
        if (typeof row.expiresAt !== "string") row.expiresAt = backfill;
      }
    }
  },
  {
    id: "0004_drafts_pinned_at",
    // The pin: when an operator exempted this draft from expiry, or NULL for an
    // ordinary one. Nullable with no backfill on purpose — "unpinned" is the
    // absence of a pin, so every pre-existing draft is already correct, and the
    // spec's "nothing pre-existing is pinned" needs no work to hold.
    //
    // The partial index is the sweep's: it scans by anchor over unpinned rows
    // only, which is exactly the set the sweep may take.
    postgres: `
      ALTER TABLE drafts ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS drafts_expiry_sweep_idx
        ON drafts(expires_at) WHERE pinned_at IS NULL;
    `,
    json(state) {
      const drafts = state.drafts;
      if (!Array.isArray(drafts)) return;

      for (const draft of drafts) {
        if (!draft || typeof draft !== "object") continue;
        const row = draft as Record<string, unknown>;
        // The guard requires the key, and a Postgres NULL is a JSON null.
        if (typeof row.pinnedAt !== "string" && row.pinnedAt !== null) {
          row.pinnedAt = null;
        }
      }
    }
  },
  {
    // 0005 is claimed by the self-service mint records in flight; IDs are
    // immutable once merged, so this keeps its number and leaves the gap. Apply
    // order is ID order, and the ledger records what ran — a gap is not a
    // missing step, and a fresh database applies 0001-0004 then 0006 cleanly.
    id: "0006_draft_reports",
    // Where a reader's flag on a served draft lands. Reports are operator-review
    // material and nothing else: no trigger reads this table, so no volume of
    // rows here can disable, delete, or revoke anything.
    //
    // `draft_id` deliberately carries no foreign key, and the expiry sweep must
    // never grow a step that deletes these rows. A report has to outlive the
    // draft it flags — expiry hard-deletes drafts, and an operator reviewing a
    // report after the fact still needs to see that it was filed, against what,
    // and from where. A reference would make the sweep's delete fail instead.
    postgres: `
      CREATE TABLE IF NOT EXISTS draft_reports (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        source_ip TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS draft_reports_draft_id_idx ON draft_reports(draft_id);
      CREATE INDEX IF NOT EXISTS draft_reports_created_at_idx ON draft_reports(created_at);
    `,
    json(state) {
      if (!Array.isArray(state.draftReports)) state.draftReports = [];
    }
  }
];

/** Every shipped migration ID, in apply order. */
export const SCHEMA_MIGRATION_IDS: readonly string[] = SCHEMA_MIGRATIONS.map(
  (migration) => migration.id
);

export interface JsonMigrationResult {
  state: JsonMigrationState;
  changed: boolean;
}

/**
 * Brings a parsed JSON state up to the current schema in place, recording each
 * applied migration in the ledger. Runs before the row guards: a state written
 * by an earlier schema version becomes guard-valid here or not at all.
 */
export function applyJsonMigrations(
  state: JsonMigrationState,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS
): JsonMigrationResult {
  const persistedLedger = state[JSON_MIGRATION_LEDGER_KEY];
  const ledger = readJsonLedger(state);
  const applied = new Set(ledger);
  // A missing or partly unreadable ledger is itself a change worth persisting.
  let changed = !Array.isArray(persistedLedger) || persistedLedger.length !== ledger.length;

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    migration.json?.(state);
    ledger.push(migration.id);
    applied.add(migration.id);
    changed = true;
  }

  state[JSON_MIGRATION_LEDGER_KEY] = ledger;
  return { state, changed };
}

function readJsonLedger(state: JsonMigrationState): string[] {
  const ledger = state[JSON_MIGRATION_LEDGER_KEY];
  if (!Array.isArray(ledger)) return [];
  return ledger.filter((id): id is string => typeof id === "string");
}
