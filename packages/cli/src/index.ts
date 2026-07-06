#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { sha256, validateHtml } from "@patchpage/core";

const VERSION = "0.0.0";
const DEFAULT_API_URL = "https://post.patchyhq.com";
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
  .argument("<api-token>", "PatchPage API token")
  .option("--api-url <url>", "Override the default PatchPage API base URL")
  .action((apiToken: string, options: { apiUrl?: string }) => {
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
      throw new CliError(body.error || "Authentication failed.");
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
  .option("--draft <draft-id>", "Update a specific draft")
  .option("--new", "Always create a new draft")
  .option("--api-url <url>", "Override the configured PatchPage API base URL")
  .description("Upload or update an HTML draft.")
  .action(async (file: string, options: { draft?: string; new?: boolean; apiUrl?: string }) => {
    const resolvedFile = path.resolve(file);
    const html = readHtmlFile(resolvedFile);
    const validation = validateHtml(html);

    if (!validation.ok) {
      throw new CliError(`HTML failed PatchPage validation:\n- ${validation.errors.join("\n- ")}`);
    }

    const { apiUrl, apiToken } = readAuth(options.apiUrl);
    const drafts = readDrafts();
    const knownDraft = drafts.files?.[resolvedFile];
    const draftId = options.new ? null : options.draft || knownDraft?.draftId || null;

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
        draftId,
        metadata: {
          ...collectGitMetadata(path.dirname(resolvedFile)),
          cliVersion: VERSION,
          fileSha256: sha256(html)
        }
      })
    });

    const body = await readResponseJson(response);
    if (!response.ok) {
      const details = body.errors?.length ? `\n- ${body.errors.join("\n- ")}` : "";
      throw new CliError(`${body.error || "Upload failed."}${details}`);
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
    throw new CliError("Missing API token. Run: patchpage auth set <api-token>");
  }

  return { apiUrl, apiToken };
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
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
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
