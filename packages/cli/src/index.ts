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
/** Skill-owned. The CLI reports whether this exists and never reads it. */
const STYLE_PATH = path.join(STATE_DIR, "style.md");

class CliError extends Error {}

/**
 * A state file left over from the retired single-instance format. Fail-closed
 * everywhere: the CLI never migrates one, because the token it holds is the
 * only key to the drafts it created.
 */
class LegacyStateError extends CliError {}

/** Errors for a host-keyed state file, all at the level of the whole document. */
interface HostKeyedErrors {
  unreadable: string;
  invalid: string;
  legacy: string;
}

const CREDENTIAL_ERRORS: HostKeyedErrors = {
  unreadable:
    "Stored credentials could not be read. Check permissions or run: patchpage auth set to replace them.",
  invalid: "Stored credentials are invalid. Run: patchpage auth set to replace them.",
  legacy:
    `Stored credentials use the retired single-instance format: ${CREDENTIALS_PATH}\n` +
    "PatchPage now stores one token per instance and does not migrate the old file.\n" +
    "Copy the token out of that file if you still need it, delete the file, then run: patchpage auth set"
};

const DRAFT_CACHE_ERRORS: HostKeyedErrors = {
  unreadable: `The stored draft cache could not be read: ${DRAFTS_PATH}\nCheck permissions, or delete that file to start a fresh cache.`,
  invalid: `The stored draft cache is invalid: ${DRAFTS_PATH}\nDelete that file to start a fresh cache. Drafts already published are unaffected.`,
  legacy:
    `The stored draft cache uses the retired single-instance format: ${DRAFTS_PATH}\n` +
    "PatchPage now caches drafts per instance and does not migrate the old file.\n" +
    "Delete that file to start a fresh cache. Drafts already published are unaffected."
};

interface CliConfig {
  apiUrl?: string;
}

type CredentialSource = "mint" | "auth-set";

/** Which link of the URL precedence chain chose the resolved instance. */
type InstanceSource = "flag" | "env" | "config" | "default";

/** The onboarding probe's answer. Every key here is quoted by the skill. */
interface StatusReport {
  instanceUrl: string;
  instanceSource: InstanceSource;
  hasToken: boolean;
  tokenSource: CredentialSource | null;
  stateDir: string;
  hasDefaultStyle: boolean;
  cliVersion: string;
}

interface HostCredential {
  token: string;
  updatedAt?: string;
  source?: CredentialSource;
}

