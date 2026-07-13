import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageDir, "dist/index.js");
const argvPreloadUrl = pathToFileURL(
  path.join(packageDir, "test/record-argv.mjs")
).href;
const ttyPreloadUrl = pathToFileURL(path.join(packageDir, "test/mock-tty.mjs")).href;
const signalListenerPreloadUrl = pathToFileURL(
  path.join(packageDir, "test/preinstalled-signal-listener.mjs")
).href;
const ptyDriverPath = path.join(packageDir, "test/pty-driver.py");
const supportsPythonPty =
  process.platform !== "win32" &&
  spawnSync("python3", ["-c", "import pty, signal, termios"], { stdio: "ignore" }).status === 0;
const externalSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type PromptSignal = (typeof externalSignals)[number] | "SIGBREAK";
interface TerminalReport {
  finalRaw: boolean;
  rawModeChanges: boolean[];
  signalHandlerCounts: Record<PromptSignal, number>;
}
const stateDirs: string[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [path.resolve(packageDir, "../../scripts/build-cli-bundle.mjs")], {
    cwd: packageDir,
    stdio: "pipe"
  });
});

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("patchpage auth set", () => {
  it("saves a token from explicit stdin without exposing it in arguments or output", () => {
    const token = "pp_stdin_secret";
    const args = ["auth", "set", "--token-stdin"];
    const result = runCli(args, `${token}\n`);

    expect(result.argv.join("\0")).not.toContain(token);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PatchPage credentials saved.\n");
    expect(result.stderr).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readCredentials(result.stateDir)).toMatchObject({ apiToken: token });
  });

  it("rejects empty input from explicit stdin", () => {
    const result = runCli(["auth", "set", "--token-stdin"], " \n");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("API token cannot be empty.\n");
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });

  it("rejects ambiguous multi-line input from explicit stdin", () => {
    const firstToken = "pp_first_secret";
    const secondToken = "pp_second_secret";
    const result = runCli(
      ["auth", "set", "--token-stdin"],
      `${firstToken}\n${secondToken}\n`
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("API token must be provided as a single line.\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(firstToken);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secondToken);
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });

  it("rejects token input with ambiguous surrounding whitespace", () => {
    const token = "pp_whitespace_secret";
    const result = runCli(["auth", "set", "--token-stdin"], ` ${token}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("API token cannot begin or end with whitespace.\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });

  it.runIf(supportsPythonPty)(
    "prompts for a token without echoing it and restores the terminal",
    () => {
      const token = "pp_interactive_secret";
      const result = runCliInPty(["auth", "set"], "line", token);

      expect(result.status).toBe(0);
      expect(result.output).toContain("PatchPage API token:");
      expect(result.output).toContain("PatchPage credentials saved.");
      expect(result.output).not.toContain(token);
      expect(result.terminalRestored).toBe(true);
      expect(readCredentials(result.stateDir)).toMatchObject({ apiToken: token });
    }
  );

  it("rejects the default interactive flow when no terminal is available", () => {
    const result = runCli(["auth", "set"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Interactive token entry requires a terminal. For automation, pipe the token to patchpage auth set --token-stdin.\n"
    );
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });

  it.runIf(supportsPythonPty)(
    "rejects --token-stdin when stdin is an echoing terminal",
    () => {
      const result = runCliInPty(["auth", "set", "--token-stdin"], "none");

      expect(result.status).toBe(1);
      expect(result.output).toContain(
        "--token-stdin requires redirected input. Run patchpage auth set to use the hidden interactive prompt."
      );
      expect(result.terminalRestored).toBe(true);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    }
  );

  it.runIf(supportsPythonPty)(
    "restores the terminal when the interactive prompt reaches EOF",
    () => {
      const result = runCliInPty(["auth", "set"], "eof");

      expect(result.status).toBe(1);
      expect(result.output).toContain("API token input ended before a token was entered.");
      expect(result.terminalRestored).toBe(true);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    }
  );

  it.runIf(supportsPythonPty)(
    "restores the terminal when the interactive prompt is interrupted",
    () => {
      const result = runCliInPty(["auth", "set"], "interrupt");

      expect(result.status).toBe(1);
      expect(result.output).toContain("Authentication cancelled.");
      expect(result.terminalRestored).toBe(true);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    }
  );

  for (const signalName of externalSignals) {
    it.runIf(supportsPythonPty)(
      `restores the terminal before preserving external ${signalName} termination`,
      () => {
        const result = runCliInPty(["auth", "set"], `signal:${signalName}`);

        expect(result.rawDuringInteraction).toBe(true);
        expect(result.status).toBe(-os.constants.signals[signalName]);
        expect(result.terminalRestored).toBe(true);
        expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
      }
    );
  }

  it.runIf(supportsPythonPty)(
    "restores the terminal before a preloaded SIGTERM listener exits",
    () => {
      const stateDir = makeStateDir();
      const signalReportPath = path.join(stateDir, "signal-listener.json");
      const result = runCliInPty(["auth", "set"], "signal:SIGTERM", "", stateDir, {
        NODE_OPTIONS: `--import=${signalListenerPreloadUrl}`,
        PATCHPAGE_TEST_SIGNAL_ACTION: "exit",
        PATCHPAGE_TEST_SIGNAL_REPORT: signalReportPath
      });

      expect(result.rawDuringInteraction).toBe(true);
      expect(JSON.parse(readFileSync(signalReportPath, "utf8"))).toEqual({
        signal: "SIGTERM",
        count: 1,
        raw: false
      });
      expect(result.status).toBe(72);
      expect(result.terminalRestored).toBe(true);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    }
  );

  it.runIf(supportsPythonPty)(
    "restores the terminal before delivering SIGTERM once to a preloaded listener and controlling termination",
    () => {
      const stateDir = makeStateDir();
      const signalReportPath = path.join(stateDir, "signal-listener.json");
      const result = runCliInPty(["auth", "set"], "signal:SIGTERM", "", stateDir, {
        NODE_OPTIONS: `--import=${signalListenerPreloadUrl}`,
        PATCHPAGE_TEST_SIGNAL_REPORT: signalReportPath
      });

      expect(result.rawDuringInteraction).toBe(true);
      expect(JSON.parse(readFileSync(signalReportPath, "utf8"))).toEqual({
        signal: "SIGTERM",
        count: 1
      });
      expect(result.status).toBe(128 + os.constants.signals.SIGTERM);
      expect(result.terminalRestored).toBe(true);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    }
  );

  it.runIf(supportsPythonPty)(
    "rejects an empty interactive token and restores the terminal",
    () => {
      const result = runCliInPty(["auth", "set"], "line");

      expect(result.status).toBe(1);
      expect(result.output).toContain("API token cannot be empty.");
      expect(result.terminalRestored).toBe(true);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    }
  );

  it.runIf(process.platform !== "win32")(
    "repairs an existing credential file to owner-only permissions",
    () => {
      const stateDir = makeStateDir();
      const credentialsPath = path.join(stateDir, "credentials.json");
      writeFileSync(credentialsPath, '{"apiToken":"old-token"}\n', { mode: 0o644 });
      chmodSync(credentialsPath, 0o644);

      const result = runCli(["auth", "set", "--token-stdin"], "pp_replacement\n", stateDir);

      expect(result.status).toBe(0);
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
      expect(readCredentials(stateDir)).toMatchObject({ apiToken: "pp_replacement" });
    }
  );

  it.runIf(process.platform !== "win32")(
    "replaces a credential symlink without exposing the token to its target",
    () => {
      const stateDir = makeStateDir();
      const credentialsPath = path.join(stateDir, "credentials.json");
      const symlinkTarget = path.join(stateDir, "unexpected-target.json");
      writeFileSync(symlinkTarget, "leave this unchanged\n", { mode: 0o644 });
      symlinkSync(symlinkTarget, credentialsPath);

      const result = runCli(["auth", "set", "--token-stdin"], "pp_private\n", stateDir);

      expect(result.status).toBe(0);
      expect(readFileSync(symlinkTarget, "utf8")).toBe("leave this unchanged\n");
      expect(lstatSync(credentialsPath).isSymbolicLink()).toBe(false);
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
      expect(readCredentials(stateDir)).toMatchObject({ apiToken: "pp_private" });
    }
  );

  it.runIf(supportsPythonPty)(
    "restores the terminal when saving credentials fails after the prompt",
    () => {
      const token = "pp_not_saved_secret";
      const parentDir = makeStateDir();
      const invalidStateDir = path.join(parentDir, "not-a-directory");
      writeFileSync(invalidStateDir, "occupied");

      const result = runCliInPty(["auth", "set"], "line", token, invalidStateDir);

      expect(result.status).toBe(1);
      expect(result.terminalRestored).toBe(true);
      expect(result.output).not.toContain(token);
    }
  );

  it("keeps PATCHPAGE_API_TOKEN authentication compatible for ordinary commands", async () => {
    const token = "pp_ci_environment_secret";
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          accountName: "CI account",
          accountId: "acct_ci",
          apiTokenName: "CI token",
          apiTokenId: "tok_ci",
          scopes: ["upload"]
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const args = ["whoami", "--api-url", `http://127.0.0.1:${address.port}`];
      const result = await runCliAsync(args, { PATCHPAGE_API_TOKEN: token });

      expect(result.argv.join("\0")).not.toContain(token);
      expect(result.status).toBe(0);
      expect(authorization).toBe(`Bearer ${token}`);
      expect(result.stdout).toContain("Account: CI account (acct_ci)");
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("does not treat PATCHPAGE_API_TOKEN as an auth-set input", async () => {
    const token = "pp_environment_not_for_auth_set";
    const result = await runCliAsync(["auth", "set"], { PATCHPAGE_API_TOKEN: token });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Interactive token entry requires a terminal.");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });
});

describe("patchpage auth set terminal boundary", () => {
  it("keeps prompted input out of output and argv and restores cooked mode", () => {
    const token = "pp_portable_prompt_secret";
    const result = runCliWithMockTty(["auth", "set"], `${token}\n`);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("PatchPage API token:");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(result.argv.join("\0")).not.toContain(token);
    expectTerminalRestored(result.terminal);
    expect(readCredentials(result.stateDir)).toMatchObject({ apiToken: token });
  });

  it("restores cooked mode after EOF", () => {
    const result = runCliWithMockTty(["auth", "set"], "");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API token input ended before a token was entered.");
    expectTerminalRestored(result.terminal);
  });

  it("restores cooked mode after Ctrl-C", () => {
    const result = runCliWithMockTty(["auth", "set"], "\x03");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authentication cancelled.");
    expectTerminalRestored(result.terminal);
  });

  it("handles readline input errors through the CLI boundary and restores cooked mode", async () => {
    const errorDetail = "injected stream failure must stay private";
    const result = await runCliWithMockTtyAsync(["auth", "set"], {
      PATCHPAGE_TEST_TTY_INPUT_ERROR: errorDetail
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("PatchPage API token: \nCould not read the API token.\n");
    expect(result.stderr).not.toContain(errorDetail);
    expect(result.stderr).not.toContain("Unhandled 'error' event");
    expectTerminalRestored(result.terminal);
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "hard-kills a SIGTERM-ignoring mock-TTY child when the async runner times out",
    async () => {
      const stateDir = makeStateDir();
      const timeoutSignalReportPath = path.join(stateDir, "timeout-signal.json");

      await expect(
        runCliWithMockTtyAsync(
          ["auth", "set"],
          { PATCHPAGE_TEST_TTY_TIMEOUT_SIGNAL_REPORT: timeoutSignalReportPath },
          stateDir,
          1_000
        )
      ).rejects.toThrow("CLI timed out: patchpage auth set");
      expect(JSON.parse(readFileSync(timeoutSignalReportPath, "utf8"))).toEqual({
        ready: true,
        sigtermReceived: false,
        fallbackTriggered: false
      });
    }
  );

  for (const [signalName, exitCode] of [
    ["SIGHUP", 129],
    ["SIGBREAK", 149]
  ] as const) {
    it(`controls Windows ${signalName} termination after restoring cooked mode`, async () => {
      const result = await runCliWithMockTtyAsync(["auth", "set"], {
        PATCHPAGE_TEST_WINDOWS_SIGNAL: signalName
      });

      expect(result.stderr).not.toContain("ENOSYS");
      expect(result.stderr).not.toContain("uncaught");
      expect(result.status).toBe(exitCode);
      expect(result.signal).toBeNull();
      expectTerminalRestored(result.terminal);
      expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
    });
  }

  it("restores cooked mode after empty input is rejected", () => {
    const result = runCliWithMockTty(["auth", "set"], "\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API token cannot be empty.");
    expectTerminalRestored(result.terminal);
  });

  it("rejects explicit stdin selection when stdin is a terminal", () => {
    const token = "pp_unsafe_tty_secret";
    const result = runCliWithMockTty(
      ["auth", "set", "--token-stdin"],
      `${token}\n`
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--token-stdin requires redirected input.");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(result.terminal.rawModeChanges).toEqual([]);
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });

  it("restores cooked mode when saving fails after the prompt", () => {
    const token = "pp_portable_not_saved";
    const parentDir = makeStateDir();
    const invalidStateDir = path.join(parentDir, "not-a-directory");
    writeFileSync(invalidStateDir, "occupied");
    const result = runCliWithMockTty(
      ["auth", "set"],
      `${token}\n`,
      invalidStateDir
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expectTerminalRestored(result.terminal);
  });
});

describe("CLI auth guidance", () => {
  it("directs missing credentials to the hidden prompt without a token placeholder", () => {
    const result = runCli(["whoami", "--api-url", "http://127.0.0.1:1"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Missing API token. Run: patchpage auth set\n");
    expect(result.stderr).not.toContain("<api-token>");
  });

  it("shows only the hidden prompt and explicit stdin auth-set interfaces", () => {
    const result = runCli(["auth", "set", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: patchpage auth set [options]");
    expect(result.stdout).toContain("--token-stdin");
    expect(`${result.stdout}${result.stderr}`).not.toContain("<api-token>");
  });

  it("rejects the removed positional syntax without repeating the supplied value", () => {
    const token = "pp_positional_secret";
    const result = runCli(["auth", "set", token]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("too many arguments");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });
});

describe("patchpage upload", () => {
  it("documents --draft as update-only in command help", () => {
    const result = runCli(["upload", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "--draft <draft-id>  Update an existing draft only; never creates a draft"
    );
  });

  it("rejects combining the update-only and create-only options", () => {
    const result = runCli([
      "upload",
      "does-not-exist.html",
      "--draft",
      "abcdefghijkl",
      "--new"
    ]);
    const emptyTargetResult = runCli([
      "upload",
      "does-not-exist.html",
      "--draft",
      "",
      "--new"
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("--draft and --new cannot be used together.\n");
    expect(emptyTargetResult.status).toBe(1);
    expect(emptyTargetResult.stdout).toBe("");
    expect(emptyTargetResult.stderr).toBe("--draft and --new cannot be used together.\n");
  });

  it("omits the draft ID field when creating a draft", async () => {
    const token = "pp_create_request_secret";
    const fixtureDir = makeStateDir();
    const htmlPath = path.join(fixtureDir, "create.html");
    writeFileSync(
      htmlPath,
      "<!doctype html><html><head><title>Create</title></head><body></body></html>"
    );
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId: "abcdefghijkl",
          publicUrl: "http://example.test/d/abcdefghijkl",
          versionNumber: 1,
          warnings: []
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const result = await runCliAsync(
        ["upload", htmlPath, "--new", "--api-url", `http://127.0.0.1:${address.port}`],
        { PATCHPAGE_API_TOKEN: token }
      );

      expect(result.status).toBe(0);
      expect(requestBody).toBeDefined();
      expect(requestBody).not.toHaveProperty("draftId");
      expect(result.stdout).toContain("Uploaded draft");
      expect(result.argv.join("\0")).not.toContain(token);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("reports an unavailable --draft target safely without retrying as create", async () => {
    const token = "pp_update_request_secret";
    const draftId = "abcdefghijkl";
    const fixtureDir = makeStateDir();
    const htmlPath = path.join(fixtureDir, "update.html");
    writeFileSync(
      htmlPath,
      "<!doctype html><html><head><title>Update</title></head><body></body></html>"
    );
    let requestCount = 0;
    let authorization: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      requestCount += 1;
      authorization = request.headers.authorization;
      let body = "";
      for await (const chunk of request) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: false, error: "Draft not found." }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const result = await runCliAsync(
        [
          "upload",
          htmlPath,
          "--draft",
          draftId,
          "--api-url",
          `http://127.0.0.1:${address.port}`
        ],
        { PATCHPAGE_API_TOKEN: token }
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Draft is unavailable for update. --draft never creates a new draft.\n"
      );
      expect(requestCount).toBe(1);
      expect(authorization).toBe(`Bearer ${token}`);
      expect(requestBody).toHaveProperty("draftId", draftId);
      expect(existsSync(path.join(result.stateDir, "drafts.json"))).toBe(false);
      expect(result.argv.join("\0")).not.toContain(token);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("reports an unavailable cached draft safely without retrying as create", async () => {
    const token = "pp_cached_update_secret";
    const draftId = "abcdefghijkl";
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "cached-update.html");
    writeFileSync(
      htmlPath,
      "<!doctype html><html><head><title>Cached update</title></head><body></body></html>"
    );
    writeFileSync(
      path.join(stateDir, "drafts.json"),
      `${JSON.stringify(
        {
          files: {
            [htmlPath]: {
              draftId,
              publicUrl: `http://example.test/d/${draftId}`,
              latestVersionNumber: 1,
              updatedAt: "2026-07-13T00:00:00.000Z"
            }
          }
        },
        null,
        2
      )}\n`
    );
    let requestCount = 0;
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      requestCount += 1;
      let body = "";
      for await (const chunk of request) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: false, error: "Draft not found." }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", `http://127.0.0.1:${address.port}`],
        { PATCHPAGE_API_TOKEN: token },
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "Cached draft is unavailable for update. Use --new to create a new draft.\n"
      );
      expect(requestCount).toBe(1);
      expect(requestBody).toHaveProperty("draftId", draftId);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

describe("PTY test driver", () => {
  it.runIf(supportsPythonPty)("hard-kills a child after the interaction deadline", () => {
    const stateDir = makeStateDir();
    const result = spawnSync(
      "python3",
      [ptyDriverPath, "none", process.execPath, cliPath, "auth", "set"],
      {
        encoding: "utf8",
        env: cliEnv({ PATCHPAGE_STATE_DIR: stateDir }),
        timeout: 10_000
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { status: number };
    expect(report.status).toBe(-os.constants.signals.SIGKILL);
  });
});

function runCli(args: string[], input?: string, stateDir = makeStateDir()) {
  const argvOutputPath = path.join(stateDir, "argv.json");
  const result = spawnSync(process.execPath, ["--import", argvPreloadUrl, cliPath, ...args], {
    encoding: "utf8",
    env: cliEnv({
      PATCHPAGE_STATE_DIR: stateDir,
      PATCHPAGE_TEST_ARGV_RECORD: argvOutputPath
    }),
    input,
    timeout: 10_000
  });

  if (result.error) throw result.error;
  return { ...result, argv: readArgv(argvOutputPath), stateDir };
}

function runCliAsync(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  stateDir = makeStateDir()
) {
  return new Promise<{
    argv: string[];
    status: number | null;
    stdout: string;
    stderr: string;
    stateDir: string;
  }>((resolve, reject) => {
    const argvOutputPath = path.join(stateDir, "argv.json");
    const child = spawn(process.execPath, ["--import", argvPreloadUrl, cliPath, ...args], {
      env: cliEnv({
        ...envOverrides,
        PATCHPAGE_STATE_DIR: stateDir,
        PATCHPAGE_TEST_ARGV_RECORD: argvOutputPath
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`CLI timed out: patchpage ${args.join(" ")}`));
        return;
      }
      resolve({ argv: readArgv(argvOutputPath), status, stdout, stderr, stateDir });
    });
  });
}

function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PATCHPAGE_API_TOKEN;
  delete env.PATCHPAGE_API_URL;
  delete env.PATCHPAGE_TEST_ARGV_RECORD;
  delete env.PATCHPAGE_TEST_TTY_INPUT_ERROR;
  delete env.PATCHPAGE_TEST_TTY_REPORT;
  delete env.PATCHPAGE_TEST_TTY_TIMEOUT_SIGNAL_REPORT;
  delete env.PATCHPAGE_TEST_SIGNAL_ACTION;
  delete env.PATCHPAGE_TEST_SIGNAL_REPORT;
  delete env.PATCHPAGE_TEST_WINDOWS_SIGNAL;
  return { ...env, ...overrides };
}

function makeStateDir(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "patchpage-cli-test-"));
  stateDirs.push(stateDir);
  return stateDir;
}

function readCredentials(stateDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(stateDir, "credentials.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function readArgv(file: string): string[] {
  return JSON.parse(readFileSync(file, "utf8")) as string[];
}

function runCliWithMockTty(args: string[], input: string, stateDir = makeStateDir()) {
  const harnessDir = makeStateDir();
  const argvOutputPath = path.join(harnessDir, "argv.json");
  const ttyReportPath = path.join(harnessDir, "tty.json");
  const result = spawnSync(
    process.execPath,
    ["--import", argvPreloadUrl, "--import", ttyPreloadUrl, cliPath, ...args],
    {
      encoding: "utf8",
      env: cliEnv({
        PATCHPAGE_STATE_DIR: stateDir,
        PATCHPAGE_TEST_ARGV_RECORD: argvOutputPath,
        PATCHPAGE_TEST_TTY_REPORT: ttyReportPath
      }),
      input,
      timeout: 10_000
    }
  );

  if (result.error) throw result.error;
  return {
    ...result,
    argv: readArgv(argvOutputPath),
    stateDir,
    terminal: JSON.parse(readFileSync(ttyReportPath, "utf8")) as TerminalReport
  };
}

function runCliWithMockTtyAsync(
  args: string[],
  envOverrides: NodeJS.ProcessEnv,
  stateDir = makeStateDir(),
  timeoutMs = 10_000
) {
  const harnessDir = makeStateDir();
  const argvOutputPath = path.join(harnessDir, "argv.json");
  const ttyReportPath = path.join(harnessDir, "tty.json");

  return new Promise<{
    argv: string[];
    status: number | null;
    stdout: string;
    stderr: string;
    stateDir: string;
    signal: NodeJS.Signals | null;
    terminal: TerminalReport;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", argvPreloadUrl, "--import", ttyPreloadUrl, cliPath, ...args],
      {
        env: cliEnv({
          PATCHPAGE_STATE_DIR: stateDir,
          PATCHPAGE_TEST_ARGV_RECORD: argvOutputPath,
          PATCHPAGE_TEST_TTY_REPORT: ttyReportPath,
          ...envOverrides
        }),
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`CLI timed out: patchpage ${args.join(" ")}`));
        return;
      }
      resolve({
        argv: readArgv(argvOutputPath),
        status,
        stdout,
        stderr,
        stateDir,
        signal,
        terminal: JSON.parse(readFileSync(ttyReportPath, "utf8")) as TerminalReport
      });
    });
  });
}

function expectTerminalRestored(report: TerminalReport) {
  expect(report.rawModeChanges.at(0)).toBe(true);
  expect(report.rawModeChanges.at(-1)).toBe(false);
  expect(report.finalRaw).toBe(false);
  expect(report.signalHandlerCounts).toEqual({ SIGINT: 0, SIGTERM: 0, SIGHUP: 0, SIGBREAK: 0 });
}

function runCliInPty(
  args: string[],
  interaction:
    | "line"
    | "eof"
    | "interrupt"
    | "none"
    | `signal:${(typeof externalSignals)[number]}`,
  input = "",
  stateDir = makeStateDir(),
  envOverrides: NodeJS.ProcessEnv = {}
) {
  const result = spawnSync(
    "python3",
    [ptyDriverPath, interaction, process.execPath, cliPath, ...args],
    {
      encoding: "utf8",
      env: cliEnv({ ...envOverrides, PATCHPAGE_STATE_DIR: stateDir }),
      input,
      timeout: 10_000
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PTY driver failed (${result.status}): ${result.stderr}`);
  }

  const report = JSON.parse(result.stdout) as {
    output: string;
    status: number;
    rawDuringInteraction: boolean | null;
    terminalRestored: boolean;
  };
  return { ...report, stateDir };
}
