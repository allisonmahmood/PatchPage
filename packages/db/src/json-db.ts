import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder, types as utilTypes } from "node:util";
import { newInternalId, sha256 } from "@patchpage/core";
import {
  applyJsonMigrations,
  JSON_MIGRATION_LEDGER_KEY,
  SCHEMA_MIGRATIONS
} from "./migrations.js";
import {
  GoPublicFlipPreconditionError,
  isInService,
  pendingMigrationIds,
  reHomeDisposition
} from "./go-public-flip.js";
import {
  BOOTSTRAP_API_TOKEN_ID,
  BOOTSTRAP_PRINCIPAL_ID,
  RETIRED_ANONYMOUS_API_TOKEN_ID,
  RETIRED_ANONYMOUS_PRINCIPAL_ID
} from "./internal-principals.js";
import { countsTowardMintQuota } from "./mint-quota.js";
import { expiryAfterUpload, expiryAfterVisit, isExpired } from "./retention.js";
import { UploadTargetError } from "./types.js";
import type { JsonMigrationState, SchemaMigration } from "./migrations.js";
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

interface AccountRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** The provenance mark: when this principal was self-service minted, else null. */
  selfServiceMintedAt: string | null;
}

interface TokenMintRow {
  id: string;
  accountId: string;
  apiTokenId: string;
  sourceIp: string | null;
  createdAt: string;
}

