#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const STABLE_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CLIENT_LOCAL_FIELDS = new Set(["_from", "_integrity", "_resolved", "_where"]);
const LOCAL_PATH_RE =
  /(?:file:(?:\/\/)?|(?:^|[\s"'`=:(])(?:~[\\/]|\/(?:Users|home|tmp|private\/(?:tmp|var\/folders)|var\/(?:tmp|folders)|home\/runner\/work)(?:[\\/]|$)|[A-Za-z]:[\\/](?:Users|Documents and Settings|Windows[\\/]Temp|Temp)(?:[\\/]|$)))/i;
const PRIVATE_ARTIFACT_RE =
  /(?:^|[\s"'`=:(/\\])(?:transcript|transript|sessions?|conversation|rollout)(?:[-_. ][\w.-]+)?(?:\.(?:txt|jsonl|json|md|log|html?|zip|tgz|gz|tar(?:\.gz)?))?(?=$|[\s"'`),;/\\])/i;
const REQUIRED_OPTIONS = [
  "tarball",
  "expected-filename",
  "expected-sha256",
  "expected-name",
  "expected-version",
  "expected-npm-version",
  "npm-cli-dir"
];

export const POSTPUBLISH_MAX_ATTEMPTS = 6;
export const POSTPUBLISH_DELAY_MS = 2_000;
export const REGISTRY_REQUEST_TIMEOUT_MS = 10_000;

export class ExactPublisherError extends Error {
  constructor(category) {
    super(`exact npm publication failed: ${category}`);
    this.name = "ExactPublisherError";
    this.category = category;
  }
}

function fail(category) {
  throw new ExactPublisherError(category);
}

function sha(buffer, algorithm, encoding) {
  return createHash(algorithm).update(buffer).digest(encoding);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--") || !REQUIRED_OPTIONS.includes(option.slice(2))) {
      fail("invalid-input");
    }
    const key = option.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(key)) fail("invalid-input");
    values.set(key, value);
    index += 1;
  }
  if (values.size !== REQUIRED_OPTIONS.length || REQUIRED_OPTIONS.some((key) => !values.has(key))) {
    fail("invalid-input");
  }
  return Object.fromEntries(values);
}

function validateOptionShapes(options) {
  if (!isPlainObject(options)) fail("invalid-input");
  for (const key of REQUIRED_OPTIONS) {
    if (typeof options[key] !== "string" || options[key].length === 0) fail("invalid-input");
  }
  if (!path.isAbsolute(options.tarball) || !path.isAbsolute(options["npm-cli-dir"])) {
    fail("invalid-input");
  }
  if (
    path.basename(options.tarball) !== options["expected-filename"] ||
    path.basename(options["expected-filename"]) !== options["expected-filename"] ||
    !options["expected-filename"].endsWith(".tgz")
  ) {
    fail("artifact-validation");
  }
  if (!/^[0-9a-f]{64}$/.test(options["expected-sha256"])) fail("artifact-validation");
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(
      options["expected-name"]
    )
  ) {
    fail("manifest-validation");
  }
  if (!STABLE_VERSION_RE.test(options["expected-version"])) {
    fail("manifest-validation");
  }
  if (!/^\d+\.\d+\.\d+$/.test(options["expected-npm-version"])) fail("tool-validation");
}

async function verifyRegularFile(filename, category) {
  let stat;
  try {
    stat = await lstat(filename);
  } catch {
    fail(category);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(category);
}

async function verifyNpmCliDirectory(npmCliDir, expectedVersion) {
  let stat;
  let packageJson;
  try {
    stat = await lstat(npmCliDir);
    packageJson = JSON.parse(await readFile(path.join(npmCliDir, "package.json"), "utf8"));
  } catch {
    fail("tool-validation");
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    packageJson?.name !== "npm" ||
    packageJson.version !== expectedVersion
  ) {
    fail("tool-validation");
  }
}

function loadPinnedModules(npmCliDir) {
  try {
    const requireFromNpm = createRequire(path.join(npmCliDir, "package.json"));
    const pacote = requireFromNpm("./node_modules/pacote");
    const { oidc } = requireFromNpm("./lib/utils/oidc.js");
    const { publish } = requireFromNpm("./node_modules/libnpmpublish");
    if (
      typeof pacote?.manifest !== "function" ||
      typeof oidc !== "function" ||
      typeof publish !== "function"
    ) {
      fail("tool-validation");
    }
    return { oidc, pacote, publish };
  } catch (error) {
    if (error instanceof ExactPublisherError) throw error;
    fail("tool-validation");
  }
}

function cleanPacoteManifest(manifest) {
  if (!isPlainObject(manifest)) fail("manifest-validation");
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => !key.startsWith("_")));
}

