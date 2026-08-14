import pg from "pg";
import { newInternalId, sha256 } from "@patchpage/core";
import {
  GoPublicFlipPreconditionError,
  pendingMigrationIds,
  reHomeDisposition
} from "./go-public-flip.js";
import {
  BOOTSTRAP_API_TOKEN_ID,
  BOOTSTRAP_PRINCIPAL_ID,
  RETIRED_ANONYMOUS_API_TOKEN_ID,
  RETIRED_ANONYMOUS_PRINCIPAL_ID
} from "./internal-principals.js";
import { SCHEMA_MIGRATIONS } from "./migrations.js";
import { mintQuotaWindowStart } from "./mint-quota.js";
import { DRAFT_VISIT_EXTENSION_WINDOW_MS, expiryAfterUpload } from "./retention.js";
import { UploadTargetError } from "./types.js";
import type { SchemaMigration } from "./migrations.js";
import type {
  AnonymousSentinelOutcome,
  ApiTokenAuth,
  ApiTokenRevocation,
  CreateApiTokenInput,
  DbDriverOptions,
  DraftRecord,
  DraftModerationOptions,
  DraftReportRecord,
  DraftVersionLookup,
  DraftVersionRecord,
  GoPublicFlipInput,
  GoPublicFlipInspection,
  GoPublicFlipOutcome,
  LiveDraftTally,
  MintSelfServiceTokenInput,
  MintSelfServiceTokenResult,
  ModeratedDraftRecord,
  PatchPageDb,
  PrincipalDraftListing,
  RecordDraftReportInput,
  RecordUploadInput,
  RecordUploadResult,
  ReHomedApiToken,
  UploadTargetInput
} from "./types.js";

const { Pool } = pg;

/**
 * "Not expired" as one SQL predicate, restating `isExpired` from `retention.ts`:
 * a pin exempts the draft outright, and otherwise the anchor must not be past.
 * The argument names the placeholder carrying the clock's reading, which every
 * query using this must bind — and the contract suite is what holds this
 * predicate and the TypeScript rule to the same answers.
 */
function notExpired(clockParameter: number): string {
  return `(drafts.pinned_at IS NOT NULL OR drafts.expires_at >= $${clockParameter}::timestamptz)`;
}

// A fixed key so concurrent instances serialize their migration runs instead of
// racing on `CREATE TABLE IF NOT EXISTS`, which is not race-free in Postgres.
const MIGRATION_ADVISORY_LOCK_KEY = 5150324118422001n;

/** A draft's creating token is the one recorded on its first version. */
const FIRST_VERSION_NUMBER = 1;

/**
 * A draft with the token that created it, for the moderation loop. `$2` is the
 * first version number; the join is outer so a draft always answers, even when
 * its first version is somehow missing.
 */
const MODERATED_DRAFT_SELECT = `
  SELECT drafts.*, first_version.created_by_api_token_id
  FROM drafts
  LEFT JOIN draft_versions AS first_version
    ON first_version.draft_id = drafts.id
    AND first_version.version_number = $2
`;

export class PostgresPatchPageDb implements PatchPageDb {
  private readonly pool: pg.Pool;
  private readonly migrations: readonly SchemaMigration[];
  private readonly clock: () => number;

  constructor(connectionString: string, options: DbDriverOptions = {}) {
    this.pool = new Pool({ connectionString });
    this.migrations = options.migrations ?? SCHEMA_MIGRATIONS;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * The retention clock's reading, as a value Postgres compares against
   * `expires_at`. Deliberately not SQL `now()`: the clock is injectable, and
   * `now()` would make the window untestable and drift from the JSON driver.
   *
   * `expires_at` and `token_mints.created_at` are on this clock here, because
   * both are anchors a window is measured from — retention's and the mint
   * quota's. Every other stamp in this driver (`last_used_at`, the remaining
   * `created_at` columns, `disabled_at`, `deleted_at`, `revoked_at`) stays on
   * SQL `now()`, where it is a column default or a `SET x = now()` clause,
   * while the JSON driver puts all of its stamps on the injected clock.
   * `revoked_at` belongs on that side because the revocation freeze keys on the
   * column being non-null, never on the instant it holds. See the note
   * on `JsonFilePatchPageDb.nowIso` — the drivers agree on the retention anchor
   * and drift on the rest under a wound-forward clock, which is deliberate.
   * Do not "fix" one driver's non-retention stamps without the other's.
   */
  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  async initialize(bootstrapApiToken: string | null): Promise<void> {
    await this.migrate();
    if (bootstrapApiToken) {
      await this.ensureBootstrapToken(bootstrapApiToken);
    }
  }