interface ApiTokenRow {
  id: string;
  accountId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface UploadEventRow {
  id: string;
  draftId: string;
  draftVersionId: string;
  apiTokenId: string;
  eventType: string;
  sourceIp: string | null;
  userAgent: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
}

interface JsonDbState {
  schemaMigrations: string[];
  accounts: AccountRow[];
  apiTokens: ApiTokenRow[];
  drafts: DraftRecord[];
  draftVersions: DraftVersionRecord[];
  uploadEvents: UploadEventRow[];
  draftReports: DraftReportRecord[];
  tokenMints: TokenMintRow[];
}

interface LoadedJsonDbState {
  state: JsonDbState;
  migrated: boolean;
}

interface StateMutationResult<T> {
  value: T;
  changed: boolean;
}

/** A draft's creating token is the one recorded on its first version. */
const FIRST_VERSION_NUMBER = 1;

// This serializer is intentionally process-local; interprocess locking is unsupported.
const mutationQueues = new Map<string, Promise<void>>();
const durabilityVerifiedDirectories = new Set<string>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class JsonFilePatchPageDb implements PatchPageDb {
  private readonly filePath: string;
  private readonly migrations: readonly SchemaMigration[];
  private readonly clock: () => number;

  constructor(filePath: string, options: DbDriverOptions = {}) {
    this.filePath = path.resolve(filePath);
    this.migrations = options.migrations ?? SCHEMA_MIGRATIONS;
    this.clock = options.clock ?? Date.now;
  }

  async initialize(bootstrapApiToken: string | null): Promise<void> {
    await this.mutateState((state) => {
      ensureBootstrapState(state, bootstrapApiToken, this.nowIso());
      return { value: undefined, changed: true };
    });
  }

  /**
   * This driver's stamps all come from the injected clock, including the ones
   * retention does not care about (`lastUsedAt`, `createdAt`, `disabledAt`,
   * `deletedAt`), because they are computed in TypeScript right here.
   *
   * The Postgres driver stamps those same fields with SQL `now()` and only
   * `expires_at` from the clock, because there they are column defaults and
   * `SET x = now()` clauses. So the two drivers agree exactly where it counts —
   * the retention anchor — and drift on the rest under a wound-forward clock.
   * Production is wall-clock on both, so this shows up only in tests.
   *
   * Deliberate, and deliberately left alone: converging them means either
   * spelling out every defaulted column in the Postgres INSERTs or giving up
   * clock control here. Whoever changes one driver's non-retention stamps must
   * change the other's in the same breath, or the drift becomes a real bug.
   */
  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  async listAppliedMigrations(): Promise<string[]> {
    const state = await this.readState();
    return [...state.schemaMigrations];
  }

  async findApiTokenByToken(token: string): Promise<ApiTokenAuth | null> {
    return this.mutateState<ApiTokenAuth | null>((state) => {
      const tokenHash = sha256(token);
      const apiToken = state.apiTokens.find((row) => row.tokenHash === tokenHash && !row.revokedAt);
      if (!apiToken) return { value: null, changed: false };

      const account = state.accounts.find((row) => row.id === apiToken.accountId);
      if (!account) return { value: null, changed: false };

      apiToken.lastUsedAt = this.nowIso();

      return {
        value: {
          id: apiToken.id,
          accountId: apiToken.accountId,
          accountName: account.name,
          name: apiToken.name,
          scopes: apiToken.scopes,
          selfService: account.selfServiceMintedAt !== null
        },
        changed: true
      };
    });
  }

  async createApiToken(input: CreateApiTokenInput): Promise<{ id: string; name: string }> {
    return this.mutateState((state) => {
      const account = state.accounts.find((row) => row.id === input.accountId);
      if (!account) {
        throw new Error("Account not found.");
      }

      const apiToken = {
        id: newInternalId("tok"),
        accountId: input.accountId,
        name: cleanText(input.name) || "API Token",
        tokenHash: sha256(input.token),
        scopes: input.scopes,
        createdAt: this.nowIso(),
        lastUsedAt: null,
        revokedAt: null
      };

      state.apiTokens.push(apiToken);

      return { value: { id: apiToken.id, name: apiToken.name }, changed: true };
    });
  }

  async countSelfServiceMintsBySourceIp(sourceIp: string | null): Promise<number> {
    const state = await this.readState();
    const now = this.clock();
    return state.tokenMints.filter(
      (mint) => mint.sourceIp === sourceIp && countsTowardMintQuota(mint.createdAt, now)
    ).length;
  }

  async mintSelfServiceToken(
    input: MintSelfServiceTokenInput
  ): Promise<MintSelfServiceTokenResult> {
    return this.mutateState((state) => {
      const now = this.nowIso();
      const name = cleanText(input.name) || "Self-service token";

      // Fresh principal, its one token, and the mint record — written together
      // under the same state mutation, so no reader ever sees a half-mint.
      const account: AccountRow = {
        id: newInternalId("acct"),
        name,
        createdAt: now,
        updatedAt: now,
        selfServiceMintedAt: now
      };
      const apiToken: ApiTokenRow = {
        id: newInternalId("tok"),
        accountId: account.id,
        name,
        tokenHash: sha256(input.token),
        // Upload only, never admin: a self-service token creates drafts and
        // updates or deletes the ones it owns, and the admin surface — token
        // creation included — stays out of its reach.
        scopes: ["upload"],
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null
      };

      state.accounts.push(account);
      state.apiTokens.push(apiToken);
      state.tokenMints.push({
        id: newInternalId("mint"),
        accountId: account.id,
        apiTokenId: apiToken.id,
        sourceIp: input.sourceIp,
        createdAt: now
      });

      return {
        value: {
          accountId: account.id,
          apiTokenId: apiToken.id,
          apiTokenName: apiToken.name
        },
        changed: true
      };
    });
  }

  async revokeApiToken(apiTokenId: string): Promise<ApiTokenRevocation | null> {
    return this.mutateState<ApiTokenRevocation | null>((state) => {
      const apiToken = state.apiTokens.find((row) => row.id === apiTokenId);
      if (!apiToken) return { value: null, changed: false };

      // The first revocation's stamp stands. It is the instant top-ups froze,
      // so re-stamping it would hand the token's drafts clock back.
      const alreadyRevoked = apiToken.revokedAt !== null;
      if (!alreadyRevoked) apiToken.revokedAt = this.nowIso();

      return {
        value: {
          id: apiToken.id,
          accountId: apiToken.accountId,
          name: apiToken.name,
          revokedAt: apiToken.revokedAt as string,
          alreadyRevoked
        },
        changed: !alreadyRevoked
      };
    });
  }

  async countLiveDraftsByCreatorApiToken(apiTokenId: string): Promise<number> {
    const state = await this.readState();
    const createdDraftIds = new Set(
      state.draftVersions
        .filter(
          (version) =>
            version.versionNumber === FIRST_VERSION_NUMBER &&
            version.createdByApiTokenId === apiTokenId
        )
        .map((version) => version.draftId)
    );

    let live = 0;
    for (const draft of state.drafts) {
      if (draft.deletedAt || draft.disabledAt) continue;
      if (createdDraftIds.has(draft.id)) live += 1;
    }
    return live;
  }

  async assertUploadTarget(input: UploadTargetInput): Promise<void> {
    return this.mutateState((state) => {
      assertUploadTarget(state, input, this.clock());
      return { value: undefined, changed: false };
    });
  }

  async recordUpload(input: RecordUploadInput): Promise<RecordUploadResult> {
    return this.mutateState((state) => {
      assertLosslessJsonPersistenceValue(input.metadata);
      const uploadedAt = this.clock();
      const existingDraft = assertUploadTarget(state, input, uploadedAt);
      const now = new Date(uploadedAt).toISOString();
      // An upload — first version or fifth — restarts the whole window.
      const expiresAt = expiryAfterUpload(uploadedAt);

      const versionNumber =
        Math.max(
          0,
          ...state.draftVersions
            .filter((version) => version.draftId === input.draftId)
            .map((version) => version.versionNumber)
        ) + 1;

      const title = input.title || existingDraft?.title || input.filename || "Untitled Draft";
      const repoOrg = cleanText(input.metadata.repoOrg);
      const repoName = cleanText(input.metadata.repoName);

      if (!existingDraft) {
        state.drafts.push({
          id: input.draftId,
          accountId: input.accountId,
          title,
          visibility: "unlisted",
          currentVersionId: input.versionId,
          repoOrg,
          repoName,
          createdAt: now,
          updatedAt: now,
          expiresAt,
          pinnedAt: null,
          deletedAt: null,
          disabledAt: null,
          disabledReason: null
        });
      } else {
        existingDraft.title = title;
        existingDraft.currentVersionId = input.versionId;
        existingDraft.repoOrg = repoOrg || existingDraft.repoOrg;
        existingDraft.repoName = repoName || existingDraft.repoName;
        existingDraft.updatedAt = now;
        existingDraft.expiresAt = expiresAt;
      }

      state.draftVersions.push({
        id: input.versionId,
        draftId: input.draftId,
        versionNumber,
        objectKey: input.objectKey,
        contentHash: input.contentHash,
        fileSize: input.fileSize,
        createdByApiTokenId: input.apiTokenId,
        sourceIp: input.sourceIp,
        userAgent: input.userAgent,
        cliVersion: cleanText(input.metadata.cliVersion),
        gitBranch: cleanText(input.metadata.gitBranch),
        gitCommitSha: cleanText(input.metadata.gitCommitSha),
        originalFilename: input.filename,
        createdAt: now
      });

      state.uploadEvents.push({
        id: newInternalId("evt"),
        draftId: input.draftId,
        draftVersionId: input.versionId,
        apiTokenId: input.apiTokenId,
        eventType: existingDraft ? "draft.updated" : "draft.created",
        sourceIp: input.sourceIp,
        userAgent: input.userAgent,
        metadataJson: input.metadata,
        createdAt: now
      });

      return {
        value: { draftId: input.draftId, versionId: input.versionId, versionNumber, title },
        changed: true
      };
    });
  }

  async findDraftVersion(draftId: string, versionNumber?: number): Promise<DraftVersionLookup> {
    const state = await this.readState();
    const now = this.clock();
    const draft =
      state.drafts.find(
        (row) =>
          row.id === draftId && !row.deletedAt && !row.disabledAt && !isExpired(row, now)
      ) || null;
    if (!draft) return { draft: null, version: null };

    const version = versionNumber
      ? state.draftVersions.find(
          (row) => row.draftId === draft.id && row.versionNumber === versionNumber
        ) || null
      : state.draftVersions.find((row) => row.id === draft.currentVersionId) || null;

    return { draft, version };
  }

  async findDraftForModeration(draftId: string): Promise<ModeratedDraftRecord | null> {
    const state = await this.readState();
    const draft = state.drafts.find((row) => row.id === draftId) || null;
    return draft ? moderatedDraft(state, draft) : null;
  }

  async listDraftsByPrincipal(
    principalId: string,
    limit: number
  ): Promise<PrincipalDraftListing> {
    const state = await this.readState();
    const owned = state.drafts
      .filter((row) => row.accountId === principalId && !row.deletedAt)
      .sort(byNewestFirst);

    return {
      drafts: owned.slice(0, Math.max(0, limit)).map((draft) => moderatedDraft(state, draft)),
      truncated: owned.length > Math.max(0, limit)
    };
  }

  async recordDraftVisit(draftId: string): Promise<void> {
    await this.mutateState((state) => {
      const now = this.clock();
      const draft =
        state.drafts.find(
          (row) =>
            row.id === draftId &&
            !row.deletedAt &&
            !row.disabledAt &&
            !hasRevokedCreator(state, row.id)
        ) || null;
      // A visit that changes nothing must not write: outside the top-up window,
      // serving a draft stays a pure read of the state file.
      const toppedUp = draft ? expiryAfterVisit(draft, now) : null;
      if (!draft || !toppedUp) return { value: undefined, changed: false };

      draft.expiresAt = toppedUp;
      return { value: undefined, changed: true };
    });
  }

  async setDraftPinned(draftId: string, pinned: boolean): Promise<boolean> {
    return this.mutateState((state) => {
      // Pinning needs a draft in service; unpinning takes whatever row is left,
      // so a pin can never be stuck on a draft that has since been taken down.
      const draft =
        state.drafts.find(
          (row) =>
            row.id === draftId && (!pinned || (!row.deletedAt && !row.disabledAt))
        ) || null;
      if (!draft) return { value: false, changed: false };

      draft.pinnedAt = pinned ? this.nowIso() : null;
      return { value: true, changed: true };
    });
  }

  async listExpiredDraftIds(limit: number): Promise<string[]> {
    if (limit <= 0) return [];

    const state = await this.readState();
    const now = this.clock();
    return state.drafts
      .filter((draft) => isExpired(draft, now))
      .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
      .slice(0, limit)
      .map((draft) => draft.id);
  }

  async deleteExpiredDraft(draftId: string): Promise<string[] | null> {
    return this.mutateState<string[] | null>((state) => {
      const now = this.clock();
      const draft = state.drafts.find((row) => row.id === draftId) || null;
      // Re-read under the mutation lock rather than trusting the listing: a pin
      // may have landed in between, and a pinned draft is not expired.
      if (!draft || !isExpired(draft, now)) return { value: null, changed: false };

      const objectKeys = state.draftVersions
        .filter((version) => version.draftId === draftId)
        .map((version) => version.objectKey);

      // Everything that points at the draft goes with it. Upload events name
      // both the draft and its versions, so they cannot outlive either.
      state.uploadEvents = state.uploadEvents.filter((event) => event.draftId !== draftId);
      state.draftVersions = state.draftVersions.filter(
        (version) => version.draftId !== draftId
      );
      state.drafts = state.drafts.filter((row) => row.id !== draftId);

      return { value: objectKeys, changed: true };
    });
  }

  async disableDraft(
    draftId: string,
    accountId: string,
    reason: string,
    options: DraftModerationOptions = {}
  ): Promise<boolean> {
    return this.mutateState((state) => {
      const draft =
        state.drafts.find(
          (row) =>
            row.id === draftId &&
            (row.accountId === accountId || options.canModerateAnyPrincipal === true) &&
            !row.deletedAt
        ) || null;
      if (!draft) return { value: false, changed: false };

      draft.disabledAt = this.nowIso();
      draft.disabledReason = reason;
      draft.updatedAt = draft.disabledAt;
      // Out of service, so out of pin: moderation outranks an expiry exemption.
      draft.pinnedAt = null;
      return { value: true, changed: true };
    });
  }

  async deleteDraft(
    draftId: string,
    accountId: string,
    options: DraftModerationOptions = {}
  ): Promise<boolean> {
    return this.mutateState((state) => {
      const draft =
        state.drafts.find(
          (row) =>
            row.id === draftId &&
            (row.accountId === accountId || options.canModerateAnyPrincipal === true) &&
            !row.deletedAt
        ) || null;
      if (!draft) return { value: false, changed: false };

      draft.deletedAt = this.nowIso();
      draft.updatedAt = draft.deletedAt;
      // A deleted draft keeps no pin, so its storage still ages out.
      draft.pinnedAt = null;
      return { value: true, changed: true };
    });
  }

  async inspectGoPublicFlip(): Promise<GoPublicFlipInspection> {
    const state = await this.readState();
    return inspectState(state);
  }

  async applyGoPublicFlip(input: GoPublicFlipInput): Promise<GoPublicFlipOutcome> {
    const outcome = await this.mutateState<Omit<GoPublicFlipOutcome, "after">>((state) => {
      const flippedAt = this.nowIso();

      // Every refusal is raised before the first assignment below, so a thrown
      // precondition leaves the state exactly as it was found.
      const pending = pendingMigrationIds(state.schemaMigrations);
      if (pending.length > 0) {
        throw new GoPublicFlipPreconditionError("migrations_pending", pending.join(", "));
      }
      if (!state.accounts.some((row) => row.id === BOOTSTRAP_PRINCIPAL_ID)) {
        throw new GoPublicFlipPreconditionError(
          "bootstrap_principal_missing",
          BOOTSTRAP_PRINCIPAL_ID
        );
      }
      const pinned = state.drafts.filter((row) => row.pinnedAt !== null);
      if (pinned.length > 0) {
        throw new GoPublicFlipPreconditionError(
          "draft_already_pinned",
          pinned.map((row) => row.id).join(", ")
        );
      }

      const planned: { token: ApiTokenRow; move: boolean }[] = [];
      for (const apiTokenId of input.reHomeApiTokenIds) {
        const token = state.apiTokens.find((row) => row.id === apiTokenId);
        if (!token) {
          throw new GoPublicFlipPreconditionError("rehome_target_unknown", apiTokenId);
        }
        if (token.id === BOOTSTRAP_API_TOKEN_ID) {
          throw new GoPublicFlipPreconditionError("rehome_target_is_bootstrap_token", apiTokenId);
        }
        if (token.scopes.includes("admin")) {
          throw new GoPublicFlipPreconditionError("rehome_target_has_admin_scope", apiTokenId);
        }
        const tokensOnPrincipal = state.apiTokens.filter(
          (row) => row.accountId === token.accountId
        ).length;
        const disposition = reHomeDisposition(token.accountId, tokensOnPrincipal);
        if (disposition === "shared") {
          throw new GoPublicFlipPreconditionError("rehome_target_principal_shared", apiTokenId);
        }
        planned.push({ token, move: disposition === "rehome" });
      }

      const reHomed: ReHomedApiToken[] = planned.map(({ token, move }) => {
        if (!move) {
          return {
            apiTokenId: token.id,
            apiTokenName: token.name,
            principalId: token.accountId,
            alreadyReHomed: true
          };
        }

        // The same three rows a self-service mint writes, minus the token: the
        // holder keeps the one they already have. The principal carries the
        // provenance mark and a mint record names it, because a mark that no
        // record derives would break the one invariant those two rows have —
        // and marking it is the fail-closed direction, since any later
        // guardrail keyed on "self-service" should reach a re-homed token too.
        // The record's address is null: no caller asked for this token, and
        // inventing an address would be inventing forensics.
        const principal: AccountRow = {
          id: newInternalId("acct"),
          name: token.name,
          createdAt: flippedAt,
          updatedAt: flippedAt,
          selfServiceMintedAt: flippedAt
        };
        state.accounts.push(principal);
        state.tokenMints.push({
          id: newInternalId("mint"),
          accountId: principal.id,
          apiTokenId: token.id,
          sourceIp: null,
          createdAt: flippedAt
        });
        // The drafts stay behind on the bootstrap principal. That is the
        // accepted consequence, not an oversight: this token's holder loses
        // edit rights over everything they published before the flip.
        token.accountId = principal.id;

        return {
          apiTokenId: token.id,
          apiTokenName: token.name,
          principalId: principal.id,
          alreadyReHomed: false
        };
      });

      const sentinelDrafts = state.drafts.filter(
        (row) => row.accountId === RETIRED_ANONYMOUS_PRINCIPAL_ID
      );
      const sentinelHistoryRows = countSentinelHistoryRows(state);

      // The uniform re-arm. Sentinel-owned drafts in service are in this set
      // like any other, which is exactly the revoked-style treatment they are
      // owed: a full window from the flip, with top-ups already frozen by the
      // revocation stamp their token has carried since it was seeded. Only the
      // anchor moves — `updatedAt` still means "when the content last changed".
      const expiresAt = expiryAfterUpload(this.clock());
      let reArmedDraftCount = 0;
      let leftOnTheirClockCount = 0;
      for (const draft of state.drafts) {
        if (!isInService(draft)) {
          leftOnTheirClockCount += 1;
          continue;
        }
        draft.expiresAt = expiresAt;
        reArmedDraftCount += 1;
      }

      const anonymousSentinel = dropAnonymousSentinel(
        state,
        sentinelDrafts.length,
        sentinelHistoryRows,
        sentinelDrafts.filter(isInService).length
      );

      return {
        value: {
          flippedAt,
          reHomed,
          reArmedDraftCount,
          leftOnTheirClockCount,
          anonymousSentinel
        },
        changed: true
      };
    });

    return { ...outcome, after: await this.inspectGoPublicFlip() };
  }

  async recordDraftReport(input: RecordDraftReportInput): Promise<DraftReportRecord> {
    return this.mutateState((state) => {
      // Nothing else in this transform touches the draft. Filing a report is a
      // write to one collection and nothing more — no disable, no clock change.
      const report: DraftReportRecord = {
        id: newInternalId("rpt"),
        draftId: input.draftId,
        sourceIp: input.sourceIp,
        reason: cleanText(input.reason),
        createdAt: this.nowIso()
      };

      state.draftReports.push(report);
      return { value: { ...report }, changed: true };
    });
  }

  async listDraftReports(draftId: string): Promise<DraftReportRecord[]> {
    const state = await this.readState();
    // Push order is chronological, so it is already the oldest-first order the
    // port promises — no sort needed, and none that could disagree with a
    // frozen clock's identical timestamps.
    return state.draftReports
      .filter((report) => report.draftId === draftId)
      .map((report) => ({ ...report }));
  }

  async close(): Promise<void> {
    return;
  }

  private async mutateState<T>(
    mutate: (state: JsonDbState) => StateMutationResult<T>
  ): Promise<T> {
    const mutationIdentities = await canonicalMutationIdentities(this.filePath);
    return serializeJsonMutation(mutationIdentities, async () => {
      const { state, migrated } = await this.loadState();
      const result = mutate(state);
      // A migration applied on read is only durable once something writes.
      if (result.changed || migrated) await this.writeState(state);
      return result.value;
    });
  }

  private async readState(): Promise<JsonDbState> {
    return (await this.loadState()).state;
  }

  private async loadState(): Promise<LoadedJsonDbState> {
    await assertNoSymlinkAncestors(this.filePath);
    await inspectDatabaseFilePath(this.filePath);

    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { state: this.migrateState(emptyState()).state, migrated: true };
      }
      throw error;
    }