/** One entry of drafts.json, which is scoped per instance then per file path. */
interface CachedDraft {
  draftId: string;
  publicUrl: string;
  latestVersionNumber: number;
  updatedAt: string;
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
    const credentials = readCredentialFileForWrite();

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
    } satisfies HostCredential;
    writeJson(CREDENTIALS_PATH, credentials, 0o600);

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
  .command("status")
  .description("Report local publishing state for the resolved instance. Never uses the network.")
  .requiredOption("--json", "Print the report as JSON")
  .option("--api-url <url>", "Override the configured PatchPage API base URL")
  .action((options: { apiUrl?: string }) => {
    console.log(JSON.stringify(buildStatusReport(options.apiUrl), null, 2));
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
  .option("--anonymous", "Deprecated and ignored; uploads always use a token")
  .option("--api-url <url>", "Override the configured PatchPage API base URL")
  .description("Upload or update an HTML draft.")
  .action(async (
    file: string,
    options: { draft?: string; new?: boolean; anonymous?: boolean; apiUrl?: string }
  ) => {
    if (options.draft !== undefined && options.new) {
      throw new CliError("--draft and --new cannot be used together.");
    }
    // A no-op rather than an error: the flag's old invocations must keep
    // working through the transition, so it is announced and then ignored.
    if (options.anonymous) {
      console.warn(
        "Warning: --anonymous is deprecated and ignored. Uploads always use a publishing token; " +
          "one is minted automatically when none is stored for the instance."
      );
    }

    const resolvedFile = path.resolve(file);
    const html = readHtmlFile(resolvedFile);
    const validation = validateHtml(html);

    if (!validation.ok) {
      throw new CliError(`HTML failed PatchPage validation:\n- ${validation.errors.join("\n- ")}`);
    }

    // Local validation gates the network, so an unpublishable file never costs
    // a mint against the instance's per-network quota.
    const { apiUrl, apiToken: storedToken } = readUploadAuth(options.apiUrl);
    const apiToken = storedToken ?? (await mintPublishingToken(apiUrl));

    const drafts = readDraftFile();
    const cachedDrafts = readCachedDrafts(drafts.hosts, apiUrl);
    const knownDraft = cachedDrafts[resolvedFile];
    const draftId = options.new ? null : (options.draft ?? knownDraft?.draftId ?? null);
    const isUpdateAttempt = draftId !== null;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `patchpage/${VERSION}`,
      Authorization: `Bearer ${apiToken}`
    };

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

    cachedDrafts[resolvedFile] = {
      draftId: body.draftId,
      publicUrl: body.publicUrl,
      latestVersionNumber: body.versionNumber,
      updatedAt: new Date().toISOString()
    };
    // Only this instance's entry is rewritten; every other instance's cache
    // is carried across exactly as it was stored.
    drafts.hosts[apiUrl] = { files: cachedDrafts };
    writeJson(DRAFTS_PATH, drafts, 0o600);

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
  return resolveInstance(apiUrlOverride).apiUrl;
}

/**
 * The same resolution, carrying which link of the chain answered. Only the
 * probe needs that; every other caller wants the URL alone.
 */
function resolveInstance(apiUrlOverride?: string): {
  apiUrl: string;
  source: InstanceSource;
} {
  if (apiUrlOverride) return { apiUrl: normalizeApiUrl(apiUrlOverride), source: "flag" };

  const environmentUrl = readEnv("PATCHPAGE_API_URL");
  if (environmentUrl) return { apiUrl: normalizeApiUrl(environmentUrl), source: "env" };

  const configUrl = readJson<CliConfig>(CONFIG_PATH, {}).apiUrl;
  if (configUrl) return { apiUrl: normalizeApiUrl(configUrl), source: "config" };

  return { apiUrl: normalizeApiUrl(DEFAULT_API_URL), source: "default" };
}

/**
 * Assembled from local state alone: every lookup below is a file or
 * environment read, and nothing on this path may ever reach the network. The
 * style file is skill-owned, so its existence is the only fact about it the
 * CLI has — its contents are never opened.
 */
function buildStatusReport(apiUrlOverride?: string): StatusReport {
  const instance = resolveInstance(apiUrlOverride);
  const environmentToken = readEnv("PATCHPAGE_API_TOKEN");
  const stored = environmentToken === undefined ? readProbeCredential(instance.apiUrl) : undefined;

  return {
    instanceUrl: instance.apiUrl,
    instanceSource: instance.source,
    // Walks the credential chain the upload path walks, so true means an
    // upload would have this token to send. False is the narrower claim "no
    // token this command can vouch for": it also covers the state below that
    // the probe declined to interpret but upload still stops on.
    hasToken: environmentToken !== undefined || stored !== undefined,
    // Only a stored credential carries provenance. A token supplied by the
    // environment, and an entry written before `source` existed, both report
    // null rather than a guess.
    tokenSource: stored?.source ?? null,
    stateDir: path.resolve(STATE_DIR),
    hasDefaultStyle: existsSync(STYLE_PATH),
    cliVersion: VERSION
  };
}

/**
 * The probe never fails on state it cannot read. Failing closed on a corrupt
 * or retired credentials file protects the commands that would spend a token,
 * and those keep doing it; reporting the same condition here as "no token we
 * can vouch for" neither loses a token nor mints one. Exiting non-zero would
 * only make the onboarding probe unanswerable exactly when someone needs the
 * answer most.
 */
function readProbeCredential(apiUrl: string): HostCredential | undefined {
  try {
    return readStoredCredential(readCredentialFile().hosts, apiUrl);
  } catch {
    return undefined;
  }
}

function readAuth(apiUrlOverride?: string): { apiUrl: string; apiToken: string } {
  const apiUrl = resolveApiUrl(apiUrlOverride);
  const apiToken =
    readEnv("PATCHPAGE_API_TOKEN") ??
    readStoredCredential(readCredentialFile().hosts, apiUrl)?.token;

  if (!apiToken) {
    // `whoami` is read-only, so it reports the absence rather than minting:
    // `upload` is the only command that ever creates a token.
    throw new CliError(
      `No publishing token is stored for ${apiUrl}.\n` +
        "One is minted automatically on your first upload, or save an existing one with: " +
        `patchpage auth set --api-url ${apiUrl}`
    );
  }

  return { apiUrl, apiToken };
}

/**
 * The upload credential chain: the environment, then the token stored for this
 * instance. A null token is not a licence to publish without one — it is the
 * signal that this instance has no key yet, which `upload` answers by minting.
 */
function readUploadAuth(apiUrlOverride: string | undefined): {
  apiUrl: string;
  apiToken: string | null;
} {
  const apiUrl = resolveApiUrl(apiUrlOverride);

  const environmentToken = readEnv("PATCHPAGE_API_TOKEN");
  if (environmentToken !== undefined) return { apiUrl, apiToken: environmentToken };

  const stored = readStoredCredential(readCredentialFile().hosts, apiUrl);
  if (stored !== undefined) return { apiUrl, apiToken: stored.token };

  return { apiUrl, apiToken: null };
}

/**
 * Mints a publishing token for one instance, saves it, and announces it. Only
 * the resolved instance is ever asked: a refusal here is the end of the road,
 * never a reason to try somewhere else, because a token minted anywhere else
 * would control a different set of pages.
 */
async function mintPublishingToken(apiUrl: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/tokens/self-service`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `patchpage/${VERSION}`
      },
      body: "{}"
    });
  } catch {
    throw new CliError(
      `Could not get a publishing token: ${apiUrl} could not be reached.\n` +
        "Check the address and your network connection, then run the same command again."
    );
  }

  const body = await readResponseJson(response);
  if (!response.ok) throw new CliError(mintFailureMessage(apiUrl, response, body));

  const token = typeof body.token === "string" ? body.token : "";
  if (token.length === 0) {
    throw new CliError(
      `Could not get a publishing token: ${apiUrl} answered without one.\n` +
        `Ask that instance's operator for a token and save it with: patchpage auth set --api-url ${apiUrl}`
    );
  }

  const credentials = readCredentialFileForWrite();
  credentials.hosts[apiUrl] = {
    token,
    updatedAt: new Date().toISOString(),
    source: "mint"
  } satisfies HostCredential;
  writeJson(CREDENTIALS_PATH, credentials, 0o600);

  // Saved before it is announced: a token that reached the instance but not
  // the disk would silently orphan every page it just created.
  console.log(
    `Minted a new publishing token for ${apiUrl}; saved to ${CREDENTIALS_PATH}. ` +
      "That file is the only key to these pages — copy it to another machine to publish from " +
      "there with the same editing rights. If you've published from another machine before, " +
      "those pages belong to that machine's token — ask your agent to help copy it over instead " +
      "of using this new one."
  );
  if (typeof body.aupUrl === "string" && body.aupUrl.length > 0) {
    console.log(`Publishing here accepts the acceptable use policy: ${body.aupUrl}`);
  }

  return token;
}

