import type { DraftVisibility, UploadMetadata } from "@patchpage/core";
import type { SchemaMigration } from "./migrations.js";

export interface ApiTokenAuth {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  scopes: string[];
  /**
   * Whether this token's principal came from a self-service mint — the
   * provenance mark, read back on the path every API request already takes so
   * a guardrail can key on it without a second query. Operator-created tokens
   * are false, including every token that predates self-service minting.
   */
  selfService: boolean;
}

export interface DraftRecord {
  id: string;
  accountId: string;
  title: string;
  visibility: DraftVisibility;
  currentVersionId: string | null;
  repoOrg: string | null;
  repoName: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The retention clock's anchor: the draft is expired once this is past,
   * unless `pinnedAt` holds it.
   */
  expiresAt: string;
  /**
   * When an operator pinned this draft, or `null` for an ordinary one. A pinned
   * draft is exempt from expiry — it keeps serving and the sweep never takes
   * it — and is ordinary in every other respect.
   */
  pinnedAt: string | null;
  deletedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface DraftVersionRecord {
  id: string;
  draftId: string;
  versionNumber: number;
  objectKey: string;
  contentHash: string;
  fileSize: number;
  createdByApiTokenId: string;
  sourceIp: string | null;
  userAgent: string | null;
  cliVersion: string | null;
  gitBranch: string | null;
  gitCommitSha: string | null;
  originalFilename: string | null;
  createdAt: string;
}

/**
 * A reader's flag on a served draft, filed without an account and stored for an
 * operator to read. Nothing in the system acts on one: disabling, deleting, and
 * revoking are all operator decisions, so no volume of these rows can take a
 * page down.
 *
 * A report outlives its draft on purpose — `draftId` is a plain string, not a
 * reference — because expiry hard-deletes drafts and the record of what was
 * reported has to survive that.
 */
export interface DraftReportRecord {
  id: string;
  draftId: string;
  /** The reporting reader's address, as the server resolved it. */
  sourceIp: string | null;
  /** The reader's optional short note. Absent when they filed without one. */
  reason: string | null;
  createdAt: string;
}

export interface RecordDraftReportInput {
  draftId: string;
  sourceIp: string | null;
  reason: string | null;
}

export interface CreateApiTokenInput {
  accountId: string;
  name: string;
  token: string;
  scopes: string[];
}

export interface MintSelfServiceTokenInput {
  /** The plaintext token. Only its hash is stored, exactly as elsewhere. */
  token: string;
  /**
   * The internal name for both the new principal and its token. The server
   * derives it from the mint date; it exists for admin legibility and is never
   * chosen by the client, because the mint operation takes no input at all.
   */
  name: string;
  /** The mint's source address, or null when the request has no usable one. */
  sourceIp: string | null;
}

export interface MintSelfServiceTokenResult {
  accountId: string;
  apiTokenId: string;
  apiTokenName: string;
}

export interface UploadTargetInput {
  intent: "create" | "update";
  draftId: string;
  accountId: string;
}

export interface RecordUploadInput extends UploadTargetInput {
  versionId: string;
  apiTokenId: string;
  title: string;
  objectKey: string;
  contentHash: string;
  fileSize: number;
  filename: string | null;
  metadata: UploadMetadata;
  sourceIp: string | null;
  userAgent: string | null;
}

export type UploadTargetErrorCode = "draft_unavailable" | "draft_conflict";

export class UploadTargetError extends Error {
  readonly statusCode: 404 | 409;