    let serialized: string;
    try {
      serialized = utf8Decoder.decode(bytes);
    } catch {
      throw new Error("JSON metadata file is not valid UTF-8.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("JSON metadata file contains malformed JSON.");
    }

    if (!isRecord(parsed)) {
      throw new Error("JSON metadata file has an invalid state shape.");
    }

    const { state, changed } = this.migrateState(parsed);
    return { state, migrated: changed };
  }

  /**
   * Brings a persisted state up to the current schema, then guards it. Guards
   * describe the current schema only — migrations are what make a state written
   * by an earlier version readable, by default-filling the fields it lacks.
   */
  private migrateState(parsed: JsonMigrationState): {
    state: JsonDbState;
    changed: boolean;
  } {
    const { state, changed } = applyJsonMigrations(parsed, this.migrations);

    if (!isJsonDbState(state)) {
      throw new Error("JSON metadata file has an invalid state shape.");
    }

    return { state, changed };
  }

  private async writeState(state: JsonDbState): Promise<void> {
    await assertNoSymlinkAncestors(this.filePath);
    const serialized = serializeLosslessJsonState(state);
    const directoryPath = path.dirname(this.filePath);
    const temporaryPath = path.join(
      directoryPath,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    let directory: FileHandle | null = null;
    let temporaryFile: FileHandle | null = null;
    let renamed = false;

    try {
      directory = await ensureDurableDirectory(directoryPath);
      const existingFile = await inspectDatabaseFilePath(this.filePath);
      const existingMode = existingFile ? existingFile.mode & 0o777 : null;

      temporaryFile = await open(temporaryPath, "wx", existingMode ?? 0o666);
      await temporaryFile.writeFile(serialized, "utf8");
      if (existingMode !== null) await temporaryFile.chmod(existingMode);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = null;

      await inspectDatabaseFilePath(this.filePath);
      try {
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        // Linux reports EBUSY when rename targets a mount point, including
        // same-filesystem bind mounts that ordinary stat identity cannot detect.
        if (process.platform === "linux" && hasErrorCode(error, "EBUSY")) {
          throw new Error(
            "JSON metadata file cannot be a Linux single-file bind mount; mount a writable containing directory instead.",
            { cause: error }
          );
        }
        throw error;
      }
      renamed = true;
      try {
        await syncDirectoryHandle(directory);
      } catch {
        throw new Error(
          "JSON metadata commit outcome is indeterminate because the containing directory could not be flushed after rename."
        );
      }
    } finally {
      if (temporaryFile) {
        await temporaryFile.close().catch(() => undefined);
      }
      if (!renamed) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      if (directory) {
        await directory.close().catch(() => undefined);
      }
    }
  }
}

async function inspectDatabaseFilePath(filePath: string): Promise<Stats | null> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fileStats = await lstat(filePath);
      if (fileStats.isSymbolicLink()) {
        throw new Error("JSON metadata file path must not be a symbolic link.");
      }
      if (!fileStats.isFile()) {
        throw new Error("JSON metadata file path must be a regular file.");
      }
      if (fileStats.nlink === 1) return fileStats;
      // Some filesystems briefly report the replacement inode with two links
      // during an atomic rename. Confirm before rejecting a persistent hard link.
    }
    throw new Error("JSON metadata file path must not have multiple hard links.");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function assertNoSymlinkAncestors(filePath: string): Promise<void> {
  let ancestorPath = path.dirname(filePath);

  while (true) {
    try {
      const ancestorStats = await lstat(ancestorPath);
      const isDarwinCompatibilityPath =
        process.platform === "darwin" &&
        (ancestorPath === "/etc" || ancestorPath === "/tmp" || ancestorPath === "/var");
      // Darwin exposes these fixed platform roots as compatibility symlinks;
      // user-configurable symbolic-link parents remain unsupported.
      if (ancestorStats.isSymbolicLink() && !isDarwinCompatibilityPath) {
        throw new Error("JSON metadata file path must not have symbolic-link parent directories.");
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }

    const parent = path.dirname(ancestorPath);
    if (parent === ancestorPath) return;
    ancestorPath = parent;
  }
}

async function canonicalMutationIdentities(filePath: string): Promise<string[]> {
  let ancestorPath = path.dirname(filePath);
  const unresolvedComponents = [path.basename(filePath)];
  const identities: string[] = [];

  while (true) {
    try {
      const ancestorStats = await stat(ancestorPath, { bigint: true });
      // Every existing ancestor contributes a key. The higher keys remain stable
      // when missing directories appear, while device/inode identity collapses
      // case-insensitive and bind-mount aliases.
      const unresolvedSuffix = foldMutationIdentity(path.join(...unresolvedComponents));
      identities.push(`${ancestorStats.dev}:${ancestorStats.ino}:${unresolvedSuffix}`);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }

    const parent = path.dirname(ancestorPath);
    if (parent === ancestorPath) return identities;
    unresolvedComponents.unshift(path.basename(ancestorPath));
    ancestorPath = parent;
  }
}

function foldMutationIdentity(filePath: string): string {
  return filePath.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

function serializeLosslessJsonState(state: JsonDbState): string {
  try {
    assertLosslessJsonPersistenceValue(state);
    if (!isJsonDbState(state)) throw new Error("Invalid JSON database state.");

    const serialized = JSON.stringify(state, null, 2);
    if (typeof serialized !== "string") throw new Error("JSON serialization failed.");
    return `${serialized}\n`;
  } catch {
    throw jsonPersistenceError();
  }
}

function assertLosslessJsonPersistenceValue(value: unknown): void {
  try {
    assertLosslessJsonValue(value, new WeakSet<object>());
  } catch {
    throw jsonPersistenceError();
  }
}

function jsonPersistenceError(): Error {
  return new Error("JSON metadata state cannot be persisted losslessly.");
}

function assertLosslessJsonValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("Unsafe JSON number.");
    return;
  }

  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new Error("Unsafe JSON value.");
  }

  if (seen.has(value)) throw new Error("Repeated JSON object reference.");
  seen.add(value);

  assertNoJsonTransformation(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error("Unsafe JSON array.");
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) throw new Error("Sparse JSON array.");

    for (const key of keys) {
      if (key === "length") continue;
      if (typeof key !== "string") throw new Error("Symbol-keyed JSON array.");

      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      ) {
        throw new Error("Non-index JSON array property.");
      }

      assertJsonDataProperty(value, key, seen);
    }
    return;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Unsafe JSON object.");
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error("Symbol-keyed JSON object.");
    assertJsonDataProperty(value, key, seen);
  }
}