/** One plain-language failure per pinned mint response, cause then next action. */
function mintFailureMessage(apiUrl: string, response: Response, body: any): string {
  const authSetAction = `patchpage auth set --api-url ${apiUrl}`;

  if (body?.code === "self_service_disabled") {
    return (
      `Could not get a publishing token: ${apiUrl} does not hand them out on request.\n` +
      `Ask that instance's operator for a token and save it with: ${authSetAction}`
    );
  }
  if (body?.code === "mint_quota_exceeded") {
    return (
      `Could not get a publishing token: ${apiUrl} has reached its limit of new tokens for your network today.\n` +
      `Copy an existing token from another machine and save it with: ${authSetAction}, or try again tomorrow.`
    );
  }
  if (body?.code === "rate_limited") {
    const retryAfterSeconds =
      typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0
        ? `${Math.ceil(body.retryAfterSeconds)} seconds`
        : "a moment";
    return (
      `Could not get a publishing token: ${apiUrl} is handing out tokens faster than it allows right now.\n` +
      `Wait ${retryAfterSeconds} and run the same command again.`
    );
  }

  const reported =
    typeof body?.error === "string" && body.error.length > 0
      ? body.error
      : `${response.status} ${response.statusText}`.trim();
  return (
    `Could not get a publishing token from ${apiUrl}: ${reported}\n` +
    `If that instance does not hand out tokens, ask its operator for one and save it with: ${authSetAction}`
  );
}

