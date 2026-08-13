#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Command } from "commander";
import { sha256, validateHtml } from "@patchpage/core";

const VERSION = typeof __PATCHPAGE_VERSION__ === "string" ? __PATCHPAGE_VERSION__ : "0.0.0-dev";
const DEFAULT_API_URL = "https://post.patchyhq.com";
const SELF_HOST_DOCS_URL = "https://github.com/allisonmahmood/PatchPage/blob/main/docs/SELF_HOSTING.md";
const STATE_DIR = readEnv("PATCHPAGE_STATE_DIR") ?? path.join(os.homedir(), ".patchpage");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const CREDENTIALS_PATH = path.join(STATE_DIR, "credentials.json");
const DRAFTS_PATH = path.join(STATE_DIR, "drafts.json");

class CliError extends Error {}

/**
 * A state file left over from the retired single-instance format. Fail-closed
 * everywhere: the CLI never migrates one, because the token it holds is the
 * only key to the drafts it created.
 */
class LegacyStateError extends CliError {}

const INVALID_CREDENTIALS_ERROR =
  "Stored credentials are invalid. Run: patchpage auth set to replace them.";
const UNREADABLE_CREDENTIALS_ERROR =
  "Stored credentials could not be read. Check permissions or run: patchpage auth set to replace them.";
const INVALID_DRAFT_CACHE_ERROR = `The stored draft cache is invalid: ${DRAFTS_PATH}\nDelete that file to start a fresh cache. Drafts already published are unaffected.`;
const UNREADABLE_DRAFT_CACHE_ERROR = `The stored draft cache could not be read: ${DRAFTS_PATH}\nCheck permissions, or delete that file to start a fresh cache.`;

interface CliConfig {
  apiUrl?: string;
}

type CredentialSource = "mint" | "auth-set";

interface HostCredential {
  token: string;
  updatedAt?: string;
  source?: CredentialSource;
}

/** credentials.json — one token per instance, keyed by normalized API URL. */
interface CredentialStore {
  hosts: Record<string, HostCredential>;
}

interface CachedDraft {
  draftId: string;
  publicUrl: string;
  latestVersionNumber: number;
  updatedAt: string;
}

/** drafts.json — the draft cache, scoped per instance. */
interface DraftStore {
  hosts: Record<string, { files: Record<string, CachedDraft> }>;
}

const program = new Command();

// Commander 15+ embeds excess argument values in its error text. Configure this
// before subcommands are registered so they inherit it. Keep the pre-15 message
// shape so a mistaken secret passed as a positional is never echoed on stderr.
program.configureOutput({
  outputError: (str, write) => {
    write(
      str.replace(
        /(error: too many arguments(?: for '[^']+')?\. Expected \d+ arguments? but got \d+): .+\.(\n?)$/,
        "$1.$2"
      )
    );
  }
});

program.name("patchpage").description("Upload static HTML drafts to PatchPage.").version(VERSION);

program
  .command("auth")
  .description("Manage CLI authentication.")
  .command("set")
  .option("--token-stdin", "Read the PatchPage API token from stdin")
  .option("--api-url <url>", "Override the default PatchPage API base URL")
  .action(async (options: { tokenStdin?: boolean; apiUrl?: string }) => {
    if (options.tokenStdin && process.stdin.isTTY) {
      throw new CliError(
        "--token-stdin requires redirected input. Run patchpage auth set to use the hidden interactive prompt."
      );
    }

    // Reject a retired state file before asking for a token, so a fail-closed
    // state dir never costs the operator a prompt.
    const credentials = readCredentialStoreForWrite();

    const tokenInput = options.tokenStdin
      ? readFileSync(process.stdin.fd, "utf8")
      : await promptForApiToken();
    const apiToken = parseApiToken(tokenInput, Boolean(options.tokenStdin));

    ensureStateDir();

    if (options.apiUrl) {
      writeJson(CONFIG_PATH, {
        ...readJson<CliConfig>(CONFIG_PATH, {}),
        apiUrl: normalizeApiUrl(options.apiUrl)
      });
    }

    const apiUrl = resolveApiUrl(options.apiUrl);
    credentials.hosts[apiUrl] = {
      token: apiToken,
      updatedAt: new Date().toISOString(),
      source: "auth-set"
    };
    writeJson<CredentialStore>(CREDENTIALS_PATH, credentials, 0o600);

    console.log(`PatchPage credentials saved for ${apiUrl}.`);
  });

program
  .command("whoami")
  .description("Check the configured PatchPage credentials.")
  .option("--api-url <url>", "Override the configured PatchPage API base URL")
  .action(async (options: { apiUrl?: string }) => {
    const { apiUrl, apiToken } = readAuth(options.apiUrl);
    const response = await fetch(`${apiUrl}/api/me`, {
      headers: { Authorization: `Bearer ${apiToken}` }
    });
    const body = await readResponseJson(response);
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? defaultHostHint(apiUrl) : "";
      throw new CliError(`${body.error || "Authentication failed."}${hint}`);
    }

    console.log(`Account: ${body.accountName} (${body.accountId})`);
    console.log(`API token: ${body.apiTokenName} (${body.apiTokenId})`);
    console.log(`Scopes: ${(body.scopes || []).join(", ")}`);
  });