function assertNoJsonTransformation(value: object): void {
  let current: object | null = value;
  while (current) {
    if (utilTypes.isProxy(current)) {
      throw new Error("Proxy-backed JSON prototypes are unsupported.");
    }

    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (
      descriptor &&
      (!("value" in descriptor) || typeof descriptor.value === "function")
    ) {
      throw new Error("JSON transformation is unsupported.");
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
}

function assertJsonDataProperty(
  object: object,
  key: string,
  seen: WeakSet<object>
): void {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Unsafe JSON property.");
  }
  assertLosslessJsonValue(descriptor.value, seen);
}

async function serializeJsonMutation<T>(
  mutationIdentities: string[],
  task: () => Promise<T>
): Promise<T> {
  const previous = new Set<Promise<void>>();
  for (const identity of mutationIdentities) {
    const pending = mutationQueues.get(identity);
    if (pending) previous.add(pending);
  }

  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const identity of mutationIdentities) {
    mutationQueues.set(identity, current);
  }

  if (previous.size > 0) await Promise.all(previous);

  try {
    return await task();
  } finally {
    release();
    for (const identity of mutationIdentities) {
      if (mutationQueues.get(identity) === current) {
        mutationQueues.delete(identity);
      }
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function ensureDurableDirectory(directoryPath: string): Promise<FileHandle | null> {
  let directory: FileHandle | null;
  try {
    directory = await openDirectoryHandle(directoryPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;

    const parentPath = path.dirname(directoryPath);
    if (parentPath === directoryPath) throw error;
    const parent = await ensureDurableDirectory(parentPath);

    try {
      try {
        await mkdir(directoryPath);
      } catch (mkdirError) {
        if (!hasErrorCode(mkdirError, "EEXIST") || !(await stat(directoryPath)).isDirectory()) {
          throw mkdirError;
        }
      }
      await syncDirectoryHandle(parent);
      durabilityVerifiedDirectories.add(directoryPath);
    } finally {
      if (parent) await parent.close().catch(() => undefined);
    }

    return openDirectoryHandle(directoryPath);
  }

  if (durabilityVerifiedDirectories.has(directoryPath)) return directory;

  const parentPath = path.dirname(directoryPath);
  if (parentPath === directoryPath) {
    durabilityVerifiedDirectories.add(directoryPath);
    return directory;
  }

  let parent: FileHandle | null = null;
  try {
    parent = await ensureDurableDirectory(parentPath);
    await syncDirectoryHandle(parent);
    durabilityVerifiedDirectories.add(directoryPath);
    return directory;
  } catch (error) {
    if (directory) await directory.close().catch(() => undefined);
    throw error;
  } finally {
    if (parent) await parent.close().catch(() => undefined);
  }
}

async function openDirectoryHandle(directoryPath: string): Promise<FileHandle | null> {
  try {
    return await open(directoryPath, "r");
  } catch (error) {
    if (isUnsupportedDirectoryOperationError(error)) return null;
    throw error;
  }
}

async function syncDirectoryHandle(directory: FileHandle | null): Promise<void> {
  if (!directory) return;

  try {
    await directory.sync();
  } catch (error) {
    if (!isUnsupportedDirectoryOperationError(error)) throw error;
  }
}

function isUnsupportedDirectoryOperationError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;

  return (
    error.code === "EINVAL" ||
    error.code === "ENOTSUP" ||
    error.code === "EOPNOTSUPP" ||
    error.code === "ENOSYS" ||
    (process.platform === "win32" && (error.code === "EISDIR" || error.code === "EPERM"))
  );
}

function isJsonDbState(value: unknown): value is JsonDbState {
  if (!isRecord(value)) return false;

  return (
    isStringArray(value[JSON_MIGRATION_LEDGER_KEY]) &&
    Array.isArray(value.accounts) &&
    value.accounts.every(isAccountRow) &&
    Array.isArray(value.apiTokens) &&
    value.apiTokens.every(isApiTokenRow) &&
    Array.isArray(value.drafts) &&
    value.drafts.every(isDraftRecord) &&
    Array.isArray(value.draftVersions) &&
    value.draftVersions.every(isDraftVersionRecord) &&
    Array.isArray(value.uploadEvents) &&
    value.uploadEvents.every(isUploadEventRow) &&
    Array.isArray(value.draftReports) &&
    value.draftReports.every(isDraftReportRecord) &&
    Array.isArray(value.tokenMints) &&
    value.tokenMints.every(isTokenMintRow)
  );
}

function isAccountRow(value: unknown): value is AccountRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.selfServiceMintedAt)
  );
}