/**
 * Reads a host-keyed state file without interpreting its per-host entries.
 * Leaving them raw is what makes a write a real merge: an entry this command
 * neither reads nor understands is carried across untouched instead of being
 * silently dropped. Only whole-document problems are errors here, because only
 * those say nothing survives.
 */
function readHostKeyedFile(
  file: string,
  legacyKey: string,
  errors: HostKeyedErrors
): { hosts: Record<string, unknown> } {
  const document = readStateDocument(file, errors.unreadable, errors.invalid);
  if (document === undefined) return { hosts: {} };

  const root = asRecord(document);
  if (!root) throw new CliError(errors.invalid);
  if (legacyKey in root) throw new LegacyStateError(errors.legacy);
  const hosts = asRecord(root.hosts);
  if (!hosts) throw new CliError(errors.invalid);
  return { hosts };
}

function readCredentialFile(): { hosts: Record<string, unknown> } {
  return readHostKeyedFile(CREDENTIALS_PATH, "apiToken", CREDENTIAL_ERRORS);
}

/**
 * The token stored for one instance. A neighbouring instance's entry is never
 * parsed, so corruption over there can neither block publishing here nor be
 * mistaken for a reason to discard it.
 */
function readStoredCredential(
  hosts: Record<string, unknown>,
  apiUrl: string
): HostCredential | undefined {
  const value = hosts[apiUrl];
  if (value === undefined) return undefined;

  const entry = asRecord(value);
  const token = entry?.token;
  if (entry === null || typeof token !== "string" || token.length === 0) {
    throw new CliError(
      `Stored credentials for ${apiUrl} are invalid. Run: patchpage auth set --api-url ${apiUrl} to replace them.`
    );
  }
  // Metadata is descriptive, not load-bearing: an unrecognized value is
  // ignored rather than allowed to strand a usable token.
  return {
    token,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
    source: entry.source === "mint" || entry.source === "auth-set" ? entry.source : undefined
  };
}

/**
 * `auth set` is the documented way to replace credentials that cannot be read,
 * so a file with no salvageable host map is overwritten rather than fatal. Two
 * things are never destroyed silently: a retired flat file, which fails closed
 * because the token it holds is the only key to its drafts, and any per-host
 * entry, which is preserved verbatim because the same is true of it.
 */
function readCredentialFileForWrite(): { hosts: Record<string, unknown> } {
  try {
    return readCredentialFile();
  } catch (error) {
    if (error instanceof LegacyStateError) throw error;
    return { hosts: {} };
  }
}

function readDraftFile(): { hosts: Record<string, unknown> } {
  return readHostKeyedFile(DRAFTS_PATH, "files", DRAFT_CACHE_ERRORS);
}

/** The draft cache for one instance; a neighbour's entry is never parsed. */
function readCachedDrafts(
  hosts: Record<string, unknown>,
  apiUrl: string
): Record<string, CachedDraft> {
  const value = hosts[apiUrl];
  if (value === undefined) return {};

  const entry = asRecord(value);
  if (!entry) throw new CliError(DRAFT_CACHE_ERRORS.invalid);
  const files = entry.files === undefined ? {} : asRecord(entry.files);
  if (!files) throw new CliError(DRAFT_CACHE_ERRORS.invalid);

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
      throw new CliError(DRAFT_CACHE_ERRORS.invalid);
    }
    parsed[file] = {
      draftId: draft.draftId,
      publicUrl: draft.publicUrl,
      latestVersionNumber: draft.latestVersionNumber,
      updatedAt: draft.updatedAt
    };
  }
  return parsed;
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
