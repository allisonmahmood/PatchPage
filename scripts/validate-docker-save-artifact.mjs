#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import * as zlib from "node:zlib";
import path from "node:path";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_LAYER_TAR_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar";
const OCI_LAYER_GZIP_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";
const OCI_LAYER_ZSTD_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+zstd";
const MAX_UNCOMPRESSED_LAYER_BYTES = 512 * 1024 * 1024;
const MAX_LAYER_EXPANSION_RATIO = 200;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(message) {
  throw new ValidationError(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
async function uncompressedLayerDigest(body, mediaType, index) {
  if (body.length === 0) fail(`OCI manifest layer ${index} blob is empty`);
  if (mediaType === OCI_LAYER_TAR_MEDIA_TYPE) {
    if (body.length > MAX_UNCOMPRESSED_LAYER_BYTES) {
      fail(`OCI manifest layer ${index} exceeds the uncompressed layer limit`);
    }
    return `sha256:${sha256(body)}`;
  }

  let decompressor;
  if (mediaType === OCI_LAYER_GZIP_MEDIA_TYPE) {
    decompressor = zlib.createGunzip();
  } else if (mediaType === OCI_LAYER_ZSTD_MEDIA_TYPE) {
    if (typeof zlib.createZstdDecompress !== "function") {
      fail(`OCI manifest layer ${index} uses zstd but this Node runtime cannot decompress it`);
    }
    decompressor = zlib.createZstdDecompress();
  } else {
    fail(`OCI manifest layer ${index} has unsupported mediaType ${mediaType}`);
  }

  const ratioLimit = body.length * MAX_LAYER_EXPANSION_RATIO;
  const outputLimit = Math.min(MAX_UNCOMPRESSED_LAYER_BYTES, ratioLimit);
  const hash = createHash("sha256");
  let outputBytes = 0;
  try {
    const stream = Readable.from([body]).pipe(decompressor);
    for await (const chunk of stream) {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        stream.destroy();
        fail(
          `OCI manifest layer ${index} exceeded the bounded decompression limit (${MAX_UNCOMPRESSED_LAYER_BYTES} bytes or ${MAX_LAYER_EXPANSION_RATIO}:1 expansion)`,
        );
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(`OCI manifest layer ${index} could not be decompressed: ${error.message}`);
  }
  if (outputBytes === 0) fail(`OCI manifest layer ${index} decompressed to an empty body`);
  return `sha256:${hash.digest("hex")}`;
}


function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail(`unexpected positional argument: ${key}`);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${name}`);
    options.set(name, value);
    index += 1;
  }

  const required = [
    "artifact-dir",
    "expected-filename",
    "expected-sha256",
    "expected-repo-tag",
    "expected-config-id",
  ];
  for (const key of required) {
    if (!options.has(key)) fail(`missing required option --${key}`);
  }

  return {
    artifactDir: options.get("artifact-dir"),
    expectedFilename: options.get("expected-filename"),
    expectedSha256: options.get("expected-sha256"),
    expectedRepoTag: options.get("expected-repo-tag"),
    expectedConfigId: options.get("expected-config-id"),
    maxBytes: Number(options.get("max-bytes") ?? DEFAULT_MAX_BYTES),
  };
}

function parseOctal(field, label) {
  const raw = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(raw)) fail(`invalid tar ${label} octal field`);
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function tarPath(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

function validateEntryPath(rawName) {
  if (rawName.length === 0) fail("tar entry has an empty path");
  if (rawName.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawName)) {
    fail(`tar entry uses an absolute path: ${rawName}`);
  }
  if (rawName.includes("\\")) fail(`tar entry uses backslashes: ${rawName}`);
  const trimmed = rawName.replace(/\/+$/, "");
  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.split("/").includes("..")
  ) {
    fail(`tar entry escapes the archive root: ${rawName}`);
  }
  return normalized;
}

function verifyChecksum(header, name) {
  const expected = parseOctal(header.subarray(148, 156), `checksum for ${name}`);
  const copy = Buffer.from(header);
  copy.fill(" ", 148, 156);
  let actual = 0;
  for (const byte of copy) actual += byte;
  if (actual !== expected) fail(`tar checksum mismatch for ${name}`);
}

function parseTar(buffer) {
  const files = new Map();
  const directories = new Set();
  const normalizedEntries = new Set();
  let offset = 0;
  let sawEnd = false;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      const next = buffer.subarray(offset + 512, offset + 1024);
      if (next.length < 512 || !isZeroBlock(next)) {
        fail("tar archive does not end with two zero blocks");
      }
      sawEnd = true;
      offset += 1024;
      break;
    }

    const rawName = tarPath(header);
    const name = validateEntryPath(rawName);
    if (normalizedEntries.has(name)) {
      fail(`tar archive contains a normalized duplicate entry: ${rawName}`);
    }
    normalizedEntries.add(name);
    verifyChecksum(header, rawName);

    const type = header.subarray(156, 157).toString("ascii") || "0";
    const size = parseOctal(header.subarray(124, 136), `size for ${rawName}`);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buffer.length) fail(`tar entry body is truncated: ${rawName}`);

    if (type === "0" || type === "\0") {
      files.set(name, buffer.subarray(bodyStart, bodyEnd));
    } else if (type === "5") {
      if (size !== 0) fail(`tar directory has a non-zero size: ${rawName}`);
      directories.add(name);
    } else if (type === "1" || type === "2") {
      fail(`tar entry is a link, which is not allowed: ${rawName}`);
    } else if (["3", "4", "6"].includes(type)) {
      fail(`tar entry is a device/FIFO, which is not allowed: ${rawName}`);
    } else {
      fail(`tar entry has an unsupported type ${JSON.stringify(type)}: ${rawName}`);
    }

    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  if (!sawEnd) fail("tar archive is missing its end-of-archive marker");
  if (buffer.subarray(offset).some((byte) => byte !== 0)) {
    fail("tar archive has non-zero trailing data after its end marker");
  }

  return { files, directories };
}

function parseJson(files, name) {
  const body = files.get(name);
  if (!body) fail(`docker-save archive is missing ${name}`);
  return parseJsonBuffer(body, name);
}

function parseJsonBuffer(body, label) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    fail(`${label} is not JSON: ${error.message}`);
  }
}

function expectDigest(value, label) {
  if (!DIGEST_RE.test(value)) fail(`${label} is not a full sha256 digest: ${value}`);
  return value;
}

function digestToPath(digest) {
  expectDigest(digest, "digest");
  return `blobs/sha256/${digest.slice("sha256:".length)}`;
}

function digestHex(digest) {
  expectDigest(digest, "digest");
  return digest.slice("sha256:".length);
}

function pathDigest(filePath, label) {
  const match = filePath.match(/^blobs\/sha256\/([0-9a-f]{64})$/);
  if (!match) fail(`${label} is not a sha256 blob path: ${filePath}`);
  return `sha256:${match[1]}`;
}

function splitRepoTag(repoTag) {
  const slash = repoTag.lastIndexOf("/");
  const colon = repoTag.lastIndexOf(":");
  if (colon <= slash) fail(`expected RepoTag is missing a tag: ${repoTag}`);
  return { repository: repoTag.slice(0, colon), tag: repoTag.slice(colon + 1) };
}

function verifyBlob(files, digest, referenced) {
  const filePath = digestToPath(digest);
  const body = files.get(filePath);
  if (!body) fail(`referenced blob is missing: ${filePath}`);
  const actual = `sha256:${sha256(body)}`;
  if (actual !== digest) fail(`blob ${filePath} hashes to ${actual}, not ${digest}`);
  referenced.add(filePath);
  return body;
}

function validateLegacyLayerConfigs(files, referenced, diffIds, config) {
  const v1KeyOrder = [
    "id",
    "parent",
    "comment",
    "created",
    "container",
    "container_config",
    "docker_version",
    "author",
    "config",
    "architecture",
    "variant",
    "os",
    "Size",
  ];
  const allowedKeys = new Set(v1KeyOrder);
  const optionalStringKeys = [
    "comment",
    "container",
    "docker_version",
    "author",
    "architecture",
    "variant",
  ];
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const goJson = (value) =>
    JSON.stringify(value).replace(
      /[<>&\u2028\u2029]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  const canonicalV1 = (legacy) => {
    const ordered = {};
    for (const key of v1KeyOrder) {
      if (hasOwn(legacy, key)) ordered[key] = legacy[key];
    }
    return ordered;
  };
  const nodes = [];
  const byId = new Map();

  for (const [filePath, body] of files) {
    if (!filePath.startsWith("blobs/sha256/") || referenced.has(filePath)) continue;

    const pathDigestValue = pathDigest(filePath, "legacy config blob");
    const actualDigest = `sha256:${sha256(body)}`;
    if (actualDigest !== pathDigestValue) {
      fail(`legacy config blob ${filePath} hashes to ${actualDigest}, not ${pathDigestValue}`);
    }

    const legacy = parseJsonBuffer(body, `legacy config blob ${filePath}`);
    if (!isObject(legacy)) {
      fail(`legacy config blob ${filePath} must be a JSON object`);
    }
    for (const key of Object.keys(legacy)) {
      if (!allowedKeys.has(key)) {
        fail(`legacy config blob ${filePath} has unexpected key ${key}`);
      }
    }

    const id = legacy.id;
    if (typeof id !== "string" || !HEX_RE.test(id)) {
      fail(`legacy config blob ${filePath} has an invalid id`);
    }
    if (byId.has(id)) fail(`duplicate legacy config id ${id}`);
    if (
      hasOwn(legacy, "parent") &&
      (typeof legacy.parent !== "string" || !HEX_RE.test(legacy.parent))
    ) {
      fail(`legacy config blob ${filePath} has an invalid parent`);
    }
    if (
      !hasOwn(legacy, "created") ||
      (legacy.created !== null && typeof legacy.created !== "string")
    ) {
      fail(`legacy config blob ${filePath} has an invalid created value`);
    }
    if (!isObject(legacy.container_config)) {
      fail(`legacy config blob ${filePath} has an invalid container_config`);
    }
    if (typeof legacy.os !== "string" || legacy.os.length === 0) {
      fail(`legacy config blob ${filePath} has an invalid os`);
    }
    for (const key of optionalStringKeys) {
      if (
        hasOwn(legacy, key) &&
        (typeof legacy[key] !== "string" || legacy[key].length === 0)
      ) {
        fail(`legacy config blob ${filePath} has an invalid ${key}`);
      }
    }
    if (hasOwn(legacy, "config") && !isObject(legacy.config)) {
      fail(`legacy config blob ${filePath} has an invalid config`);
    }
    if (
      hasOwn(legacy, "Size") &&
      (!Number.isSafeInteger(legacy.Size) || legacy.Size <= 0)
    ) {
      fail(`legacy config blob ${filePath} has an invalid Size`);
    }

    const canonicalBody = Buffer.from(goJson(canonicalV1(legacy)), "utf8");
    if (!body.equals(canonicalBody)) {
      fail(`legacy config blob ${filePath} is not canonical Moby V1 JSON`);
    }

    const node = { filePath, legacy, id, parent: legacy.parent };
    nodes.push(node);
    byId.set(id, node);
    referenced.add(filePath);
  }

  if (nodes.length !== diffIds.length) {
    fail(
      `docker-save archive must contain exactly ${diffIds.length} legacy configs, found ${nodes.length}`,
    );
  }

  const roots = nodes.filter((node) => node.parent === undefined);
  if (roots.length !== 1) {
    fail(`legacy config graph must contain exactly one parentless root, found ${roots.length}`);
  }
  const children = new Map();
  for (const node of nodes) {
    if (node.parent === undefined) continue;
    if (!byId.has(node.parent)) {
      fail(`legacy config ${node.filePath} references a missing parent ${node.parent}`);
    }
    if (children.has(node.parent)) {
      fail(`legacy config graph forks at parent ${node.parent}`);
    }
    children.set(node.parent, node);
  }

  const chain = [];
  const visited = new Set();
  let current = roots[0];
  while (current) {
    if (visited.has(current.id)) {
      fail(`legacy config graph contains a cycle at ${current.id}`);
    }
    visited.add(current.id);
    chain.push(current);
    current = children.get(current.id);
  }
  if (chain.length !== nodes.length) {
    fail(`legacy config graph contains disconnected nodes or a cycle`);
  }

  if (!isObject(config) || typeof config.os !== "string" || config.os.length === 0) {
    fail("OCI image config must contain a nonempty os for Moby legacy configs");
  }
  for (const [index, node] of chain.entries()) {
    if (node.legacy.os !== config.os) {
      fail(
        `legacy config ${node.filePath} operating system does not match OCI image config`,
      );
    }

    const isLeaf = index === chain.length - 1;
    for (const key of ["config", "architecture", "variant"]) {
      if (!isLeaf && hasOwn(node.legacy, key)) {
        fail(`non-leaf legacy config ${node.filePath} must not contain ${key}`);
      }
    }
  }

  const leaf = chain.at(-1);
  const leafRuntimeConfig = leaf.legacy.config;
  const ociRuntimeConfig = config.config;
  if (
    ociRuntimeConfig !== undefined &&
    ociRuntimeConfig !== null &&
    !isObject(ociRuntimeConfig)
  ) {
    fail("OCI image config has an invalid runtime config");
  }
  if (leafRuntimeConfig !== undefined && isObject(ociRuntimeConfig)) {
    const stableRuntimeFields = [
      "User",
      "Env",
      "Entrypoint",
      "Cmd",
      "WorkingDir",
      "Labels",
      "ExposedPorts",
      "Volumes",
      "Healthcheck",
      "StopSignal",
      "Shell",
      "OnBuild",
    ];
    for (const key of stableRuntimeFields) {
      if (
        hasOwn(ociRuntimeConfig, key) &&
        (!hasOwn(leafRuntimeConfig, key) ||
          !isDeepStrictEqual(leafRuntimeConfig[key], ociRuntimeConfig[key]))
      ) {
        fail(`leaf runtime config ${key} does not match OCI image config`);
      }
    }
  }
  for (const key of ["architecture", "variant"]) {
    if (hasOwn(leaf.legacy, key) && leaf.legacy[key] !== config[key]) {
      fail(`leaf ${key} does not match OCI image config`);
    }
  }

}

async function validateDockerSaveTar(buffer, { expectedRepoTag, expectedConfigId }) {
  expectDigest(expectedConfigId, "expected config ID");
  const { repository, tag } = splitRepoTag(expectedRepoTag);
  const { files, directories } = parseTar(buffer);

  for (const directory of directories) {
    if (directory !== "blobs" && directory !== "blobs/sha256") {
      fail(`unexpected directory in docker-save archive: ${directory}`);
    }
  }

  const dockerManifest = parseJson(files, "manifest.json");
  if (!Array.isArray(dockerManifest) || dockerManifest.length !== 1) {
    fail("manifest.json must contain exactly one image");
  }
  const [image] = dockerManifest;
  if (!image || typeof image !== "object") fail("manifest.json image is invalid");
  if (!Array.isArray(image.RepoTags) || image.RepoTags.length !== 1) {
    fail("manifest.json image must contain exactly one RepoTag");
  }
  if (image.RepoTags[0] !== expectedRepoTag) {
    fail(`manifest.json RepoTag ${image.RepoTags[0]} does not match ${expectedRepoTag}`);
  }
  if (typeof image.Config !== "string") fail("manifest.json image is missing Config");
  const configDigest = pathDigest(image.Config, "manifest.json Config");
  if (configDigest !== expectedConfigId) {
    fail(`manifest config ${configDigest} does not match ${expectedConfigId}`);
  }
  if (!Array.isArray(image.Layers) || image.Layers.length === 0) {
    fail("manifest.json image must contain at least one layer");
  }
  const layerDigests = image.Layers.map((layer, index) =>
    pathDigest(layer, `manifest.json Layers[${index}]`),
  );

  const referenced = new Set(["manifest.json", "repositories", "oci-layout", "index.json"]);
  const configBody = verifyBlob(files, configDigest, referenced);
  const layerBodies = layerDigests.map((digest) => verifyBlob(files, digest, referenced));

  const config = JSON.parse(configBody.toString("utf8"));
  const diffIds = config?.rootfs?.diff_ids;
  if (!Array.isArray(diffIds) || diffIds.length !== layerDigests.length) {
    fail("config rootfs.diff_ids must match the nonempty manifest layer graph");
  }

  const repositories = parseJson(files, "repositories");
  const repositoryNames = Object.keys(repositories ?? {});
  if (repositoryNames.length !== 1 || repositoryNames[0] !== repository) {
    fail(`repositories must contain exactly ${repository}`);
  }
  const repositoryTags = repositories?.[repository];
  if (!repositoryTags || typeof repositoryTags !== "object" || Array.isArray(repositoryTags)) {
    fail(`repositories entry for ${repository} is invalid`);
  }
  const tagNames = Object.keys(repositoryTags);
  if (tagNames.length !== 1 || tagNames[0] !== tag) {
    fail(`repositories must contain exactly ${expectedRepoTag}`);
  }

  const layout = parseJson(files, "oci-layout");
  if (layout?.imageLayoutVersion !== "1.0.0") fail("oci-layout must be version 1.0.0");

  const index = parseJson(files, "index.json");
  if (!Array.isArray(index?.manifests) || index.manifests.length !== 1) {
    fail("index.json must contain exactly one image manifest descriptor");
  }
  const descriptor = index.manifests[0];
  if (descriptor?.mediaType !== OCI_MANIFEST_MEDIA_TYPE) {
    fail(`index OCI manifest mediaType must be ${OCI_MANIFEST_MEDIA_TYPE}`);
  }
  const ociManifestDigest = expectDigest(descriptor?.digest, "index manifest digest");
  const ociManifestBody = verifyBlob(files, ociManifestDigest, referenced);
  if (descriptor.size !== ociManifestBody.length) {
    fail("index manifest descriptor size does not match its blob");
  }
  const refName = descriptor.annotations?.["org.opencontainers.image.ref.name"];
  if (refName !== undefined && refName !== tag && refName !== expectedRepoTag) {
    fail(`index manifest ref.name ${refName} does not match ${expectedRepoTag}`);
  }

  const ociManifest = JSON.parse(ociManifestBody.toString("utf8"));
  if (ociManifest?.mediaType !== OCI_MANIFEST_MEDIA_TYPE) {
    fail(`OCI manifest mediaType must be ${OCI_MANIFEST_MEDIA_TYPE}`);
  }
  if (Number(ociManifest.schemaVersion) !== 2) fail("OCI manifest schemaVersion must be 2");
  if (ociManifest?.config?.digest !== configDigest) {
    fail("OCI manifest config descriptor does not match manifest.json Config");
  }
  if (ociManifest.config.size !== configBody.length) {
    fail("OCI manifest config descriptor size does not match the config blob");
  }
  if (!Array.isArray(ociManifest.layers) || ociManifest.layers.length !== layerDigests.length) {
    fail("OCI manifest layers do not match manifest.json layer graph");
  }
  for (const [index, layer] of ociManifest.layers.entries()) {
    if (layer.digest !== layerDigests[index]) {
      fail(`OCI manifest layer ${index} does not match manifest.json`);
    }
    if (layer.size !== layerBodies[index].length) {
      fail(`OCI manifest layer ${index} size does not match its blob`);
    }
    const actualDiffId = await uncompressedLayerDigest(
      layerBodies[index],
      layer.mediaType,
      index,
    );
    if (diffIds[index] !== actualDiffId) {
      fail(
        `config rootfs.diff_ids[${index}] ${diffIds[index]} does not match uncompressed layer ${actualDiffId}`,
      );
    }
  }

  for (const filePath of files.keys()) {
    if (filePath.startsWith("blobs/sha256/")) {
      const hex = filePath.slice("blobs/sha256/".length);
      if (!HEX_RE.test(hex)) fail(`unsafe blob path in docker-save archive: ${filePath}`);
      const body = files.get(filePath);
      const actual = sha256(body);
      if (actual !== hex) {
        fail(`blob ${filePath} hashes to sha256:${actual}, not sha256:${hex}`);
      }
    }
  }

  validateLegacyLayerConfigs(files, referenced, diffIds, config);
  const expectedRepositoryLayer = diffIds.at(-1).slice("sha256:".length);
  if (repositoryTags[tag] !== expectedRepositoryLayer) {
    fail(
      `repositories ${expectedRepoTag} points to ${repositoryTags[tag]}, expected top uncompressed diff ID ${expectedRepositoryLayer}`,
    );
  }

  for (const filePath of files.keys()) {
    if (!referenced.has(filePath)) {
      fail(`unreferenced or unexpected file in docker-save archive: ${filePath}`);
    }
  }

  return {
    configDigest,
    layerDigests,
    manifestDigest: ociManifestDigest,
    rawManifest: ociManifestBody,
    blobs: new Map([
      [configDigest, configBody],
      ...layerDigests.map((digest, index) => [digest, layerBodies[index]]),
    ]),
  };
}

async function validateArtifact(options) {
  if (!DIGEST_RE.test(options.expectedConfigId)) {
    fail(`--expected-config-id must be a full sha256 digest`);
  }
  if (!HEX_RE.test(options.expectedSha256)) {
    fail(`--expected-sha256 must be 64 lowercase hex characters`);
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    fail("--max-bytes must be a positive safe integer");
  }

  const dirStat = await stat(options.artifactDir);
  if (!dirStat.isDirectory()) fail("--artifact-dir must be a directory");
  const entries = await readdir(options.artifactDir, { withFileTypes: true });
  if (entries.length !== 1) {
    fail(`artifact directory must contain exactly one entry, found ${entries.length}`);
  }
  const [entry] = entries;
  if (entry.name !== options.expectedFilename) {
    fail(`artifact filename ${entry.name} does not match ${options.expectedFilename}`);
  }
  if (!entry.isFile()) fail("artifact entry must be a regular file");

  const tarPath = path.join(options.artifactDir, entry.name);
  const linkStat = await lstat(tarPath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    fail("artifact entry must not be a symlink or special file");
  }
  if (linkStat.nlink !== 1) fail("artifact entry must not be hardlinked");
  if (linkStat.size <= 0 || linkStat.size > options.maxBytes) {
    fail(`artifact file size ${linkStat.size} is outside the allowed bound`);
  }

  const tar = await readFile(tarPath);
  const actualSha256 = sha256(tar);
  if (actualSha256 !== options.expectedSha256) {
    fail("artifact file SHA-256 does not match the verified handoff digest");
  }
  const image = await validateDockerSaveTar(tar, options);
  return { path: tarPath, sha256: actualSha256, image };
}

async function main() {
  try {
    const result = await validateArtifact(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `validated docker-save artifact ${path.basename(result.path)} (${result.sha256})\n`,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`validate-docker-save-artifact: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { validateArtifact, validateDockerSaveTar };