function isTokenMintRow(value: unknown): value is TokenMintRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.accountId === "string" &&
    typeof value.apiTokenId === "string" &&
    isNullableString(value.sourceIp) &&
    typeof value.createdAt === "string"
  );
}

function isApiTokenRow(value: unknown): value is ApiTokenRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.accountId === "string" &&
    typeof value.name === "string" &&
    typeof value.tokenHash === "string" &&
    isStringArray(value.scopes) &&
    typeof value.createdAt === "string" &&
    isNullableString(value.lastUsedAt) &&
    isNullableString(value.revokedAt)
  );
}

function isDraftRecord(value: unknown): value is DraftRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.accountId === "string" &&
    typeof value.title === "string" &&
    (value.visibility === "unlisted" ||
      value.visibility === "public" ||
      value.visibility === "private") &&
    isNullableString(value.currentVersionId) &&
    isNullableString(value.repoOrg) &&
    isNullableString(value.repoName) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.expiresAt === "string" &&
    isNullableString(value.pinnedAt) &&
    isNullableString(value.deletedAt) &&
    isNullableString(value.disabledAt) &&
    isNullableString(value.disabledReason)
  );
}

function isDraftVersionRecord(value: unknown): value is DraftVersionRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.draftId === "string" &&
    Number.isInteger(value.versionNumber) &&
    (value.versionNumber as number) > 0 &&
    typeof value.objectKey === "string" &&
    typeof value.contentHash === "string" &&
    Number.isInteger(value.fileSize) &&
    (value.fileSize as number) >= 0 &&
    typeof value.createdByApiTokenId === "string" &&
    isNullableString(value.sourceIp) &&
    isNullableString(value.userAgent) &&
    isNullableString(value.cliVersion) &&
    isNullableString(value.gitBranch) &&
    isNullableString(value.gitCommitSha) &&
    isNullableString(value.originalFilename) &&
    typeof value.createdAt === "string"
  );
}

