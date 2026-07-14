#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateDockerSaveTar } from "./validate-docker-save-artifact.mjs";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
const STABLE_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const FIRST_PACKAGE_REPOSITORY = "allisonmahmood/patchpage-server";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const MANIFEST_ACCEPT = OCI_MANIFEST_MEDIA_TYPE;
const MINIMUM_SUPPORTED_IMAGE_VERSION = "0.1.1";
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_REGISTRY_JSON_BYTES = 1024 * 1024;
const MAX_REGISTRY_RESPONSE_BYTES = 64 * 1024;

class OciError extends Error {
  constructor(message) {
    super(message);
    this.name = "OciError";
  }
}

function fail(message) {
  throw new OciError(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fullDigest(buffer) {
  return `sha256:${sha256(buffer)}`;
}
async function readCappedResponseBody(
  response,
  { label, maxBytes, expectedBytes = null },
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail(`invalid body limit for ${label}`);
  if (
    expectedBytes !== null &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)
  ) {
    fail(`invalid expected body size for ${label}`);
  }

  const reader = response.body?.getReader();
  const exactBody = expectedBytes === null ? null : Buffer.allocUnsafe(expectedBytes);
  const chunks = [];
  const limit = expectedBytes ?? maxBytes;
  let total = 0;

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        const limitLabel =
          expectedBytes === null
            ? `reviewed maximum ${maxBytes}`
            : `declared size ${expectedBytes}`;
        fail(`${label} exceeded ${limitLabel} while streaming`);
      }

      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (exactBody) {
        chunk.copy(exactBody, total);
      } else {
        chunks.push(Buffer.from(chunk));
      }
      total += chunk.length;
    }
  }

  if (expectedBytes !== null) {
    if (total !== expectedBytes) {
      fail(`${label} ended at ${total} bytes, expected ${expectedBytes}`);
    }
    return exactBody;
  }
  return Buffer.concat(chunks, total);
}


function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) fail("missing command");
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) fail(`unexpected positional argument: ${key}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${key}`);
    options.set(key.slice(2), value);
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  const value = options.get(key);
  if (!value) fail(`missing required option --${key}`);
  return value;
}

function isStableSemver(value) {
  return STABLE_SEMVER_RE.test(value);
}

function compareSemver(left, right) {
  const leftMatch = left.match(STABLE_SEMVER_RE);
  const rightMatch = right.match(STABLE_SEMVER_RE);
  if (!leftMatch || !rightMatch) fail(`cannot compare non-stable semver values`);
  const leftParts = leftMatch.slice(1).map(BigInt);
  const rightParts = rightMatch.slice(1).map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}
function isSupportedImageRelease(version) {
  return compareSemver(version, MINIMUM_SUPPORTED_IMAGE_VERSION) >= 0;
}


function parseBearerChallenge(value) {
  if (!value) return null;
  const [scheme, parameterText = ""] = value.split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  const params = new Map();
  for (const match of parameterText.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g)) {
    params.set(match[1], match[2]);
  }
  const realm = params.get("realm");
  if (!realm) return null;
  return {
    realm,
    service: params.get("service"),
    scope: params.get("scope"),
  };
}