  constructor(readonly code: UploadTargetErrorCode) {
    super(code === "draft_unavailable" ? "Draft not found." : "Draft already exists.");
    this.statusCode = code === "draft_unavailable" ? 404 : 409;
  }
}

export function isUploadTargetError(error: unknown): error is UploadTargetError {
  return error instanceof UploadTargetError;
}

export interface RecordUploadResult {
  draftId: string;
  versionId: string;
  versionNumber: number;
  title: string;
}

export interface DraftVersionLookup {
  draft: DraftRecord | null;
  version: DraftVersionRecord | null;
}

export interface DraftModerationOptions {
  /**
   * Lets the caller moderate a draft owned by any principal, not just its own.
   * This is the operator's moderation reach, granted by the `admin` scope; it is
   * keyed on nothing but that scope. (It replaces a carve-out that reached only
   * the retired anonymous sentinel account.)
   */
  canModerateAnyPrincipal?: boolean;
}

export interface DbDriverOptions {
  /**
   * The ordered migration list to run. Defaults to the shipped
   * `SCHEMA_MIGRATIONS`; overridden to exercise a migration end to end.
   */
  migrations?: readonly SchemaMigration[];
  /**
   * Epoch milliseconds, `Date.now` by default — the same shape the server and
   * the rate limiters take. The retention clock reads it, so a driver and the
   * app in front of it want the *same* function: give `createApp` one clock and
   * its database another and expiry will not move when the app's clock does.
   */
  clock?: () => number;
}

export interface PatchPageDb {
  initialize(bootstrapApiToken: string | null): Promise<void>;
  /** The applied migration IDs this database records, in apply order. */
  listAppliedMigrations(): Promise<string[]>;
  findApiTokenByToken(token: string): Promise<ApiTokenAuth | null>;
  createApiToken(input: CreateApiTokenInput): Promise<{ id: string; name: string }>;
  /**
   * How many self-service mints this source address has to its name inside the
   * quota window ending now. The window is `mint-quota.ts`'s, read from the
   * driver's own clock — the caller passes no instant, exactly as the live-draft
   * tally takes no cutoff.
   *
   * A null address is a bucket like any other: mints the server could not
   * attribute count together rather than each escaping the tally.
   */
  countSelfServiceMintsBySourceIp(sourceIp: string | null): Promise<number>;
  /**
   * Mints a self-service token: a fresh principal, the one token that controls
   * it, and the mint record carrying source address and date, together. All
   * three or none — a principal with no token owns drafts nobody can reach, and
   * a token with no mint record is one the quota cannot see.
   *
   * The principal is 1:1 with the token by construction, which is the whole
   * point: it reuses the account-scoped ownership checks unchanged, so a
   * self-service token reaches its own drafts and no others without a second
   * authorization model existing anywhere.
   */
  mintSelfServiceToken(input: MintSelfServiceTokenInput): Promise<MintSelfServiceTokenResult>;
  /**
   * How many drafts this token created that are still live — neither deleted
   * nor disabled. The creating token is the one on a draft's first version, so
   * a later update by another token never moves a draft between tallies. This
   * is the durable half of the per-token quota: it is recounted from the
   * database on every create, so a restart cannot reset it.
   */
  countLiveDraftsByCreatorApiToken(apiTokenId: string): Promise<number>;
  assertUploadTarget(input: UploadTargetInput): Promise<void>;
  recordUpload(input: RecordUploadInput): Promise<RecordUploadResult>;
  /** Expired drafts are absent here, exactly as deleted and disabled ones are. */
  findDraftVersion(draftId: string, versionNumber?: number): Promise<DraftVersionLookup>;
  /**
   * Tops a served draft's retention clock up to the visit-extension window when
   * less than that remains. A no-op otherwise, including for a draft that is
   * already expired, deleted, or disabled — a visit never shortens the clock
   * and never brings a draft back.
   */
  recordDraftVisit(draftId: string): Promise<void>;
  /**
   * Pins or unpins a draft, exempting it from expiry or handing it back to the
   * clock. An operator's act and admin-only above this port, so no ownership
   * narrows it: the instance's own pages may sit on any account.
   *
   * A pin is a statement about a page that is *live*, and the two directions
   * are deliberately not symmetric. Pinning answers `false` unless the draft is
   * in service — neither deleted nor disabled — because a pin on a taken-down
   * draft would exempt storage nobody can reach from the sweep. Unpinning
   * answers `true` for any row that is still there, so a pin can never become
   * stuck on a draft the operator has since taken down.
   *
   * Pinning is idempotent in effect but not in stamp — re-pinning restamps
   * `pinnedAt` — and unpinning restores the ordinary clock, which for a draft
   * pinned long past its anchor means it expires immediately.
   */
  setDraftPinned(draftId: string, pinned: boolean): Promise<boolean>;
  /**
   * IDs the expiry sweep may take right now — expired and unpinned, the
   * longest-expired first — capped at `limit`. Deleted and disabled drafts are
   * included: they are out of sight already, and the sweep is what finally
   * frees their storage.
   */
  listExpiredDraftIds(limit: number): Promise<string[]>;
  /**
   * Hard-deletes one expired draft — its upload events, its versions, and the
   * draft row — and answers with the storage keys those versions held, so the
   * caller can delete the content behind them. Answers `null` when the draft is
   * no longer the sweep's to take: already gone, or pinned since it was listed.
   *
   * The record goes first on purpose. Once the row is gone its objects are
   * unreachable, so a crash before the caller deletes them leaks storage — the
   * other order risks a live draft whose content vanished, which is worse.
   */
  deleteExpiredDraft(draftId: string): Promise<string[] | null>;
  /**
   * Taking a draft out of service ends any pin on it, here and in
   * `deleteDraft`. A pinned draft is otherwise ordinary, and that includes
   * this: moderation and deletion outrank a pin, so neither can leave content
   * the sweep may never take.
   */
  disableDraft(
    draftId: string,
    accountId: string,
    reason: string,
    options?: DraftModerationOptions
  ): Promise<boolean>;
  deleteDraft(
    draftId: string,
    accountId: string,
    options?: DraftModerationOptions
  ): Promise<boolean>;
  /**
   * Files a reader's report against a draft. Storing one is the whole effect:
   * this writes a row and changes nothing about the draft, its retention clock,
   * or its owning token.
   */
  recordDraftReport(input: RecordDraftReportInput): Promise<DraftReportRecord>;
  /**
   * Every report filed against one draft, oldest first. This is the operator's
   * review path at launch — a database read, deliberately with no endpoint in
   * front of it — and the seam the report path is observable through.
   */
  listDraftReports(draftId: string): Promise<DraftReportRecord[]>;
  close(): Promise<void>;
}

export interface DbFactoryOptions {
  driver: "postgres" | "json";
  databaseUrl: string | null;
  jsonDbFile: string;
}