  async listAppliedMigrations(): Promise<string[]> {
    const ledgerExists = await this.pool.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present"
    );
    if (!ledgerExists.rows[0]?.present) return [];

    const result = await this.pool.query("SELECT id FROM schema_migrations ORDER BY id");
    return result.rows.map((row) => String(row.id));
  }

  async findApiTokenByToken(token: string): Promise<ApiTokenAuth | null> {
    const result = await this.pool.query(
      `
        SELECT api_tokens.id, api_tokens.account_id, api_tokens.name, api_tokens.scopes,
               accounts.name AS account_name,
               accounts.self_service_minted_at
        FROM api_tokens
        JOIN accounts ON accounts.id = api_tokens.account_id
        WHERE api_tokens.token_hash = $1
          AND api_tokens.revoked_at IS NULL
        LIMIT 1
      `,
      [sha256(token)]
    );

    const row = result.rows[0];
    if (!row) return null;

    await this.pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id]);

    return {
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      name: row.name,
      scopes: normalizeScopes(row.scopes),
      selfService: row.self_service_minted_at !== null
    };
  }

  async createApiToken(input: CreateApiTokenInput): Promise<{ id: string; name: string }> {
    const id = newInternalId("tok");
    const name = cleanText(input.name) || "API Token";

    await this.pool.query(
      `
        INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [id, input.accountId, name, sha256(input.token), JSON.stringify(input.scopes)]
    );

    return { id, name };
  }

  async countSelfServiceMintsBySourceIp(sourceIp: string | null): Promise<number> {
    // `IS NOT DISTINCT FROM` so a null address matches the null rows rather
    // than matching nothing: unattributable mints share one bucket instead of
    // each one escaping the tally.
    const result = await this.pool.query(
      `
        SELECT count(*) AS mints
        FROM token_mints
        WHERE source_ip IS NOT DISTINCT FROM $1
          AND created_at >= $2::timestamptz
      `,
      [sourceIp, mintQuotaWindowStart(this.clock())]
    );
    return Number(result.rows[0]?.mints ?? 0);
  }

  async mintSelfServiceToken(
    input: MintSelfServiceTokenInput
  ): Promise<MintSelfServiceTokenResult> {
    const accountId = newInternalId("acct");
    const apiTokenId = newInternalId("tok");
    const name = cleanText(input.name) || "Self-service token";
    // The quota counts these rows, so the mint stamp is on the injected clock
    // for the same reason `expires_at` is — see `nowIso`.
    const mintedAt = this.nowIso();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
          INSERT INTO accounts (id, name, self_service_minted_at)
          VALUES ($1, $2, $3::timestamptz)
        `,
        [accountId, name, mintedAt]
      );

      await client.query(
        `
          INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
          VALUES ($1, $2, $3, $4, '["upload"]'::jsonb)
        `,
        [apiTokenId, accountId, name, sha256(input.token)]
      );

      await client.query(
        `
          INSERT INTO token_mints (id, account_id, api_token_id, source_ip, created_at)
          VALUES ($1, $2, $3, $4, $5::timestamptz)
        `,
        [newInternalId("mint"), accountId, apiTokenId, input.sourceIp, mintedAt]
      );

      await client.query("COMMIT");
      return { accountId, apiTokenId, apiTokenName: name };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeApiToken(apiTokenId: string): Promise<ApiTokenRevocation | null> {
    // Read the row under a lock, stamp it only if it is not already stamped,
    // and report the state it was in beforehand — one statement, so two
    // concurrent revocations of the same token cannot both claim the first.
    // The first revocation's stamp stands: it is when top-ups froze.
    const result = await this.pool.query(
      `
        WITH prior AS (
          SELECT id, account_id, name, revoked_at
          FROM api_tokens
          WHERE id = $1
          FOR UPDATE
        ),
        revoked AS (
          UPDATE api_tokens
          SET revoked_at = now()
          FROM prior
          WHERE api_tokens.id = prior.id AND prior.revoked_at IS NULL
          RETURNING api_tokens.revoked_at
        )
        SELECT prior.id,
               prior.account_id,
               prior.name,
               COALESCE((SELECT revoked_at FROM revoked), prior.revoked_at) AS revoked_at,
               prior.revoked_at IS NOT NULL AS already_revoked
        FROM prior
      `,
      [apiTokenId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      revokedAt: toIso(row.revoked_at),
      alreadyRevoked: Boolean(row.already_revoked)
    };
  }

  async countLiveDraftsByCreatorApiToken(apiTokenId: string): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT count(*) AS live
        FROM drafts
        JOIN draft_versions ON draft_versions.draft_id = drafts.id
          AND draft_versions.version_number = $2
        WHERE draft_versions.created_by_api_token_id = $1
          AND drafts.deleted_at IS NULL
          AND drafts.disabled_at IS NULL
      `,
      [apiTokenId, FIRST_VERSION_NUMBER]
    );
    return Number(result.rows[0]?.live ?? 0);
  }

  async assertUploadTarget(input: UploadTargetInput): Promise<void> {
    const result =
      input.intent === "update"
        ? await this.pool.query(
            `
              SELECT 1
              FROM drafts
              WHERE id = $1
                AND account_id = $2
                AND deleted_at IS NULL
                AND disabled_at IS NULL
                AND ${notExpired(3)}
            `,
            [input.draftId, input.accountId, this.nowIso()]
          )
        : await this.pool.query("SELECT 1 FROM drafts WHERE id = $1", [input.draftId]);

    if (input.intent === "update" ? !result.rowCount : Boolean(result.rowCount)) {
      throw new UploadTargetError(
        input.intent === "update" ? "draft_unavailable" : "draft_conflict"
      );
    }
  }

  async recordUpload(input: RecordUploadInput): Promise<RecordUploadResult> {
    const client = await this.pool.connect();
    let commitAttempted = false;
    try {
      await client.query("BEGIN");

      const repoOrg = cleanText(input.metadata.repoOrg);
      const repoName = cleanText(input.metadata.repoName);
      // An upload — first version or fifth — restarts the whole window.
      const expiresAt = expiryAfterUpload(this.clock());
      let title: string;
      let versionNumber: number;

      if (input.intent === "update") {
        const existingResult = await client.query(
          `
            SELECT *
            FROM drafts
            WHERE id = $1
              AND account_id = $2
              AND deleted_at IS NULL
              AND disabled_at IS NULL
              AND ${notExpired(3)}
            FOR UPDATE
          `,
          [input.draftId, input.accountId, this.nowIso()]
        );
        const existingDraft = existingResult.rows[0] || null;
        if (!existingDraft) {
          throw new UploadTargetError("draft_unavailable");
        }

        // Allocate after acquiring the draft row lock. A concurrent update for
        // the same draft waits above, then this query sees the committed version.
        const versionResult = await client.query(
          `
            SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
            FROM draft_versions
            WHERE draft_id = $1
          `,
          [input.draftId]
        );
        versionNumber = Number(versionResult.rows[0].next_version);
        title = input.title || existingDraft.title || input.filename || "Untitled Draft";
      } else {
        title = input.title || input.filename || "Untitled Draft";
        versionNumber = 1;
        const createdDraft = await client.query(
          `
            INSERT INTO drafts (
              id, account_id, title, visibility, current_version_id, repo_org, repo_name,
              expires_at
            )
            VALUES ($1, $2, $3, 'unlisted', $4, $5, $6, $7::timestamptz)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          `,
          [
            input.draftId,
            input.accountId,
            title,
            input.versionId,
            repoOrg,
            repoName,
            expiresAt
          ]
        );
        if (!createdDraft.rowCount) {
          throw new UploadTargetError("draft_conflict");
        }
      }

      await client.query(
        `
          INSERT INTO draft_versions (
            id, draft_id, version_number, object_key, content_hash, file_size,
            created_by_api_token_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        `,
        [
          input.versionId,
          input.draftId,
          versionNumber,
          input.objectKey,
          input.contentHash,
          input.fileSize,
          input.apiTokenId,
          input.sourceIp,
          input.userAgent,
          cleanText(input.metadata.cliVersion),
          cleanText(input.metadata.gitBranch),
          cleanText(input.metadata.gitCommitSha),
          input.filename
        ]
      );

      await client.query(
        `
          UPDATE drafts
          SET current_version_id = $1,
              title = $2,
              repo_org = COALESCE($3, repo_org),
              repo_name = COALESCE($4, repo_name),
              updated_at = now(),
              expires_at = $6::timestamptz
          WHERE id = $5
        `,
        [input.versionId, title, repoOrg, repoName, input.draftId, expiresAt]
      );

      await client.query(
        `
          INSERT INTO upload_events (
            id, draft_id, draft_version_id, api_token_id, event_type,
            source_ip, user_agent, metadata_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          newInternalId("evt"),
          input.draftId,
          input.versionId,
          input.apiTokenId,
          input.intent === "update" ? "draft.updated" : "draft.created",
          input.sourceIp,
          input.userAgent,
          JSON.stringify(input.metadata)
        ]
      );

      commitAttempted = true;
      await client.query("COMMIT");
      return { draftId: input.draftId, versionId: input.versionId, versionNumber, title };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // A definitive target rejection happened before COMMIT, so preserve it
        // for the server's object-compensation path even if cleanup also fails.
        if (!commitAttempted && error instanceof UploadTargetError) {
          throw error;
        }
        throw rollbackError;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findDraftVersion(draftId: string, versionNumber?: number): Promise<DraftVersionLookup> {
    const draftResult = await this.pool.query(
      `
        SELECT *
        FROM drafts
        WHERE id = $1
          AND deleted_at IS NULL
          AND disabled_at IS NULL
          AND ${notExpired(2)}
        LIMIT 1
      `,
      [draftId, this.nowIso()]
    );
    const draft = draftResult.rows[0] ? mapDraft(draftResult.rows[0]) : null;
    if (!draft) return { draft: null, version: null };

    const versionResult = versionNumber
      ? await this.pool.query(
          `
            SELECT *
            FROM draft_versions
            WHERE draft_id = $1 AND version_number = $2
            LIMIT 1
          `,
          [draft.id, versionNumber]
        )
      : await this.pool.query("SELECT * FROM draft_versions WHERE id = $1 LIMIT 1", [
          draft.currentVersionId
        ]);

    return {
      draft,
      version: versionResult.rows[0] ? mapDraftVersion(versionResult.rows[0]) : null
    };
  }

  async findDraftForModeration(draftId: string): Promise<ModeratedDraftRecord | null> {
    const result = await this.pool.query(
      `
        ${MODERATED_DRAFT_SELECT}
        WHERE drafts.id = $1
        LIMIT 1
      `,
      [draftId, FIRST_VERSION_NUMBER]
    );
    return result.rows[0] ? mapModeratedDraft(result.rows[0]) : null;
  }

  async listDraftsByPrincipal(
    principalId: string,
    limit: number
  ): Promise<PrincipalDraftListing> {
    const capped = Math.max(0, limit);
    // One row past the limit is how truncation is detected without a count.
    const result = await this.pool.query(
      `
        ${MODERATED_DRAFT_SELECT}
        WHERE drafts.account_id = $1
          AND drafts.deleted_at IS NULL
        ORDER BY drafts.created_at DESC, drafts.id DESC
        LIMIT $3
      `,
      [principalId, FIRST_VERSION_NUMBER, capped + 1]
    );

    return {
      drafts: result.rows.slice(0, capped).map(mapModeratedDraft),
      truncated: result.rows.length > capped
    };
  }

  async recordDraftVisit(draftId: string): Promise<void> {
    const now = this.clock();
    // One predicate says both halves of the visit rule: `expires_at` below the
    // topped-up anchor is exactly "less than the visit-extension window
    // remains", and it is also exactly "this move does not shorten the clock".
    // The not-expired term keeps a visit from reviving an expired draft — and,
    // because a pin means not expired, keeps topping a pinned draft up. The
    // NOT EXISTS is the revocation freeze: once the draft's creating token is
    // revoked, its clock only runs down.
    await this.pool.query(
      `
        UPDATE drafts
        SET expires_at = $2::timestamptz
        WHERE id = $1
          AND deleted_at IS NULL
          AND disabled_at IS NULL
          AND ${notExpired(3)}
          AND expires_at < $2::timestamptz
          AND NOT EXISTS (
            SELECT 1
            FROM draft_versions
            JOIN api_tokens ON api_tokens.id = draft_versions.created_by_api_token_id
            WHERE draft_versions.draft_id = drafts.id
              AND draft_versions.version_number = $4
              AND api_tokens.revoked_at IS NOT NULL
          )
      `,
      [
        draftId,
        new Date(now + DRAFT_VISIT_EXTENSION_WINDOW_MS).toISOString(),
        new Date(now).toISOString(),
        FIRST_VERSION_NUMBER
      ]
    );
  }

  async setDraftPinned(draftId: string, pinned: boolean): Promise<boolean> {
    // Two statements rather than one predicate carrying a boolean: pinning
    // needs a draft in service, and unpinning takes whatever row is left, so a
    // pin can never be stuck on a draft that has since been taken down.
    const result = pinned
      ? await this.pool.query(
          `
            UPDATE drafts
            SET pinned_at = $2::timestamptz
            WHERE id = $1
              AND deleted_at IS NULL
              AND disabled_at IS NULL
            RETURNING id
          `,
          [draftId, this.nowIso()]
        )
      : await this.pool.query(
          "UPDATE drafts SET pinned_at = NULL WHERE id = $1 RETURNING id",
          [draftId]
        );
    return Boolean(result.rowCount);
  }

  async listExpiredDraftIds(limit: number): Promise<string[]> {
    if (limit <= 0) return [];

    const result = await this.pool.query(
      `
        SELECT id
        FROM drafts
        WHERE NOT ${notExpired(1)}
        ORDER BY expires_at ASC
        LIMIT $2
      `,
      [this.nowIso(), limit]
    );
    return result.rows.map((row) => String(row.id));
  }

  async deleteExpiredDraft(draftId: string): Promise<string[] | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // The row lock plus the re-check is what makes a concurrent pin safe: a
      // pin either lands before this and the draft is no longer expired, or it
      // waits here and finds nothing left to pin.
      const target = await client.query(
        `
          SELECT id
          FROM drafts
          WHERE id = $1
            AND NOT ${notExpired(2)}
          FOR UPDATE
        `,
        [draftId, this.nowIso()]
      );
      if (!target.rowCount) {
        await client.query("ROLLBACK");
        return null;
      }

      const versions = await client.query(
        "SELECT object_key FROM draft_versions WHERE draft_id = $1",
        [draftId]
      );

      // Foreign keys decide the order: upload events name both the draft and
      // its versions, versions name the draft, and the draft goes last.
      await client.query("DELETE FROM upload_events WHERE draft_id = $1", [draftId]);
      await client.query("DELETE FROM draft_versions WHERE draft_id = $1", [draftId]);
      await client.query("DELETE FROM drafts WHERE id = $1", [draftId]);

      await client.query("COMMIT");
      return versions.rows.map((row) => String(row.object_key));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async disableDraft(
    draftId: string,
    accountId: string,
    reason: string,
    options: DraftModerationOptions = {}
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE drafts
        SET disabled_at = now(), disabled_reason = $3, updated_at = now(),
            -- Out of service, so out of pin: moderation outranks an exemption.
            pinned_at = NULL
        WHERE id = $1
          AND (account_id = $2 OR $4)
          AND deleted_at IS NULL
        RETURNING id
      `,
      [draftId, accountId, reason, options.canModerateAnyPrincipal === true]
    );
    return Boolean(result.rowCount);
  }

  async deleteDraft(
    draftId: string,
    accountId: string,
    options: DraftModerationOptions = {}
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE drafts
        SET deleted_at = now(), updated_at = now(),
            -- A deleted draft keeps no pin, so its storage still ages out.
            pinned_at = NULL
        WHERE id = $1
          AND (account_id = $2 OR $3)
          AND deleted_at IS NULL
        RETURNING id
      `,
      [draftId, accountId, options.canModerateAnyPrincipal === true]
    );
    return Boolean(result.rowCount);
  }

  async inspectGoPublicFlip(): Promise<GoPublicFlipInspection> {
    const client = await this.pool.connect();
    try {
      return await inspectWith((text, values) => client.query(text, values));
    } finally {
      client.release();
    }
  }

  async applyGoPublicFlip(input: GoPublicFlipInput): Promise<GoPublicFlipOutcome> {
    const client = await this.pool.connect();
    const flippedAt = this.nowIso();
    let surgery: Omit<GoPublicFlipOutcome, "after">;

    try {
      await client.query("BEGIN");

      // Every precondition is checked inside this transaction and before the
      // first write, so a refusal rolls back to exactly the state it found.
      const applied = await client.query("SELECT id FROM schema_migrations");
      const pending = pendingMigrationIds(applied.rows.map((row) => String(row.id)));
      if (pending.length > 0) {
        throw new GoPublicFlipPreconditionError("migrations_pending", pending.join(", "));
      }

      const bootstrap = await client.query("SELECT id FROM accounts WHERE id = $1", [
        BOOTSTRAP_PRINCIPAL_ID
      ]);
      if (!bootstrap.rowCount) {
        throw new GoPublicFlipPreconditionError(
          "bootstrap_principal_missing",
          BOOTSTRAP_PRINCIPAL_ID
        );
      }

      const pinned = await client.query(
        "SELECT id FROM drafts WHERE pinned_at IS NOT NULL ORDER BY id"
      );
      if (pinned.rowCount) {
        throw new GoPublicFlipPreconditionError(
          "draft_already_pinned",
          pinned.rows.map((row) => String(row.id)).join(", ")
        );
      }

      const reHomed: ReHomedApiToken[] = [];
      for (const apiTokenId of input.reHomeApiTokenIds) {
        // Row-locked: a concurrent revocation or a second flip cannot move this
        // token out from under the disposition decided on the next line.
        const target = await client.query(
          `
            SELECT id, account_id, name, scopes,
              (SELECT count(*) FROM api_tokens AS peer
                WHERE peer.account_id = api_tokens.account_id) AS tokens_on_principal
            FROM api_tokens
            WHERE id = $1
            FOR UPDATE
          `,
          [apiTokenId]
        );
        const row = target.rows[0];
        if (!row) {
          throw new GoPublicFlipPreconditionError("rehome_target_unknown", apiTokenId);
        }
        if (row.id === BOOTSTRAP_API_TOKEN_ID) {
          throw new GoPublicFlipPreconditionError("rehome_target_is_bootstrap_token", apiTokenId);
        }
        if (normalizeScopes(row.scopes).includes("admin")) {
          throw new GoPublicFlipPreconditionError("rehome_target_has_admin_scope", apiTokenId);
        }

        const disposition = reHomeDisposition(
          String(row.account_id),
          Number(row.tokens_on_principal)
        );
        if (disposition === "shared") {
          throw new GoPublicFlipPreconditionError("rehome_target_principal_shared", apiTokenId);
        }
        if (disposition === "already") {
          reHomed.push({
            apiTokenId: String(row.id),
            apiTokenName: String(row.name),
            principalId: String(row.account_id),
            alreadyReHomed: true
          });
          continue;
        }

        // The same three rows a self-service mint writes, minus the token: the
        // holder keeps the one they already have. The principal carries the
        // provenance mark and a mint record names it, because a mark no record
        // derives would break the one invariant those two rows have — and
        // marking it is the fail-closed direction, since any later guardrail
        // keyed on "self-service" should reach a re-homed token too. The
        // record's address is null: no caller asked for this token, and
        // inventing an address would be inventing forensics.
        const principalId = newInternalId("acct");
        await client.query(
          `
            INSERT INTO accounts (id, name, self_service_minted_at)
            VALUES ($1, $2, $3::timestamptz)
          `,
          [principalId, String(row.name), flippedAt]
        );
        // The mint stamp is on the injected clock for the same reason
        // `mintSelfServiceToken` puts it there: the mint quota measures a
        // window from it. See `nowIso`.
        await client.query(
          `
            INSERT INTO token_mints (id, account_id, api_token_id, source_ip, created_at)
            VALUES ($1, $2, $3, NULL, $4::timestamptz)
          `,
          [newInternalId("mint"), principalId, apiTokenId, flippedAt]
        );
        // The drafts stay behind on the bootstrap principal. That is the
        // accepted consequence, not an oversight: this token's holder loses
        // edit rights over everything they published before the flip.
        await client.query("UPDATE api_tokens SET account_id = $2 WHERE id = $1", [
          apiTokenId,
          principalId
        ]);

        reHomed.push({
          apiTokenId: String(row.id),
          apiTokenName: String(row.name),
          principalId,
          alreadyReHomed: false
        });
      }

      const sentinelDrafts = await client.query(
        `
          SELECT
            count(*) AS total,
            count(*) FILTER (
              WHERE deleted_at IS NULL AND disabled_at IS NULL
            ) AS in_service
          FROM drafts
          WHERE account_id = $1
        `,
        [RETIRED_ANONYMOUS_PRINCIPAL_ID]
      );
      const sentinelDraftCount = Number(sentinelDrafts.rows[0]?.total ?? 0);
      const sentinelDraftsInService = Number(sentinelDrafts.rows[0]?.in_service ?? 0);
      const sentinelHistoryRows = await countSentinelHistoryRows((text, values) =>
        client.query(text, values)
      );

      // The uniform re-arm. Sentinel-owned drafts in service are in this set
      // like any other, which is exactly the revoked-style treatment they are
      // owed: a full window from the flip, with top-ups already frozen by the
      // revocation stamp their token has carried since it was seeded. Only the
      // anchor moves — `updated_at` still means "when the content last changed".
      const reArmed = await client.query(
        `
          UPDATE drafts
          SET expires_at = $1::timestamptz
          WHERE deleted_at IS NULL AND disabled_at IS NULL
          RETURNING id
        `,
        [expiryAfterUpload(this.clock())]
      );
      const outOfService = await client.query(
        "SELECT count(*) AS total FROM drafts WHERE deleted_at IS NOT NULL OR disabled_at IS NOT NULL"
      );

      const anonymousSentinel = await dropAnonymousSentinel(
        (text, values) => client.query(text, values),
        sentinelDraftCount,
        sentinelHistoryRows,
        sentinelDraftsInService
      );

      await client.query("COMMIT");
      surgery = {
        flippedAt,
        reHomed,
        reArmedDraftCount: reArmed.rowCount ?? 0,
        leftOnTheirClockCount: Number(outOfService.rows[0]?.total ?? 0),
        anonymousSentinel
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    return { ...surgery, after: await this.inspectGoPublicFlip() };
  }

  async recordDraftReport(input: RecordDraftReportInput): Promise<DraftReportRecord> {
    // One INSERT and nothing else: no trigger, no cascade, no UPDATE of the
    // draft. That is what makes report volume unable to move any state.
    const result = await this.pool.query(
      `
        INSERT INTO draft_reports (id, draft_id, source_ip, reason)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [newInternalId("rpt"), input.draftId, input.sourceIp, cleanText(input.reason)]
    );
    return mapDraftReport(result.rows[0]);
  }

  async listDraftReports(draftId: string): Promise<DraftReportRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM draft_reports WHERE draft_id = $1 ORDER BY created_at, id",
      [draftId]
    );
    return result.rows.map(mapDraftReport);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [
        MIGRATION_ADVISORY_LOCK_KEY.toString()
      ]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      const applied = new Set(
        (await client.query("SELECT id FROM schema_migrations")).rows.map((row) =>
          String(row.id)
        )
      );

      for (const migration of this.migrations) {
        if (applied.has(migration.id)) continue;

        // One transaction per step: Postgres DDL is transactional, so a failed
        // step leaves neither half-applied schema nor a ledger row claiming it.
        await client.query("BEGIN");
        try {
          if (migration.postgres) await client.query(migration.postgres);
          await client.query(
            "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
            [migration.id]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw new Error(`Schema migration ${migration.id} failed.`, { cause: error });
        }
      }
    } finally {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY.toString()])
        .catch(() => undefined);
      client.release();
    }
  }

  private async ensureBootstrapToken(token: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO accounts (id, name)
        VALUES ($1, 'Bootstrap Account')
        ON CONFLICT (id) DO UPDATE SET updated_at = now()
      `,
      [BOOTSTRAP_PRINCIPAL_ID]
    );

    await this.pool.query(
      `
        INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
        VALUES ($2, $3, 'Bootstrap API Token', $1, '["admin", "upload"]'::jsonb)
        ON CONFLICT (id) DO UPDATE
          SET token_hash = EXCLUDED.token_hash,
              scopes = EXCLUDED.scopes,
              revoked_at = NULL
      `,
      [sha256(token), BOOTSTRAP_API_TOKEN_ID, BOOTSTRAP_PRINCIPAL_ID]
    );
  }
}

function mapDraft(row: any): DraftRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    visibility: row.visibility,
    currentVersionId: row.current_version_id,
    repoOrg: row.repo_org,
    repoName: row.repo_name,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    expiresAt: toIso(row.expires_at),
    pinnedAt: row.pinned_at ? toIso(row.pinned_at) : null,
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null,
    disabledAt: row.disabled_at ? toIso(row.disabled_at) : null,
    disabledReason: row.disabled_reason
  };
}

