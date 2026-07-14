import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageDir = path.join(repoRoot, "packages/cli");
const serverEntry = path.join(repoRoot, "apps/server/dist/start.js");
const npmCliEntry = path.join(repoRoot, "node_modules/npm/bin/npm-cli.js");
const bootstrapToken = "patchpage-packed-e2e-bootstrap-token";
const expectedViewerCsp = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "frame-src 'self' about:",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
const activeChildren = new Set();
const trackedProcessGroups = new Set();
const signalProbe = {
  target: process.env.PATCHPAGE_PACKED_CLI_E2E_SIGNAL_PROBE,
  childMarkerPath: process.env.PATCHPAGE_PACKED_CLI_E2E_SIGNAL_PROBE_CHILDREN,
  stubRunAfterSignal:
    process.env.PATCHPAGE_PACKED_CLI_E2E_SIGNAL_PROBE_STUB_RUN_AFTER_SIGNAL === "1",
  observedSignal: undefined
};
const lifecycleProbe = {
  mode: process.env.PATCHPAGE_PACKED_CLI_E2E_LIFECYCLE_PROBE,
  markerPath: process.env.PATCHPAGE_PACKED_CLI_E2E_LIFECYCLE_MARKER,
  cleanupCount: 0
};
let latchedSignal;
let latchedSignalExitCode;
let tempRoot;
let cleanupPromise;
let portReservation;
let serverProcess;
let serverProcessFailure;
let serverStdout = "";
let serverStderr = "";

if (process.argv[2] === "--signal-probes") {
  await runSignalProbes();
  process.exit(0);
}
if (process.argv[2] === "--platform-probes") {
  await runPlatformProbes();
  process.exit(0);
}
if (process.argv[2] === "--lifecycle-probes") {
  await runLifecycleProbes();
  process.exit(0);
}

class SignalAbort extends Error {
  constructor(signal) {
    super(`received ${signal}`);
    this.name = "SignalAbort";
    this.signal = signal;
  }
}

class ProbeComplete extends Error {
  constructor() {
    super("probe completed");
    this.name = "ProbeComplete";
  }
}

function latchSignal(signal) {
  if (latchedSignal) return;
  latchedSignal = signal;
  latchedSignalExitCode = 128 + os.constants.signals[signal];
  process.exitCode = latchedSignalExitCode;
  for (const child of activeChildren) terminateProcessGroup(child, "SIGTERM");
  terminateTrackedProcessGroups("SIGTERM");
}

function throwIfSignalLatched() {
  if (latchedSignal) throw new SignalAbort(latchedSignal);
}

async function checkedCall(operation) {
  throwIfSignalLatched();
  const result = await operation();
  throwIfSignalLatched();
  return result;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => latchSignal(signal));
}