function isUploadEventRow(value: unknown): value is UploadEventRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.draftId === "string" &&
    typeof value.draftVersionId === "string" &&
    typeof value.apiTokenId === "string" &&
    typeof value.eventType === "string" &&
    isNullableString(value.sourceIp) &&
    isNullableString(value.userAgent) &&
    isRecord(value.metadataJson) &&
    typeof value.createdAt === "string"
  );
}

function isDraftReportRecord(value: unknown): value is DraftReportRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.draftId === "string" &&
    isNullableString(value.sourceIp) &&
    isNullableString(value.reason) &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// A database that does not exist yet is an empty state at schema version zero:
// the migrations build its collections, exactly as they do for a stored one.
function emptyState(): JsonMigrationState {
  return {};
}

/** Versions and upload events still naming the retired sentinel token. */
function countSentinelHistoryRows(state: JsonDbState): number {
  const versions = state.draftVersions.filter(
    (row) => row.createdByApiTokenId === RETIRED_ANONYMOUS_API_TOKEN_ID
  ).length;
  const events = state.uploadEvents.filter(
    (row) => row.apiTokenId === RETIRED_ANONYMOUS_API_TOKEN_ID
  ).length;
  return versions + events;
}

/**
 * Assert-and-drop. The rows go only when the sentinel owns no drafts *and* no
 * version or upload event still names its token — the second condition is what
 * the Postgres foreign keys would enforce anyway, checked here so both drivers
 * refuse for the same reason instead of one throwing a constraint error.
 */
