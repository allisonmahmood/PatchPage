import pg from "pg";
import { newInternalId, sha256 } from "@patchpage/core";
import {
  ANONYMOUS_INTERNAL_TOKEN_HASH,
  ANONYMOUS_UPLOAD_PRINCIPAL
} from "./internal-principals.js";
import { POSTGRES_SCHEMA_SQL } from "./migrations.js";
import { UploadTargetError } from "./types.js";
import type {
  AnonymousUploadPrincipal,
  ApiTokenAuth,
  CreateApiTokenInput,
  DraftRecord,
  DraftModerationOptions,
  DraftVersionLookup,
  DraftVersionRecord,
  PatchPageDb,
  RecordUploadInput,
  RecordUploadResult,
  UploadTargetInput
} from "./types.js";

const { Pool } = pg;

export class PostgresPatchPageDb implements PatchPageDb {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(bootstrapApiToken: string | null): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA_SQL);
    if (bootstrapApiToken) {
      await this.ensureBootstrapToken(bootstrapApiToken);
    }
  }

  async getAnonymousUploadPrincipal(): Promise<AnonymousUploadPrincipal> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM api_tokens
        JOIN accounts ON accounts.id = api_tokens.account_id
        WHERE api_tokens.id = $1
          AND api_tokens.account_id = $2
          AND api_tokens.token_hash = $3
          AND api_tokens.revoked_at IS NOT NULL
        LIMIT 1
      `,
      [
        ANONYMOUS_UPLOAD_PRINCIPAL.apiTokenId,
        ANONYMOUS_UPLOAD_PRINCIPAL.accountId,
        ANONYMOUS_INTERNAL_TOKEN_HASH
      ]
    );
    if (!result.rowCount) {
      throw new Error("Anonymous upload principal is not initialized.");
    }
    return { ...ANONYMOUS_UPLOAD_PRINCIPAL };
  }

  async findApiTokenByToken(token: string): Promise<ApiTokenAuth | null> {
    const result = await this.pool.query(
      `
        SELECT api_tokens.id, api_tokens.account_id, api_tokens.name, api_tokens.scopes,
               accounts.name AS account_name
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
      scopes: normalizeScopes(row.scopes)
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
            `,
            [input.draftId, input.accountId]
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
            FOR UPDATE
          `,
          [input.draftId, input.accountId]
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
              id, account_id, title, visibility, current_version_id, repo_org, repo_name
            )
            VALUES ($1, $2, $3, 'unlisted', $4, $5, $6)
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          `,
          [input.draftId, input.accountId, title, input.versionId, repoOrg, repoName]
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
              updated_at = now()
          WHERE id = $5
        `,
        [input.versionId, title, repoOrg, repoName, input.draftId]
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
        LIMIT 1
      `,
      [draftId]
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

  async disableDraft(
    draftId: string,
    accountId: string,
    reason: string,
    options: DraftModerationOptions = {}
  ): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE drafts
        SET disabled_at = now(), disabled_reason = $3, updated_at = now()
        WHERE id = $1
          AND (account_id = $2 OR ($4 AND account_id = $5))
          AND deleted_at IS NULL
        RETURNING id
      `,
      [
        draftId,
        accountId,
        reason,
        options.canModerateAnonymous === true,
        ANONYMOUS_UPLOAD_PRINCIPAL.accountId
      ]
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
        SET deleted_at = now(), updated_at = now()
        WHERE id = $1
          AND (account_id = $2 OR ($3 AND account_id = $4))
          AND deleted_at IS NULL
        RETURNING id
      `,
      [
        draftId,
        accountId,
        options.canModerateAnonymous === true,
        ANONYMOUS_UPLOAD_PRINCIPAL.accountId
      ]
    );
    return Boolean(result.rowCount);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureBootstrapToken(token: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO accounts (id, name)
        VALUES ('acct_bootstrap', 'Bootstrap Account')
        ON CONFLICT (id) DO UPDATE SET updated_at = now()
      `
    );

    await this.pool.query(
      `
        INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
        VALUES ('tok_bootstrap', 'acct_bootstrap', 'Bootstrap API Token', $1, '["admin", "upload"]'::jsonb)
        ON CONFLICT (id) DO UPDATE
          SET token_hash = EXCLUDED.token_hash,
              scopes = EXCLUDED.scopes,
              revoked_at = NULL
      `,
      [sha256(token)]
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
    deletedAt: row.deleted_at ? toIso(row.deleted_at) : null,
    disabledAt: row.disabled_at ? toIso(row.disabled_at) : null,
    disabledReason: row.disabled_reason
  };
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

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}
