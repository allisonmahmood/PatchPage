import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
const DEFAULT_API_URL = "https://post.patchyhq.com";
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
    expect(result.stdout).toBe(`PatchPage credentials saved for ${DEFAULT_API_URL}.\n`);
    expect(result.stderr).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(readHostCredential(result.stateDir)).toMatchObject({
      token,
      source: "auth-set"
    });
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
      expect(result.output).toContain(`PatchPage credentials saved for ${DEFAULT_API_URL}.`);
      expect(result.output).not.toContain(token);
      expect(result.terminalRestored).toBe(true);
      expect(readHostCredential(result.stateDir)).toMatchObject({ token });
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
      writeFileSync(credentialsPath, hostKeyedCredentials({ [DEFAULT_API_URL]: "old-token" }), {
        mode: 0o644
      });
      chmodSync(credentialsPath, 0o644);

      const result = runCli(["auth", "set", "--token-stdin"], "pp_replacement\n", stateDir);

      expect(result.status).toBe(0);
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
      expect(readHostCredential(stateDir)).toMatchObject({ token: "pp_replacement" });
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
      expect(readHostCredential(stateDir)).toMatchObject({ token: "pp_private" });
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
    expect(readHostCredential(result.stateDir)).toMatchObject({ token });
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
    expect(result.stderr).toBe(
      "Missing API token for http://127.0.0.1:1. Run: patchpage auth set --api-url http://127.0.0.1:1\n"
    );
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
    expect(result.stdout).toContain(
      "--anonymous         Create without credentials; never updates a draft"
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
    const anonymousResult = runCli([
      "upload",
      "does-not-exist.html",
      "--draft",
      "abcdefghijkl",
      "--anonymous"
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("--draft and --new cannot be used together.\n");
    expect(emptyTargetResult.status).toBe(1);
    expect(emptyTargetResult.stdout).toBe("");
    expect(emptyTargetResult.stderr).toBe("--draft and --new cannot be used together.\n");
    expect(anonymousResult.status).toBe(1);
    expect(anonymousResult.stdout).toBe("");
    expect(anonymousResult.stderr).toBe(
      "Anonymous uploads are create-only; --draft requires credentials.\n"
    );
  });

  it("lets --anonymous bypass credentials and cached update state", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "anonymous-override.html");
    const cachedDraftId = "abcdefghijkl";
    const draftCachePath = path.join(stateDir, "drafts.json");
    const draftCacheReadMarker = path.join(stateDir, "draft-cache-read");
    const cacheReadProbe = {
      PATCHPAGE_TEST_FS_READ_TARGET: draftCachePath,
      PATCHPAGE_TEST_FS_READ_MARKER: draftCacheReadMarker
    };
    writeFileSync(
      htmlPath,
      "<!doctype html><html><head><title>Anonymous override</title></head><body></body></html>"
    );
    writeFileSync(
      path.join(stateDir, "credentials.json"),
      "malformed stored credentials that anonymous mode must not read\n"
    );
    let cachedState: string;
    let authorization: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      authorization = request.headers.authorization;
      let body = "";
      for await (const chunk of request) body += chunk;
      requestBody = JSON.parse(body) as Record<string, unknown>;
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId: "mnopqrstuvwx",
          publicUrl: "http://example.test/d/mnopqrstuvwx",
          versionNumber: 1,
          warnings: []
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      cachedState = hostKeyedDraftCache({
        [apiUrl]: { [htmlPath]: { draftId: cachedDraftId, latestVersionNumber: 3 } }
      });
      writeFileSync(draftCachePath, cachedState);

      const result = await runCliAsync(
        ["upload", htmlPath, "--anonymous", "--api-url", apiUrl],
        { PATCHPAGE_API_TOKEN: "environment-token", ...cacheReadProbe },
        stateDir
      );
      const explicitNewResult = await runCliAsync(
        ["upload", htmlPath, "--anonymous", "--new", "--api-url", apiUrl],
        { PATCHPAGE_API_TOKEN: "environment-token", ...cacheReadProbe },
        stateDir
      );

      expect([result.status, explicitNewResult.status]).toEqual([0, 0]);
      expect(authorization).toBeUndefined();
      expect(requestBody).not.toHaveProperty("draftId");
      expect(readFileSync(draftCachePath, "utf8")).toBe(cachedState);
      expect(existsSync(draftCacheReadMarker)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("rejects an explicit update when automatic anonymous mode has no credentials", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "anonymous-update.html");
    writeFileSync(
      htmlPath,
      "<!doctype html><html><head><title>Anonymous update</title></head><body></body></html>"
    );
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId: "mnopqrstuvwx",
          publicUrl: "http://example.test/d/mnopqrstuvwx",
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
        [
          "upload",
          htmlPath,
          "--draft",
          "abcdefghijkl",
          "--api-url",
          `http://127.0.0.1:${address.port}`
        ],
        {},
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        "Anonymous uploads are create-only; --draft requires credentials.\n"
      );
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("selects environment, stored, then automatic anonymous upload credentials", async () => {
    const authorizations: Array<string | undefined> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      authorizations.push(request.headers.authorization);
      let body = "";
      for await (const chunk of request) body += chunk;
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId: "mnopqrstuvwx",
          publicUrl: "http://example.test/d/mnopqrstuvwx",
          versionNumber: 1,
          warnings: []
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      const apiArgs = ["--api-url", apiUrl];

      const environmentState = makeStateDir();
      const environmentHtml = path.join(environmentState, "environment.html");
      writeFileSync(environmentHtml, "<!doctype html><title>Environment</title>");
      writeFileSync(
        path.join(environmentState, "credentials.json"),
        hostKeyedCredentials({ [apiUrl]: "stored-token" })
      );
      const environmentResult = await runCliAsync(
        ["upload", environmentHtml, "--new", ...apiArgs],
        { PATCHPAGE_API_TOKEN: "environment-token" },
        environmentState
      );

      const storedState = makeStateDir();
      const storedHtml = path.join(storedState, "stored.html");
      writeFileSync(storedHtml, "<!doctype html><title>Stored</title>");
      writeFileSync(
        path.join(storedState, "credentials.json"),
        hostKeyedCredentials({ [apiUrl]: "stored-token" })
      );
      const storedResult = await runCliAsync(
        ["upload", storedHtml, "--new", ...apiArgs],
        {},
        storedState
      );

      const anonymousState = makeStateDir();
      const anonymousHtml = path.join(anonymousState, "anonymous.html");
      writeFileSync(anonymousHtml, "<!doctype html><title>Automatic anonymous</title>");
      const cachedState = hostKeyedDraftCache({
        [apiUrl]: { [anonymousHtml]: { draftId: "abcdefghijkl", latestVersionNumber: 2 } }
      });
      writeFileSync(path.join(anonymousState, "drafts.json"), cachedState);
      const anonymousResult = await runCliAsync(
        ["upload", anonymousHtml, ...apiArgs],
        {},
        anonymousState
      );

      expect([
        environmentResult.status,
        storedResult.status,
        anonymousResult.status
      ]).toEqual([0, 0, 0]);
      expect(authorizations).toEqual([
        "Bearer environment-token",
        "Bearer stored-token",
        undefined
      ]);
      expect(requestBodies[2]).not.toHaveProperty("draftId");
      expect(readFileSync(path.join(anonymousState, "drafts.json"), "utf8")).toBe(cachedState);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("fails closed on malformed or invalid stored credentials", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId: "mnopqrstuvwx",
          publicUrl: "http://example.test/d/mnopqrstuvwx",
          versionNumber: 1,
          warnings: []
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      const host = JSON.stringify(apiUrl);
      // Nothing host-keyed survives parsing, so the whole document is rejected.
      const invalidDocuments = [
        ["malformed", "not-json\n"],
        ["null-document", "null\n"],
        ["array-document", "[]\n"],
        ["missing-hosts", "{}\n"],
        ["null-hosts", '{"hosts":null}\n'],
        ["array-hosts", '{"hosts":[]}\n']
      ];
      // The map is intact; only this instance's own entry is unusable.
      const invalidEntries = [
        ["string-host-entry", `{"hosts":{${host}:"pp_bare"}}\n`],
        ["missing-token", `{"hosts":{${host}:{}}}\n`],
        ["null-token", `{"hosts":{${host}:{"token":null}}}\n`],
        ["number-token", `{"hosts":{${host}:{"token":42}}}\n`],
        ["empty-token", `{"hosts":{${host}:{"token":""}}}\n`]
      ];

      for (const [label, contents] of invalidDocuments) {
        const stateDir = makeStateDir();
        const htmlPath = path.join(stateDir, `${label}.html`);
        writeFileSync(htmlPath, `<!doctype html><title>${label}</title>`);
        writeFileSync(path.join(stateDir, "credentials.json"), contents);

        const result = await runCliAsync(["upload", htmlPath, "--api-url", apiUrl], {}, stateDir);

        expect(result.status, label).toBe(1);
        expect(result.stdout, label).toBe("");
        expect(result.stderr, label).toBe(
          "Stored credentials are invalid. Run: patchpage auth set to replace them.\n"
        );
        expect(existsSync(path.join(stateDir, "drafts.json")), label).toBe(false);
      }

      for (const [label, contents] of invalidEntries) {
        const stateDir = makeStateDir();
        const htmlPath = path.join(stateDir, `${label}.html`);
        writeFileSync(htmlPath, `<!doctype html><title>${label}</title>`);
        writeFileSync(path.join(stateDir, "credentials.json"), contents);

        const result = await runCliAsync(["upload", htmlPath, "--api-url", apiUrl], {}, stateDir);

        expect(result.status, label).toBe(1);
        expect(result.stdout, label).toBe("");
        expect(result.stderr, label).toBe(
          `Stored credentials for ${apiUrl} are invalid. Run: patchpage auth set --api-url ${apiUrl} to replace them.\n`
        );
        expect(existsSync(path.join(stateDir, "drafts.json")), label).toBe(false);
      }

      const unreadableStateDir = makeStateDir();
      const unreadableHtmlPath = path.join(unreadableStateDir, "unreadable.html");
      writeFileSync(unreadableHtmlPath, "<!doctype html><title>Unreadable credentials</title>");
      mkdirSync(path.join(unreadableStateDir, "credentials.json"));
      const unreadableResult = await runCliAsync(
        [
          "upload",
          unreadableHtmlPath,
          "--api-url",
          `http://127.0.0.1:${address.port}`
        ],
        {},
        unreadableStateDir
      );
      expect(unreadableResult.status).toBe(1);
      expect(unreadableResult.stdout).toBe("");
      expect(unreadableResult.stderr).toBe(
        "Stored credentials could not be read. Check permissions or run: patchpage auth set to replace them.\n"
      );
      expect(existsSync(path.join(unreadableStateDir, "drafts.json"))).toBe(false);
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("keeps repeated no-credential uploads create-only without persisting update intent", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "repeat-anonymous.html");
    const draftCachePath = path.join(stateDir, "drafts.json");
    const draftCacheReadMarker = path.join(stateDir, "draft-cache-read");
    const cacheReadProbe = {
      PATCHPAGE_TEST_FS_READ_TARGET: draftCachePath,
      PATCHPAGE_TEST_FS_READ_MARKER: draftCacheReadMarker
    };
    writeFileSync(htmlPath, "<!doctype html><title>Repeat anonymous</title>");
    const authorizations: Array<string | undefined> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const responseDraftIds = ["mnopqrstuvwx", "yzabcdefghij"];
    const server = createServer(async (request, response) => {
      authorizations.push(request.headers.authorization);
      let body = "";
      for await (const chunk of request) body += chunk;
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      const draftId = responseDraftIds[requestBodies.length - 1];
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId,
          publicUrl: `http://example.test/d/${draftId}`,
          versionNumber: 1,
          warnings: []
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const args = ["upload", htmlPath, "--api-url", `http://127.0.0.1:${address.port}`];

      const first = await runCliAsync(args, cacheReadProbe, stateDir);
      const second = await runCliAsync(args, cacheReadProbe, stateDir);

      expect([first.status, second.status]).toEqual([0, 0]);
      expect(authorizations).toEqual([undefined, undefined]);
      expect(requestBodies).toHaveLength(2);
      for (const requestBody of requestBodies) {
        expect(requestBody).not.toHaveProperty("draftId");
      }
      expect(first.stdout).toContain("Draft ID: mnopqrstuvwx");
      expect(second.stdout).toContain("Draft ID: yzabcdefghij");
      expect(existsSync(path.join(stateDir, "drafts.json"))).toBe(false);
      expect(existsSync(draftCacheReadMarker)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("treats an empty environment token as unset rather than an empty Bearer header", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "empty-environment-token.html");
    writeFileSync(htmlPath, "<!doctype html><title>Empty environment token</title>");
    let requestCount = 0;
    let authorization: string | undefined | null = null;
    const server = createServer((request, response) => {
      requestCount += 1;
      authorization = request.headers.authorization;
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId: "mnopqrstuvwx",
          publicUrl: "http://example.test/d/mnopqrstuvwx",
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
        ["upload", htmlPath, "--api-url", `http://127.0.0.1:${address.port}`],
        { PATCHPAGE_API_TOKEN: "" },
        stateDir
      );

      expect(result.status).toBe(0);
      expect(requestCount).toBe(1);
      expect(authorization).toBeUndefined();
      expect(existsSync(path.join(stateDir, "drafts.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("treats an empty environment API URL as unset and keeps the configured instance", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "empty-environment-url.html");
    writeFileSync(htmlPath, "<!doctype html><title>Empty environment URL</title>");
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.statusCode = 201;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          draftId: "mnopqrstuvwx",
          publicUrl: "http://example.test/d/mnopqrstuvwx",
          versionNumber: 1,
          warnings: []
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const apiUrl = `http://127.0.0.1:${address.port}`;
      writeFileSync(
        path.join(stateDir, "config.json"),
        `${JSON.stringify({ apiUrl }, null, 2)}\n`
      );
      writeFileSync(
        path.join(stateDir, "credentials.json"),
        hostKeyedCredentials({ [apiUrl]: "configured-instance-token" })
      );

      const result = await runCliAsync(
        ["upload", htmlPath],
        { PATCHPAGE_API_URL: "" },
        stateDir
      );

      expect(result.status).toBe(0);
      expect(authorization).toBe("Bearer configured-instance-token");
      expect(Object.keys(readDraftCache(stateDir).hosts)).toEqual([apiUrl]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("does not retry an authenticated upload failure anonymously", async () => {
    const token = "pp_rejected_environment_token";
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "rejected-auth.html");
    writeFileSync(htmlPath, "<!doctype html><title>Rejected auth</title>");
    let requestCount = 0;
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      requestCount += 1;
      authorization = request.headers.authorization;
      response.statusCode = 401;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: false, error: "Missing or invalid API token." }));
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
      expect(requestCount).toBe(1);
      expect(authorization).toBe(`Bearer ${token}`);
      expect(existsSync(path.join(stateDir, "drafts.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
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
      const apiUrl = `http://127.0.0.1:${address.port}`;
      writeFileSync(
        path.join(stateDir, "drafts.json"),
        hostKeyedDraftCache({ [apiUrl]: { [htmlPath]: { draftId, latestVersionNumber: 1 } } })
      );

      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", apiUrl],
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

describe("host-keyed local state", () => {
  it("saves auth set credentials under the resolved instance and merges other instances", () => {
    const stateDir = makeStateDir();
    const firstUrl = "https://first.test";
    const secondUrl = "https://second.test:8443";

    const first = runCli(
      ["auth", "set", "--token-stdin", "--api-url", firstUrl],
      "pp_first\n",
      stateDir
    );
    const second = runCli(
      ["auth", "set", "--token-stdin", "--api-url", secondUrl],
      "pp_second\n",
      stateDir
    );
    // A trailing slash normalizes to the same host key, so this replaces the first entry.
    const again = runCli(
      ["auth", "set", "--token-stdin", "--api-url", `${firstUrl}/`],
      "pp_first_again\n",
      stateDir
    );

    expect([first.status, second.status, again.status]).toEqual([0, 0, 0]);
    expect(first.stdout).toBe(`PatchPage credentials saved for ${firstUrl}.\n`);
    expect(second.stdout).toBe(`PatchPage credentials saved for ${secondUrl}.\n`);
    expect(again.stdout).toBe(`PatchPage credentials saved for ${firstUrl}.\n`);

    const { hosts } = readCredentials(stateDir);
    expect(Object.keys(hosts).sort()).toEqual([firstUrl, secondUrl].sort());
    expect(hosts[firstUrl]).toMatchObject({ token: "pp_first_again", source: "auth-set" });
    expect(hosts[secondUrl]).toMatchObject({ token: "pp_second", source: "auth-set" });
    expect(typeof hosts[firstUrl]?.updatedAt).toBe("string");
  });

  it("saves auth set credentials under the instance the environment selects", () => {
    const stateDir = makeStateDir();
    const result = runCli(["auth", "set", "--token-stdin"], "pp_from_environment\n", stateDir, {
      PATCHPAGE_API_URL: "https://environment.test"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PatchPage credentials saved for https://environment.test.\n");
    expect(Object.keys(readCredentials(stateDir).hosts)).toEqual(["https://environment.test"]);
    // Without --api-url the instance choice is not persisted.
    expect(existsSync(path.join(stateDir, "config.json"))).toBe(false);
  });

  it("never sends a token stored for one instance to another", async () => {
    const token = "pp_first_instance_only";
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "cross-instance.html");
    writeFileSync(htmlPath, "<!doctype html><title>Cross instance</title>");
    const configured = await startUploadServer(createOnly("aaaabbbbcccc"));
    const other = await startUploadServer(createOnly("ddddeeeeffff"));

    try {
      writeFileSync(
        path.join(stateDir, "credentials.json"),
        hostKeyedCredentials({ [configured.apiUrl]: token })
      );

      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", other.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      expect(configured.requests).toEqual([]);
      expect(other.requests).toHaveLength(1);
      expect(other.requests[0]?.authorization).toBeUndefined();
      expect(result.argv.join("\0")).not.toContain(token);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      // A credential-free upload stays create-only and writes no cache.
      expect(existsSync(path.join(stateDir, "drafts.json"))).toBe(false);
    } finally {
      await configured.close();
      await other.close();
    }
  });

  it("keeps the draft cache per instance and never replays a draft ID across instances", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "shared.html");
    writeFileSync(htmlPath, "<!doctype html><title>Shared</title>");
    const first = await startUploadServer(createOrUpdate("aaaabbbbcccc"));
    const second = await startUploadServer(createOrUpdate("ddddeeeeffff"));

    try {
      writeFileSync(
        path.join(stateDir, "credentials.json"),
        hostKeyedCredentials({
          [first.apiUrl]: "first-instance-token",
          [second.apiUrl]: "second-instance-token"
        })
      );

      const created = await runCliAsync(
        ["upload", htmlPath, "--api-url", first.apiUrl],
        {},
        stateDir
      );
      const crossed = await runCliAsync(
        ["upload", htmlPath, "--api-url", second.apiUrl],
        {},
        stateDir
      );
      const updated = await runCliAsync(
        ["upload", htmlPath, "--api-url", first.apiUrl],
        {},
        stateDir
      );

      expect([created.status, crossed.status, updated.status]).toEqual([0, 0, 0]);
      expect(created.stdout).toContain("Uploaded draft");
      expect(crossed.stdout).toContain("Uploaded draft");
      expect(updated.stdout).toContain("Updated draft");

      expect(first.requests.map((request) => request.authorization)).toEqual([
        "Bearer first-instance-token",
        "Bearer first-instance-token"
      ]);
      expect(second.requests.map((request) => request.authorization)).toEqual([
        "Bearer second-instance-token"
      ]);
      expect(first.requests[0]?.body).not.toHaveProperty("draftId");
      expect(second.requests[0]?.body).not.toHaveProperty("draftId");
      expect(first.requests[1]?.body).toHaveProperty("draftId", "aaaabbbbcccc");

      const cache = readDraftCache(stateDir);
      expect(Object.keys(cache.hosts).sort()).toEqual([first.apiUrl, second.apiUrl].sort());
      expect(cache.hosts[first.apiUrl]?.files[htmlPath]).toMatchObject({
        draftId: "aaaabbbbcccc",
        latestVersionNumber: 2
      });
      expect(cache.hosts[second.apiUrl]?.files[htmlPath]).toMatchObject({
        draftId: "ddddeeeeffff",
        latestVersionNumber: 1
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("keeps every other instance's token when auth set follows an invalid-entry error", () => {
    const stateDir = makeStateDir();
    const credentialsPath = path.join(stateDir, "credentials.json");
    const liveToken = "pp_sibling_live_token";
    const brokenEntry = { token: null };
    writeFileSync(
      credentialsPath,
      `${JSON.stringify(
        {
          hosts: {
            "https://good.test": {
              token: liveToken,
              updatedAt: "2026-08-14T00:00:00.000Z",
              source: "auth-set"
            },
            "https://broken.test": brokenEntry
          }
        },
        null,
        2
      )}\n`
    );

    const result = runCli(
      ["auth", "set", "--token-stdin", "--api-url", "https://third.test"],
      "pp_third\n",
      stateDir
    );

    expect(result.status).toBe(0);
    const { hosts } = readCredentials(stateDir);
    expect(Object.keys(hosts).sort()).toEqual([
      "https://broken.test",
      "https://good.test",
      "https://third.test"
    ]);
    // The healthy sibling's live token survives the write.
    expect(hosts["https://good.test"]).toMatchObject({ token: liveToken, source: "auth-set" });
    // The unusable entry is not destroyed either; it is carried across verbatim.
    expect(hosts["https://broken.test"]).toEqual(brokenEntry);
    expect(hosts["https://third.test"]).toMatchObject({
      token: "pp_third",
      source: "auth-set"
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain(liveToken);
  });

  it("repairs one instance's invalid entry without disturbing another's", () => {
    const stateDir = makeStateDir();
    const liveToken = "pp_untouched_live_token";
    writeFileSync(
      path.join(stateDir, "credentials.json"),
      `${JSON.stringify(
        {
          hosts: {
            "https://good.test": { token: liveToken, source: "auth-set" },
            "https://broken.test": { token: "" }
          }
        },
        null,
        2
      )}\n`
    );

    const result = runCli(
      ["auth", "set", "--token-stdin", "--api-url", "https://broken.test"],
      "pp_repaired\n",
      stateDir
    );

    expect(result.status).toBe(0);
    const { hosts } = readCredentials(stateDir);
    expect(hosts["https://broken.test"]).toMatchObject({
      token: "pp_repaired",
      source: "auth-set"
    });
    expect(hosts["https://good.test"]).toMatchObject({ token: liveToken });
  });

  it("does not let one instance's invalid entry block another instance", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "unaffected.html");
    writeFileSync(htmlPath, "<!doctype html><title>Unaffected</title>");
    const server = await startUploadServer(createOnly("aaaabbbbcccc"));

    try {
      writeFileSync(
        path.join(stateDir, "credentials.json"),
        `${JSON.stringify(
          {
            hosts: {
              [server.apiUrl]: { token: "pp_usable", source: "auth-set" },
              "https://broken.test": { token: null }
            }
          },
          null,
          2
        )}\n`
      );

      // The draft cache carries the same kind of unrelated damage.
      const brokenCacheEntry = { files: { "/gone.html": { draftId: 42 } } };
      writeFileSync(
        path.join(stateDir, "drafts.json"),
        `${JSON.stringify({ hosts: { "https://broken.test": brokenCacheEntry } }, null, 2)}\n`
      );

      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(server.requests[0]?.authorization).toBe("Bearer pp_usable");

      const cache = readDraftCache(stateDir);
      expect(Object.keys(cache.hosts).sort()).toEqual(
        ["https://broken.test", server.apiUrl].sort()
      );
      expect(cache.hosts[server.apiUrl]?.files[htmlPath]).toMatchObject({
        draftId: "aaaabbbbcccc"
      });
      // The neighbour's unusable entry is preserved, not rewritten or dropped.
      expect(cache.hosts["https://broken.test"]).toEqual(brokenCacheEntry);
    } finally {
      await server.close();
    }
  });

  it("names the default instance's own next action instead of a competing auth set", () => {
    const result = runCli(["whoami"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Missing API token for ${DEFAULT_API_URL}.`);
    expect(result.stderr).toContain("does not issue public tokens");
    expect(result.stderr).toContain("--api-url or PATCHPAGE_API_URL");
    // The instance that issues no tokens is never offered as an auth set target.
    expect(result.stderr).not.toContain(`patchpage auth set --api-url ${DEFAULT_API_URL}`);
  });

  it("fails closed on a credentials file in the retired single-instance format", async () => {
    const legacyToken = "pp_legacy_only_key";
    const legacyContents = `{"apiToken":"${legacyToken}","updatedAt":"2026-07-13T00:00:00.000Z"}\n`;
    const stateDir = makeStateDir();
    const credentialsPath = path.join(stateDir, "credentials.json");
    const htmlPath = path.join(stateDir, "legacy-credentials.html");
    writeFileSync(htmlPath, "<!doctype html><title>Legacy credentials</title>");
    writeFileSync(credentialsPath, legacyContents);
    const server = await startUploadServer(createOnly("aaaabbbbcccc"));

    try {
      const upload = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );
      const whoami = await runCliAsync(
        ["whoami", "--api-url", server.apiUrl],
        {},
        stateDir
      );
      const authSet = runCli(
        ["auth", "set", "--token-stdin", "--api-url", server.apiUrl],
        "pp_replacement\n",
        stateDir
      );

      const expected =
        `Stored credentials use the retired single-instance format: ${credentialsPath}\n` +
        "PatchPage now stores one token per instance and does not migrate the old file.\n" +
        "Copy the token out of that file if you still need it, delete the file, then run: patchpage auth set\n";
      for (const result of [upload, whoami, authSet]) {
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(expected);
        expect(`${result.stdout}${result.stderr}`).not.toContain(legacyToken);
      }
      expect(server.requests).toEqual([]);
      // Nothing is migrated, and nothing is destroyed: the old key survives.
      expect(readFileSync(credentialsPath, "utf8")).toBe(legacyContents);
    } finally {
      await server.close();
    }
  });

  it("fails closed on a draft cache in the retired single-instance format", async () => {
    const stateDir = makeStateDir();
    const draftsPath = path.join(stateDir, "drafts.json");
    const htmlPath = path.join(stateDir, "legacy-cache.html");
    writeFileSync(htmlPath, "<!doctype html><title>Legacy cache</title>");
    const legacyContents = `${JSON.stringify(
      {
        files: {
          [htmlPath]: {
            draftId: "abcdefghijkl",
            publicUrl: "http://example.test/d/abcdefghijkl",
            latestVersionNumber: 1,
            updatedAt: "2026-07-13T00:00:00.000Z"
          }
        }
      },
      null,
      2
    )}\n`;
    writeFileSync(draftsPath, legacyContents);
    const server = await startUploadServer(createOnly("aaaabbbbcccc"));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        { PATCHPAGE_API_TOKEN: "environment-token" },
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `The stored draft cache uses the retired single-instance format: ${draftsPath}\n` +
          "PatchPage now caches drafts per instance and does not migrate the old file.\n" +
          "Delete that file to start a fresh cache. Drafts already published are unaffected.\n"
      );
      expect(server.requests).toEqual([]);
      expect(readFileSync(draftsPath, "utf8")).toBe(legacyContents);
    } finally {
      await server.close();
    }
  });

  it("fails closed on an unreadable or invalid draft cache", async () => {
    const server = await startUploadServer(createOnly("aaaabbbbcccc"));

    try {
      const invalidStateDir = makeStateDir();
      const invalidHtmlPath = path.join(invalidStateDir, "invalid-cache.html");
      const invalidDraftsPath = path.join(invalidStateDir, "drafts.json");
      writeFileSync(invalidHtmlPath, "<!doctype html><title>Invalid cache</title>");
      writeFileSync(invalidDraftsPath, "not-json\n");
      const invalid = await runCliAsync(
        ["upload", invalidHtmlPath, "--api-url", server.apiUrl],
        { PATCHPAGE_API_TOKEN: "environment-token" },
        invalidStateDir
      );

      const unreadableStateDir = makeStateDir();
      const unreadableHtmlPath = path.join(unreadableStateDir, "unreadable-cache.html");
      const unreadableDraftsPath = path.join(unreadableStateDir, "drafts.json");
      writeFileSync(unreadableHtmlPath, "<!doctype html><title>Unreadable cache</title>");
      mkdirSync(unreadableDraftsPath);
      const unreadable = await runCliAsync(
        ["upload", unreadableHtmlPath, "--api-url", server.apiUrl],
        { PATCHPAGE_API_TOKEN: "environment-token" },
        unreadableStateDir
      );

      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toBe(
        `The stored draft cache is invalid: ${invalidDraftsPath}\n` +
          "Delete that file to start a fresh cache. Drafts already published are unaffected.\n"
      );
      expect(unreadable.status).toBe(1);
      expect(unreadable.stderr).toBe(
        `The stored draft cache could not be read: ${unreadableDraftsPath}\n` +
          "Check permissions, or delete that file to start a fresh cache.\n"
      );
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "creates the state dir owner-only and writes host-keyed state owner-only",
    async () => {
      const parentDir = makeStateDir();
      const stateDir = path.join(parentDir, "nested state");
      const htmlPath = path.join(parentDir, "permissions.html");
      writeFileSync(htmlPath, "<!doctype html><title>Permissions</title>");
      const server = await startUploadServer(createOnly("aaaabbbbcccc"));

      try {
        const auth = runCli(
          ["auth", "set", "--token-stdin", "--api-url", server.apiUrl],
          "pp_permissions\n",
          stateDir
        );
        expect(auth.status).toBe(0);
        expect(statSync(stateDir).mode & 0o777).toBe(0o700);
        expect(statSync(path.join(stateDir, "credentials.json")).mode & 0o777).toBe(0o600);

        const upload = await runCliAsync(["upload", htmlPath], {}, stateDir);
        expect(upload.status).toBe(0);
        expect(statSync(path.join(stateDir, "drafts.json")).mode & 0o777).toBe(0o600);
        expect(Object.keys(readDraftCache(stateDir).hosts)).toEqual([server.apiUrl]);
      } finally {
        await server.close();
      }
    }
  );
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

function runCli(
  args: string[],
  input?: string,
  stateDir = makeStateDir(),
  envOverrides: NodeJS.ProcessEnv = {}
) {
  const argvOutputPath = path.join(makeStateDir(), "argv.json");
  const result = spawnSync(process.execPath, ["--import", argvPreloadUrl, cliPath, ...args], {
    encoding: "utf8",
    env: cliEnv({
      ...envOverrides,
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

interface UploadRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface UploadResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * A hand-written loopback instance. Each returned server is a distinct host key
 * because it listens on its own port.
 */
async function startUploadServer(respond: (request: UploadRequest) => UploadResponse) {
  const requests: UploadRequest[] = [];
  const server = createServer(async (incoming, response) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk;
    const request: UploadRequest = {
      authorization: incoming.headers.authorization,
      body: JSON.parse(raw) as Record<string, unknown>
    };
    requests.push(request);
    const { status, body } = respond(request);
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

function createOnly(draftId: string) {
  return (): UploadResponse => ({
    status: 201,
    body: {
      ok: true,
      draftId,
      publicUrl: `http://example.test/d/${draftId}`,
      versionNumber: 1,
      warnings: []
    }
  });
}

function createOrUpdate(createdDraftId: string) {
  return (request: UploadRequest): UploadResponse => {
    const requested = request.body.draftId;
    const isUpdate = typeof requested === "string";
    const draftId = isUpdate ? requested : createdDraftId;
    return {
      status: isUpdate ? 200 : 201,
      body: {
        ok: true,
        draftId,
        publicUrl: `http://example.test/d/${draftId}`,
        versionNumber: isUpdate ? 2 : 1,
        warnings: []
      }
    };
  };
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

function readCredentials(stateDir: string): {
  hosts: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path.join(stateDir, "credentials.json"), "utf8")) as {
    hosts: Record<string, Record<string, unknown>>;
  };
}

function readHostCredential(
  stateDir: string,
  host = DEFAULT_API_URL
): Record<string, unknown> | undefined {
  return readCredentials(stateDir).hosts[host];
}

function readDraftCache(stateDir: string): {
  hosts: Record<string, { files: Record<string, Record<string, unknown>> }>;
} {
  return JSON.parse(readFileSync(path.join(stateDir, "drafts.json"), "utf8")) as {
    hosts: Record<string, { files: Record<string, Record<string, unknown>> }>;
  };
}

function hostKeyedCredentials(entries: Record<string, string>): string {
  return `${JSON.stringify(
    {
      hosts: Object.fromEntries(
        Object.entries(entries).map(([host, token]) => [
          host,
          { token, updatedAt: "2026-08-14T00:00:00.000Z", source: "auth-set" }
        ])
      )
    },
    null,
    2
  )}\n`;
}

function hostKeyedDraftCache(
  hosts: Record<string, Record<string, { draftId: string; latestVersionNumber: number }>>
): string {
  return `${JSON.stringify(
    {
      hosts: Object.fromEntries(
        Object.entries(hosts).map(([host, files]) => [
          host,
          {
            files: Object.fromEntries(
              Object.entries(files).map(([file, draft]) => [
                file,
                {
                  draftId: draft.draftId,
                  publicUrl: `${host}/d/${draft.draftId}`,
                  latestVersionNumber: draft.latestVersionNumber,
                  updatedAt: "2026-08-14T00:00:00.000Z"
                }
              ])
            )
          }
        ])
      )
    },
    null,
    2
  )}\n`;
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