let mainFailure;
try {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  assert.ok(nodeMajor >= 22, `packed CLI E2E requires Node 22 or newer; found ${process.version}`);

  await signalProbeCheckpoint("before-temp-creation");
  throwIfSignalLatched();
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "patchpage-packed-cli-e2e-"));
  throwIfSignalLatched();
  await signalProbeCheckpoint("after-temp-created");
  throwIfSignalLatched();
  const packDir = path.join(tempRoot, "pack");
  const consumerDir = path.join(tempRoot, "consumer");
  const serverStateDir = path.join(tempRoot, "server-state");
  const metadataPath = path.join(serverStateDir, "metadata.json");
  const objectDir = path.join(serverStateDir, "objects");
  const cliStateDir = path.join(tempRoot, "cli-state-authenticated");
  await checkedCall(() =>
    Promise.all([mkdir(packDir), mkdir(consumerDir), mkdir(serverStateDir), mkdir(cliStateDir)])
  );

  if (lifecycleProbe.mode === "server-spawn-error") {
    portReservation = await reserveLoopbackPort();
    const publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
    await startServer({ publicBaseUrl, metadataPath, objectDir });
    await waitForReady(`${publicBaseUrl}/healthz`);
    throw new Error("server spawn error probe unexpectedly reached readiness");
  }

  if (lifecycleProbe.mode === "term-orphaned-process-group") {
    await runTermOrphanedProcessGroupWorkload();
    throw new ProbeComplete();
  }

  if (signalProbe.target === "after-real-server-ready") {
    console.log("[packed-cli-e2e] building the real server for signal probe");
    await run("pnpm", ["--filter", "@patchpage/server...", "build"], { cwd: repoRoot });
    portReservation = await reserveLoopbackPort();
    const publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
    await startServer({ publicBaseUrl, metadataPath, objectDir });
    await waitForReady(`${publicBaseUrl}/healthz`);
    await signalProbeCheckpoint("after-real-server-ready", { publicBaseUrl });
    throw new Error("after-real-server signal probe unexpectedly resumed");
  }

  await signalProbeCheckpoint("before-first-child-spawn");
  throwIfSignalLatched();
  console.log("[packed-cli-e2e] building the real server");
  await run("pnpm", ["--filter", "@patchpage/server...", "build"], { cwd: repoRoot });

  console.log("[packed-cli-e2e] building CLI once");
  await run("pnpm", ["--filter", "patchpage", "build"], { cwd: repoRoot });

  console.log("[packed-cli-e2e] packing one exact tarball without rerunning prepack");
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    { cwd: cliPackageDir }
  );
  const packResult = parseNpmPackResult(packed.stdout);
  assert.equal(packResult.length, 1, "npm pack must produce exactly one artifact");

  const tarballs = (await checkedCall(() => readdir(packDir))).filter((entry) =>
    entry.endsWith(".tgz")
  );
  assert.deepEqual(tarballs, [packResult[0].filename], "npm pack must create one exact tarball");
  const packedFiles = new Set(packResult[0].files.map((file) => file.path));
  for (const requiredFile of [
    "dist/index.js",
    "skills/patchpage/SKILL.md",
    "LICENSE",
    "README.md"
  ]) {
    assert.ok(packedFiles.has(requiredFile), `packed CLI is missing ${requiredFile}`);
  }

  const tarballPath = path.join(packDir, tarballs[0]);
  console.log("[packed-cli-e2e] installing tarball in a clean consumer directory");
  await run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", tarballPath],
    { cwd: consumerDir, timeoutMs: 120_000 }
  );

  const cliPath = installedCliBinPath(consumerDir);
  await checkedCall(() => access(cliPath));
  const installedManifest = JSON.parse(
    await checkedCall(() =>
      readFile(path.join(consumerDir, "node_modules/patchpage/package.json"), "utf8")
    )
  );
  const version = await run(cliPath, ["--version"], { cwd: consumerDir });
  assert.equal(version.stdout.trim(), installedManifest.version);
  assert.notEqual(version.stdout.trim(), "0.0.0-dev");

  portReservation = await reserveLoopbackPort();
  const publicBaseUrl = `http://127.0.0.1:${portReservation.port}`;
  await startServer({
    publicBaseUrl,
    metadataPath,
    objectDir
  });
  await waitForReady(`${publicBaseUrl}/healthz`);
  await signalProbeCheckpoint("after-real-server-ready", { publicBaseUrl });

  const cliEnv = environment(
    {
      PATCHPAGE_STATE_DIR: cliStateDir
    },
    ["PATCHPAGE_API_TOKEN", "PATCHPAGE_API_URL"]
  );

  console.log("[packed-cli-e2e] configuring packed CLI auth through stdin");
  const auth = await runCli(cliPath, ["auth", "set", "--token-stdin", "--api-url", publicBaseUrl], {
    cwd: consumerDir,
    env: cliEnv,
    input: `${bootstrapToken}\n`
  });
  assert.equal(auth.stdout, "PatchPage credentials saved.\n");
  assert.equal(auth.stderr, "");
  assert.ok(!`${auth.stdout}${auth.stderr}`.includes(bootstrapToken), "token leaked in CLI output");

  const whoami = await runCli(cliPath, ["whoami"], {
    cwd: consumerDir,
    env: cliEnv
  });
  assert.match(whoami.stdout, /^Account: Bootstrap Account \(acct_bootstrap\)$/m);
  assert.match(whoami.stdout, /^API token: Bootstrap API Token \(tok_bootstrap\)$/m);
  assert.match(whoami.stdout, /^Scopes: admin, upload$/m);

  const fixturePath = path.join(consumerDir, "packed-contract.html");
  const firstHtml = validHtml("Packed contract v1", "packed-contract-version-one");
  const secondHtml = validHtml("Packed contract v2", "packed-contract-version-two");
  const newHtml = validHtml("Packed contract new draft", "packed-contract-new-draft");

  console.log("[packed-cli-e2e] exercising authenticated create, cached update, and --new");
  await checkedCall(() => writeFile(fixturePath, firstHtml, "utf8"));
  const first = parseUpload(
    await runCli(cliPath, ["upload", fixturePath], { cwd: consumerDir, env: cliEnv })
  );
  assert.equal(first.label, "Uploaded draft");
  assert.equal(first.versionNumber, 1);
  assert.equal(first.publicUrl, `${publicBaseUrl}/d/${first.draftId}`);

  await checkedCall(() => writeFile(fixturePath, secondHtml, "utf8"));
  const second = parseUpload(
    await runCli(cliPath, ["upload", fixturePath], { cwd: consumerDir, env: cliEnv })
  );
  assert.equal(second.label, "Updated draft");
  assert.equal(second.draftId, first.draftId);
  assert.equal(second.versionNumber, 2);

  await checkedCall(() => writeFile(fixturePath, newHtml, "utf8"));
  const fresh = parseUpload(
    await runCli(cliPath, ["upload", fixturePath, "--new"], {
      cwd: consumerDir,
      env: cliEnv
    })
  );
  assert.equal(fresh.label, "Uploaded draft");
  assert.equal(fresh.versionNumber, 1);
  assert.notEqual(fresh.draftId, first.draftId);

  console.log("[packed-cli-e2e] validating current and explicit public versions");
  const currentViewer = await fetchViewer(`${publicBaseUrl}/d/${first.draftId}`);
  assertViewer(currentViewer, first.draftId, 2, "packed-contract-version-two");
  assert.ok(!currentViewer.body.includes("packed-contract-version-one"));

  const firstVersionViewer = await fetchViewer(`${publicBaseUrl}/d/${first.draftId}/v/1`);
  assertViewer(firstVersionViewer, first.draftId, 1, "packed-contract-version-one");
  assert.ok(!firstVersionViewer.body.includes("packed-contract-version-two"));

  const secondVersionViewer = await fetchViewer(`${publicBaseUrl}/d/${first.draftId}/v/2`);
  assertViewer(secondVersionViewer, first.draftId, 2, "packed-contract-version-two");

  const freshViewer = await fetchViewer(fresh.publicUrl);
  assertViewer(freshViewer, fresh.draftId, 1, "packed-contract-new-draft");

  const metadata = await readMetadata(metadataPath);
  assert.equal(metadata.drafts.length, 2);
  assert.equal(metadata.draftVersions.length, 3);
  assert.equal(metadata.uploadEvents.length, 3);
  await assertStoredDraft(metadata, objectDir, {
    draftId: first.draftId,
    expectedHtmlByVersion: [firstHtml, secondHtml],
    accountId: "acct_bootstrap",
    apiTokenId: "tok_bootstrap"
  });
  await assertStoredDraft(metadata, objectDir, {
    draftId: fresh.draftId,
    expectedHtmlByVersion: [newHtml],
    accountId: "acct_bootstrap",
    apiTokenId: "tok_bootstrap"
  });

  console.log("[packed-cli-e2e] proving unsafe HTML and bad credentials cannot mutate state");
  const unsafeHtml =
    '<!doctype html><html><head><title>Unsafe</title></head><body><script>alert("no")</script></body></html>';
  const unsafeValidationStateDir = path.join(tempRoot, "cli-state-unsafe-validation");
  await checkedCall(() => mkdir(unsafeValidationStateDir));
  assert.deepEqual(await snapshotTree(unsafeValidationStateDir), []);
  await checkedCall(() => writeFile(fixturePath, unsafeHtml, "utf8"));
  await assertCliFailureNoMutation({
    cliPath,
    args: ["upload", fixturePath],
    cwd: consumerDir,
    env: environment({
      PATCHPAGE_STATE_DIR: unsafeValidationStateDir,
      PATCHPAGE_API_URL: publicBaseUrl
    }),
    cliStateDir: unsafeValidationStateDir,
    metadataPath,
    objectDir,
    expectAuthoritativeNonEmpty: true,
    expectEmptyCliState: true,
    stderr: /Blocked <script> tag found\./
  });

  await checkedCall(() =>
    writeFile(fixturePath, validHtml("Invalid env", "invalid-env-must-not-persist"), "utf8")
  );
  await assertCliFailureNoMutation({
    cliPath,
    args: ["upload", fixturePath],
    cwd: consumerDir,
    env: { ...cliEnv, PATCHPAGE_API_TOKEN: "invalid-env-credential" },
    cliStateDir,
    metadataPath,
    objectDir,
    sensitiveValues: ["invalid-env-credential"],
    stderr: /Missing or invalid API token\./
  });

  const invalidStoredStateDir = path.join(tempRoot, "cli-state-invalid-stored");
  await checkedCall(() => mkdir(invalidStoredStateDir));
  const invalidStoredToken = "invalid-stored-credential";
  await runCli(cliPath, ["auth", "set", "--token-stdin", "--api-url", publicBaseUrl], {
    cwd: consumerDir,
    env: environment({ PATCHPAGE_STATE_DIR: invalidStoredStateDir }, ["PATCHPAGE_API_TOKEN"]),
    input: `${invalidStoredToken}\n`,
    sensitiveValues: [invalidStoredToken]
  });
  const invalidStoredEnv = environment({ PATCHPAGE_STATE_DIR: invalidStoredStateDir }, [
    "PATCHPAGE_API_TOKEN",
    "PATCHPAGE_API_URL"
  ]);
  await assertCliFailureNoMutation({
    cliPath,
    args: ["upload", fixturePath],
    cwd: consumerDir,
    env: invalidStoredEnv,
    cliStateDir: invalidStoredStateDir,
    metadataPath,
    objectDir,
    sensitiveValues: [invalidStoredToken],
    stderr: /Missing or invalid API token\./
  });

  console.log("[packed-cli-e2e] exercising automatic and explicit anonymous creation");
  const anonymousStateDir = path.join(tempRoot, "cli-state-anonymous");
  await checkedCall(() => mkdir(anonymousStateDir));
  const anonymousEnv = environment({ PATCHPAGE_STATE_DIR: anonymousStateDir }, [
    "PATCHPAGE_API_TOKEN",
    "PATCHPAGE_API_URL"
  ]);
  const anonymousHtml = validHtml("Anonymous same path", "anonymous-same-path");
  await checkedCall(() => writeFile(fixturePath, anonymousHtml, "utf8"));
  const automaticAnonymousOne = parseUpload(
    await runCli(cliPath, ["upload", fixturePath, "--api-url", publicBaseUrl], {
      cwd: consumerDir,
      env: anonymousEnv
    })
  );
  const automaticAnonymousTwo = parseUpload(
    await runCli(cliPath, ["upload", fixturePath, "--api-url", publicBaseUrl], {
      cwd: consumerDir,
      env: anonymousEnv
    })
  );
  assert.notEqual(automaticAnonymousOne.draftId, automaticAnonymousTwo.draftId);
  assert.equal(automaticAnonymousOne.versionNumber, 1);
  assert.equal(automaticAnonymousTwo.versionNumber, 1);
  assert.deepEqual(await snapshotTree(anonymousStateDir), []);

  const authenticatedCacheBeforeAnonymous = await checkedCall(() =>
    readFile(path.join(cliStateDir, "drafts.json"), "utf8")
  );
  const explicitAnonymousHtml = validHtml(
    "Explicit anonymous",
    "explicit-anonymous-bypassed-valid-credential"
  );
  await checkedCall(() => writeFile(fixturePath, explicitAnonymousHtml, "utf8"));
  const explicitAnonymous = parseUpload(
    await runCli(cliPath, ["upload", fixturePath, "--anonymous"], {
      cwd: consumerDir,
      env: { ...cliEnv, PATCHPAGE_API_TOKEN: bootstrapToken }
    })
  );
  assert.equal(explicitAnonymous.label, "Uploaded draft");
  assert.equal(explicitAnonymous.versionNumber, 1);
  assert.notEqual(explicitAnonymous.draftId, first.draftId);
  assert.notEqual(explicitAnonymous.draftId, fresh.draftId);
  assert.notEqual(explicitAnonymous.draftId, automaticAnonymousOne.draftId);
  assert.notEqual(explicitAnonymous.draftId, automaticAnonymousTwo.draftId);
  assert.equal(
    await checkedCall(() => readFile(path.join(cliStateDir, "drafts.json"), "utf8")),
    authenticatedCacheBeforeAnonymous
  );
  const metadataAfterExplicitAnonymous = await readMetadata(metadataPath);
  await assertStoredDraft(metadataAfterExplicitAnonymous, objectDir, {
    draftId: explicitAnonymous.draftId,
    expectedHtmlByVersion: [explicitAnonymousHtml],
    accountId: "acct_anonymous",
    apiTokenId: "tok_anonymous"
  });

  console.log("[packed-cli-e2e] proving environment credentials override stored credentials");
  const envPrecedenceHtml = validHtml(
    "Environment precedence",
    "valid-env-overrode-invalid-stored"
  );
  await checkedCall(() => writeFile(fixturePath, envPrecedenceHtml, "utf8"));
  const envPrecedence = parseUpload(
    await runCli(cliPath, ["upload", fixturePath], {
      cwd: consumerDir,
      env: { ...invalidStoredEnv, PATCHPAGE_API_TOKEN: bootstrapToken }
    })
  );

  const finalMetadata = await readMetadata(metadataPath);
  assert.equal(finalMetadata.drafts.length, 6);
  assert.equal(finalMetadata.draftVersions.length, 7);
  assert.equal(finalMetadata.uploadEvents.length, 7);
  for (const anonymousUpload of [automaticAnonymousOne, automaticAnonymousTwo]) {
    await assertStoredDraft(finalMetadata, objectDir, {
      draftId: anonymousUpload.draftId,
      expectedHtmlByVersion: [anonymousHtml],
      accountId: "acct_anonymous",
      apiTokenId: "tok_anonymous"
    });
  }
  await assertStoredDraft(finalMetadata, objectDir, {
    draftId: explicitAnonymous.draftId,
    expectedHtmlByVersion: [explicitAnonymousHtml],
    accountId: "acct_anonymous",
    apiTokenId: "tok_anonymous"
  });
  await assertStoredDraft(finalMetadata, objectDir, {
    draftId: envPrecedence.draftId,
    expectedHtmlByVersion: [envPrecedenceHtml],
    accountId: "acct_bootstrap",
    apiTokenId: "tok_bootstrap"
  });
  assert.equal((await snapshotTree(objectDir)).length, 7);

  console.log("[packed-cli-e2e] PASS: complete packed CLI real-server contract");
} catch (error) {
  if (!(error instanceof ProbeComplete)) mainFailure = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    mainFailure ??= error;
  }
}
if (latchedSignal) process.exit(latchedSignalExitCode);
if (mainFailure) throw mainFailure;