program
  .command("validate")
  .argument("<file>", "HTML file path")
  .description("Validate a static HTML draft without uploading it.")
  .action((file: string) => {
    const html = readHtmlFile(file);
    const validation = validateHtml(html);

    if (!validation.ok) {
      throw new CliError(`HTML failed PatchPage validation:\n- ${validation.errors.join("\n- ")}`);
    }

    console.log("HTML passed PatchPage validation.");
    for (const warning of validation.warnings) {
      console.warn(`Warning: ${warning}`);
    }
  });

program
  .command("upload")
  .argument("<file>", "HTML file path")
  .option("--draft <draft-id>", "Update an existing draft only; never creates a draft")
  .option("--new", "Always create a new draft")
  .option("--anonymous", "Create without credentials; never updates a draft")
  .option("--api-url <url>", "Override the configured PatchPage API base URL")
  .description("Upload or update an HTML draft.")
  .action(async (
    file: string,
    options: { draft?: string; new?: boolean; anonymous?: boolean; apiUrl?: string }
  ) => {
    if (options.draft !== undefined && options.new) {
      throw new CliError("--draft and --new cannot be used together.");
    }
    if (options.draft !== undefined && options.anonymous) {
      throw new CliError(
        "Anonymous uploads are create-only; --draft requires credentials."
      );
    }

    const resolvedFile = path.resolve(file);
    const html = readHtmlFile(resolvedFile);
    const validation = validateHtml(html);

    if (!validation.ok) {
      throw new CliError(`HTML failed PatchPage validation:\n- ${validation.errors.join("\n- ")}`);
    }

    const { apiUrl, apiToken, anonymous } = readUploadAuth(
      options.apiUrl,
      Boolean(options.anonymous)
    );
    if (anonymous && options.draft !== undefined) {
      throw new CliError(
        "Anonymous uploads are create-only; --draft requires credentials."
      );
    }
    const drafts = anonymous ? null : readDraftStore();
    const knownDraft = drafts?.hosts[apiUrl]?.files[resolvedFile];
    const draftId = anonymous
      ? null
      : options.new
        ? null
        : (options.draft ?? knownDraft?.draftId ?? null);
    const isUpdateAttempt = draftId !== null;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `patchpage/${VERSION}`
    };
    if (apiToken !== null) headers.Authorization = `Bearer ${apiToken}`;

    const response = await fetch(`${apiUrl}/api/uploads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        html,
        filename: path.basename(resolvedFile),
        ...(draftId !== null ? { draftId } : {}),
        metadata: {
          ...collectGitMetadata(path.dirname(resolvedFile)),
          cliVersion: VERSION,
          fileSha256: sha256(html)
        }
      })
    });

    const body = await readResponseJson(response);
    if (!response.ok) {
      if (response.status === 404 && isUpdateAttempt) {
        if (options.draft === undefined) {
          throw new CliError(
            "Cached draft is unavailable for update. Use --new to create a new draft."
          );
        }
        throw new CliError(
          "Draft is unavailable for update. --draft never creates a new draft."
        );
      }
      const details = body.errors?.length ? `\n- ${body.errors.join("\n- ")}` : "";
      const hint = response.status === 401 || response.status === 403 ? defaultHostHint(apiUrl) : "";
      throw new CliError(`${body.error || "Upload failed."}${details}${hint}`);
    }

    if (drafts) {
      const hostDrafts = (drafts.hosts[apiUrl] ||= { files: {} });
      hostDrafts.files[resolvedFile] = {
        draftId: body.draftId,
        publicUrl: body.publicUrl,
        latestVersionNumber: body.versionNumber,
        updatedAt: new Date().toISOString()
      };
      writeJson<DraftStore>(DRAFTS_PATH, drafts, 0o600);
    }

    console.log(isUpdateAttempt ? "Updated draft" : "Uploaded draft");
    console.log(`URL: ${body.publicUrl}`);
    console.log(`Draft ID: ${body.draftId}`);
    console.log(`Version: ${body.versionNumber}`);
    for (const warning of body.warnings || []) {
      console.warn(`Warning: ${warning}`);
    }
  });

program.exitOverride();

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(1);
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.version")
  ) {
    process.exit(0);
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

/**
 * An unset environment variable and an empty one mean the same thing
 * everywhere: nothing was configured.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The instance every other piece of state is keyed by: an explicit flag, then
 * the environment, then the saved config, then the default. Exact string
 * equality on this value is the host key — scheme and port differences are
 * distinct instances by design.
 */
function resolveApiUrl(apiUrlOverride?: string): string {
  const config = readJson<CliConfig>(CONFIG_PATH, {});
  return normalizeApiUrl(
    apiUrlOverride || readEnv("PATCHPAGE_API_URL") || config.apiUrl || DEFAULT_API_URL
  );
}

function readAuth(apiUrlOverride?: string): { apiUrl: string; apiToken: string } {
  const apiUrl = resolveApiUrl(apiUrlOverride);
  const apiToken = readEnv("PATCHPAGE_API_TOKEN") ?? readCredentialStore().hosts[apiUrl]?.token;

  if (!apiToken) {
    throw new CliError(
      `Missing API token for ${apiUrl}. Run: patchpage auth set --api-url ${apiUrl}${defaultHostHint(apiUrl)}`
    );
  }

  return { apiUrl, apiToken };
}

function readUploadAuth(
  apiUrlOverride: string | undefined,
  forceAnonymous: boolean
): { apiUrl: string; apiToken: string | null; anonymous: boolean } {
  const apiUrl = resolveApiUrl(apiUrlOverride);
  if (forceAnonymous) return { apiUrl, apiToken: null, anonymous: true };

  const environmentToken = readEnv("PATCHPAGE_API_TOKEN");
  if (environmentToken !== undefined) {
    return { apiUrl, apiToken: environmentToken, anonymous: false };
  }
  const stored = readCredentialStore().hosts[apiUrl];
  if (stored !== undefined) {
    return { apiUrl, apiToken: stored.token, anonymous: false };
  }
  return { apiUrl, apiToken: null, anonymous: true };
}

function readCredentialStore(): CredentialStore {
  const document = readStateDocument(
    CREDENTIALS_PATH,
    UNREADABLE_CREDENTIALS_ERROR,
    INVALID_CREDENTIALS_ERROR
  );
  if (document === undefined) return { hosts: {} };

  const root = asRecord(document);
  if (!root) throw new CliError(INVALID_CREDENTIALS_ERROR);
  if ("apiToken" in root) {
    throw new LegacyStateError(
      `Stored credentials use the retired single-instance format: ${CREDENTIALS_PATH}\n` +
        "PatchPage now stores one token per instance and does not migrate the old file.\n" +
        "Copy the token out of that file if you still need it, delete the file, then run: patchpage auth set"
    );
  }
  const hosts = asRecord(root.hosts);
  if (!hosts) throw new CliError(INVALID_CREDENTIALS_ERROR);

  const store: CredentialStore = { hosts: {} };
  for (const [host, value] of Object.entries(hosts)) {
    const entry = asRecord(value);
    if (!entry) throw new CliError(INVALID_CREDENTIALS_ERROR);
    const { token, updatedAt, source } = entry;
    if (typeof token !== "string" || token.length === 0) {
      throw new CliError(INVALID_CREDENTIALS_ERROR);
    }
    if (updatedAt !== undefined && typeof updatedAt !== "string") {
      throw new CliError(INVALID_CREDENTIALS_ERROR);
    }
    if (source !== undefined && source !== "mint" && source !== "auth-set") {
      throw new CliError(INVALID_CREDENTIALS_ERROR);
    }
    store.hosts[host] = { token, updatedAt, source };
  }
  return store;
}

/**
 * `auth set` is the documented way to replace credentials it cannot read, so a
 * corrupt file is overwritten rather than fatal. A retired flat file still
 * fails closed: it holds a live token, and dropping it silently would strand
 * the drafts that token controls.
 */
function readCredentialStoreForWrite(): CredentialStore {
  try {
    return readCredentialStore();
  } catch (error) {
    if (error instanceof LegacyStateError) throw error;
    return { hosts: {} };
  }
}

function readDraftStore(): DraftStore {
  const document = readStateDocument(
    DRAFTS_PATH,
    UNREADABLE_DRAFT_CACHE_ERROR,
    INVALID_DRAFT_CACHE_ERROR
  );
  if (document === undefined) return { hosts: {} };

  const root = asRecord(document);
  if (!root) throw new CliError(INVALID_DRAFT_CACHE_ERROR);
  if ("files" in root) {
    throw new LegacyStateError(
      `The stored draft cache uses the retired single-instance format: ${DRAFTS_PATH}\n` +
        "PatchPage now caches drafts per instance and does not migrate the old file.\n" +
        "Delete that file to start a fresh cache. Drafts already published are unaffected."
    );
  }
  const hosts = asRecord(root.hosts);
  if (!hosts) throw new CliError(INVALID_DRAFT_CACHE_ERROR);

  const store: DraftStore = { hosts: {} };
  for (const [host, value] of Object.entries(hosts)) {
    const entry = asRecord(value);
    if (!entry) throw new CliError(INVALID_DRAFT_CACHE_ERROR);
    const files = entry.files === undefined ? {} : asRecord(entry.files);
    if (!files) throw new CliError(INVALID_DRAFT_CACHE_ERROR);

    const parsed: Record<string, CachedDraft> = {};
    for (const [file, cached] of Object.entries(files)) {
      const draft = asRecord(cached);
      if (
        !draft ||
        typeof draft.draftId !== "string" ||
        draft.draftId.length === 0 ||
        typeof draft.publicUrl !== "string" ||
        typeof draft.latestVersionNumber !== "number" ||
        typeof draft.updatedAt !== "string"
      ) {
        throw new CliError(INVALID_DRAFT_CACHE_ERROR);
      }
      parsed[file] = {
        draftId: draft.draftId,
        publicUrl: draft.publicUrl,
        latestVersionNumber: draft.latestVersionNumber,
        updatedAt: draft.updatedAt
      };
    }
    store.hosts[host] = { files: parsed };
  }
  return store;
}

/** Returns undefined when the file does not exist; throws on anything else. */
function readStateDocument(
  file: string,
  unreadableError: string,
  invalidError: string
): unknown | undefined {
  let serialized: string;
  try {
    serialized = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(unreadableError);
  }

  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new CliError(invalidError);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function defaultHostHint(apiUrl: string): string {
  if (apiUrl !== DEFAULT_API_URL) return "";
  return `\nNote: ${DEFAULT_API_URL} is the maintainer's private instance and does not issue public tokens.\nTo run your own server, see ${SELF_HOST_DOCS_URL} and point the CLI at it with --api-url or PATCHPAGE_API_URL.`;
}

function readHtmlFile(file: string): string {
  const resolvedFile = path.resolve(file);
  if (!existsSync(resolvedFile)) {
    throw new CliError(`File does not exist: ${resolvedFile}`);
  }
  return readFileSync(resolvedFile, "utf8");
}

function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

async function promptForApiToken(): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;

  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new CliError(
      "Interactive token entry requires a terminal. For automation, pipe the token to patchpage auth set --token-stdin."
    );
  }

  const wasRaw = Boolean(input.isRaw);
  const hiddenOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const abortController = new AbortController();
  const abort = (error: CliError) => {
    if (!abortController.signal.aborted) abortController.abort(error);
  };
  const onEnd = () => abort(new CliError("API token input ended before a token was entered."));
  const onError = () => abort(new CliError("Could not read the API token."));
  const onInterrupt = () => abort(new CliError("Authentication cancelled."));
  const onClose = () => abort(new CliError("API token input ended before a token was entered."));
  let readline: ReturnType<typeof createInterface> | undefined;
  let promptStarted = false;
  let cleanedUp = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;

    try {
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      readline?.removeListener("SIGINT", onInterrupt);
      readline?.removeListener("close", onClose);
      readline?.removeListener("error", onError);
      try {
        readline?.close();
      } finally {
        try {
          hiddenOutput.destroy();
        } finally {
          if (Boolean(input.isRaw) !== wasRaw) input.setRawMode(wasRaw);
        }
      }
      if (promptStarted) output.write("\n");
    } finally {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    }
  };
  const onExternalSignal = (signal: NodeJS.Signals) => {
    const requiresControlledExit =
      process.listenerCount(signal) > 1 ||
      (process.platform === "win32" && (signal === "SIGHUP" || signal === "SIGBREAK"));
    if (requiresControlledExit) {
      const signalNumber =
        os.constants.signals[signal] ?? (signal === "SIGBREAK" ? 21 : 1);
      queueMicrotask(() => process.exit(128 + signalNumber));
    }

    try {
      cleanup();
    } finally {
      if (!requiresControlledExit) {
        process.kill(process.pid, signal);
      }
    }
  };

  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      const handler = () => onExternalSignal(signal);
      signalHandlers.set(signal, handler);
      process.prependListener(signal, handler);
    }
    readline = createInterface({
      input,
      output: hiddenOutput,
      terminal: true,
      historySize: 0
    });
    input.prependOnceListener("end", onEnd);
    input.prependOnceListener("error", onError);
    readline.once("SIGINT", onInterrupt);
    readline.once("close", onClose);
    readline.once("error", onError);
    promptStarted = true;
    output.write("PatchPage API token: ");

    try {
      return await readline.question("", { signal: abortController.signal });
    } catch {
      const reason = abortController.signal.reason;
      if (reason instanceof CliError) throw reason;
      throw new CliError("Could not read the API token.");
    }
  } finally {
    cleanup();
  }
}

