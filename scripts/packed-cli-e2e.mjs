import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageDir = path.join(repoRoot, "packages/cli");
const serverEntry = path.join(repoRoot, "apps/server/dist/start.js");
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
let tempRoot;
let cleanupPromise;
let portReservation;
let serverProcess;
let serverStdout = "";
let serverStderr = "";

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(128 + os.constants.signals[signal]));
  });
}

try {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  assert.ok(nodeMajor >= 22, `packed CLI E2E requires Node 22 or newer; found ${process.version}`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "patchpage-packed-cli-e2e-"));
  const packDir = path.join(tempRoot, "pack");
  const consumerDir = path.join(tempRoot, "consumer");
  const serverStateDir = path.join(tempRoot, "server-state");
  const metadataPath = path.join(serverStateDir, "metadata.json");
  const objectDir = path.join(serverStateDir, "objects");
  const cliStateDir = path.join(tempRoot, "cli-state-authenticated");
  await Promise.all([
    mkdir(packDir),
    mkdir(consumerDir),
    mkdir(serverStateDir),
    mkdir(cliStateDir)
  ]);

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
  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.length, 1, "npm pack must produce exactly one artifact");

  const tarballs = (await readdir(packDir)).filter((entry) => entry.endsWith(".tgz"));
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

  const cliPath = path.join(consumerDir, "node_modules/.bin/patchpage");
  await access(cliPath);
  const installedManifest = JSON.parse(
    await readFile(path.join(consumerDir, "node_modules/patchpage/package.json"), "utf8")
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
  await writeFile(fixturePath, firstHtml, "utf8");
  const first = parseUpload(
    await runCli(cliPath, ["upload", fixturePath], { cwd: consumerDir, env: cliEnv })
  );
  assert.equal(first.label, "Uploaded draft");
  assert.equal(first.versionNumber, 1);
  assert.equal(first.publicUrl, `${publicBaseUrl}/d/${first.draftId}`);

  await writeFile(fixturePath, secondHtml, "utf8");
  const second = parseUpload(
    await runCli(cliPath, ["upload", fixturePath], { cwd: consumerDir, env: cliEnv })
  );
  assert.equal(second.label, "Updated draft");
  assert.equal(second.draftId, first.draftId);
  assert.equal(second.versionNumber, 2);

  await writeFile(fixturePath, newHtml, "utf8");
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
  await writeFile(fixturePath, unsafeHtml, "utf8");
  await assertCliFailureNoMutation({
    cliPath,
    args: ["upload", fixturePath],
    cwd: consumerDir,
    env: cliEnv,
    cliStateDir,
    metadataPath,
    objectDir,
    stderr: /Blocked <script> tag found\./
  });

  await writeFile(fixturePath, validHtml("Invalid env", "invalid-env-must-not-persist"), "utf8");
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
  await mkdir(invalidStoredStateDir);
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
  await mkdir(anonymousStateDir);
  const anonymousEnv = environment({ PATCHPAGE_STATE_DIR: anonymousStateDir }, [
    "PATCHPAGE_API_TOKEN",
    "PATCHPAGE_API_URL"
  ]);
  const anonymousHtml = validHtml("Anonymous same path", "anonymous-same-path");
  await writeFile(fixturePath, anonymousHtml, "utf8");
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

  const authenticatedCacheBeforeAnonymous = await readFile(
    path.join(cliStateDir, "drafts.json"),
    "utf8"
  );
  const explicitAnonymousHtml = validHtml(
    "Explicit anonymous",
    "explicit-anonymous-bypassed-valid-credential"
  );
  await writeFile(fixturePath, explicitAnonymousHtml, "utf8");
  const explicitAnonymous = parseUpload(
    await runCli(cliPath, ["upload", fixturePath, "--anonymous"], {
      cwd: consumerDir,
      env: cliEnv
    })
  );
  assert.equal(
    await readFile(path.join(cliStateDir, "drafts.json"), "utf8"),
    authenticatedCacheBeforeAnonymous
  );

  console.log("[packed-cli-e2e] proving environment credentials override stored credentials");
  const envPrecedenceHtml = validHtml(
    "Environment precedence",
    "valid-env-overrode-invalid-stored"
  );
  await writeFile(fixturePath, envPrecedenceHtml, "utf8");
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
} finally {
  await cleanup();
}

function validHtml(title, marker) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${marker}</h1></body></html>`;
}

async function reserveLoopbackPort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "failed to reserve an ephemeral port");
  return { server, port: address.port };
}

async function startServer({ publicBaseUrl, metadataPath, objectDir }) {
  await access(serverEntry);
  assert.ok(portReservation, "loopback port must be reserved before server launch");
  await new Promise((resolve, reject) => {
    portReservation.server.close((error) => (error ? reject(error) : resolve()));
  });
  portReservation = undefined;

  const serverEnv = environment(
    {
      PORT: new URL(publicBaseUrl).port,
      PATCHPAGE_PUBLIC_BASE_URL: publicBaseUrl,
      PATCHPAGE_BOOTSTRAP_API_TOKEN: bootstrapToken,
      PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS: "true",
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

  console.log(`[packed-cli-e2e] launching real server at ${publicBaseUrl}`);
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: serverEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  activeChildren.add(serverProcess);
  serverProcess.stdout.setEncoding("utf8");
  serverProcess.stderr.setEncoding("utf8");
  serverProcess.stdout.on("data", (chunk) => {
    serverStdout += chunk;
  });
  serverProcess.stderr.on("data", (chunk) => {
    serverStderr += chunk;
  });
  serverProcess.once("close", () => activeChildren.delete(serverProcess));
}

async function waitForReady(healthUrl) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  sensitiveValues = [],
  stderr
}) {
  const authoritativeBefore = await authoritativeSnapshot(metadataPath, objectDir);
  const cliStateBefore = await snapshotTree(cliStateDir);
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
    cliStateBefore,
    "failed CLI invocation mutated CLI state"
  );
}

async function authoritativeSnapshot(metadataPath, objectDir) {
  return {
    metadata: await readFile(metadataPath, "utf8"),
    objects: await snapshotTree(objectDir)
  };
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
  const env = { ...process.env, ...overrides };
  for (const name of unset) delete env[name];
  return env;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    detached: process.platform !== "win32",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    shell: false
  });
  activeChildren.add(child);

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
  }, options.timeoutMs ?? 60_000);

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    activeChildren.delete(child);
  });

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

function redactSensitive(value, sensitiveValues) {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.split(sensitiveValue).join("[REDACTED]");
  }
  return redacted;
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function cleanup() {
  cleanupPromise ??= (async () => {
    if (portReservation) {
      await new Promise((resolve) => portReservation.server.close(() => resolve()));
      portReservation = undefined;
    }
    for (const child of activeChildren) terminateProcessGroup(child, "SIGTERM");
    if (activeChildren.size > 0) {
      await Promise.race([
        Promise.allSettled([...activeChildren].map((child) => waitForClose(child))),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    for (const child of activeChildren) terminateProcessGroup(child, "SIGKILL");
    if (activeChildren.size > 0) {
      await Promise.race([
        Promise.allSettled([...activeChildren].map((child) => waitForClose(child))),
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