async function runSignalProbes() {
  const probes = [
    { checkpoint: "before-temp-creation", signal: "SIGINT", expectedCode: 130 },
    { checkpoint: "after-temp-created", signal: "SIGTERM", expectedCode: 143 },
    {
      checkpoint: "before-first-child-spawn",
      signal: "SIGTERM",
      expectedCode: 143,
      stubRunAfterSignal: true
    },
    { checkpoint: "after-real-server-ready", signal: "SIGINT", expectedCode: 130 }
  ];

  for (const probe of probes) {
    await runSignalProbe(probe);
    console.log(`[signal-probe] PASS ${probe.checkpoint} ${probe.signal}`);
  }
}

async function runPlatformProbes() {
  const fakePnpmEntry = path.win32.join("C:\\tools", "pnpm", "pnpm.cjs");
  const winEnv = sanitizedProcessEnv({
    PATH: "C:\\Windows\\System32",
    PATCHPAGE_API_TOKEN: "ambient-token",
    PATCHPAGE_UNKNOWN_POISON: "ambient-poison",
    npm_execpath: fakePnpmEntry
  });

  const npmInvocation = resolveSpawnInvocation("npm", ["pack"], {
    platform: "win32",
    env: winEnv
  });
  assert.equal(npmInvocation.command, process.execPath);
  assert.deepEqual(npmInvocation.args, [npmCliEntry, "pack"]);

  const pnpmInvocation = resolveSpawnInvocation("pnpm", ["--filter", "patchpage", "build"], {
    platform: "win32",
    env: winEnv
  });
  assert.equal(pnpmInvocation.command, process.execPath);
  assert.deepEqual(pnpmInvocation.args, [fakePnpmEntry, "--filter", "patchpage", "build"]);

  const winCliBin = path.win32.join(
    "C:\\workspace",
    "consumer",
    "node_modules",
    ".bin",
    "patchpage.cmd"
  );
  const winCliInvocation = resolveSpawnInvocation(winCliBin, ["--version"], {
    platform: "win32",
    env: winEnv
  });
  assert.equal(winCliInvocation.command, process.execPath);
  assert.deepEqual(winCliInvocation.args, [
    path.win32.join("C:\\workspace", "consumer", "node_modules", "patchpage", "dist", "index.js"),
    "--version"
  ]);

  const posixCliBin = "/tmp/consumer/node_modules/.bin/patchpage";
  const posixCliInvocation = resolveSpawnInvocation(posixCliBin, ["--version"], {
    platform: "linux",
    env: sanitizedProcessEnv()
  });
  assert.equal(posixCliInvocation.command, posixCliBin);
  assert.deepEqual(posixCliInvocation.args, ["--version"]);

  assert.equal(winEnv.PATCHPAGE_API_TOKEN, undefined);
  assert.equal(winEnv.PATCHPAGE_UNKNOWN_POISON, undefined);
  assert.equal(winEnv.PATH, "C:\\Windows\\System32");

  assert.throws(
    () => resolveSpawnInvocation("pnpm", ["--version"], { platform: "win32", env: {} }),
    /npm_execpath/
  );

  console.log("[platform-probe] PASS win32 command resolution and PATCHPAGE env stripping");
}

