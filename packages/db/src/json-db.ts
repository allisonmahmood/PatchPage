import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { newInternalId, sha256 } from "@patchpage/core";
import type {
  ApiTokenAuth,
  CreateApiTokenInput,
  DraftRecord,
  DraftVersionLookup,
  DraftVersionRecord,
  PatchPageDb,
  RecordUploadInput,
  RecordUploadResult
} from "./types.js";

interface AccountRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
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
  accounts: AccountRow[];
  apiTokens: ApiTokenRow[];
  drafts: DraftRecord[];
  draftVersions: DraftVersionRecord[];
  uploadEvents: UploadEventRow[];
}

export class JsonFilePatchPageDb implements PatchPageDb {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async initialize(bootstrapApiToken: string | null): Promise<void> {
    const state = await this.readState();
    ensureBootstrapState(state, bootstrapApiToken);
    await this.writeState(state);
  }

  async findApiTokenByToken(token: string): Promise<ApiTokenAuth | null> {
    const state = await this.readState();
    const tokenHash = sha256(token);
    const apiToken = state.apiTokens.find((row) => row.tokenHash === tokenHash && !row.revokedAt);
    if (!apiToken) return null;

    const account = state.accounts.find((row) => row.id === apiToken.accountId);
    if (!account) return null;

    apiToken.lastUsedAt = new Date().toISOString();
    await this.writeState(state);

    return {
      id: apiToken.id,
      accountId: apiToken.accountId,
      accountName: account.name,
      name: apiToken.name,
      scopes: apiToken.scopes
    };
  }

  async createApiToken(input: CreateApiTokenInput): Promise<{ id: string; name: string }> {
    const state = await this.readState();
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
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null
    };

    state.apiTokens.push(apiToken);
    await this.writeState(state);

    return { id: apiToken.id, name: apiToken.name };
  }

  async recordUpload(input: RecordUploadInput): Promise<RecordUploadResult> {
    const state = await this.readState();
    const now = new Date().toISOString();
    const existingDraft = state.drafts.find((draft) => draft.id === input.draftId) || null;

    if (existingDraft && (existingDraft.accountId !== input.accountId || existingDraft.deletedAt)) {
      const error = new Error("Draft not found.");
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }

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

    await this.writeState(state);
    return { draftId: input.draftId, versionId: input.versionId, versionNumber, title };
  }

  async findDraftVersion(draftId: string, versionNumber?: number): Promise<DraftVersionLookup> {
    const state = await this.readState();
    const draft =
      state.drafts.find((row) => row.id === draftId && !row.deletedAt && !row.disabledAt) || null;
    if (!draft) return { draft: null, version: null };

    const version = versionNumber
      ? state.draftVersions.find(
          (row) => row.draftId === draft.id && row.versionNumber === versionNumber
        ) || null
      : state.draftVersions.find((row) => row.id === draft.currentVersionId) || null;

    return { draft, version };
  }

  async disableDraft(draftId: string, accountId: string, reason: string): Promise<boolean> {
    const state = await this.readState();
    const draft =
      state.drafts.find((row) => row.id === draftId && row.accountId === accountId && !row.deletedAt) ||
      null;
    if (!draft) return false;

    draft.disabledAt = new Date().toISOString();
    draft.disabledReason = reason;
    draft.updatedAt = draft.disabledAt;
    await this.writeState(state);
    return true;
  }

  async deleteDraft(draftId: string, accountId: string): Promise<boolean> {
    const state = await this.readState();
    const draft =
      state.drafts.find((row) => row.id === draftId && row.accountId === accountId && !row.deletedAt) ||
      null;
    if (!draft) return false;

    draft.deletedAt = new Date().toISOString();
    draft.updatedAt = draft.deletedAt;
    await this.writeState(state);
    return true;
  }

  async close(): Promise<void> {
    return;
  }

  private async readState(): Promise<JsonDbState> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as JsonDbState;
    } catch {
      return emptyState();
    }
  }

  private async writeState(state: JsonDbState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function emptyState(): JsonDbState {
  return {
    accounts: [],
    apiTokens: [],
    drafts: [],
    draftVersions: [],
    uploadEvents: []
  };
}

function ensureBootstrapState(state: JsonDbState, bootstrapApiToken: string | null): void {
  if (!bootstrapApiToken) return;

  const now = new Date().toISOString();
  const account = state.accounts.find((row) => row.id === "acct_bootstrap");
  if (account) {
    account.updatedAt = now;
  } else {
    state.accounts.push({
      id: "acct_bootstrap",
      name: "Bootstrap Account",
      createdAt: now,
      updatedAt: now
    });
  }

  const token = state.apiTokens.find((row) => row.id === "tok_bootstrap");
  if (token) {
    token.tokenHash = sha256(bootstrapApiToken);
    token.scopes = ["admin", "upload"];
    token.revokedAt = null;
  } else {
    state.apiTokens.push({
      id: "tok_bootstrap",
      accountId: "acct_bootstrap",
      name: "Bootstrap API Token",
      tokenHash: sha256(bootstrapApiToken),
      scopes: ["admin", "upload"],
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null
    });
  }
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}
