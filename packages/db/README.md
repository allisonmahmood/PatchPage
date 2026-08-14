# @patchpage/db

The metadata store behind the hosting context, with two drivers: `postgres` for
deployed instances and `json` for a single-file store. Both implement the same
`PatchPageDb` port and are held to the same driver-parametrized contract suite
in `src/upload-contract.test.ts`.

## The retention clock

Every draft carries one expiry anchor, `expiresAt`, and `src/retention.ts` owns
the rules that act on it: an upload restarts the full window, a visit tops the
remaining time up to the visit window when less than that remains, a draft is
expired the moment `expiresAt` is past — and a **pinned** draft (`pinnedAt` set)
is never expired, however far past its anchor now is. `isExpired` is the one
answer everything keys on, and it needs no term for deleted or disabled drafts
because a pin only ever sits on a draft in service: `deleteDraft` and
`disableDraft` clear the pin, and `setDraftPinned` refuses to pin a draft that is
already deleted or disabled — while unpinning takes any row still there, so a pin
can never be stuck on a draft the operator has since taken down. Without that
invariant, a pinned-then-deleted draft would be exempt from the sweep forever.
Expired drafts are absent from `findDraftVersion` and
refused as update targets, exactly as deleted and disabled ones are; the row
itself stays until the sweep removes it.

## The expiry sweep

Expiry is a hard delete, and `listExpiredDraftIds` plus `deleteExpiredDraft` are
how it happens: the first names drafts whose clock has run out with no pin on
them, the second takes one — its upload events, its versions, and the draft row,
in the order the foreign keys require — and answers with the storage keys those
versions held so the caller can delete the content too. There is no recovery.

The record goes before the content on purpose. Once the row is gone its objects
are unreachable, so a failure between the two leaks storage; the other order
risks a live draft whose content vanished. `deleteExpiredDraft` re-checks expiry
under a row lock, so a pin landing mid-sweep saves the draft rather than racing
it, and answers `null` when there was nothing to take.

The sweep is what frees storage *and* quota in one event: an expired draft still
counts against `countLiveDraftsByCreatorApiToken` until its row is gone. Who
calls the sweep, and how often, is the hosting app's business — see
`apps/server/src/expiry-sweep.ts`.

Both drivers answer to those functions, and the contract suite is what holds them
to the same answers; the Postgres driver restates the visit rule as one SQL
predicate rather than reading the row first.

The clock is `DbDriverOptions.clock` — epoch milliseconds, `Date.now` by default,
the same shape `createApp` and the rate limiters take. **A test that winds time
forward must give the app and its database the same clock function.** Passing one
only to `createApp` moves the rate limiters and leaves retention on wall time,
which looks like the clock working and proves nothing.

## Reports

`draft_reports` is where a reader's flag on a served draft lands, written by
`recordDraftReport` and read by `listDraftReports`. Two properties are load-bearing
and neither is an accident:

- **Nothing acts on the table.** No trigger, no cascade, no sweep reads it. Filing a
  report writes one row and touches nothing else — not the draft, not its retention
  clock, not its token — so report-bombing a page cannot take it down. Disabling,
  deleting, and revoking stay operator decisions.
- **`draft_id` carries no foreign key.** A report has to outlive the draft it flags:
  expiry hard-deletes drafts, and an operator reviewing a report after the fact still
  needs to see that it was filed, against what, and from where. A reference would make
  the expiry sweep's delete fail instead.

Operator review at launch is a direct read of this table — deliberately with no
endpoint in front of it. `listDraftReports` exists so the report path is observable
through the port rather than by reading storage.

## Schema migrations

One ordered list in `src/migrations.ts` — `SCHEMA_MIGRATIONS` — is the schema for
both drivers. Each entry has an ID and an optional step per driver, as
`0003_drafts_expiry_columns` does for the retention clock's anchor:

```ts
{
  id: "0003_drafts_expiry_columns",
  postgres: `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ; /* … */`,
  json(state) {
    /* default-fill `expiresAt` on every stored draft row */
  }
}
```

Read that one before writing a new column migration: it is the shipped worked
example of an additive column with a backfill, and its Postgres step shows the
whole additive sequence — add the column, backfill every existing row, only then
constrain it.

Both drivers keep a ledger of applied IDs — the `schema_migrations` table, the
`schemaMigrations` array in the state file — so a migration runs once and
`initialize()` is a no-op from any prior state. A database deployed before the
ledger existed reaches it by having the baseline replayed over its live schema,
which is why **every step must be idempotent on its own** even though the ledger
normally prevents a second run.

`initialize()` migrates, then seeds the bootstrap token when one is configured.
Seeding is not a migration: it re-runs on every startup and must stay idempotent.
(The retired anonymous owner/audit actor used to be seeded here too; the
trust-model cutover removed it, and no sentinel principal is seeded now.)

Two objects are easy to confuse, so they are named here. **`0002_drafts_account_id_index`,
`0003_drafts_expiry_columns`, `0004_drafts_pinned_at`, and `0006_draft_reports` are
the shipped additive migrations** — each ships permanently and none supersedes
another; `0002` exists because ownership lookups scan `drafts` by account, `0004`
adds the pin plus the partial index the sweep scans, and `0006` adds a whole table
rather than a column (see "Reports" below). **`0005` is deliberately absent** — it
is claimed by work in flight, and an ID is immutable once merged, so the list keeps
a gap rather than renumbering. Apply order is ID order and the ledger records what
actually ran, so a gap is not a missing step. The **probe migrations in
a column-level additive step on both drivers without putting a placeholder column
in the shipped schema. A later agent should not treat a probe as the pattern to
copy for a real column — copy `0003` and the steps below.

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