async function runLifecycleProbes() {
  const probes = [
    {
      mode: "server-spawn-error",
      expectFailure: true,
      expectedStderr: /patchpage-packed-cli-e2e-missing-server-spawn|ENOENT/
    },
    {
      mode: "term-orphaned-process-group",
      expectFailure: false
    }
  ];

  for (const probe of probes) {
    await runLifecycleProbe(probe);
    console.log(`[lifecycle-probe] PASS ${probe.mode}`);
  }
}

async function runLifecycleProbe(probe) {
  const beforeTempRoots = await listPackedCliTempRoots();
  const markerPath = path.join(
    os.tmpdir(),
    `patchpage-packed-cli-e2e-lifecycle-probe-${process.pid}-${probe.mode}.jsonl`
  );
  await rm(markerPath, { force: true });

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATCHPAGE_PACKED_CLI_E2E_LIFECYCLE_PROBE: probe.mode,
      PATCHPAGE_PACKED_CLI_E2E_LIFECYCLE_MARKER: markerPath
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let result;
  let records = [];
  let events = [];
  let leakFailures;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseLifecycleProbeEvent(line);
      if (event) events.push(event);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    result = await waitForProbeChild(child, probe.timeoutMs ?? 60_000);
    records = await readJsonlRecords(markerPath);
    leakFailures = await collectLifecycleProbeLeaks({
      beforeTempRoots,
      records,
      events
    });

    const cleanupStarts = records.filter((record) => record.type === "cleanup-start");
    const cleanupEnds = records.filter((record) => record.type === "cleanup-end");
    assert.equal(
      cleanupStarts.length,
      1,
      `${probe.mode} should start cleanup exactly once\nrecords:\n${JSON.stringify(records, null, 2)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.equal(
      cleanupEnds.length,
      1,
      `${probe.mode} should finish cleanup exactly once\nrecords:\n${JSON.stringify(records, null, 2)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.deepEqual(cleanupStarts.map((record) => record.count), [1]);
    assert.deepEqual(cleanupEnds.map((record) => record.count), [1]);

    if (probe.expectFailure) {
      assert.notEqual(
        result.code,
        0,
        `${probe.mode} should reject main\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
      assert.match(stderr, probe.expectedStderr);
    } else {
      assert.equal(
        result.code,
        0,
        `${probe.mode} should exit cleanly after cleanup\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }

    assert.deepEqual(
      leakFailures.messages,
      [],
      `${probe.mode} leaked state:\n${leakFailures.messages.join("\n")}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    const cleanupRecords = records.length > 0 ? records : await readJsonlRecords(markerPath);
    const cleanupEvents = events;
    await emergencyCleanupLifecycleProbe({
      markerPath,
      records: cleanupRecords,
      events: cleanupEvents,
      leakedTempRoots: leakFailures?.newTempRoots ?? []
    });
  }
}

async function runSignalProbe(probe) {
  const beforeTempRoots = await listPackedCliTempRoots();
  const markerPath = path.join(
    os.tmpdir(),
    `patchpage-packed-cli-e2e-signal-probe-${process.pid}-${probe.checkpoint}.jsonl`
  );
  await rm(markerPath, { force: true });

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATCHPAGE_PACKED_CLI_E2E_SIGNAL_PROBE: probe.checkpoint,
      PATCHPAGE_PACKED_CLI_E2E_SIGNAL_PROBE_CHILDREN: markerPath,
      ...(probe.stubRunAfterSignal
        ? { PATCHPAGE_PACKED_CLI_E2E_SIGNAL_PROBE_STUB_RUN_AFTER_SIGNAL: "1" }
        : {})
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  let stdout = "";
  let stderr = "";
  let signaled = false;
  let checkpointDetails = {};
  let lineBuffer = "";
  let result;
  let childRecords = [];
  let leakFailures;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSignalProbeEvent(line);
      if (event?.checkpoint === probe.checkpoint && !signaled) {
        signaled = true;
        checkpointDetails = event.details ?? {};
        child.kill(probe.signal);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    result = await waitForProbeChild(child, probe.timeoutMs ?? 180_000);
    childRecords = await readSignalProbeChildRecords(markerPath);
    leakFailures = await collectSignalProbeLeaks({
      beforeTempRoots,
      childRecords,
      checkpointDetails
    });

    assert.ok(
      signaled,
      `${probe.checkpoint} did not reach its signal checkpoint\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.equal(
      result.code,
      probe.expectedCode,
      `${probe.checkpoint} ${probe.signal} should exit ${probe.expectedCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.deepEqual(
      leakFailures.messages,
      [],
      `${probe.checkpoint} ${probe.signal} leaked state:\n${leakFailures.messages.join("\n")}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  } finally {
    const cleanupRecords = childRecords.length > 0 ? childRecords : await readJsonlRecords(markerPath);
    await cleanupSignalProbeArtifacts(
      markerPath,
      cleanupRecords,
      leakFailures?.newTempRoots ?? []
    );
  }
}

function parseSignalProbeEvent(line) {
  const prefix = "__PATCHPAGE_SIGNAL_PROBE__";
  if (!line.startsWith(prefix)) return undefined;
  return JSON.parse(line.slice(prefix.length));
}

function parseLifecycleProbeEvent(line) {
  const prefix = "__PATCHPAGE_LIFECYCLE_PROBE__";
  if (!line.startsWith(prefix)) return undefined;
  return JSON.parse(line.slice(prefix.length));
}

async function waitForProbeChild(child, timeoutMs) {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.ok(!timedOut, `signal probe timed out after ${timeoutMs}ms`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function collectLifecycleProbeLeaks({ beforeTempRoots, records, events }) {
  await delay(300);
  const afterTempRoots = await listPackedCliTempRoots();
  const newTempRoots = afterTempRoots.filter((entry) => !beforeTempRoots.includes(entry));
  const messages = [];
  if (newTempRoots.length > 0) {
    messages.push(`new temp roots remained: ${newTempRoots.join(", ")}`);
  }

  const descendantEvents = events.filter((event) => event.type === "descendant-ready");
  for (const event of descendantEvents) {
    if (Number.isInteger(event.launcherPid) && isProcessGroupAlive(event.launcherPid)) {
      messages.push(`process group ${event.launcherPid} remained alive`);
    }
    if (Number.isInteger(event.descendantPid) && isPidAlive(event.descendantPid)) {
      messages.push(`descendant process ${event.descendantPid} remained alive`);
    }
    if (Number.isInteger(event.port) && (await isTcpPortOpen(event.port))) {
      messages.push(`descendant port ${event.port} remained open`);
    }
  }

  for (const record of records) {
    if (record.type === "cleanup-end" && record.tempRoot) {
      const tempRootName = path.basename(record.tempRoot);
      if (afterTempRoots.includes(tempRootName)) {
        messages.push(`cleanup temp root remained: ${tempRootName}`);
      }
    }
  }

  return { messages, newTempRoots };
}

async function emergencyCleanupLifecycleProbe({ markerPath, records, events, leakedTempRoots }) {
  for (const event of events) {
    if (Number.isInteger(event.launcherPid) && process.platform !== "win32") {
      terminatePosixProcessGroup(event.launcherPid, "SIGKILL");
    }
    if (Number.isInteger(event.descendantPid)) {
      try {
        process.kill(event.descendantPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  for (const record of records) {
    if (record.type === "cleanup-end" && record.tempRoot) {
      await rm(record.tempRoot, { recursive: true, force: true });
    }
  }
  for (const tempRootName of leakedTempRoots) {
    await rm(path.join(os.tmpdir(), tempRootName), { recursive: true, force: true });
  }
  await rm(markerPath, { force: true });
}

async function collectSignalProbeLeaks({ beforeTempRoots, childRecords, checkpointDetails }) {
  await delay(300);
  const afterTempRoots = await listPackedCliTempRoots();
  const newTempRoots = afterTempRoots.filter((entry) => !beforeTempRoots.includes(entry));
  const messages = [];
  if (newTempRoots.length > 0) {
    messages.push(`new temp roots remained: ${newTempRoots.join(", ")}`);
  }

  const ports = new Set();
  if (checkpointDetails.publicBaseUrl) {
    ports.add(Number(new URL(checkpointDetails.publicBaseUrl).port));
  }
  for (const record of childRecords) {
    if (Number.isInteger(record.port)) ports.add(record.port);
    if (Number.isInteger(record.pid) && isProcessGroupAlive(record.pid)) {
      messages.push(`${record.type ?? "child"} process group ${record.pid} remained alive`);
    }
  }
  for (const port of ports) {
    if (await isTcpPortOpen(port)) messages.push(`server/sentinel port ${port} remained open`);
  }

  return { messages, newTempRoots };
}

async function cleanupSignalProbeArtifacts(markerPath, childRecords, leakedTempRoots) {
  for (const record of childRecords) {
    if (Number.isInteger(record.pid)) {
      try {
        process.kill(process.platform === "win32" ? record.pid : -record.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }
  for (const tempRootName of leakedTempRoots) {
    await rm(path.join(os.tmpdir(), tempRootName), { recursive: true, force: true });
  }
  await rm(markerPath, { force: true });
}

async function readSignalProbeChildRecords(markerPath) {
  return readJsonlRecords(markerPath);
}

async function readJsonlRecords(markerPath) {
  let raw;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runTermOrphanedProcessGroupWorkload() {
  assert.ok(lifecycleProbe.markerPath, "term orphan lifecycle probe requires a marker path");
  const launcher = spawn(process.execPath, ["-e", termOrphanLauncherScript(), lifecycleProbe.markerPath], {
    cwd: repoRoot,
    env: sanitizedProcessEnv(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
    shell: false
  });
  const launcherLifecycle = observeSpawnedChild(launcher);
  launcherLifecycle.errorPromise.catch(() => {});
  activeChildren.add(launcher);
  trackProcessGroup(launcher);

  let launcherStderr = "";
  launcher.stderr.setEncoding("utf8");
  launcher.stderr.on("data", (chunk) => {
    launcherStderr += chunk;
  });

  const descendant = await waitForJsonlRecord(
    lifecycleProbe.markerPath,
    (record) => record.type === "descendant-ready",
    5_000
  );
  console.log(
    `__PATCHPAGE_LIFECYCLE_PROBE__${JSON.stringify({
      type: "descendant-ready",
      launcherPid: launcher.pid,
      descendantPid: descendant.pid,
      port: descendant.port,
      tempRootName: path.basename(tempRoot)
    })}`
  );
  assert.equal(launcherStderr, "");
  await cleanup();
}

function termOrphanLauncherScript() {
  const descendantScript = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const marker = process.argv[1];",
    "process.on('SIGTERM', () => {});",
    "const server = net.createServer();",
    "server.listen(0, '127.0.0.1', () => {",
    "  fs.appendFileSync(marker, JSON.stringify({ type: 'descendant-ready', pid: process.pid, port: server.address().port }) + '\\n');",
    "});",
    "setInterval(() => {}, 1000);"
  ].join("\n");

  return [
    "const { spawn } = require('node:child_process');",
    "const marker = process.argv[1];",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}, marker], { stdio: 'ignore', detached: false });`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);"
  ].join("\n");
}

async function waitForJsonlRecord(markerPath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await readJsonlRecords(markerPath);
    const record = records.find(predicate);
    if (record) return record;
    await delay(50);
  }
  throw new Error(`timed out waiting for lifecycle probe record in ${markerPath}`);
}

async function listPackedCliTempRoots() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("patchpage-packed-cli-e2e-"))
    .map((entry) => entry.name)
    .sort();
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function isTcpPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function signalProbeCheckpoint(checkpoint, details = {}) {
  if (signalProbe.target !== checkpoint) return;
  console.log(
    `__PATCHPAGE_SIGNAL_PROBE__${JSON.stringify({ checkpoint, details, pid: process.pid })}`
  );
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (signal) => {
        if (resolved) return;
        resolved = true;
        signalProbe.observedSignal = signal;
        resolve();
      };
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => resolveOnce(signal));
      }
    });
  } finally {
    clearInterval(keepAlive);
  }
  throwIfSignalLatched();
}

async function recordSignalProbeChild(record) {
  if (!signalProbe.childMarkerPath) return;
  await appendFile(signalProbe.childMarkerPath, `${JSON.stringify(record)}\n`);
}

async function recordLifecycleProbe(record) {
  if (!lifecycleProbe.markerPath) return;
  await appendFile(lifecycleProbe.markerPath, `${JSON.stringify(record)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validHtml(title, marker) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${marker}</h1></body></html>`;
}

function parseNpmPackResult(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed;
  assert.ok(parsed && typeof parsed === "object", `unexpected npm pack JSON: ${stdout}`);
  return Object.values(parsed);
}

async function reserveLoopbackPort() {
  throwIfSignalLatched();
  const server = createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    if (latchedSignal) {
      await new Promise((resolve) => server.close(() => resolve()));
      throwIfSignalLatched();
    }
  } catch (error) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw error;
  }
  throwIfSignalLatched();
  const address = server.address();
  assert.ok(address && typeof address === "object", "failed to reserve an ephemeral port");
  return { server, port: address.port };
}

async function startServer({ publicBaseUrl, metadataPath, objectDir }) {
  throwIfSignalLatched();
  await access(serverEntry);
  throwIfSignalLatched();
  assert.ok(portReservation, "loopback port must be reserved before server launch");
  await new Promise((resolve, reject) => {
    portReservation.server.close((error) => (error ? reject(error) : resolve()));
  });
  portReservation = undefined;
  throwIfSignalLatched();

  const serverEnv = environment(
    {
      PORT: new URL(publicBaseUrl).port,
      PATCHPAGE_PUBLIC_BASE_URL: publicBaseUrl,
      PATCHPAGE_BOOTSTRAP_API_TOKEN: bootstrapToken,
      PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS: "true",
      PATCHPAGE_MAX_HTML_BYTES: String(512 * 1024),
      PATCHPAGE_DB_DRIVER: "json",
      PATCHPAGE_DB_FILE: metadataPath,
      PATCHPAGE_STORAGE_DRIVER: "filesystem",
      PATCHPAGE_STORAGE_DIR: objectDir,
      PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE: "10000",
      PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE: "10000",
      PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE: "10000"
    },
    [
      "DATABASE_URL",
      "PATCHPAGE_TRUST_PROXY",
      "AZURE_STORAGE_ACCOUNT",
      "AZURE_STORAGE_CONTAINER",
      "AZURE_STORAGE_CONNECTION_STRING"
    ]
  );

  throwIfSignalLatched();
  console.log(`[packed-cli-e2e] launching real server at ${publicBaseUrl}`);
  const serverInvocation = resolveSpawnInvocation(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: serverEnv
  });
  serverProcess = spawn(serverInvocation.command, serverInvocation.args, {
    cwd: repoRoot,
    env: serverEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  const serverLifecycle = observeSpawnedChild(serverProcess);
  serverLifecycle.errorPromise.catch((error) => {
    serverProcessFailure = error;
  });
  activeChildren.add(serverProcess);
  trackProcessGroup(serverProcess);
  await recordSignalProbeChild({
    type: "server",
    pid: serverProcess.pid,
    port: Number(new URL(publicBaseUrl).port)
  });
  throwIfSignalLatched();
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stdout.on("data", (chunk) => {
    serverStdout += chunk;
  });
  serverProcess.stderr.on("data", (chunk) => {
    serverStderr += chunk;
  });
  serverProcess.once("close", () => {
    activeChildren.delete(serverProcess);
    releaseTrackedProcessGroupIfEmpty(serverProcess);
  });
  await Promise.race([
    serverLifecycle.errorPromise,
    new Promise((resolve) => setImmediate(resolve))
  ]);
}

async function waitForReady(healthUrl) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    throwIfSignalLatched();
    if (serverProcessFailure) throw serverProcessFailure;
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
      throwIfSignalLatched();
      throw new Error(
        `server exited before readiness (${serverProcess.exitCode ?? serverProcess.signalCode})${serverDiagnostics()}`
      );
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(750) });
      const body = await response.json();
      if (response.status === 200 && body?.ok === true) return;
      lastError = new Error(`health returned ${response.status}: ${JSON.stringify(body)}`);
    } catch (error) {
      lastError = error;
    }
    throwIfSignalLatched();
    await new Promise((resolve) => setTimeout(resolve, 100));
    throwIfSignalLatched();
  }
  throwIfSignalLatched();
  throw new Error(
    `server readiness timed out: ${lastError?.message ?? "no response"}${serverDiagnostics()}`
  );
}

function serverDiagnostics() {
  return `\nserver stdout:\n${redactSensitive(serverStdout, [bootstrapToken]) || "<empty>"}\nserver stderr:\n${redactSensitive(serverStderr, [bootstrapToken]) || "<empty>"}`;
}

async function runCli(cliPath, args, options) {
  const sensitiveValues = [bootstrapToken, ...(options.sensitiveValues ?? [])].filter(Boolean);
  assert.ok(
    args.every((argument) =>
      sensitiveValues.every((sensitiveValue) => !argument.includes(sensitiveValue))
    ),
    "API tokens must never appear in CLI argv"
  );
  const result = await run(cliPath, args, { ...options, sensitiveValues });
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(
    sensitiveValues.every((sensitiveValue) => !output.includes(sensitiveValue)),
    "sensitive value leaked in CLI output"
  );
  return result;
}

async function assertCliFailureNoMutation({
  cliPath,
  args,
  cwd,
  env,
  cliStateDir,
  metadataPath,
  objectDir,
  expectAuthoritativeNonEmpty = false,
  expectEmptyCliState = false,
  sensitiveValues = [],
  stderr
}) {
  const authoritativeBefore = await authoritativeSnapshot(metadataPath, objectDir);
  const cliStateBefore = await snapshotTree(cliStateDir);
  if (expectAuthoritativeNonEmpty) {
    assertAuthoritativeSnapshotNonEmpty(authoritativeBefore);
  }
  if (expectEmptyCliState) {
    assert.deepEqual(cliStateBefore, [], "expected dedicated CLI state to start empty");
  }
  const result = await runCli(cliPath, args, {
    cwd,
    env,
    allowFailure: true,
    sensitiveValues
  });
  assert.notEqual(result.code, 0, "expected packed CLI invocation to fail");
  assert.match(result.stderr, stderr);
  assert.deepEqual(
    await authoritativeSnapshot(metadataPath, objectDir),
    authoritativeBefore,
    "failed CLI invocation mutated server metadata or object storage"
  );
  assert.deepEqual(
    await snapshotTree(cliStateDir),
    expectEmptyCliState ? [] : cliStateBefore,
    expectEmptyCliState
      ? "failed CLI invocation created CLI state"
      : "failed CLI invocation mutated CLI state"
  );
}

async function authoritativeSnapshot(metadataPath, objectDir) {
  return {
    metadata: await readFile(metadataPath, "utf8"),
    objects: await snapshotTree(objectDir)
  };
}

function assertAuthoritativeSnapshotNonEmpty(snapshot) {
  const metadata = JSON.parse(snapshot.metadata);
  assert.ok(metadata.drafts.length > 0, "expected existing authoritative drafts before failure");
  assert.ok(snapshot.objects.length > 0, "expected existing authoritative objects before failure");
}

async function snapshotTree(rootDir) {
  const files = [];
  await visit(rootDir, "");
  return files;

  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push([relativePath, await readFile(absolutePath, "utf8")]);
      } else {
        throw new Error(`unexpected non-file storage entry: ${absolutePath}`);
      }
    }
  }
}

function parseUpload(result) {
  const label = result.stdout.match(/^(Uploaded draft|Updated draft)$/m)?.[1];
  const publicUrl = result.stdout.match(/^URL: (.+)$/m)?.[1];
  const draftId = result.stdout.match(/^Draft ID: ([a-z0-9]{12})$/m)?.[1];
  const versionNumber = Number(result.stdout.match(/^Version: (\d+)$/m)?.[1]);
  assert.ok(label, `missing upload label in CLI output:\n${result.stdout}`);
  assert.ok(publicUrl, `missing public URL in CLI output:\n${result.stdout}`);
  assert.ok(draftId, `missing draft ID in CLI output:\n${result.stdout}`);
  assert.ok(Number.isInteger(versionNumber), `missing version in CLI output:\n${result.stdout}`);
  return { label, publicUrl, draftId, versionNumber };
}

async function fetchViewer(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  return { response, body: await response.text() };
}

function assertViewer(viewer, draftId, versionNumber, marker) {
  assert.equal(viewer.response.status, 200);
  assert.equal(viewer.response.headers.get("content-security-policy"), expectedViewerCsp);
  assert.equal(viewer.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(viewer.response.headers.get("cache-control"), "no-store");
  assert.equal(viewer.response.headers.get("content-type"), "text/html");
  assert.ok(viewer.body.includes('sandbox=""'), "viewer iframe lost its empty sandbox");
  assert.ok(
    viewer.body.includes('referrerpolicy="no-referrer"'),
    "viewer iframe lost its no-referrer policy"
  );
  assert.ok(viewer.body.includes(marker), `viewer is missing ${marker}`);
  assert.ok(
    viewer.body.includes(`<!-- draft:${draftId} version:${versionNumber} -->`),
    "viewer rendered the wrong draft version"
  );
}

async function readMetadata(metadataPath) {
  return JSON.parse(await readFile(metadataPath, "utf8"));
}

async function assertStoredDraft(
  metadata,
  objectDir,
  { draftId, expectedHtmlByVersion, accountId, apiTokenId }
) {
  const draft = metadata.drafts.find((candidate) => candidate.id === draftId);
  assert.ok(draft, `metadata is missing draft ${draftId}`);
  assert.equal(draft.accountId, accountId);

  const versions = metadata.draftVersions
    .filter((version) => version.draftId === draftId)
    .sort((left, right) => left.versionNumber - right.versionNumber);
  assert.equal(versions.length, expectedHtmlByVersion.length);
  assert.equal(draft.currentVersionId, versions.at(-1).id);

  for (let index = 0; index < versions.length; index += 1) {
    const version = versions[index];
    assert.equal(version.versionNumber, index + 1);
    assert.equal(version.createdByApiTokenId, apiTokenId);
    assert.equal(
      await readFile(path.join(objectDir, version.objectKey), "utf8"),
      expectedHtmlByVersion[index]
    );
  }
}

function environment(overrides, unset = []) {
  const env = sanitizedProcessEnv();
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  for (const name of unset) delete env[name];
  return env;
}

function sanitizedProcessEnv(source = process.env) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith("PATCHPAGE_")) delete env[name];
  }
  return env;
}

async function run(command, args, options = {}) {
  throwIfSignalLatched();
  const probeCommand = signalProbe.stubRunAfterSignal && signalProbe.observedSignal;
  const effectiveCommand = probeCommand ? process.execPath : command;
  const effectiveArgs = probeCommand
    ? [
        "-e",
        [
          "const fs = require('node:fs');",
          "const net = require('node:net');",
          "const marker = process.env.PATCHPAGE_PACKED_CLI_E2E_SENTINEL_MARKER;",
          "const server = net.createServer();",
          "server.listen(0, '127.0.0.1', () => {",
          "  const port = server.address().port;",
          "  fs.appendFileSync(marker, JSON.stringify({ type: 'sentinel', pid: process.pid, port }) + '\\n');",
          "});",
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));",
          "setInterval(() => {}, 1000);"
        ].join("\n")
      ]
    : args;
  const effectiveEnv = probeCommand
    ? {
        ...(options.env ?? sanitizedProcessEnv()),
        PATCHPAGE_PACKED_CLI_E2E_SENTINEL_MARKER: signalProbe.childMarkerPath
      }
    : (options.env ?? sanitizedProcessEnv());
  const invocation = resolveSpawnInvocation(effectiveCommand, effectiveArgs, {
    cwd: options.cwd ?? repoRoot,
    env: effectiveEnv,
    platform: options.platform ?? process.platform
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd ?? repoRoot,
    env: effectiveEnv,
    detached: process.platform !== "win32",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    shell: false
  });
  const childLifecycle = observeSpawnedChild(child);
  activeChildren.add(child);
  trackProcessGroup(child);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  if (options.input !== undefined) child.stdin.end(options.input);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, "SIGKILL");
    if (process.platform !== "win32" && Number.isInteger(child.pid)) {
      terminatePosixProcessGroup(child.pid, "SIGKILL");
    }
  }, options.timeoutMs ?? 60_000);

  const result = await Promise.race([
    childLifecycle.errorPromise,
    childLifecycle.closePromise
  ]).finally(() => {
    clearTimeout(timeout);
    activeChildren.delete(child);
    releaseTrackedProcessGroupIfEmpty(child);
  });
  throwIfSignalLatched();

  if (timedOut || (result.code !== 0 && !options.allowFailure)) {
    const sensitiveValues = options.sensitiveValues ?? [];
    throw new Error(
      [
        `${command} ${args.map((arg) => redactSensitive(arg, sensitiveValues)).join(" ")} ${timedOut ? "timed out" : `exited ${result.code ?? result.signal}`}`,
        stdout && `stdout:\n${redactSensitive(stdout, sensitiveValues)}`,
        stderr && `stderr:\n${redactSensitive(stderr, sensitiveValues)}`
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { ...result, stdout, stderr };
}

function resolveSpawnInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (shouldInjectServerSpawnError(command, args)) {
    return {
      command: path.join(os.tmpdir(), "patchpage-packed-cli-e2e-missing-server-spawn"),
      args: []
    };
  }

  if (command === "npm") {
    return { command: process.execPath, args: [npmCliEntry, ...args] };
  }

  if (command === "pnpm" && platform === "win32") {
    const pnpmEntry = resolvePnpmJsEntry(env);
    return { command: process.execPath, args: [pnpmEntry, ...args] };
  }

  if (platform === "win32" && isPatchpageBinPath(command)) {
    return {
      command: process.execPath,
      args: [installedPatchpageJsForBin(command, platform), ...args]
    };
  }

  return { command, args };
}

function shouldInjectServerSpawnError(command, args) {
  return (
    lifecycleProbe.mode === "server-spawn-error" &&
    command === process.execPath &&
    args[0] === serverEntry
  );
}

function resolvePnpmJsEntry(env) {
  const entry = env.npm_execpath;
  assert.ok(
    entry && /(?:^|[\\/])pnpm(?:\.cjs|\.js)?$/i.test(entry),
    "Windows pnpm execution requires npm_execpath to point at pnpm's JavaScript entry"
  );
  assert.ok(
    !/\.cmd$/i.test(entry),
    "Windows pnpm execution must use pnpm's JavaScript entry, not a .cmd shim"
  );
  return entry;
}

function isPatchpageBinPath(command) {
  return /[\\/]node_modules[\\/]\.bin[\\/]patchpage(?:\.cmd)?$/i.test(command);
}

function installedPatchpageJsForBin(command, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const binDir = pathApi.dirname(command);
  const nodeModulesDir = pathApi.dirname(binDir);
  return pathApi.join(nodeModulesDir, "patchpage", "dist", "index.js");
}

function installedCliBinPath(consumerDir) {
  return path.join(
    consumerDir,
    "node_modules/.bin",
    process.platform === "win32" ? "patchpage.cmd" : "patchpage"
  );
}

function observeSpawnedChild(child) {
  let rejectSpawnError;
  const errorPromise = new Promise((_, reject) => {
    rejectSpawnError = reject;
  });
  errorPromise.catch(() => {});
  child.once("error", (error) => {
    activeChildren.delete(child);
    rejectSpawnError(error);
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { errorPromise, closePromise };
}

function trackProcessGroup(child) {
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    trackedProcessGroups.add(child.pid);
  }
}

function releaseTrackedProcessGroupIfEmpty(child) {
  if (
    process.platform !== "win32" &&
    Number.isInteger(child.pid) &&
    !isProcessGroupAlive(child.pid)
  ) {
    trackedProcessGroups.delete(child.pid);
  }
}

function redactSensitive(value, sensitiveValues) {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.split(sensitiveValue).join("[REDACTED]");
  }
  return redacted;
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isInteger(child.pid)) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateTrackedProcessGroups(signal) {
  if (process.platform === "win32") return;
  for (const pid of trackedProcessGroups) terminatePosixProcessGroup(pid, signal);
}

function terminatePosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function cleanup() {
  cleanupPromise ??= (async () => {
    lifecycleProbe.cleanupCount += 1;
    await recordLifecycleProbe({
      type: "cleanup-start",
      count: lifecycleProbe.cleanupCount,
      tempRoot
    });
    if (portReservation) {
      await new Promise((resolve) => portReservation.server.close(() => resolve()));
      portReservation = undefined;
    }
    for (const child of activeChildren) terminateProcessGroup(child, "SIGTERM");
    terminateTrackedProcessGroups("SIGTERM");
    if (activeChildren.size > 0) {
      await Promise.race([
        Promise.allSettled([...activeChildren].map((child) => waitForClose(child))),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    if (process.platform === "win32") {
      for (const child of activeChildren) terminateProcessGroup(child, "SIGKILL");
    } else {
      terminateTrackedProcessGroups("SIGKILL");
    }
    if (activeChildren.size > 0) {
      await Promise.race([
        Promise.allSettled([...activeChildren].map((child) => waitForClose(child))),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    activeChildren.clear();
    trackedProcessGroups.clear();
    await recordLifecycleProbe({
      type: "cleanup-end",
      count: lifecycleProbe.cleanupCount,
      tempRoot
    });
  })();
  return cleanupPromise;
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
