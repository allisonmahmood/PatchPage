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
const MINT_PATH = "/api/tokens/self-service";
const MINTED_TOKEN = "pp_minted_publishing_key";
const AUP_URL = "https://patchyhq.com/acceptable-use";
// Not spec-pinned copy: the mint response carries the URL and acceptance is
// implied by publishing, so the CLI surfaces it. Asserted separately from the
// pinned announcement paragraph so the two can never be edited as one string.
const AUP_NOTICE = `Publishing here accepts the acceptable use policy: ${AUP_URL}\n`;
const DEPRECATED_ANONYMOUS_NOTICE =
  "Warning: --anonymous is deprecated and ignored. Uploads always use a publishing token; " +
  "one is minted automatically when none is stored for the instance.\n";
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
  it("explains both ways a token arrives without a token placeholder", () => {
    const result = runCli(["whoami", "--api-url", "http://127.0.0.1:1"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    // `whoami` reports; it never mints. Both routes to a token are named.
    expect(result.stderr).toBe(
      "No publishing token is stored for http://127.0.0.1:1.\n" +
        "One is minted automatically on your first upload, or save an existing one with: " +
        "patchpage auth set --api-url http://127.0.0.1:1\n"
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
      "--anonymous         Deprecated and ignored; uploads always use a token"
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

  it("accepts --anonymous as a deprecated no-op that publishes normally", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "deprecated-anonymous.html");
    const cachedDraftId = "abcdefghijkl";
    writeFileSync(
      htmlPath,
      "<!doctype html><html><head><title>Deprecated anonymous</title></head><body></body></html>"
    );
    const server = await startUploadServer(createOrUpdate("mnopqrstuvwx"));

    try {
      writeFileSync(
        path.join(stateDir, "credentials.json"),
        hostKeyedCredentials({ [server.apiUrl]: "stored-token" })
      );
      writeFileSync(
        path.join(stateDir, "drafts.json"),
        hostKeyedDraftCache({
          [server.apiUrl]: { [htmlPath]: { draftId: cachedDraftId, latestVersionNumber: 3 } }
        })
      );

      const result = await runCliAsync(
        ["upload", htmlPath, "--anonymous", "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      // Announced on stderr, then ignored: credentials and the cached draft are
      // both honoured exactly as they would be without the flag.
      expect(result.stderr).toBe(DEPRECATED_ANONYMOUS_NOTICE);
      expect(result.stdout).toContain("Updated draft");
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.authorization).toBe("Bearer stored-token");
      expect(server.requests[0]?.body).toHaveProperty("draftId", cachedDraftId);
      expect(server.mints).toEqual([]);
      expect(readDraftCache(stateDir).hosts[server.apiUrl]?.files[htmlPath]).toMatchObject({
        draftId: cachedDraftId,
        latestVersionNumber: 2
      });
    } finally {
      await server.close();
    }
  });

  it("still auto-mints under the deprecated --anonymous flag", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "deprecated-anonymous-mint.html");
    writeFileSync(htmlPath, "<!doctype html><title>Deprecated anonymous mint</title>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--anonymous", "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe(DEPRECATED_ANONYMOUS_NOTICE);
      expect(result.stdout).toBe(
        `${mintAnnouncement(server.apiUrl, stateDir)}${AUP_NOTICE}Uploaded draft\n` +
          "URL: http://example.test/d/mnopqrstuvwx\n" +
          "Draft ID: mnopqrstuvwx\n" +
          "Version: 1\n"
      );
      expect(server.mints).toHaveLength(1);
      expect(server.requests[0]?.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    } finally {
      await server.close();
    }
  });

  it("mints before an explicit --draft update when no token is stored", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-then-update.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint then update</title>");
    const server = await startUploadServer(createOrUpdate("mnopqrstuvwx"));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--draft", "abcdefghijkl", "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      // The flag combination that used to be rejected is now ordinary: every
      // upload has a token, so an explicit target is always answerable.
      expect(result.stdout).toContain("Updated draft");
      expect(server.mints).toHaveLength(1);
      expect(server.requests[0]?.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
      expect(server.requests[0]?.body).toHaveProperty("draftId", "abcdefghijkl");
    } finally {
      await server.close();
    }
  });

  it("selects environment, then stored, then a freshly minted upload credential", async () => {
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const apiArgs = ["--api-url", server.apiUrl];

      const environmentState = makeStateDir();
      const environmentHtml = path.join(environmentState, "environment.html");
      writeFileSync(environmentHtml, "<!doctype html><title>Environment</title>");
      writeFileSync(
        path.join(environmentState, "credentials.json"),
        hostKeyedCredentials({ [server.apiUrl]: "stored-token" })
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
        hostKeyedCredentials({ [server.apiUrl]: "stored-token" })
      );
      const storedResult = await runCliAsync(
        ["upload", storedHtml, "--new", ...apiArgs],
        {},
        storedState
      );

      const mintState = makeStateDir();
      const mintHtml = path.join(mintState, "minted.html");
      writeFileSync(mintHtml, "<!doctype html><title>Minted</title>");
      const mintResult = await runCliAsync(["upload", mintHtml, ...apiArgs], {}, mintState);

      expect([
        environmentResult.status,
        storedResult.status,
        mintResult.status
      ]).toEqual([0, 0, 0]);
      expect(server.requests.map((request) => request.authorization)).toEqual([
        "Bearer environment-token",
        "Bearer stored-token",
        `Bearer ${MINTED_TOKEN}`
      ]);
      // Minting is the last resort, so neither configured source triggers one.
      expect(server.mints).toHaveLength(1);
    } finally {
      await server.close();
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

  it("mints once and republishes with the saved token on later uploads", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "repeat-upload.html");
    writeFileSync(htmlPath, "<!doctype html><title>Repeat upload</title>");
    const server = await startUploadServer(createOrUpdate("mnopqrstuvwx"));

    try {
      const args = ["upload", htmlPath, "--api-url", server.apiUrl];
      const first = await runCliAsync(args, {}, stateDir);
      const second = await runCliAsync(args, {}, stateDir);

      expect([first.status, second.status]).toEqual([0, 0]);
      // One key per instance, for the life of that instance's pages.
      expect(server.mints).toHaveLength(1);
      expect(server.requests.map((request) => request.authorization)).toEqual([
        `Bearer ${MINTED_TOKEN}`,
        `Bearer ${MINTED_TOKEN}`
      ]);
      expect(first.stdout).toContain(mintAnnouncement(server.apiUrl, stateDir));
      expect(first.stdout).toContain("Uploaded draft");
      // The announcement is a first-run event, not a per-upload banner.
      expect(second.stdout).not.toContain("Minted a new publishing token");
      expect(second.stdout).toContain("Updated draft");
      expect(server.requests[0]?.body).not.toHaveProperty("draftId");
      expect(server.requests[1]?.body).toHaveProperty("draftId", "mnopqrstuvwx");
    } finally {
      await server.close();
    }
  });

  it("treats an empty environment token as unset rather than an empty Bearer header", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "empty-environment-token.html");
    writeFileSync(htmlPath, "<!doctype html><title>Empty environment token</title>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        { PATCHPAGE_API_TOKEN: "" },
        stateDir
      );

      expect(result.status).toBe(0);
      // Unset means unset: the empty value mints rather than sending an empty
      // Bearer header the instance would reject.
      expect(server.mints).toHaveLength(1);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    } finally {
      await server.close();
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

  it("never re-mints after a configured token is rejected", async () => {
    const environmentToken = "pp_rejected_environment_token";
    const storedToken = "pp_rejected_stored_token";
    const reject = (): UploadResponse => ({
      status: 401,
      body: { ok: false, error: "Missing or invalid API token." }
    });
    const server = await startUploadServer(reject);

    try {
      const environmentState = makeStateDir();
      const environmentHtml = path.join(environmentState, "rejected-environment.html");
      writeFileSync(environmentHtml, "<!doctype html><title>Rejected environment</title>");
      const environmentResult = await runCliAsync(
        ["upload", environmentHtml, "--api-url", server.apiUrl],
        { PATCHPAGE_API_TOKEN: environmentToken },
        environmentState
      );

      const storedState = makeStateDir();
      const storedHtml = path.join(storedState, "rejected-stored.html");
      writeFileSync(storedHtml, "<!doctype html><title>Rejected stored</title>");
      writeFileSync(
        path.join(storedState, "credentials.json"),
        hostKeyedCredentials({ [server.apiUrl]: storedToken })
      );
      const storedResult = await runCliAsync(
        ["upload", storedHtml, "--api-url", server.apiUrl],
        {},
        storedState
      );

      // A rejected token is a misconfiguration to surface, not a reason to mint
      // a second identity that would not control the first one's pages.
      expect([environmentResult.status, storedResult.status]).toEqual([1, 1]);
      expect(server.mints).toEqual([]);
      expect(server.requests.map((request) => request.authorization)).toEqual([
        `Bearer ${environmentToken}`,
        `Bearer ${storedToken}`
      ]);
      for (const result of [environmentResult, storedResult]) {
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Missing or invalid API token.");
        expect(result.stderr).not.toContain("Minted a new publishing token");
        expect(existsSync(path.join(result.stateDir, "drafts.json"))).toBe(false);
      }
      expect(`${environmentResult.stdout}${environmentResult.stderr}`).not.toContain(
        environmentToken
      );
      expect(`${storedResult.stdout}${storedResult.stderr}`).not.toContain(storedToken);
      // The rejected stored token is left exactly as configured.
      expect(readHostCredential(storedState, server.apiUrl)).toMatchObject({
        token: storedToken,
        source: "auth-set"
      });
    } finally {
      await server.close();
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

describe("auto-mint on first upload", () => {
  it("mints, announces, saves host-keyed, and completes the upload", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "first-upload.html");
    writeFileSync(htmlPath, "<!doctype html><title>First upload</title>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      // The announcement is pinned byte-for-byte and precedes the upload result.
      expect(result.stdout).toBe(
        `${mintAnnouncement(server.apiUrl, stateDir)}${AUP_NOTICE}Uploaded draft\n` +
          "URL: http://example.test/d/mnopqrstuvwx\n" +
          "Draft ID: mnopqrstuvwx\n" +
          "Version: 1\n"
      );

      // The plaintext is never echoed and never reaches argv.
      expect(`${result.stdout}${result.stderr}`).not.toContain(MINTED_TOKEN);
      expect(result.argv.join("\0")).not.toContain(MINTED_TOKEN);

      expect(readHostCredential(stateDir, server.apiUrl)).toMatchObject({
        token: MINTED_TOKEN,
        source: "mint"
      });
      expect(typeof readHostCredential(stateDir, server.apiUrl)?.updatedAt).toBe("string");
      expect(server.requests[0]?.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
    } finally {
      await server.close();
    }
  });

  it("asks the resolved instance for a token with no credentials of its own", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-request.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint request</title>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      expect(server.mints).toHaveLength(1);
      // Self-service minting is zero-input and unauthenticated by contract.
      expect(server.mints[0]?.authorization).toBeUndefined();
      expect(server.mints[0]?.raw).toBe("{}");
    } finally {
      await server.close();
    }
  });

  it("reports a minted token to the status probe without the probe minting one", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "probe-after-mint.html");
    writeFileSync(htmlPath, "<!doctype html><title>Probe after mint</title>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const apiArgs = ["--api-url", server.apiUrl];
      const before = JSON.parse(
        (await runCliAsync(["status", "--json", ...apiArgs], {}, stateDir)).stdout
      ) as Record<string, unknown>;

      const upload = await runCliAsync(["upload", htmlPath, ...apiArgs], {}, stateDir);

      const after = JSON.parse(
        (await runCliAsync(["status", "--json", ...apiArgs], {}, stateDir)).stdout
      ) as Record<string, unknown>;

      expect(upload.status).toBe(0);
      // The probe reads state and nothing else: it reported the absence
      // without creating a token, and the only mint came from the upload.
      expect(before).toMatchObject({ hasToken: false, tokenSource: null });
      expect(after).toMatchObject({ hasToken: true, tokenSource: "mint" });
      expect(server.mints).toHaveLength(1);
      // Two probes either side of the upload, and neither touched the network.
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("mints from upload alone, never from whoami or validate", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "read-only.html");
    writeFileSync(htmlPath, "<!doctype html><title>Read only</title>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const whoami = await runCliAsync(
        ["whoami", "--api-url", server.apiUrl],
        {},
        stateDir
      );
      const validate = await runCliAsync(["validate", htmlPath], {}, stateDir);

      // Both are read-only diagnostics: they report the absence of a token
      // rather than quietly creating an identity the user never asked for.
      expect(whoami.status).toBe(1);
      expect(whoami.stderr).toBe(
        `No publishing token is stored for ${server.apiUrl}.\n` +
          "One is minted automatically on your first upload, or save an existing one with: " +
          `patchpage auth set --api-url ${server.apiUrl}\n`
      );
      expect(validate.status).toBe(0);
      expect(server.mints).toEqual([]);
      expect(server.requests).toEqual([]);
      expect(existsSync(path.join(stateDir, "credentials.json"))).toBe(false);

      // The same instance mints readily once an upload asks it to.
      const upload = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );
      expect(upload.status).toBe(0);
      expect(server.mints).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("relays the acceptable use policy only when the instance names one", async () => {
    const withPolicy = await startUploadServer(createOnly("mnopqrstuvwx"));
    const withoutPolicy = await startUploadServer(createOnly("yzabcdefghij"), () => ({
      status: 201,
      body: { ok: true, token: MINTED_TOKEN }
    }));

    try {
      const policyState = makeStateDir();
      const policyHtml = path.join(policyState, "aup.html");
      writeFileSync(policyHtml, "<!doctype html><title>Policy</title>");
      const announced = await runCliAsync(
        ["upload", policyHtml, "--api-url", withPolicy.apiUrl],
        {},
        policyState
      );

      const silentState = makeStateDir();
      const silentHtml = path.join(silentState, "no-aup.html");
      writeFileSync(silentHtml, "<!doctype html><title>No policy</title>");
      const silent = await runCliAsync(
        ["upload", silentHtml, "--api-url", withoutPolicy.apiUrl],
        {},
        silentState
      );

      expect([announced.status, silent.status]).toEqual([0, 0]);
      // Acceptance is implied by publishing, so the link is shown when offered.
      expect(announced.stdout).toContain(AUP_NOTICE);
      // An instance that names no policy gets no invented one, and minting
      // still succeeds: the URL is relayed, never required.
      expect(silent.stdout).not.toContain("acceptable use policy");
      expect(silent.stdout).toContain(mintAnnouncement(withoutPolicy.apiUrl, silentState));
      expect(readHostCredential(silentState, withoutPolicy.apiUrl)).toMatchObject({
        token: MINTED_TOKEN,
        source: "mint"
      });
    } finally {
      await withPolicy.close();
      await withoutPolicy.close();
    }
  });

  it("merges a minted token beside every other instance's saved token", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "merged-mint.html");
    writeFileSync(htmlPath, "<!doctype html><title>Merged mint</title>");
    const neighbourToken = "pp_neighbour_live_key";
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      writeFileSync(
        path.join(stateDir, "credentials.json"),
        hostKeyedCredentials({ "https://neighbour.test": neighbourToken })
      );

      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(0);
      const { hosts } = readCredentials(stateDir);
      expect(Object.keys(hosts).sort()).toEqual(["https://neighbour.test", server.apiUrl].sort());
      expect(hosts["https://neighbour.test"]).toMatchObject({
        token: neighbourToken,
        source: "auth-set"
      });
      expect(hosts[server.apiUrl]).toMatchObject({ token: MINTED_TOKEN, source: "mint" });
      expect(`${result.stdout}${result.stderr}`).not.toContain(neighbourToken);
    } finally {
      await server.close();
    }
  });

  it("fails hard when the instance does not hand out tokens", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-disabled.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint disabled</title>");
    const server = await startUploadServer(
      createOnly("mnopqrstuvwx"),
      refusesMint("self_service_disabled")
    );

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `Could not get a publishing token: ${server.apiUrl} does not hand them out on request.\n` +
          "Ask that instance's operator for a token and save it with: " +
          `patchpage auth set --api-url ${server.apiUrl}\n`
      );
      // One attempt, no fallback instance, and nothing written.
      expect(server.mints).toHaveLength(1);
      expect(server.requests).toEqual([]);
      expect(existsSync(path.join(stateDir, "credentials.json"))).toBe(false);
      expect(existsSync(path.join(stateDir, "drafts.json"))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("fails hard when the network has exhausted its rolling-window mints", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-quota.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint quota</title>");
    const server = await startUploadServer(
      createOnly("mnopqrstuvwx"),
      refusesMint("mint_quota_exceeded")
    );

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `Could not get a publishing token: ${server.apiUrl} has reached its limit of new tokens ` +
          "for your network over the last 24 hours.\nCopy an existing token from another " +
          `machine and save it with: patchpage auth set --api-url ${server.apiUrl}, or try ` +
          "again once the oldest of those mints is 24 hours old.\n"
      );
      expect(server.mints).toHaveLength(1);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails hard and names the wait when minting is rate limited", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-rate-limited.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint rate limited</title>");
    const server = await startUploadServer(
      createOnly("mnopqrstuvwx"),
      refusesMint("rate_limited", 42)
    );

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `Could not get a publishing token: ${server.apiUrl} is handing out tokens faster than ` +
          "it allows right now.\nWait 42 seconds and run the same command again.\n"
      );
      // Named as the next action rather than slept through: no retries.
      expect(server.mints).toHaveLength(1);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("fails hard when the resolved instance cannot be reached", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-unreachable.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint unreachable</title>");
    const apiUrl = "http://127.0.0.1:1";

    const result = await runCliAsync(["upload", htmlPath, "--api-url", apiUrl], {}, stateDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `Could not get a publishing token: ${apiUrl} could not be reached.\n` +
        "Check the address and your network connection, then run the same command again.\n"
    );
    // Never the official instance as a consolation prize.
    expect(result.stderr).not.toContain(DEFAULT_API_URL);
    expect(existsSync(path.join(stateDir, "credentials.json"))).toBe(false);
  });

  it("fails hard on an instance with no self-service mint route", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-absent.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint absent</title>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"), () => ({
      status: 404,
      body: { ok: false, error: "Not found." }
    }));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `Could not get a publishing token from ${server.apiUrl}: Not found.\n` +
          "If that instance does not hand out tokens, ask its operator for one and save it " +
          `with: patchpage auth set --api-url ${server.apiUrl}\n`
      );
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("does not mint for an unpublishable file", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "invalid.html");
    writeFileSync(htmlPath, "<!doctype html><title>Invalid</title><script>alert(1)</script>");
    const server = await startUploadServer(createOnly("mnopqrstuvwx"));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(1);
      // Local validation gates the network, so a bad file costs no mint quota.
      expect(server.mints).toEqual([]);
      expect(server.requests).toEqual([]);
      expect(existsSync(path.join(stateDir, "credentials.json"))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("keeps a minted token when the upload it was minted for fails", async () => {
    const stateDir = makeStateDir();
    const htmlPath = path.join(stateDir, "mint-then-fail.html");
    writeFileSync(htmlPath, "<!doctype html><title>Mint then fail</title>");
    const server = await startUploadServer(() => ({
      status: 500,
      body: { ok: false, error: "Storage unavailable." }
    }));

    try {
      const result = await runCliAsync(
        ["upload", htmlPath, "--api-url", server.apiUrl],
        {},
        stateDir
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Storage unavailable.");
      // The instance already issued it, so discarding it locally would orphan
      // anything it goes on to control.
      expect(readHostCredential(stateDir, server.apiUrl)).toMatchObject({
        token: MINTED_TOKEN,
        source: "mint"
      });
      expect(existsSync(path.join(stateDir, "drafts.json"))).toBe(false);
    } finally {
      await server.close();
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
      // The other instance mints its own key rather than borrowing this one.
      expect(configured.requests).toEqual([]);
      expect(configured.mints).toEqual([]);
      expect(other.mints).toHaveLength(1);
      expect(other.requests).toHaveLength(1);
      expect(other.requests[0]?.authorization).toBe(`Bearer ${MINTED_TOKEN}`);
      expect(result.argv.join("\0")).not.toContain(token);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      // Each instance keeps its own key; the first instance's is untouched.
      expect(readHostCredential(stateDir, configured.apiUrl)).toMatchObject({ token });
      expect(readHostCredential(stateDir, other.apiUrl)).toMatchObject({
        token: MINTED_TOKEN,
        source: "mint"
      });
      expect(Object.keys(readDraftCache(stateDir).hosts)).toEqual([other.apiUrl]);
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

  it("names auto-mint and auth set for the default instance without claiming its posture", () => {
    const result = runCli(["whoami"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `No publishing token is stored for ${DEFAULT_API_URL}.\n` +
        "One is minted automatically on your first upload, or save an existing one with: " +
        `patchpage auth set --api-url ${DEFAULT_API_URL}\n`
    );
    // True whether or not the instance allows self-service minting yet: if it
    // does not, the refused-mint error on the first upload says so with its
    // own next action, so this copy never has to guess.
    expect(result.stderr).not.toContain("does not issue public tokens");
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

describe("patchpage status", () => {
  const packageVersion = (
    JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version: string }
  ).version;
  // Proving the probe never opens style.md needs a file it could not open.
  const canDenyReads = process.platform !== "win32" && process.getuid?.() !== 0;

  it("reports an unconfigured machine against the default instance", () => {
    const result = runCli(["status", "--json"]);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // The skill quotes these names, so the key set is part of the interface.
    expect(Object.keys(report)).toEqual([
      "instanceUrl",
      "instanceSource",
      "hasToken",
      "tokenSource",
      "stateDir",
      "hasDefaultStyle",
      "cliVersion"
    ]);
    expect(report).toEqual({
      instanceUrl: DEFAULT_API_URL,
      instanceSource: "default",
      hasToken: false,
      tokenSource: null,
      stateDir: result.stateDir,
      hasDefaultStyle: false,
      cliVersion: packageVersion
    });
    // A probe reports state; it never reports it as a failure.
    expect(existsSync(path.join(result.stateDir, "credentials.json"))).toBe(false);
  });

  it("names which link of the precedence chain chose the instance", () => {
    const stateDir = makeStateDir();
    const configUrl = "https://config.test";
    const environmentUrl = "https://environment.test";
    const flagUrl = "https://flag.test:8443";

    const byDefault = runCli(["status", "--json"], undefined, stateDir);
    writeFileSync(
      path.join(stateDir, "config.json"),
      `${JSON.stringify({ apiUrl: configUrl }, null, 2)}\n`
    );
    const byConfig = runCli(["status", "--json"], undefined, stateDir);
    const byEmptyEnvironment = runCli(["status", "--json"], undefined, stateDir, {
      PATCHPAGE_API_URL: ""
    });
    const byEnvironment = runCli(["status", "--json"], undefined, stateDir, {
      PATCHPAGE_API_URL: environmentUrl
    });
    // A trailing slash normalizes to the host key state is stored under.
    const byFlag = runCli(["status", "--json", "--api-url", `${flagUrl}/`], undefined, stateDir, {
      PATCHPAGE_API_URL: environmentUrl
    });

    const runs = [byDefault, byConfig, byEmptyEnvironment, byEnvironment, byFlag];
    expect(runs.map((run) => run.status)).toEqual([0, 0, 0, 0, 0]);
    expect(runs.map((run) => run.stderr)).toEqual(["", "", "", "", ""]);
    expect(runs.map((run) => statusReport(run.stdout))).toEqual([
      { instanceUrl: DEFAULT_API_URL, instanceSource: "default" },
      { instanceUrl: configUrl, instanceSource: "config" },
      // An empty environment variable means unset, exactly as it does elsewhere.
      { instanceUrl: configUrl, instanceSource: "config" },
      { instanceUrl: environmentUrl, instanceSource: "env" },
      { instanceUrl: flagUrl, instanceSource: "flag" }
    ]);
  });

  it("reports the stored token's source for the resolved instance only", () => {
    const stateDir = makeStateDir();
    const mintedUrl = "https://minted.test";
    const configuredUrl = "https://configured.test";
    const mintedToken = "pp_minted_secret";
    const configuredToken = "pp_configured_secret";
    writeFileSync(
      path.join(stateDir, "credentials.json"),
      `${JSON.stringify(
        {
          hosts: {
            [mintedUrl]: {
              token: mintedToken,
              updatedAt: "2026-08-14T00:00:00.000Z",
              source: "mint"
            },
            [configuredUrl]: {
              token: configuredToken,
              updatedAt: "2026-08-14T00:00:00.000Z",
              source: "auth-set"
            }
          }
        },
        null,
        2
      )}\n`
    );

    const minted = runCli(["status", "--json", "--api-url", mintedUrl], undefined, stateDir);
    const configured = runCli(
      ["status", "--json", "--api-url", configuredUrl],
      undefined,
      stateDir
    );
    const unknown = runCli(
      ["status", "--json", "--api-url", "https://unknown.test"],
      undefined,
      stateDir
    );

    const runs = [minted, configured, unknown];
    expect(runs.map((run) => run.status)).toEqual([0, 0, 0]);
    expect(runs.map((run) => tokenReport(run.stdout))).toEqual([
      { hasToken: true, tokenSource: "mint" },
      { hasToken: true, tokenSource: "auth-set" },
      // A neighbouring instance's token is never counted as this one's.
      { hasToken: false, tokenSource: null }
    ]);
    for (const run of runs) {
      expect(`${run.stdout}${run.stderr}`).not.toContain(mintedToken);
      expect(`${run.stdout}${run.stderr}`).not.toContain(configuredToken);
    }
  });

  it("counts an environment token as a token with no stored provenance", () => {
    const stateDir = makeStateDir();
    const environmentToken = "pp_environment_secret";
    const storedToken = "pp_stored_secret";
    writeFileSync(
      path.join(stateDir, "credentials.json"),
      hostKeyedCredentials({ [DEFAULT_API_URL]: storedToken })
    );

    const result = runCli(["status", "--json"], undefined, stateDir, {
      PATCHPAGE_API_TOKEN: environmentToken
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // The environment token is the one an upload would send, and it carries no
    // provenance, so the stored entry it outranks is not reported as its source.
    expect(tokenReport(result.stdout)).toEqual({ hasToken: true, tokenSource: null });
    expect(`${result.stdout}${result.stderr}`).not.toContain(environmentToken);
    expect(`${result.stdout}${result.stderr}`).not.toContain(storedToken);
  });

  it("stays answerable on credentials it cannot read", () => {
    const legacyStateDir = makeStateDir();
    writeFileSync(
      path.join(legacyStateDir, "credentials.json"),
      `${JSON.stringify({ apiToken: "pp_legacy_secret" }, null, 2)}\n`
    );
    const invalidStateDir = makeStateDir();
    writeFileSync(path.join(invalidStateDir, "credentials.json"), "not-json\n");
    const unreadableStateDir = makeStateDir();
    mkdirSync(path.join(unreadableStateDir, "credentials.json"));
    const invalidEntryStateDir = makeStateDir();
    writeFileSync(
      path.join(invalidEntryStateDir, "credentials.json"),
      `${JSON.stringify({ hosts: { [DEFAULT_API_URL]: { token: "" } } }, null, 2)}\n`
    );

    const runs = [legacyStateDir, invalidStateDir, unreadableStateDir, invalidEntryStateDir].map(
      (stateDir) => runCli(["status", "--json"], undefined, stateDir)
    );

    // Failing closed protects the commands that spend a token; the probe spends
    // nothing, so unreadable state is reported rather than raised.
    expect(runs.map((run) => run.status)).toEqual([0, 0, 0, 0]);
    expect(runs.map((run) => run.stderr)).toEqual(["", "", "", ""]);
    expect(runs.map((run) => tokenReport(run.stdout))).toEqual([
      { hasToken: false, tokenSource: null },
      { hasToken: false, tokenSource: null },
      { hasToken: false, tokenSource: null },
      { hasToken: false, tokenSource: null }
    ]);
    expect(runs.map((run) => run.stdout).join("")).not.toContain("pp_legacy_secret");
  });

  it("reports the default style by existence alone", () => {
    const beforeStateDir = makeStateDir();
    const afterStateDir = makeStateDir();
    writeFileSync(path.join(afterStateDir, "style.md"), "# Default style\n");

    const before = runCli(["status", "--json"], undefined, beforeStateDir);
    const after = runCli(["status", "--json"], undefined, afterStateDir);

    expect([before.status, after.status]).toEqual([0, 0]);
    expect([before.stderr, after.stderr]).toEqual(["", ""]);
    expect([styleReport(before), styleReport(after)]).toEqual([false, true]);
  });

  it.runIf(canDenyReads)("never opens the default style it reports", () => {
    const stateDir = makeStateDir();
    const stylePath = path.join(stateDir, "style.md");
    writeFileSync(stylePath, "# Unreadable style\n");
    chmodSync(stylePath, 0o000);

    const result = runCli(["status", "--json"], undefined, stateDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    // style.md is skill-owned: a file the CLI could not read is still a file
    // whose existence stops onboarding re-asking the style question.
    expect(styleReport(result)).toBe(true);
  });

  it("never reaches the instance it reports", async () => {
    const instance = await startUploadServer(createOnly("aaaabbbbcccc"));

    try {
      const reachable = await runCliAsync(["status", "--json", "--api-url", instance.apiUrl]);
      // Nothing listens on port 1; a probe that dialled out would fail here.
      const unroutable = runCli(["status", "--json", "--api-url", "http://127.0.0.1:1"]);

      expect(reachable.status).toBe(0);
      expect(reachable.stderr).toBe("");
      expect(statusReport(reachable.stdout)).toEqual({
        instanceUrl: instance.apiUrl,
        instanceSource: "flag"
      });
      expect(instance.requests).toEqual([]);

      expect(unroutable.status).toBe(0);
      expect(unroutable.stderr).toBe("");
      expect(statusReport(unroutable.stdout)).toEqual({
        instanceUrl: "http://127.0.0.1:1",
        instanceSource: "flag"
      });
    } finally {
      await instance.close();
    }
  });

  it("offers JSON as its only reporting format", () => {
    const result = runCli(["status"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("error: required option '--json' not specified\n");
  });

  it("documents itself as local-only in command help", () => {
    const result = runCli(["status", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Report local publishing state for the resolved instance. Never uses the network."
    );
    expect(result.stdout).toContain("--json           Print the report as JSON");
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

/** What a mint attempt saw, so a test can assert the pinned request shape. */
interface MintRequest {
  authorization: string | undefined;
  raw: string;
}

/** A mint reply is its own contract, not an upload reply that happens to fit. */
interface MintResponse {
  status: number;
  body: Record<string, unknown>;
}

type MintResponder = () => MintResponse;

/**
 * A hand-written loopback instance implementing the pinned self-service mint
 * route alongside uploads. Each returned server is a distinct host key because
 * it listens on its own port.
 */
async function startUploadServer(
  respond: (request: UploadRequest) => UploadResponse,
  mint: MintResponder = mintsToken(MINTED_TOKEN)
) {
  const requests: UploadRequest[] = [];
  const mints: MintRequest[] = [];
  const server = createServer(async (incoming, response) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk;

    const isMint = incoming.url === MINT_PATH;
    const { status, body } = isMint
      ? (mints.push({ authorization: incoming.headers.authorization, raw }), mint())
      : (() => {
          const request: UploadRequest = {
            authorization: incoming.headers.authorization,
            body: JSON.parse(raw) as Record<string, unknown>
          };
          requests.push(request);
          return respond(request);
        })();

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
    mints,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

/** The pinned 201: plaintext exactly once, alongside the AUP URL constant. */
function mintsToken(token: string): MintResponder {
  return () => ({ status: 201, body: { ok: true, token, aupUrl: AUP_URL } });
}

/** The pinned refusals, verbatim from the mint wire contract. */
function refusesMint(
  code: "self_service_disabled" | "mint_quota_exceeded" | "rate_limited",
  retryAfterSeconds?: number
): MintResponder {
  const status = code === "self_service_disabled" ? 403 : 429;
  return () => ({
    status,
    body: {
      ok: false,
      error: `Mint refused: ${code}.`,
      code,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
    }
  });
}

/**
 * The announcement paragraph, pinned byte-for-byte by the spec. Nothing that
 * is not spec text belongs in this string: folding extra copy in here would
 * let an ordinary edit masquerade as an edit of the pinned wording.
 */
function mintAnnouncement(apiUrl: string, stateDir: string): string {
  return (
    `Minted a new publishing token for ${apiUrl}; saved to ` +
    `${path.join(stateDir, "credentials.json")}. That file is the only key to these pages — ` +
    "copy it to another machine to publish from there with the same editing rights. If you've " +
    "published from another machine before, those pages belong to that machine's token — ask " +
    "your agent to help copy it over instead of using this new one.\n"
  );
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

/** The instance half of a status report, for comparing runs side by side. */
function statusReport(stdout: string): { instanceUrl: unknown; instanceSource: unknown } {
  const report = JSON.parse(stdout) as Record<string, unknown>;
  return { instanceUrl: report.instanceUrl, instanceSource: report.instanceSource };
}

function tokenReport(stdout: string): { hasToken: unknown; tokenSource: unknown } {
  const report = JSON.parse(stdout) as Record<string, unknown>;
  return { hasToken: report.hasToken, tokenSource: report.tokenSource };
}

function styleReport(result: { stdout: string }): unknown {
  return (JSON.parse(result.stdout) as Record<string, unknown>).hasDefaultStyle;
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
