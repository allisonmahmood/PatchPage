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
const STATE_DIR = process.env.PATCHPAGE_STATE_DIR || path.join(os.homedir(), ".patchpage");
const CONFIG_PATH = path.join(STATE_DIR, "config.json");
const CREDENTIALS_PATH = path.join(STATE_DIR, "credentials.json");
const DRAFTS_PATH = path.join(STATE_DIR, "drafts.json");

class CliError extends Error {}

interface CliConfig {
  apiUrl?: string;
}

interface Credentials {
  apiToken?: string;
  updatedAt?: string;
}

interface DraftCache {
  files?: Record<
    string,
    {
      draftId: string;
      publicUrl: string;
      latestVersionNumber: number;
      updatedAt: string;
    }
  >;
}

const program = new Command();

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

    writeJson<Credentials>(
      CREDENTIALS_PATH,
      {
        apiToken,
        updatedAt: new Date().toISOString()
      },
      0o600
    );

    console.log("PatchPage credentials saved.");
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
  .option("--api-url <url>", "Override the configured PatchPage API base URL")
  .description("Upload or update an HTML draft.")
  .action(async (file: string, options: { draft?: string; new?: boolean; apiUrl?: string }) => {
    if (options.draft !== undefined && options.new) {
      throw new CliError("--draft and --new cannot be used together.");
    }

    const resolvedFile = path.resolve(file);
    const html = readHtmlFile(resolvedFile);
    const validation = validateHtml(html);

    if (!validation.ok) {
      throw new CliError(`HTML failed PatchPage validation:\n- ${validation.errors.join("\n- ")}`);
    }

    const { apiUrl, apiToken } = readAuth(options.apiUrl);
    const drafts = readDrafts();
    const knownDraft = drafts.files?.[resolvedFile];
    const draftId = options.new ? null : (options.draft ?? knownDraft?.draftId ?? null);
    const isUpdateAttempt = draftId !== null;

    const response = await fetch(`${apiUrl}/api/uploads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `patchpage/${VERSION}`,
        Authorization: `Bearer ${apiToken}`
      },
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

    drafts.files ||= {};
    drafts.files[resolvedFile] = {
      draftId: body.draftId,
      publicUrl: body.publicUrl,
      latestVersionNumber: body.versionNumber,
      updatedAt: new Date().toISOString()
    };
    writeJson(DRAFTS_PATH, drafts, 0o600);

    console.log(draftId ? "Updated draft" : "Uploaded draft");
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

function readAuth(apiUrlOverride?: string): { apiUrl: string; apiToken: string } {
  const config = readJson<CliConfig>(CONFIG_PATH, {});
  const credentials = readJson<Credentials>(CREDENTIALS_PATH, {});
  const apiUrl = normalizeApiUrl(
    apiUrlOverride || process.env.PATCHPAGE_API_URL || config.apiUrl || DEFAULT_API_URL
  );
  const apiToken = process.env.PATCHPAGE_API_TOKEN || credentials.apiToken;

  if (!apiToken) {
    throw new CliError(`Missing API token. Run: patchpage auth set${defaultHostHint(apiUrl)}`);
  }

  return { apiUrl, apiToken };
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

function readDrafts(): DraftCache {
  return readJson<DraftCache>(DRAFTS_PATH, { files: {} });
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