function containsForbiddenMetadata(value, seen = new Set()) {
  if (typeof value === "string")
    return LOCAL_PATH_RE.test(value) || PRIVATE_ARTIFACT_RE.test(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    if (typeof key === "string") {
      if (CLIENT_LOCAL_FIELDS.has(key) || LOCAL_PATH_RE.test(key) || PRIVATE_ARTIFACT_RE.test(key))
        return true;
    }
    if (containsForbiddenMetadata(child, seen)) return true;
  }
  seen.delete(value);
  return false;
}

function expectedIntegrity(tarball) {
  return `sha512-${sha(tarball, "sha512", "base64")}`;
}

function hasProvenance(metadata) {
  const attestations = metadata?.dist?.attestations;
  if (!isPlainObject(attestations) || !isPlainObject(attestations.provenance)) return false;
  if (attestations.provenance.predicateType !== PROVENANCE_PREDICATE) return false;
  if (typeof attestations.url !== "string") return false;
  try {
    return new URL(attestations.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateRegistryManifest(metadata, { name, version, integrity }) {
  if (
    !isPlainObject(metadata) ||
    metadata.name !== name ||
    metadata.version !== version ||
    metadata.dist?.integrity !== integrity
  ) {
    fail("registry-integrity");
  }
  if (!hasProvenance(metadata)) fail("registry-provenance");
  if (containsForbiddenMetadata(metadata)) fail("registry-metadata");
}

async function queryRegistryJson(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS)
    });
  } catch {
    fail("registry-query");
  }
  if (!response || typeof response.status !== "number") fail("registry-query");
  if (response.status === 404) return { status: 404 };
  if (response.status !== 200) fail("registry-query");
  try {
    return { status: 200, metadata: await response.json() };
  } catch {
    fail("registry-query");
  }
}

async function queryExactVersion(fetchImpl, name, version) {
  const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, REGISTRY);
  return queryRegistryJson(fetchImpl, url);
}