function dropAnonymousSentinel(
  state: JsonDbState,
  draftCount: number,
  historyRowCount: number,
  reArmedDraftCount: number
): AnonymousSentinelOutcome {
  const principalIndex = state.accounts.findIndex(
    (row) => row.id === RETIRED_ANONYMOUS_PRINCIPAL_ID
  );
  const tokenIndex = state.apiTokens.findIndex((row) => row.id === RETIRED_ANONYMOUS_API_TOKEN_ID);

  if (draftCount > 0) {
    return { disposition: "retained_drafts_present", draftCount, reArmedDraftCount };
  }
  if (historyRowCount > 0) {
    return { disposition: "retained_history_present", draftCount, reArmedDraftCount };
  }
  if (principalIndex < 0 && tokenIndex < 0) {
    return { disposition: "absent", draftCount, reArmedDraftCount };
  }

  if (tokenIndex >= 0) state.apiTokens.splice(tokenIndex, 1);
  if (principalIndex >= 0) state.accounts.splice(principalIndex, 1);
  return { disposition: "dropped", draftCount, reArmedDraftCount };
}

function inspectState(state: JsonDbState): GoPublicFlipInspection {
  const creatorByDraftId = new Map<string, string>();
  for (const version of state.draftVersions) {
    if (version.versionNumber !== FIRST_VERSION_NUMBER) continue;
    creatorByDraftId.set(version.draftId, version.createdByApiTokenId);
  }

  const liveByToken = new Map<string, number>();
  let draftsInService = 0;
  let draftsOutOfService = 0;
  let earliestInServiceExpiry: string | null = null;
  for (const draft of state.drafts) {
    if (!isInService(draft)) {
      draftsOutOfService += 1;
      continue;
    }
    draftsInService += 1;
    if (earliestInServiceExpiry === null || draft.expiresAt < earliestInServiceExpiry) {
      earliestInServiceExpiry = draft.expiresAt;
    }
    const creator = creatorByDraftId.get(draft.id);
    if (creator) liveByToken.set(creator, (liveByToken.get(creator) ?? 0) + 1);
  }

  const liveDraftTallies: LiveDraftTally[] = [];
  for (const token of state.apiTokens) {
    const liveDraftCount = liveByToken.get(token.id) ?? 0;
    const admin = token.scopes.includes("admin");
    // An admin token at zero still earns a line: it is the one the runbook
    // tells the operator to look for, and a uniformity check that vanishes
    // when the count happens to be zero proves nothing.
    if (liveDraftCount === 0 && !admin) continue;
    liveDraftTallies.push({
      apiTokenId: token.id,
      apiTokenName: token.name,
      principalId: token.accountId,
      admin,
      liveDraftCount
    });
  }
  liveDraftTallies.sort(
    (left, right) =>
      right.liveDraftCount - left.liveDraftCount || left.apiTokenId.localeCompare(right.apiTokenId)
  );

  return {
    appliedMigrations: [...state.schemaMigrations],
    pendingMigrations: pendingMigrationIds(state.schemaMigrations),
    bootstrapPrincipalPresent: state.accounts.some((row) => row.id === BOOTSTRAP_PRINCIPAL_ID),
    bootstrapPrincipalApiTokenIds: state.apiTokens
      .filter((row) => row.accountId === BOOTSTRAP_PRINCIPAL_ID)
      .map((row) => row.id)
      .sort(),
    pinnedDraftIds: state.drafts
      .filter((row) => row.pinnedAt !== null)
      .map((row) => row.id)
      .sort(),
    anonymousSentinel: {
      principalPresent: state.accounts.some((row) => row.id === RETIRED_ANONYMOUS_PRINCIPAL_ID),
      tokenPresent: state.apiTokens.some((row) => row.id === RETIRED_ANONYMOUS_API_TOKEN_ID),
      draftCount: state.drafts.filter((row) => row.accountId === RETIRED_ANONYMOUS_PRINCIPAL_ID)
        .length,
      historyRowCount: countSentinelHistoryRows(state)
    },
    draftsInService,
    draftsOutOfService,
    earliestInServiceExpiry,
    liveDraftTallies
  };
}