function mapModeratedDraft(row: any): ModeratedDraftRecord {
  return { ...mapDraft(row), createdByApiTokenId: row.created_by_api_token_id ?? null };
}

function mapDraftVersion(row: any): DraftVersionRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    versionNumber: Number(row.version_number),
    objectKey: row.object_key,
    contentHash: row.content_hash,
    fileSize: Number(row.file_size),
    createdByApiTokenId: row.created_by_api_token_id,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    cliVersion: row.cli_version,
    gitBranch: row.git_branch,
    gitCommitSha: row.git_commit_sha,
    originalFilename: row.original_filename,
    createdAt: toIso(row.created_at)
  };
}

function mapDraftReport(row: any): DraftReportRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    sourceIp: row.source_ip,
    reason: row.reason,
    createdAt: toIso(row.created_at)
  };
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The one query shape the flip's reads share. Both the inspection and the
 * surgery run against a single checked-out client — the surgery so its
 * preconditions and writes are one transaction, the inspection so its several
 * counts describe one instant rather than several.
 */
type FlipQuery = (
  text: string,
  values?: unknown[]
) => Promise<{ rows: any[]; rowCount: number | null }>;

/** Versions and upload events still naming the retired sentinel token. */
async function countSentinelHistoryRows(query: FlipQuery): Promise<number> {
  const result = await query(
    `
      SELECT
        (SELECT count(*) FROM draft_versions WHERE created_by_api_token_id = $1)
        + (SELECT count(*) FROM upload_events WHERE api_token_id = $1) AS total
    `,
    [RETIRED_ANONYMOUS_API_TOKEN_ID]
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * Assert-and-drop. The rows go only when the sentinel owns no drafts *and* no
 * version or upload event still names its token. The second condition is what
 * this driver's foreign keys would enforce anyway; checking it here means both
 * drivers refuse for the same stated reason instead of one raising a
 * constraint error the operator has to decode.
 */
async function dropAnonymousSentinel(
  query: FlipQuery,
  draftCount: number,
  historyRowCount: number,
  reArmedDraftCount: number
): Promise<AnonymousSentinelOutcome> {
  if (draftCount > 0) {
    return { disposition: "retained_drafts_present", draftCount, reArmedDraftCount };
  }
  if (historyRowCount > 0) {
    return { disposition: "retained_history_present", draftCount, reArmedDraftCount };
  }

  const token = await query("DELETE FROM api_tokens WHERE id = $1 RETURNING id", [
    RETIRED_ANONYMOUS_API_TOKEN_ID
  ]);
  const principal = await query("DELETE FROM accounts WHERE id = $1 RETURNING id", [
    RETIRED_ANONYMOUS_PRINCIPAL_ID
  ]);
  const dropped = (token.rowCount ?? 0) + (principal.rowCount ?? 0) > 0;
  return { disposition: dropped ? "dropped" : "absent", draftCount, reArmedDraftCount };
}

async function inspectWith(query: FlipQuery): Promise<GoPublicFlipInspection> {
  const applied = (
    await query("SELECT id FROM schema_migrations ORDER BY applied_at, id")
  ).rows.map((row) => String(row.id));

  const bootstrapTokens = await query(
    "SELECT id FROM api_tokens WHERE account_id = $1 ORDER BY id",
    [BOOTSTRAP_PRINCIPAL_ID]
  );
  const bootstrapPrincipal = await query("SELECT id FROM accounts WHERE id = $1", [
    BOOTSTRAP_PRINCIPAL_ID
  ]);
  const pinned = await query("SELECT id FROM drafts WHERE pinned_at IS NOT NULL ORDER BY id");

  const sentinel = await query(
    `
      SELECT
        (SELECT count(*) FROM accounts WHERE id = $1) AS principal_present,
        (SELECT count(*) FROM api_tokens WHERE id = $2) AS token_present,
        (SELECT count(*) FROM drafts WHERE account_id = $1) AS draft_count
    `,
    [RETIRED_ANONYMOUS_PRINCIPAL_ID, RETIRED_ANONYMOUS_API_TOKEN_ID]
  );

  const draftCounts = await query(
    `
      SELECT
        count(*) FILTER (WHERE deleted_at IS NULL AND disabled_at IS NULL) AS in_service,
        count(*) FILTER (WHERE deleted_at IS NOT NULL OR disabled_at IS NOT NULL) AS out_of_service,
        min(expires_at) FILTER (
          WHERE deleted_at IS NULL AND disabled_at IS NULL
        ) AS earliest_in_service_expiry
      FROM drafts
    `
  );

  const tallies = await query(
    `
      SELECT api_tokens.id,
             api_tokens.name,
             api_tokens.account_id,
             api_tokens.scopes @> '"admin"'::jsonb AS admin,
             count(drafts.id) AS live_draft_count
      FROM api_tokens
      JOIN draft_versions
        ON draft_versions.created_by_api_token_id = api_tokens.id
        AND draft_versions.version_number = $1
      JOIN drafts
        ON drafts.id = draft_versions.draft_id
        AND drafts.deleted_at IS NULL
        AND drafts.disabled_at IS NULL
      GROUP BY api_tokens.id, api_tokens.name, api_tokens.account_id, api_tokens.scopes
      ORDER BY count(drafts.id) DESC, api_tokens.id
    `,
    [FIRST_VERSION_NUMBER]
  );

  const earliest = draftCounts.rows[0]?.earliest_in_service_expiry;

  return {
    appliedMigrations: applied,
    pendingMigrations: pendingMigrationIds(applied),
    bootstrapPrincipalPresent: Boolean(bootstrapPrincipal.rowCount),
    bootstrapPrincipalApiTokenIds: bootstrapTokens.rows.map((row) => String(row.id)),
    pinnedDraftIds: pinned.rows.map((row) => String(row.id)),
    anonymousSentinel: {
      principalPresent: Number(sentinel.rows[0]?.principal_present ?? 0) > 0,
      tokenPresent: Number(sentinel.rows[0]?.token_present ?? 0) > 0,
      draftCount: Number(sentinel.rows[0]?.draft_count ?? 0),
      historyRowCount: await countSentinelHistoryRows(query)
    },
    draftsInService: Number(draftCounts.rows[0]?.in_service ?? 0),
    draftsOutOfService: Number(draftCounts.rows[0]?.out_of_service ?? 0),
    earliestInServiceExpiry: earliest ? toIso(earliest) : null,
    liveDraftTallies: tallies.rows.map((row): LiveDraftTally => ({
      apiTokenId: String(row.id),
      apiTokenName: String(row.name),
      principalId: String(row.account_id),
      admin: Boolean(row.admin),
      liveDraftCount: Number(row.live_draft_count)
    }))
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}
