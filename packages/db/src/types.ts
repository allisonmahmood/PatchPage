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
}

export interface PatchPageDb {
  initialize(bootstrapApiToken: string | null): Promise<void>;
  /** The applied migration IDs this database records, in apply order. */
  listAppliedMigrations(): Promise<string[]>;
  getAnonymousUploadPrincipal(): Promise<AnonymousUploadPrincipal>;
  findApiTokenByToken(token: string): Promise<ApiTokenAuth | null>;
  createApiToken(input: CreateApiTokenInput): Promise<{ id: string; name: string }>;
  assertUploadTarget(input: UploadTargetInput): Promise<void>;
  recordUpload(input: RecordUploadInput): Promise<RecordUploadResult>;
  findDraftVersion(draftId: string, versionNumber?: number): Promise<DraftVersionLookup>;
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