function parseApiToken(input: string, allowTrailingLineEnding: boolean): string {
  let apiToken = input;
  if (allowTrailingLineEnding) {
    apiToken = apiToken.endsWith("\r\n")
      ? apiToken.slice(0, -2)
      : apiToken.endsWith("\n")
        ? apiToken.slice(0, -1)
        : apiToken;
  }

  if (/[\r\n]/.test(apiToken)) {
    throw new CliError("API token must be provided as a single line.");
  }
  if (!apiToken.trim()) {
    throw new CliError("API token cannot be empty.");
  }
  if (apiToken !== apiToken.trim()) {
    throw new CliError("API token cannot begin or end with whitespace.");
  }

  return apiToken;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(file: string, value: T, mode = 0o600): void {
  ensureStateDir();
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      tempFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode
    );
    if (process.platform !== "win32") fchmodSync(fd, mode);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    if (process.platform !== "win32") fchmodSync(fd, mode);
    const completedFd = fd;
    fd = undefined;
    closeSync(completedFd);
    renameSync(tempFile, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempFile, { force: true });
  }
}

function collectGitMetadata(cwd: string): Record<string, string | null> {
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const remote = git(["config", "--get", "remote.origin.url"], cwd);
  const parsedRemote = parseRemote(remote);

  return {
    repoOrg: parsedRemote.org || inferOrgFromRoot(repoRoot),
    repoName: parsedRemote.name || (repoRoot ? path.basename(repoRoot) : null),
    gitBranch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    gitCommitSha: git(["rev-parse", "HEAD"], cwd)
  };
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function parseRemote(remote: string | null): { org?: string; name?: string } {
  if (!remote) return {};

  const cleaned = remote.replace(/\.git$/, "");
  const sshMatch = cleaned.match(/^[^@]+@[^:]+:([^/]+)\/(.+)$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { org: sshMatch[1], name: path.basename(sshMatch[2]) };
  }

  try {
    const url = new URL(cleaned);
    const parts = url.pathname.split("/").filter(Boolean);
    const org = parts[0];
    const name = parts.at(-1);
    if (parts.length >= 2 && org && name) {
      return { org, name };
    }
  } catch {
    // Fall through to path parsing.
  }

  const parts = cleaned.split("/").filter(Boolean);
  const org = parts.at(-2);
  const name = parts.at(-1);
  if (parts.length >= 2 && org && name) {
    return { org, name };
  }

  return {};
}

function inferOrgFromRoot(repoRoot: string | null): string | null {
  if (!repoRoot) return null;
  return path.basename(path.dirname(repoRoot));
}

function normalizeApiUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function readResponseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return { error: `${response.status} ${response.statusText}` };
  }
}