function ensureBootstrapState(
  state: JsonDbState,
  bootstrapApiToken: string | null,
  now: string
): void {
  if (!bootstrapApiToken) return;

  const account = state.accounts.find((row) => row.id === BOOTSTRAP_PRINCIPAL_ID);
  if (account) {
    account.updatedAt = now;
  } else {
    state.accounts.push({
      id: BOOTSTRAP_PRINCIPAL_ID,
      name: "Bootstrap Account",
      createdAt: now,
      updatedAt: now,
      // The operator's own principal: seeded, not minted, so it carries no mark.
      selfServiceMintedAt: null
    });
  }

  const token = state.apiTokens.find((row) => row.id === BOOTSTRAP_API_TOKEN_ID);
  if (token) {
    token.tokenHash = sha256(bootstrapApiToken);
    token.scopes = ["admin", "upload"];
    token.revokedAt = null;
  } else {
    state.apiTokens.push({
      id: BOOTSTRAP_API_TOKEN_ID,
      accountId: BOOTSTRAP_PRINCIPAL_ID,
      name: "Bootstrap API Token",
      tokenHash: sha256(bootstrapApiToken),
      scopes: ["admin", "upload"],
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null
    });
  }
}

/** The token on a draft's first version: who to revoke when a report lands. */
function creatingApiTokenId(state: JsonDbState, draftId: string): string | null {
  const firstVersion = state.draftVersions.find(
    (version) => version.draftId === draftId && version.versionNumber === FIRST_VERSION_NUMBER
  );
  return firstVersion ? firstVersion.createdByApiTokenId : null;
}

function moderatedDraft(state: JsonDbState, draft: DraftRecord): ModeratedDraftRecord {
  return { ...draft, createdByApiTokenId: creatingApiTokenId(state, draft.id) };
}

/** Whether the draft's clock is frozen because its creating token was revoked. */
function hasRevokedCreator(state: JsonDbState, draftId: string): boolean {
  const apiTokenId = creatingApiTokenId(state, draftId);
  if (!apiTokenId) return false;
  const apiToken = state.apiTokens.find((row) => row.id === apiTokenId);
  return Boolean(apiToken?.revokedAt);
}

/** Newest first, with the ID as a tiebreak so a page of drafts is stable. */
function byNewestFirst(left: DraftRecord, right: DraftRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? 1 : -1;
}

function assertUploadTarget(
  state: JsonDbState,
  input: UploadTargetInput,
  now: number
): DraftRecord | null {
  const existingDraft = state.drafts.find((draft) => draft.id === input.draftId) || null;

  if (input.intent === "create") {
    // An expired row still occupies its ID until the sweep removes it, so a
    // create against one is a conflict, not a fresh draft.
    if (existingDraft) throw new UploadTargetError("draft_conflict");
    return null;
  }

  // An expired draft is unavailable to its owner too: republishing is the way
  // back, and it comes through the create path with a new ID.
  if (
    !existingDraft ||
    existingDraft.accountId !== input.accountId ||
    existingDraft.deletedAt ||
    existingDraft.disabledAt ||
    isExpired(existingDraft, now)
  ) {
    throw new UploadTargetError("draft_unavailable");
  }
  return existingDraft;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}
