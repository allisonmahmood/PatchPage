# @patchpage/db

The metadata store behind the hosting context, with two drivers: `postgres` for
deployed instances and `json` for a single-file store. Both implement the same
`PatchPageDb` port and are held to the same driver-parametrized contract suite
in `src/upload-contract.test.ts`.

## Schema migrations

One ordered list in `src/migrations.ts` — `SCHEMA_MIGRATIONS` — is the schema for
both drivers. Each entry has an ID and an optional step per driver:

```ts
{
  id: "0003_drafts_expiry_columns",
  postgres: `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`,
  json(state) {
    /* default-fill `expiresAt` on every stored draft row */
  }
}
```

Both drivers keep a ledger of applied IDs — the `schema_migrations` table, the
`schemaMigrations` array in the state file — so a migration runs once and
`initialize()` is a no-op from any prior state. A database deployed before the
ledger existed reaches it by having the baseline replayed over its live schema,
which is why **every step must be idempotent on its own** even though the ledger
normally prevents a second run.

`initialize()` migrates, then seeds (the dedicated internal owner/audit actor,
the bootstrap token). Seeding is not a migration: it re-runs on every startup and
must stay idempotent.

Two objects are easy to confuse, so they are named here. **`0002_drafts_account_id_index`
is the shipped additive migration** — it ships permanently and is not superseded
by the expiry columns; it exists because ownership lookups scan `drafts` by
account. The **probe migrations in `src/migration-fixtures.fixture.ts` are
test-only** and never ship: they exercise a column-level additive step on both
drivers so the shipped schema needs no placeholder column. A later agent should
not treat a probe as the pattern to copy for a real column — copy `0002` and the
steps below.

### Postgres

Migrations run under a session advisory lock, one transaction per step, so
concurrent instances starting at once serialize instead of racing on DDL. A
failed step leaves neither half-applied schema nor a ledger row claiming it.

### JSON: the default-fill convention

The JSON driver's row guards describe the **current** schema only — they are
deliberately strict, and they reject a row shape they don't know. Migrations are
what make an older state readable: they run against the parsed state *before*
the guards, so a migration's job is to default-fill the fields its guard will
then require. A field that later tickets treat as nullable is filled with
`null`; a field with a Postgres `DEFAULT` is filled with that same default.

The reverse direction needs no work: guards ignore fields they don't know, so a
handle on an older schema still reads rows a newer one wrote.

Migrations apply on read and persist on the next write, so a read-only process
never rewrites the file.

## How to add a migration

1. **Append** an entry to `SCHEMA_MIGRATIONS` in `src/migrations.ts`. Never edit
   or reorder a merged entry — the ledger has already recorded it as applied,
   so an edit silently never runs. Fix a shipped migration with a new one.
2. **ID it** `NNNN_snake_case_summary` with the next zero-padded number. ID
   order is apply order.
3. **Write the Postgres step** as idempotent DDL: `ADD COLUMN IF NOT EXISTS`,
   `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Additive only —
   dropping or retyping a column is a different conversation. Omit the step
   entirely if the migration doesn't touch Postgres.
4. **Write the JSON step** to default-fill the same fields on existing rows,
   reading defensively (the state is parsed, not yet guarded). Omit it when the
   change has no JSON analogue, such as an index.
5. **Extend the guards** in `src/json-db.ts` (`isDraftRecord` and friends) and
   the row interfaces to require the new fields, plus the record types in
   `src/types.ts` and the Postgres row mappers in `src/postgres-db.ts`.
6. **Test it through the contract suite.** Add the behavior your columns enable
   to `src/upload-contract.test.ts`, which runs on JSON always and on Postgres
   when `PATCHPAGE_TEST_DATABASE_URL` is set. Assert through the port only —
   never by reading the state file or selecting the column directly. The
   mechanism itself is already covered ("records every shipped migration once,
   in order, and re-migrates as a no-op", "resumes from a partly applied
   ledger", "adopts a database created before this mechanism existed", "applies
   an additive migration to an already-migrated database", "fails an additive
   migration whose predecessor never ran", and the JSON guard-inversion case
   "reads rows written by an earlier schema version only after they migrate"),
   so you do not need to re-prove any of it.
7. **Run both drivers** before opening the PR:

   ```sh
   pnpm --filter @patchpage/db test
   PATCHPAGE_TEST_DATABASE_URL=postgres://... \
     PATCHPAGE_REQUIRE_POSTGRES_TESTS=1 pnpm --filter @patchpage/db test
   ```

Deployed Postgres instances pick the migration up by running `pnpm db:migrate`
(see `docs/SELF_HOSTING.md`); JSON instances migrate on startup.