async function verifiedRegistryState(fetchImpl, expected) {
  const result = await queryExactVersion(fetchImpl, expected.name, expected.version);
  if (result.status === 200) validateRegistryManifest(result.metadata, expected);
  return result.status;
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

async function enforceLatestTagHighWaterMark(fetchImpl, name, version) {
  const result = await queryRegistryJson(fetchImpl, new URL(encodeURIComponent(name), REGISTRY));
  if (result.status === 404) return;
  if (!isPlainObject(result.metadata) || !isPlainObject(result.metadata.versions)) {
    fail("registry-query");
  }

  let highestVersion = null;
  for (const [publishedVersion, publishedManifest] of Object.entries(result.metadata.versions)) {
    if (!STABLE_VERSION_RE.test(publishedVersion)) continue;
    if (!isPlainObject(publishedManifest)) fail("registry-query");
    if (publishedManifest.deprecated) continue;
    if (highestVersion === null || compareStableVersions(publishedVersion, highestVersion) > 0) {
      highestVersion = publishedVersion;
    }
  }

  if (highestVersion !== null && compareStableVersions(highestVersion, version) >= 0) {
    fail("latest-tag");
  }
}

function createOidcConfig(opts) {
  return {
    isDefault() {
      return false;
    },
    set(key, value) {
      opts[key] = value;
    }
  };
}

function authTokenKey() {
  const registry = new URL(REGISTRY);
  return `//${registry.host}${registry.pathname}:_authToken`;
}

export async function publishExactNpmArtifact(options, runtime = {}) {
  validateOptionShapes(options);
  const tarballPath = options.tarball;
  const npmCliDir = options["npm-cli-dir"];
  const readTarball = runtime.readTarball ?? readFile;
  await verifyRegularFile(tarballPath, "artifact-validation");
  await verifyNpmCliDirectory(npmCliDir, options["expected-npm-version"]);

  let tarball;
  try {
    tarball = await readTarball(tarballPath);
  } catch {
    fail("artifact-validation");
  }
  if (sha(tarball, "sha256", "hex") !== options["expected-sha256"]) fail("artifact-validation");

  const modules = runtime.modules ?? loadPinnedModules(npmCliDir);
  let fetchedManifest;
  try {
    fetchedManifest = await modules.pacote.manifest(tarballPath, { ignoreScripts: true });
  } catch {
    fail("manifest-validation");
  }

  let confirmedTarball;
  try {
    confirmedTarball = await readTarball(tarballPath);
  } catch {
    fail("artifact-validation");
  }
  if (
    confirmedTarball.length !== tarball.length ||
    !timingSafeEqual(confirmedTarball, tarball) ||
    sha(confirmedTarball, "sha256", "hex") !== options["expected-sha256"]
  ) {
    fail("artifact-validation");
  }

  const manifest = cleanPacoteManifest(fetchedManifest);
  if (
    manifest.name !== options["expected-name"] ||
    manifest.version !== options["expected-version"]
  ) {
    fail("manifest-validation");
  }
  if (containsForbiddenMetadata(manifest)) fail("manifest-privacy");

  const expected = {
    name: options["expected-name"],
    version: options["expected-version"],
    integrity: expectedIntegrity(tarball)
  };
  if ((await verifiedRegistryState(runtime.fetch ?? globalThis.fetch, expected)) === 200) {
    return { status: "already-published" };
  }
  await enforceLatestTagHighWaterMark(
    runtime.fetch ?? globalThis.fetch,
    expected.name,
    expected.version
  );

  const opts = {
    access: "public",
    defaultTag: "latest",
    ignoreScripts: true,
    npmVersion: options["expected-npm-version"],
    provenance: true,
    registry: REGISTRY,
    retry: { retries: 2, factor: 2, minTimeout: 1_000, maxTimeout: 10_000 }
  };
  const config = createOidcConfig(opts);
  try {
    await modules.oidc({ packageName: manifest.name, registry: REGISTRY, opts, config });
  } catch {
    fail("oidc-authentication");
  }
  const key = authTokenKey();
  if (typeof opts[key] !== "string" || opts[key].length === 0) fail("oidc-authentication");

  try {
    await modules.publish(manifest, tarball, opts);
  } catch {
    fail("registry-publication");
  }

  const sleep =
    runtime.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < POSTPUBLISH_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(POSTPUBLISH_DELAY_MS);
    if ((await verifiedRegistryState(runtime.fetch ?? globalThis.fetch, expected)) === 200) {
      return { status: "published" };
    }
  }
  fail("postpublish-verification");
}

async function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await publishExactNpmArtifact(options);
    process.stdout.write(
      result.status === "published"
        ? "npm publication verified\n"
        : "existing npm publication verified\n"
    );
  } catch (error) {
    const category = error instanceof ExactPublisherError ? error.category : "unexpected-failure";
    process.stderr.write(`::error::exact npm publisher: ${category}\n`);
    process.exitCode = 1;
  }
}

if (await isDirectExecution()) {
  await main();
}
