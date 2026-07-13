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
import { UploadTargetError } from "./types.js";
import type {
  ApiTokenAuth,
  CreateApiTokenInput,
  DraftRecord,
  DraftVersionLookup,
  DraftVersionRecord,
  PatchPageDb,
  RecordUploadInput,
  RecordUploadResult,
  UploadTargetInput
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

interface StateMutationResult<T> {
  value: T;
  changed: boolean;
}

// This serializer is intentionally process-local; interprocess locking is unsupported.
const mutationQueues = new Map<string, Promise<void>>();
const durabilityVerifiedDirectories = new Set<string>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class JsonFilePatchPageDb implements PatchPageDb {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async initialize(bootstrapApiToken: string | null): Promise<void> {
    await this.mutateState((state) => {
      ensureBootstrapState(state, bootstrapApiToken);
      return { value: undefined, changed: true };
    });
  }

  async findApiTokenByToken(token: string): Promise<ApiTokenAuth | null> {
    return this.mutateState<ApiTokenAuth | null>((state) => {
      const tokenHash = sha256(token);
      const apiToken = state.apiTokens.find((row) => row.tokenHash === tokenHash && !row.revokedAt);
      if (!apiToken) return { value: null, changed: false };

      const account = state.accounts.find((row) => row.id === apiToken.accountId);
      if (!account) return { value: null, changed: false };

      apiToken.lastUsedAt = new Date().toISOString();

      return {
        value: {
          id: apiToken.id,
          accountId: apiToken.accountId,
          accountName: account.name,
          name: apiToken.name,
          scopes: apiToken.scopes
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
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null
      };

      state.apiTokens.push(apiToken);

      return { value: { id: apiToken.id, name: apiToken.name }, changed: true };
    });
  }

  async assertUploadTarget(input: UploadTargetInput): Promise<void> {
    return this.mutateState((state) => {
      assertUploadTarget(state, input);
      return { value: undefined, changed: false };
    });
  }

  async recordUpload(input: RecordUploadInput): Promise<RecordUploadResult> {
    return this.mutateState((state) => {
      assertLosslessJsonPersistenceValue(input.metadata);
      const existingDraft = assertUploadTarget(state, input);
      const now = new Date().toISOString();

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

      return {
        value: { draftId: input.draftId, versionId: input.versionId, versionNumber, title },
        changed: true
      };
    });
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
    return this.mutateState((state) => {
      const draft =
        state.drafts.find(
          (row) => row.id === draftId && row.accountId === accountId && !row.deletedAt
        ) || null;
      if (!draft) return { value: false, changed: false };

      draft.disabledAt = new Date().toISOString();
      draft.disabledReason = reason;
      draft.updatedAt = draft.disabledAt;
      return { value: true, changed: true };
    });
  }

  async deleteDraft(draftId: string, accountId: string): Promise<boolean> {
    return this.mutateState((state) => {
      const draft =
        state.drafts.find(
          (row) => row.id === draftId && row.accountId === accountId && !row.deletedAt
        ) || null;
      if (!draft) return { value: false, changed: false };

      draft.deletedAt = new Date().toISOString();
      draft.updatedAt = draft.deletedAt;
      return { value: true, changed: true };
    });
  }

  async close(): Promise<void> {
    return;
  }

  private async mutateState<T>(
    mutate: (state: JsonDbState) => StateMutationResult<T>
  ): Promise<T> {
    const mutationIdentities = await canonicalMutationIdentities(this.filePath);
    return serializeJsonMutation(mutationIdentities, async () => {
      const state = await this.readState();
      const result = mutate(state);
      if (result.changed) await this.writeState(state);
      return result.value;
    });
  }

  private async readState(): Promise<JsonDbState> {
    await assertNoSymlinkAncestors(this.filePath);
    await inspectDatabaseFilePath(this.filePath);

    let bytes: Buffer;
    try {
      bytes = await readFile(this.filePath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return emptyState();
      throw error;
    }

    let serialized: string;
    try {
      serialized = utf8Decoder.decode(bytes);
    } catch {
      throw new Error("JSON metadata file is not valid UTF-8.");
    }

    let state: unknown;
    try {
      state = JSON.parse(serialized);
    } catch {
      throw new Error("JSON metadata file contains malformed JSON.");
    }

    if (!isJsonDbState(state)) {
      throw new Error("JSON metadata file has an invalid state shape.");
    }

    return state;
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
            "JSON metadata file cannot be a Linux single-file bind mount; mount a writable containing directory instead."
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
    Array.isArray(value.accounts) &&
    value.accounts.every(isAccountRow) &&
    Array.isArray(value.apiTokens) &&
    value.apiTokens.every(isApiTokenRow) &&
    Array.isArray(value.drafts) &&
    value.drafts.every(isDraftRecord) &&
    Array.isArray(value.draftVersions) &&
    value.draftVersions.every(isDraftVersionRecord) &&
    Array.isArray(value.uploadEvents) &&
    value.uploadEvents.every(isUploadEventRow)
  );
}

function isAccountRow(value: unknown): value is AccountRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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

function assertUploadTarget(
  state: JsonDbState,
  input: UploadTargetInput
): DraftRecord | null {
  const existingDraft = state.drafts.find((draft) => draft.id === input.draftId) || null;

  if (input.intent === "create") {
    if (existingDraft) throw new UploadTargetError("draft_conflict");
    return null;
  }

  if (
    !existingDraft ||
    existingDraft.accountId !== input.accountId ||
    existingDraft.deletedAt ||
    existingDraft.disabledAt
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