function detailValue(detail, keys) {
  for (const key of keys) {
    const value = detail?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function detailMatchesTarget(detail, target) {
  if (detail == null) return true;
  if (typeof detail !== "object" || Array.isArray(detail)) return false;

  const repository = detailValue(detail, ["name", "Name", "repository", "Repository"]);
  if (repository !== target.repository) return false;

  if (target.reference !== undefined) {
    const reference = detailValue(detail, [
      "reference",
      "Reference",
      "revision",
      "Revision",
      "tag",
      "Tag",
    ]);
    return reference === target.reference;
  }

  return true;
}

function parseOciError(body, expectedCode, target) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  if (!parsed || !Array.isArray(parsed.errors) || parsed.errors.length !== 1) {
    return false;
  }
  const [error] = parsed.errors;
  if (!error || typeof error !== "object") return false;
  return error.code === expectedCode && detailMatchesTarget(error.detail, target);
}

class RegistryClient {
  constructor({ registryUrl, name, username, password, allowFirstPackage = false, scopeActions = "pull" }) {
    this.registryUrl = registryUrl.replace(/\/+$/, "");
    this.registryOrigin = new URL(this.registryUrl).origin;
    this.name = name.replace(/^\/+|\/+$/g, "");
    this.username = username;
    this.password = password;
    this.allowFirstPackage = allowFirstPackage;
    if (this.allowFirstPackage && this.name !== FIRST_PACKAGE_REPOSITORY) {
      fail(`--allow-first-package is only valid for ${FIRST_PACKAGE_REPOSITORY}`);
    }
    this.scopeActions = scopeActions;
    this.bearerToken = "";
    this.repositoryAbsent = false;
    this.repositoryProbed = false;
  }

  async request(method, route, { headers = {}, body } = {}) {
    const url = route.startsWith("http")
      ? new URL(route)
      : new URL(`${this.registryUrl}${route}`);
    if (url.origin !== this.registryOrigin) {
      fail(`refusing registry request to unexpected origin ${url.origin}`);
    }
    const requestHeaders = new Headers(headers);
    if (this.bearerToken) requestHeaders.set("authorization", `Bearer ${this.bearerToken}`);
    let response = await fetch(url, { method, headers: requestHeaders, body });
    if (response.status !== 401 || this.bearerToken) return response;

    const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
    if (!challenge) return response;
    this.bearerToken = await this.fetchBearerToken(challenge);
    const retryHeaders = new Headers(headers);
    retryHeaders.set("authorization", `Bearer ${this.bearerToken}`);
    response = await fetch(url, { method, headers: retryHeaders, body });
    return response;
  }

  async fetchBearerToken(challenge) {
    const url = new URL(challenge.realm);
    if (url.origin !== this.registryOrigin) {
      fail(`registry bearer realm changed origin to ${url.origin}`);
    }
    if (challenge.service) url.searchParams.set("service", challenge.service);
    url.searchParams.set("scope", `repository:${this.name}:${this.scopeActions}`);
    const headers = new Headers();
    if (this.username && this.password) {
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64")}`,
      );
    }
    const response = await fetch(url, { headers });
    const body = await readCappedResponseBody(response, {
      label: "registry token response",
      maxBytes: MAX_REGISTRY_RESPONSE_BYTES,
    });
    if (!response.ok) {
      fail(`registry token request failed with HTTP ${response.status}: ${body.toString("utf8")}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch (error) {
      fail(`registry token response was not JSON: ${error.message}`);
    }
    const token = parsed.token ?? parsed.access_token;
    if (typeof token !== "string" || token.length === 0) {
      fail("registry token response did not contain a token");
    }
    return token;
  }

  async listTags() {
    const tags = [];
    const seenTags = new Set();
    const seenPages = new Set();
    let route = `/v2/${this.name}/tags/list?n=100`;

    while (route) {
      if (seenPages.has(route)) fail(`registry tags/list pagination loop at ${route}`);
      seenPages.add(route);
      const response = await this.request("GET", route);
      const body = await readCappedResponseBody(response, {
        label: `registry tags/list response for ${route}`,
        maxBytes: MAX_REGISTRY_JSON_BYTES,
      });

      if (response.status === 404) {
        if (
          this.allowFirstPackage &&
          parseOciError(body, "NAME_UNKNOWN", { repository: this.name })
        ) {
          this.repositoryAbsent = true;
          this.repositoryProbed = true;
          return [];
        }
        fail("registry tags/list returned an invalid or unexpected 404 OCI error");
      }
      if (!response.ok) {
        fail(`registry tags/list failed with HTTP ${response.status}: ${body.toString("utf8")}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (error) {
        fail(`registry tags/list response was not JSON: ${error.message}`);
      }
      if (parsed.name !== this.name) {
        fail(`registry tags/list returned name ${parsed.name}, expected ${this.name}`);
      }
      this.repositoryAbsent = false;
      this.repositoryProbed = true;
      if (parsed.tags != null && !Array.isArray(parsed.tags)) {
        fail("registry tags/list tags must be an array when present");
      }
      for (const tag of parsed.tags ?? []) {
        if (typeof tag !== "string" || tag.length === 0) {
          fail("registry tags/list returned a malformed tag");
        }
        if (seenTags.has(tag)) fail(`registry tags/list returned duplicate tag ${tag}`);
        seenTags.add(tag);
        tags.push(tag);
      }

      route = "";
      const link = response.headers.get("link");
      if (link) {
        const next = link
          .split(",")
          .map((part) => part.trim())
          .find((part) => /;\s*rel="?next"?/.test(part));
        if (next) {
          const match = next.match(/^<([^>]+)>/);
          if (!match) fail(`registry tags/list Link header is malformed: ${link}`);
          const nextUrl = new URL(match[1], this.registryUrl);
          if (nextUrl.origin !== this.registryOrigin) {
            fail(`registry tags/list Link changed registry origin: ${link}`);
          }
          route = `${nextUrl.pathname}${nextUrl.search}`;
        }
      }
    }

    return tags;
  }

  async probeFirstPackageIfAllowed() {
    if (!this.allowFirstPackage || this.repositoryProbed) return;
    await this.listTags();
  }

  async readTagState(ref, { allowNameUnknown = false } = {}) {
    const response = await this.request("GET", `/v2/${this.name}/manifests/${ref}`, {
      headers: { accept: MANIFEST_ACCEPT },
    });
    const body = await readCappedResponseBody(response, {
      label: `manifest ${ref} response`,
      maxBytes: MAX_MANIFEST_BYTES,
    });
    if (response.status === 404) {
      if (parseOciError(body, "MANIFEST_UNKNOWN", {
        repository: this.name,
        reference: ref,
      })) return null;
      if (
        allowNameUnknown &&
        this.allowFirstPackage &&
        this.repositoryAbsent &&
        parseOciError(body, "NAME_UNKNOWN", { repository: this.name })
      ) {
        return null;
      }
      fail(`manifest ${ref} returned an invalid or unexpected 404 OCI error`);
    }
    if (!response.ok) {
      fail(`manifest ${ref} failed with HTTP ${response.status}: ${body.toString("utf8")}`);
    }

    const responseMediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (responseMediaType !== OCI_MANIFEST_MEDIA_TYPE) {
      fail(`manifest ${ref} has unsupported manifest media type ${responseMediaType ?? "missing"}`);
    }

    const digestHeader = response.headers.get("docker-content-digest");
    const manifestDigest = fullDigest(body);
    if (digestHeader !== manifestDigest) {
      fail(
        `manifest ${ref} Docker-Content-Digest ${digestHeader} does not match raw body ${manifestDigest}`,
      );
    }

    let manifest;
    try {
      manifest = JSON.parse(body.toString("utf8"));
    } catch (error) {
      fail(`manifest ${ref} body is not JSON: ${error.message}`);
    }
    if (manifest?.mediaType !== OCI_MANIFEST_MEDIA_TYPE) {
      fail(`manifest ${ref} body declares unsupported manifest media type ${manifest?.mediaType}`);
    }
    if (Array.isArray(manifest.manifests)) {
      fail(`manifest ${ref} resolved to an image index, not a single image manifest`);
    }
    const configDigest = manifest?.config?.digest;
    const configSize = manifest?.config?.size;
    if (!DIGEST_RE.test(configDigest) || !Number.isSafeInteger(configSize) || configSize <= 0) {
      fail(`manifest ${ref} is missing a valid config descriptor`);
    }
    if (configSize > MAX_CONFIG_BYTES) {
      fail(`manifest ${ref} config descriptor ${configSize} exceeds reviewed maximum ${MAX_CONFIG_BYTES}`);
    }

    const configResponse = await this.request("GET", `/v2/${this.name}/blobs/${configDigest}`);
    const configLabel = `config blob ${configDigest} for ${ref}`;
    if (!configResponse.ok) {
      await readCappedResponseBody(configResponse, {
        label: `${configLabel} error`,
        maxBytes: 64 * 1024,
      });
      fail(`${configLabel} failed with HTTP ${configResponse.status}`);
    }
    const configBody = await readCappedResponseBody(configResponse, {
      label: configLabel,
      maxBytes: MAX_CONFIG_BYTES,
      expectedBytes: configSize,
    });
    const actualConfigDigest = fullDigest(configBody);
    if (actualConfigDigest !== configDigest) {
      fail(`config blob ${configDigest} for ${ref} hashes to ${actualConfigDigest}`);
    }
    const configDigestHeader = configResponse.headers.get("docker-content-digest");
    if (configDigestHeader && configDigestHeader !== configDigest) {
      fail(`config blob ${configDigest} for ${ref} returned digest ${configDigestHeader}`);
    }

    let config;
    try {
      config = JSON.parse(configBody.toString("utf8"));
    } catch (error) {
      fail(`config blob ${configDigest} for ${ref} is not JSON: ${error.message}`);
    }
    const labels = config?.config?.Labels ?? {};
    const version = labels["org.opencontainers.image.version"];
    const revision = labels["org.opencontainers.image.revision"];
    if (!isStableSemver(version)) {
      fail(`config labels for ${ref} do not contain an exact stable version`);
    }
    if (!REVISION_RE.test(revision)) {
      fail(`config labels for ${ref} do not contain a full lowercase revision`);
    }

    return {
      ref,
      manifestDigest,
      configDigest,
      version,
      revision,
      rawManifest: body,
      manifest,
      config,
    };
  }

  async putManifest(ref, rawManifest) {
    const manifestDigest = fullDigest(rawManifest);
    const response = await this.request("PUT", `/v2/${this.name}/manifests/${ref}`, {
      headers: {
        "content-type": OCI_MANIFEST_MEDIA_TYPE,
      },
      body: rawManifest,
    });
    const body = await readCappedResponseBody(response, {
      label: `manifest PUT ${ref} response`,
      maxBytes: MAX_REGISTRY_RESPONSE_BYTES,
    });
    if (response.status !== 201) {
      fail(`manifest PUT ${ref} failed with HTTP ${response.status}: ${body.toString("utf8")}`);
    }
    const digestHeader = response.headers.get("docker-content-digest");
    if (digestHeader !== manifestDigest) {
      fail(`manifest PUT ${ref} returned digest ${digestHeader}, expected ${manifestDigest}`);
    }
    return manifestDigest;
  }

  async uploadBlob(digest, body) {
    if (!DIGEST_RE.test(digest)) fail(`cannot upload invalid blob digest ${digest}`);
    if (fullDigest(body) !== digest) fail(`local blob body does not match ${digest}`);

    const start = await this.request("POST", `/v2/${this.name}/blobs/uploads/`);
    const startBody = await readCappedResponseBody(start, {
      label: `blob upload start for ${digest} response`,
      maxBytes: MAX_REGISTRY_RESPONSE_BYTES,
    });
    if (start.status !== 202) {
      fail(`blob upload start for ${digest} failed with HTTP ${start.status}: ${startBody.toString("utf8")}`);
    }
    const location = start.headers.get("location");
    if (!location) fail(`blob upload start for ${digest} did not return a Location`);
    const uploadUrl = new URL(location, this.registryUrl);
    if (uploadUrl.origin !== this.registryOrigin) {
      fail(`blob upload Location changed registry origin to ${uploadUrl.origin}`);
    }
    uploadUrl.searchParams.set("digest", digest);
    const finish = await this.request("PUT", `${uploadUrl.pathname}${uploadUrl.search}`, {
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    const finishBody = await readCappedResponseBody(finish, {
      label: `blob upload finish for ${digest} response`,
      maxBytes: MAX_REGISTRY_RESPONSE_BYTES,
    });
    if (finish.status !== 201) {
      fail(`blob upload finish for ${digest} failed with HTTP ${finish.status}: ${finishBody.toString("utf8")}`);
    }
    const header = finish.headers.get("docker-content-digest");
    if (header && header !== digest) {
      fail(`blob upload finish for ${digest} returned digest ${header}`);
    }
  }
}

function requireSameReleasePair(semverState, revisionState) {
  if (!semverState || !revisionState) fail("release pair is incomplete");
  if (semverState.manifestDigest !== revisionState.manifestDigest) {
    fail(
      `release ${semverState.version} semver and revision tags resolve to different manifest digests`,
    );
  }
  if (semverState.configDigest !== revisionState.configDigest) {
    fail(`release ${semverState.version} semver and revision tags resolve to different configs`);
  }
  if (
    revisionState.version !== semverState.version ||
    revisionState.revision !== semverState.revision
  ) {
    fail(`release ${semverState.version} revision tag labels do not match the semver tag`);
  }
}

function requireSameManifestAndConfig(left, right, label) {
  if (left.manifestDigest !== right.manifestDigest) {
    fail(`${label} manifest digest ${left.manifestDigest} does not match ${right.manifestDigest}`);
  }
  if (left.configDigest !== right.configDigest) {
    fail(`${label} config digest ${left.configDigest} does not match ${right.configDigest}`);
  }
}

function requireSameReleaseIdentity(left, right, label) {
  if (left.version !== right.version || left.revision !== right.revision) {
    fail(`${label} release identity ${left.version}/${left.revision} does not match ${right.version}/${right.revision}`);
  }
  requireSameManifestAndConfig(left, right, label);
}

async function selectHighestCompleteRelease(client) {
  const tags = await client.listTags();
  const stableTags = tags
    .filter((tag) => isStableSemver(tag) && isSupportedImageRelease(tag))
    .sort(compareSemver);
  let highest = null;

  for (const version of stableTags) {
    const semverState = await client.readTagState(version);
    if (!semverState) fail(`stable tag ${version} was listed but could not be read`);
    if (semverState.version !== version) {
      fail(`stable tag ${version} has label version ${semverState.version}`);
    }
    const revisionState = await client.readTagState(semverState.revision);
    if (!revisionState) {
      fail(`stable tag ${version} is incomplete because revision tag ${semverState.revision} is missing`);
    }
    requireSameReleasePair(semverState, revisionState);
    highest = {
      version,
      revision: semverState.revision,
      manifestDigest: semverState.manifestDigest,
      configDigest: semverState.configDigest,
      rawManifest: semverState.rawManifest,
    };
  }

  return highest;
}

async function authenticateLatestCandidate(client, latestState) {
  const semverState = await client.readTagState(latestState.version);
  if (!semverState) fail(`latest label-derived stable tag ${latestState.version} is missing`);
  const revisionState = await client.readTagState(latestState.revision);
  if (!revisionState) fail(`latest label-derived revision tag ${latestState.revision} is missing`);
  requireSameReleasePair(semverState, revisionState);
  requireSameManifestAndConfig(latestState, semverState, "latest and label-derived stable tag");
  requireSameManifestAndConfig(latestState, revisionState, "latest and label-derived revision tag");
}

async function reconcileLatest(client) {
  const highest = await selectHighestCompleteRelease(client);
  if (!highest) fail("cannot reconcile latest without a complete stable release");

  let latest = await client.readTagState("latest", {
    allowNameUnknown: client.allowFirstPackage,
  });
  let latestResult = "unchanged";
  if (latest) {
    await authenticateLatestCandidate(client, latest);
    const comparison = compareSemver(latest.version, highest.version);
    if (comparison < 0) {
      latestResult = "updated";
    } else if (comparison === 0) {
      const expected = {
        manifestDigest: highest.manifestDigest,
        configDigest: highest.configDigest,
      };
      requireSameManifestAndConfig(latest, expected, "latest and highest complete release");
      latestResult = "unchanged";
    } else {
      latestResult = "retained-newer";
    }
  } else {
    latestResult = "updated";
  }

  if (latestResult === "updated") {
    await client.putManifest("latest", highest.rawManifest);
    const postWriteHighest = await selectHighestCompleteRelease(client);
    latest = await client.readTagState("latest");
    await authenticateLatestCandidate(client, latest);
    requireSameReleaseIdentity(
      latest,
      postWriteHighest,
      "post-write latest and re-enumerated highest complete release",
    );
    highest.version = postWriteHighest.version;
    highest.revision = postWriteHighest.revision;
    highest.manifestDigest = postWriteHighest.manifestDigest;
    highest.configDigest = postWriteHighest.configDigest;
    highest.rawManifest = postWriteHighest.rawManifest;
  }
  return { ...highest, latest: latestResult };
}

function requireExactReleaseLabels(state, version, revision, label) {
  if (state.version !== version) {
    fail(`${label} has version label ${state.version}, expected ${version}`);
  }
  if (state.revision !== revision) {
    fail(`${label} has revision label ${state.revision}, expected ${revision}`);
  }
}

function localLabels(localImage) {
  const configBody = localImage.blobs.get(localImage.configDigest);
  if (!configBody) fail("validated local image did not expose its config blob");
  let config;
  try {
    config = JSON.parse(configBody.toString("utf8"));
  } catch (error) {
    fail(`validated local image config is not JSON: ${error.message}`);
  }
  return config?.config?.Labels ?? {};
}

async function localImageFromOptions(options, version) {
  const imageTar = required(options, "image-tar");
  const expectedRepoTag = required(options, "expected-repo-tag");
  const expectedConfigId = required(options, "expected-config-id");
  const tar = await readFile(imageTar);
  const image = await validateDockerSaveTar(tar, {
    expectedRepoTag,
    expectedConfigId,
  });
  if (expectedRepoTag !== `ghcr.io/${required(options, "name")}:${version}`) {
    fail(`expected RepoTag ${expectedRepoTag} does not match release version ${version}`);
  }
  return image;
}

async function publishRelease(client, options) {
  const version = required(options, "version");
  const revision = required(options, "revision");
  if (!isStableSemver(version)) fail(`release version must be exact stable semver: ${version}`);
  if (!REVISION_RE.test(revision)) fail(`release revision must be full lowercase hex: ${revision}`);
  await client.probeFirstPackageIfAllowed();

  const local = await localImageFromOptions(options, version);
  const labels = localLabels(local);
  if (labels["org.opencontainers.image.version"] !== version) {
    fail("validated local image version label does not match the release version");
  }
  if (labels["org.opencontainers.image.revision"] !== revision) {
    fail("validated local image revision label does not match the release revision");
  }

  const semverState = await client.readTagState(version, {
    allowNameUnknown: client.allowFirstPackage,
  });
  const revisionState = await client.readTagState(revision, {
    allowNameUnknown: client.allowFirstPackage,
  });
  const repaired = [];
  let canonical;
  let canonicalKind = "remote";

  if (semverState && revisionState) {
    requireExactReleaseLabels(semverState, version, revision, `semver tag ${version}`);
    requireExactReleaseLabels(revisionState, version, revision, `revision tag ${revision}`);
    requireSameReleasePair(semverState, revisionState);
    canonical = semverState;
  } else if (semverState || revisionState) {
    const existing = semverState ?? revisionState;
    const missingTag = semverState ? revision : version;
    requireExactReleaseLabels(existing, version, revision, `existing release tag ${existing.ref}`);
    await client.putManifest(missingTag, existing.rawManifest);
    const repairedState = await client.readTagState(missingTag);
    if (!repairedState) fail(`repaired release tag ${missingTag} is missing after PUT`);
    requireExactReleaseLabels(repairedState, version, revision, `repaired release tag ${missingTag}`);
    requireSameManifestAndConfig(repairedState, existing, `repaired release tag ${missingTag}`);
    repaired.push(missingTag);
    canonical = existing;
  } else {
    canonicalKind = "local";
    for (const [digest, body] of local.blobs) {
      await client.uploadBlob(digest, body);
    }
    await client.putManifest(version, local.rawManifest);
    const afterSemver = await client.readTagState(version);
    if (!afterSemver) fail(`semver tag ${version} is missing after PUT`);
    requireExactReleaseLabels(afterSemver, version, revision, `semver tag ${version}`);
    requireSameManifestAndConfig(afterSemver, {
      manifestDigest: local.manifestDigest,
      configDigest: local.configDigest,
    }, `semver tag ${version} and local image`);

    await client.putManifest(revision, local.rawManifest);
    const afterRevision = await client.readTagState(revision);
    if (!afterRevision) fail(`revision tag ${revision} is missing after PUT`);
    requireExactReleaseLabels(afterRevision, version, revision, `revision tag ${revision}`);
    requireSameReleasePair(afterSemver, afterRevision);
    repaired.push(version, revision);
    canonical = afterSemver;
  }

  if (repaired.length > 0) {
    const postWriteSemver = await client.readTagState(version);
    const postWriteRevision = await client.readTagState(revision);
    if (!postWriteSemver || !postWriteRevision) {
      fail("post-write release pair is incomplete");
    }
    requireExactReleaseLabels(
      postWriteSemver,
      version,
      revision,
      `post-write semver tag ${version}`,
    );
    requireExactReleaseLabels(
      postWriteRevision,
      version,
      revision,
      `post-write revision tag ${revision}`,
    );
    requireSameReleasePair(postWriteSemver, postWriteRevision);
    requireSameManifestAndConfig(
      postWriteSemver,
      canonical,
      "post-write release pair and canonical image",
    );
    canonical = postWriteSemver;
  }

  return {
    version,
    revision,
    manifestDigest: canonical.manifestDigest,
    configDigest: canonical.configDigest,
    canonical: canonicalKind,
    repaired,
  };
}

async function inspectRelease(client, options) {
  const version = required(options, "version");
  const revision = required(options, "revision");
  if (!isStableSemver(version)) fail(`release version must be exact stable semver: ${version}`);
  if (!REVISION_RE.test(revision)) fail(`release revision must be full lowercase hex: ${revision}`);
  await client.probeFirstPackageIfAllowed();

  const semverState = await client.readTagState(version, {
    allowNameUnknown: client.allowFirstPackage,
  });
  const revisionState = await client.readTagState(revision, {
    allowNameUnknown: client.allowFirstPackage,
  });
  if (!semverState && !revisionState) {
    return { version, revision, status: "missing" };
  }
  if (semverState) requireExactReleaseLabels(semverState, version, revision, `semver tag ${version}`);
  if (revisionState) requireExactReleaseLabels(revisionState, version, revision, `revision tag ${revision}`);
  if (!semverState || !revisionState) {
    return {
      version,
      revision,
      status: "incomplete",
      present: semverState ? [version] : [revision],
      manifestDigest: (semverState ?? revisionState).manifestDigest,
      configDigest: (semverState ?? revisionState).configDigest,
    };
  }
  requireSameReleasePair(semverState, revisionState);
  return {
    version,
    revision,
    status: "complete",
    manifestDigest: semverState.manifestDigest,
    configDigest: semverState.configDigest,
  };
}

function clientFromOptions(options, scopeActions = "pull") {
  return new RegistryClient({
    registryUrl: required(options, "registry-url"),
    name: required(options, "name"),
    username: options.get("username") ?? process.env.GITHUB_ACTOR,
    password: options.get("password") ?? process.env.GITHUB_TOKEN,
    allowFirstPackage: options.get("allow-first-package") === "true",
    scopeActions,
  });
}

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === "select-latest") {
      const selected = await selectHighestCompleteRelease(clientFromOptions(options, "pull"));
      if (!selected) {
        process.stdout.write("null\n");
        return;
      }
      process.stdout.write(
        `${JSON.stringify({
          version: selected.version,
          revision: selected.revision,
          manifestDigest: selected.manifestDigest,
          configDigest: selected.configDigest,
        })}\n`,
      );
      return;
    }
    if (command === "reconcile-latest") {
      const selected = await reconcileLatest(clientFromOptions(options, "pull,push"));
      process.stdout.write(
        `${JSON.stringify({
          version: selected.version,
          revision: selected.revision,
          manifestDigest: selected.manifestDigest,
          configDigest: selected.configDigest,
          latest: selected.latest,
        })}\n`,
      );
      return;
    }
    if (command === "publish-release") {
      const published = await publishRelease(clientFromOptions(options, "pull,push"), options);
      process.stdout.write(`${JSON.stringify(published)}\n`);
      return;
    }
    if (command === "inspect-release") {
      const inspected = await inspectRelease(clientFromOptions(options, "pull"), options);
      process.stdout.write(`${JSON.stringify(inspected)}\n`);
      return;
    }
    fail(`unknown command: ${command}`);
  } catch (error) {
    if (error instanceof OciError) {
      console.error(`ghcr-oci-release: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export {
  RegistryClient,
  compareSemver,
  isStableSemver,
  isSupportedImageRelease,
  MAX_CONFIG_BYTES,
  MINIMUM_SUPPORTED_IMAGE_VERSION,
  requireSameReleasePair,
  reconcileLatest,
  publishRelease,
  inspectRelease,
  selectHighestCompleteRelease,
};
