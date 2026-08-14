import type { DraftVisibility, UploadMetadata } from "@patchpage/core";
import type { SchemaMigration } from "./migrations.js";

export interface ApiTokenAuth {
  id: string;
  accountId: string;
  accountName: string;
  name: string;
  scopes: string[];
}

export interface AnonymousUploadPrincipal {
  accountId: string;
  apiTokenId: string;
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

export interface CreateApiTokenInput {
  accountId: string;
  name: string;
  token: string;
  scopes: string[];
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
  canModerateAnonymous?: boolean;
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
  getAnonymousUploadPrincipal(): Promise<AnonymousUploadPrincipal>;
  findApiTokenByToken(token: string): Promise<ApiTokenAuth | null>;
  createApiToken(input: CreateApiTokenInput): Promise<{ id: string; name: string }>;
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
   * narrows it: the instance's own pages may sit on any account. Answers
   * whether a draft was there to move; a deleted draft is not.
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
  close(): Promise<void>;
}

export interface DbFactoryOptions {
  driver: "postgres" | "json";
  databaseUrl: string | null;
  jsonDbFile: string;
}
