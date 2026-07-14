#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const REVIEWED_ALLOWLIST = Object.freeze({
  gitCommitterIdentitySha256s: Object.freeze([
    "b04e69a0929f93035334e4ba422772dfd4966cd4e693f767e04a1f3e9011c577",
    "a41b65ba81bfb1a3250274b0bd325be0cc7ae3ea8af07798ca77cb7920468ffc"
  ]),
  gitEmailSha256: "299ff4fb5cc1be8a13381a254f8ee401dbe2735434a5222fdd924187631047e9",
  gitIdentitySha256: "b04e69a0929f93035334e4ba422772dfd4966cd4e693f767e04a1f3e9011c577",
  packageAuthorSha256: "5eedb5b62ca4cdf1419644d50aba297991d12b6393bd953c665e8e87c52ec397"
});
const EMAIL_RE =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;
const HOME_PATH_RE =
  /(?:^|[\s"'`=:(])((?:file:\/\/)?(?:~(?:\/[^/\\\s"'`),;]*)+|\/Users\/[^/\\\s"'`),;]+(?:\/[^/\\\s"'`),;]*)+|\/home\/[^/\\\s"'`),;]+(?:\/[^/\\\s"'`),;]*)+|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`),;]+(?:[\\/][^\\/\s"'`),;]*)*))/gi;
const TEMP_BUILD_PATH_RE =
  /(?:^|[\s"'`=:(])((?:file:\/\/)?(?:\/private\/(?:var\/)?folders\/[^/\\\s"'`),;]+|\/private\/tmp(?:\/[^/\\\s"'`),;]+)+|\/var\/folders\/[^/\\\s"'`),;]+(?:\/[^/\\\s"'`),;]*)*|\/var\/tmp(?:\/[^/\\\s"'`),;]+)+|\/tmp\/[^/\\\s"'`),;]+(?:\/[^/\\\s"'`),;]*)*|[A-Za-z]:[\\/](?:Windows[\\/]Temp|Temp|Users[\\/][^\\/\s"'`),;]+[\\/]AppData[\\/]Local[\\/]Temp)(?:[\\/][^\\/\s"'`),;]*)*|%(?:TEMP|TMP)%[\\/][^\\/\s"'`),;]+(?:[\\/][^\\/\s"'`),;]*)*))/gi;
const PRIVATE_ARTIFACT_TEXT_RE =
  /(?:^|[\s"'`=:(])(?:\.?\/)?(?:[\w.-]+\/){0,8}(?:trans(?:)cript|trans(?:)ript|sess(?:)ions?|conver(?:)sation|roll(?:)out)(?:[-_. ][\w.-]+)?(?:\.(?:txt|jsonl|json|md|log|html?|zip|tgz|gz|tar(?:\.gz)?))?(?=$|[\s"'`),;])/gi;
const PRIVATE_ARTIFACT_COMPONENT_RE =
  /^(?:[^/]*?(?:trans(?:)cript|trans(?:)ript)(?:[-_.][^/]*)?|(?:sess(?:)ion|sess(?:)ions|conver(?:)sation|roll(?:)out)(?:[-_.][^/]*)?)(?:\.(?:txt|jsonl|json|md|log|html?|zip|tgz|gz|tar(?:\.gz)?))?$/i;
const PRIVATE_IDENTIFIER_FIELD_RE =
  /(?:^|[\s{,;])["']?(?:sess(?:)ion|conver(?:)sation|roll(?:)out)(?:[-_ ]?(?:id|identifier)|Id|ID)["']?\s*[:=]/gi;
const PRIVATE_IDENTIFIER_KEY_RE =
  /^(?:sess(?:)ion|conver(?:)sation|roll(?:)out)(?:[-_]?(?:id|identifier))$/i;
const PRIVATE_ARTIFACT_CATEGORY = `${"sess"}${"ion"}-export`;
const PRIVATE_ARTIFACT_PATH_CATEGORY = `${PRIVATE_ARTIFACT_CATEGORY}-path`;
const PRIVATE_IDENTIFIER_CATEGORY = `${"sess"}${"ion"}-identifier-field`;
const LOCAL_NPM_FIELDS = new Set(["_where", "_resolved", "_integrity", "_npmOperationalInternal"]);
const PAX_ALLOWED_KEYS = new Set(["gid", "gname", "linkpath", "path", "uid", "uname"]);
const PAX_DUPLICATE_KEY = Symbol("pax-duplicate-key");
const REVIEWED_TAR_ENTRY_TYPES = new Set(["0", "1", "2", "5", "x", "g", "L", "K"]);
const RESERVED_EXAMPLE_EMAIL_DOMAINS = new Set(["example.com", "example.net", "example.org"]);
const TRACKED_TEMP_EXEMPTIONS = new Set([
  "scripts/packed-cli-e2e.mjs\u0000/tmp/consumer/node_modules/.bin/patchpage",
  "scripts/verify-release-workflow.mjs\u0000/tmp/attacker.cjs",
  "scripts/verify-release-workflow.mjs\u0000/tmp/attacker.tgz"
]);
const TRACKED_HOME_EXEMPTIONS = new Set([
  ".agents/skills/patchpage-mint-token/SKILL.md\u0000~/.patchpage/credentials.json",
  "docs/PLAN.md\u0000~/.patchpage",
  "packages/cli/README.md\u0000~/.patchpage",
  "skills/patchpage/SKILL.md\u0000~/.patchpage"
]);
const TAR_HOME_EXEMPTIONS = new Set([
  "package/README.md\u0000~/.patchpage",
  "package/skills/patchpage/SKILL.md\u0000~/.patchpage"
]);
const DEFAULT_TRACKED_TEXT_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TAR_TEXT_LIMIT_BYTES = 10 * 1024 * 1024;

class PrivacyCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "PrivacyCheckError";
  }
}

function fail(message) {
  throw new PrivacyCheckError(message);
}

function repoDefaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function reviewedIdentityForTests({
  gitCommitterEmail,
  gitCommitterName,
  gitEmail,
  gitName,
  packageAuthor,
  reviewedCommitters = []
}) {
  gitCommitterEmail ??= gitEmail;
  gitCommitterName ??= gitName;
  const parsedPackageAuthor = parseAuthor(packageAuthor);
  if (!parsedPackageAuthor) fail("test package author metadata is invalid");
  const committerDigests = [
    { email: gitEmail, name: gitName },
    { email: gitCommitterEmail, name: gitCommitterName },
    ...reviewedCommitters
  ].map(({ email, name }) => sha256(`${name}\0${email}`));
  return Object.freeze({
    gitCommitterIdentitySha256s: Object.freeze([...new Set(committerDigests)]),
    gitEmailSha256: sha256(gitEmail),
    gitIdentitySha256: sha256(`${gitName}\0${gitEmail}`),
    packageAuthorSha256: packageAuthorDigest(parsedPackageAuthor)
  });
}

function normalizeAllowlist(allowlist) {
  const candidate = allowlist ?? REVIEWED_ALLOWLIST;
  for (const key of ["gitEmailSha256", "gitIdentitySha256", "packageAuthorSha256"]) {
    if (typeof candidate[key] !== "string" || !/^[0-9a-f]{64}$/.test(candidate[key])) {
      fail("reviewed release privacy identity source is invalid");
    }
  }
  if (
    !Array.isArray(candidate.gitCommitterIdentitySha256s) ||
    candidate.gitCommitterIdentitySha256s.length !==
      new Set(candidate.gitCommitterIdentitySha256s).size ||
    !candidate.gitCommitterIdentitySha256s.every(
      (digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)
    )
  ) {
    fail("reviewed release privacy identity source is invalid");
  }
  return candidate;
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail("unexpected positional argument");
    const name = key.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${name}`);
    options.set(name, value);
    index += 1;
  }

  if (!options.has("pack-json")) fail("missing required option --pack-json");
  if (!options.has("tarball")) fail("missing required option --tarball");

  return {
    packJsonPath: options.get("pack-json"),
    repoRoot:
      options.get("repo-root") ??
      process.env.PATCHPAGE_RELEASE_PRIVACY_REPO_ROOT ??
      repoDefaultRoot(),
    tarballPath: options.get("tarball")
  };
}

function isMapping(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

function parseAuthor(value) {
  if (typeof value === "string") {
    const match = value.match(/^\s*([^<>()]+?)(?:\s*<([^<>\s]+@[^<>\s]+)>)?(?:\s*\([^()]*\))?\s*$/);
    if (!match) return null;
    return {
      email: match[2] ?? null,
      name: match[1].trim()
    };
  }

  if (isMapping(value) && typeof value.name === "string") {
    return {
      email: typeof value.email === "string" ? value.email : null,
      name: value.name.trim()
    };
  }

  return null;
}

function git(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    fail("git metadata is unavailable");
  }
  return result.stdout;
}

function gitIdentityDigest(name, email) {
  return sha256(`${name}\0${email}`);
}

function packageAuthorDigest(author) {
  return sha256(`${author.name}\0${author.email ?? ""}`);
}

function add(failures, category, location) {
  failures.push({ category, location });
}

function arrayJsonLocation(base, index) {
  return `${base}/${index}`;
}

function fieldJsonLocation(base, index) {
  return `${base}/field${index + 1}`;
}

function stringLocation(base) {
  return base.length === 0 ? "/" : base;
}

function isAllowedEmail(email, allowlist) {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return sha256(email) === allowlist.gitEmailSha256 || RESERVED_EXAMPLE_EMAIL_DOMAINS.has(domain);
}

function isAllowedIdentity(name, email, allowlist) {
  return gitIdentityDigest(name.trim(), email) === allowlist.gitIdentitySha256;
}

function isAllowedCommitterIdentity(name, email, allowlist) {
  return allowlist.gitCommitterIdentitySha256s.includes(gitIdentityDigest(name.trim(), email));
}

function isAllowedTrackedTempPath(tempPath, source, context) {
  const normalizedTempPath = tempPath.replace(/\\+$/g, "");
  return (
    source.startsWith("tracked-") &&
    typeof context.trackedPath === "string" &&
    TRACKED_TEMP_EXEMPTIONS.has(`${context.trackedPath}\0${normalizedTempPath}`)
  );
}

function isAllowedHomePath(homePath, source, context) {
  const normalizedHomePath = homePath.replace(/\\+$/g, "");
  if (source.startsWith("tracked-") && typeof context.trackedPath === "string") {
    return TRACKED_HOME_EXEMPTIONS.has(`${context.trackedPath}\0${normalizedHomePath}`);
  }
  if (source.startsWith("tar-") && typeof context.tarEntryName === "string") {
    return TAR_HOME_EXEMPTIONS.has(`${context.tarEntryName}\0${normalizedHomePath}`);
  }
  return false;
}

function hasUnallowedHomePath(value, source, context) {
  HOME_PATH_RE.lastIndex = 0;
  for (const match of value.matchAll(HOME_PATH_RE)) {
    if (!isAllowedHomePath(match[1], source, context)) {
      HOME_PATH_RE.lastIndex = 0;
      return true;
    }
  }
  HOME_PATH_RE.lastIndex = 0;
  return false;
}

function hasUnallowedTempPath(value, source, context) {
  TEMP_BUILD_PATH_RE.lastIndex = 0;
  for (const match of value.matchAll(TEMP_BUILD_PATH_RE)) {
    if (!isAllowedTrackedTempPath(match[1], source, context)) {
      TEMP_BUILD_PATH_RE.lastIndex = 0;
      return true;
    }
  }
  TEMP_BUILD_PATH_RE.lastIndex = 0;
  return false;
}

function scanString(value, location, allowlist, failures, source, context = {}) {
  for (const match of value.matchAll(EMAIL_RE)) {
    if (!isAllowedEmail(match[0], allowlist)) {
      add(failures, `${source}-email`, location);
    }
  }

  if (hasUnallowedHomePath(value, source, context)) {
    add(failures, `${source}-home-path`, location);
  }

  if (hasUnallowedTempPath(value, source, context)) {
    add(failures, `${source}-temp-build-path`, location);
  }

  if (PRIVATE_ARTIFACT_TEXT_RE.test(value)) {
    add(failures, `${source}-${PRIVATE_ARTIFACT_CATEGORY}`, location);
  }
  PRIVATE_ARTIFACT_TEXT_RE.lastIndex = 0;

  if (PRIVATE_IDENTIFIER_FIELD_RE.test(value)) {
    add(failures, `${source}-${PRIVATE_IDENTIFIER_CATEGORY}`, location);
  }
  PRIVATE_IDENTIFIER_FIELD_RE.lastIndex = 0;
}

function scanJson(value, location, allowlist, failures, source, context = {}) {
  if (typeof value === "string") {
    scanString(value, stringLocation(location), allowlist, failures, source, context);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanJson(item, arrayJsonLocation(location, index), allowlist, failures, source, context)
    );
    return;
  }
  if (!isMapping(value)) return;

  for (const [index, [key, field]] of Object.entries(value).entries()) {
    const childLocation = fieldJsonLocation(location, index);
    scanString(key, childLocation, allowlist, failures, `${source}-key`, context);
    if (PRIVATE_IDENTIFIER_KEY_RE.test(key)) {
      add(failures, `${source}-${PRIVATE_IDENTIFIER_CATEGORY}`, childLocation);
    }
    if (LOCAL_NPM_FIELDS.has(key)) {
      add(failures, `${source}-npm-local-field`, childLocation);
    }
    scanJson(field, childLocation, allowlist, failures, source, context);
  }
}

function scanPackageAuthor(value, allowlist, failures, source, location) {
  const author = parseAuthor(value);
  if (!author || packageAuthorDigest(author) !== allowlist.packageAuthorSha256) {
    add(failures, `${source}-author`, location);
  }
}

function isLikelyText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    TEXT_DECODER.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function decodeText(buffer) {
  return TEXT_DECODER.decode(buffer);
}

function decodeSignatureText(buffer) {
  if (isLikelyText(buffer)) return decodeText(buffer);
  return buffer
    .toString("latin1")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u00ff]+/g, " ");
}

function decodeRequiredUtf8(buffer, label) {
  try {
    return decodeText(buffer);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
}

function safeTrackedLocation(index) {
  return `tracked entry #${index + 1}`;
}

function safeTarLocation(index) {
  return `tar entry #${index + 1}`;
}

function scanPrivateArtifactPathComponents(value, failures, source, location) {
  const pathComponents = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (pathComponents.some((component) => PRIVATE_ARTIFACT_COMPONENT_RE.test(component))) {
    add(failures, `${source}-${PRIVATE_ARTIFACT_PATH_CATEGORY}`, location);
  }
}

function scanPathName(relativePath, allowlist, failures, source, location, context = {}) {
  for (const match of relativePath.matchAll(EMAIL_RE)) {
    if (!isAllowedEmail(match[0], allowlist)) {
      add(failures, `${source}-email`, location);
    }
  }

  scanPrivateArtifactPathComponents(relativePath, failures, source, location);
  if (hasUnallowedHomePath(relativePath, source, context)) {
    add(failures, `${source}-home-path`, location);
  }
  if (hasUnallowedTempPath(relativePath, source, context)) {
    add(failures, `${source}-temp-build-path`, location);
  }
}

async function trackedFiles(repoRoot) {
  const output = git(repoRoot, ["ls-files", "-z"]);
  return output.split("\0").filter(Boolean);
}

async function scanTrackedText(repoRoot, allowlist, failures, trackedTextLimitBytes) {
  const files = await trackedFiles(repoRoot);
  for (const [index, relativePath] of files.entries()) {
    const safeLocation = safeTrackedLocation(index);
    const context = { trackedPath: relativePath };
    scanPathName(
      relativePath,
      allowlist,
      failures,
      "tracked-path",
      `tracked path #${index + 1}`,
      context
    );

    const absolutePath = path.join(repoRoot, relativePath);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      scanString(target, safeLocation, allowlist, failures, "tracked-text", context);
      scanPrivateArtifactPathComponents(target, failures, "tracked-text", safeLocation);
      continue;
    }
    if (!stats.isFile()) continue;
    if (stats.size > trackedTextLimitBytes) {
      add(failures, "tracked-text-size-limit", safeLocation);
      continue;
    }

    const body = await readFile(absolutePath);
    const isReviewedText = isLikelyText(body);
    scanString(
      decodeSignatureText(body),
      safeLocation,
      allowlist,
      failures,
      "tracked-text",
      context
    );
    if (!isReviewedText) {
      add(failures, "tracked-binary-unreviewed", safeLocation);
    }

    if (relativePath.endsWith(".json")) {
      try {
        const text = decodeText(body);
        scanJson(JSON.parse(text), safeLocation, allowlist, failures, "tracked-json", context);
      } catch {
        add(failures, "tracked-json-invalid", safeLocation);
      }
    }
  }
}

function parseOctal(field, label) {
  const raw = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(raw)) fail(`invalid tar ${label} octal field`);
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function tarHeaderString(field, label) {
  const end = field.indexOf(0);
  const value = end === -1 ? field : field.subarray(0, end);
  try {
    return decodeText(value);
  } catch {
    fail(`invalid tar ${label} utf-8 field`);
  }
}

function tarPath(header) {
  const name = tarHeaderString(header.subarray(0, 100), "name");
  const prefix = tarHeaderString(header.subarray(345, 500), "prefix");
  return prefix ? `${prefix}/${name}` : name;
}

function isTarLinkType(type) {
  return type === "1" || type === "2";
}

function isTarMetadataType(type) {
  return type === "x" || type === "g" || type === "L" || type === "K";
}

function isAbsolutePathName(value) {
  return value.startsWith("/") || value.startsWith("file:///") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasTraversalPathSegment(value) {
  return value.split(/[\\/]+/).includes("..");
}

function decodeOptionalUtf8(buffer) {
  try {
    return decodeText(buffer);
  } catch {
    return null;
  }
}

function validateGzipEnvelope(buffer) {
  if (
    buffer.length < 10 ||
    buffer[0] !== 0x1f ||
    buffer[1] !== 0x8b ||
    buffer[2] !== 8 ||
    buffer[3] !== 0 ||
    buffer[4] !== 0 ||
    buffer[5] !== 0 ||
    buffer[6] !== 0 ||
    buffer[7] !== 0 ||
    buffer[8] !== 2 ||
    buffer[9] !== 255
  ) {
    fail("gzip envelope is not the reviewed minimal form");
  }
}

function decompressReviewedGzipMember(buffer) {
  validateGzipEnvelope(buffer);

  let rawResult;
  try {
    rawResult = inflateRawSync(buffer.subarray(10), { info: true });
  } catch {
    fail("gzip member is malformed");
  }

  const compressedBytes = rawResult.engine.bytesWritten;
  const memberEnd = 10 + compressedBytes + 8;
  if (!Number.isSafeInteger(compressedBytes) || memberEnd !== buffer.length) {
    fail("gzip envelope must contain exactly one reviewed member");
  }

  try {
    return gunzipSync(buffer);
  } catch {
    fail("gzip member is malformed");
  }
}

function parseTar(buffer) {
  const entries = [];
  let offset = 0;

  while (true) {
    if (offset + 512 > buffer.length) {
      fail("tar archive is missing the canonical end marker");
    }
    const header = buffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      const secondZeroOffset = offset + 512;
      if (secondZeroOffset + 512 > buffer.length) {
        fail("tar archive is missing the canonical end marker");
      }
      if (!isZeroBlock(buffer.subarray(secondZeroOffset, secondZeroOffset + 512))) {
        fail("tar archive is missing the canonical end marker");
      }
      if (buffer.subarray(secondZeroOffset + 512).some((byte) => byte !== 0)) {
        fail("tar archive has nonzero trailing data");
      }
      break;
    }

    const name = tarPath(header);
    const type = tarHeaderString(header.subarray(156, 157), "typeflag") || "0";
    const uid = parseOctal(header.subarray(108, 116), `uid for entry`);
    const gid = parseOctal(header.subarray(116, 124), `gid for entry`);
    const uname = tarHeaderString(header.subarray(265, 297), "uname");
    const gname = tarHeaderString(header.subarray(297, 329), "gname");
    const size = parseOctal(header.subarray(124, 136), `size for entry`);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const alignedBodyEnd = bodyStart + Math.ceil(size / 512) * 512;
    if (bodyEnd > buffer.length || alignedBodyEnd > buffer.length) {
      fail("tar entry body is truncated");
    }
    if (buffer.subarray(bodyEnd, alignedBodyEnd).some((byte) => byte !== 0)) {
      fail(`tar entry #${entries.length + 1} has nonzero alignment padding`);
    }

    const linkName = isTarLinkType(type)
      ? tarHeaderString(header.subarray(157, 257), "linkname")
      : null;
    entries.push({
      body: buffer.subarray(bodyStart, bodyEnd),
      header,
      linkName,
      name,
      owner: { gid, gname, uid, uname },
      type
    });
    offset = alignedBodyEnd;
  }

  return entries;
}

function scanTarLinkTarget(linkName, allowlist, failures, location) {
  if (!linkName) {
    add(failures, "tar-link-missing-target", location);
    return;
  }

  if (isAbsolutePathName(linkName)) {
    add(failures, "tar-link-absolute-path", location);
  }
  if (hasTraversalPathSegment(linkName)) {
    add(failures, "tar-link-traversal-path", location);
  }

  scanString(linkName, location, allowlist, failures, "tar-link");
  scanPrivateArtifactPathComponents(linkName, failures, "tar-link", location);
}

function scanTarEntryPath(entryName, allowlist, failures, location) {
  const context = { tarEntryName: entryName };
  scanPathName(entryName, allowlist, failures, "tar-entry", location, context);
  if (entryName.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entryName)) {
    add(failures, "tar-entry-absolute-path", location);
  }
  if (hasTraversalPathSegment(entryName)) {
    add(failures, "tar-entry-traversal-path", location);
  }
}

function parsePaxOwnerNumber(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function paxOwnerOverrides(records) {
  const owner = {};
  for (const key of ["uid", "gid", "uname", "gname"]) {
    if (records.has(key)) owner[key] = records.get(key);
  }
  return Object.keys(owner).length === 0 ? null : owner;
}

function validateOwnerFields(owner, failures, location) {
  if (owner.uid !== 0) add(failures, "tar-owner-uid", location);
  if (owner.gid !== 0) add(failures, "tar-owner-gid", location);
  if (owner.uname !== "") add(failures, "tar-owner-uname", location);
  if (owner.gname !== "") add(failures, "tar-owner-gname", location);
}

function normalizePaxOwnerOverrides(ownerOverrides, failures, location) {
  if (ownerOverrides === null) return null;
  const owner = {};
  let valid = true;
  let uidValid = true;
  let gidValid = true;

  if (ownerOverrides.uid !== undefined) {
    const parsed = parsePaxOwnerNumber(ownerOverrides.uid);
    if (parsed === null) {
      add(failures, "tar-owner-uid", location);
      uidValid = false;
      valid = false;
    } else {
      owner.uid = parsed;
    }
  }
  if (ownerOverrides.gid !== undefined) {
    const parsed = parsePaxOwnerNumber(ownerOverrides.gid);
    if (parsed === null) {
      add(failures, "tar-owner-gid", location);
      gidValid = false;
      valid = false;
    } else {
      owner.gid = parsed;
    }
  }
  if (ownerOverrides.uname !== undefined) owner.uname = ownerOverrides.uname;
  if (ownerOverrides.gname !== undefined) owner.gname = ownerOverrides.gname;

  if (uidValid && owner.uid !== undefined && owner.uid !== 0) {
    add(failures, "tar-owner-uid", location);
    valid = false;
  }
  if (gidValid && owner.gid !== undefined && owner.gid !== 0) {
    add(failures, "tar-owner-gid", location);
    valid = false;
  }
  if (owner.uname !== undefined && owner.uname !== "") {
    add(failures, "tar-owner-uname", location);
    valid = false;
  }
  if (owner.gname !== undefined && owner.gname !== "") {
    add(failures, "tar-owner-gname", location);
    valid = false;
  }

  return valid ? owner : null;
}

function parsePaxRecords(body) {
  const values = new Map();
  let offset = 0;

  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) return null;
    const lengthText = body.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) return null;
    const length = Number.parseInt(lengthText, 10);
    const nextOffset = offset + length;
    if (nextOffset > body.length || body[nextOffset - 1] !== 0x0a) return null;

    const payload = body.subarray(space + 1, nextOffset - 1);
    const equals = payload.indexOf(0x3d);
    if (equals === -1) return null;
    const key = payload.subarray(0, equals).toString("ascii");
    const value = decodeOptionalUtf8(payload.subarray(equals + 1));
    if (value === null) return null;
    if (values.has(key)) return PAX_DUPLICATE_KEY;
    values.set(key, value);
    offset = nextOffset;
  }

  return values;
}

function parseGnuLongValue(body) {
  const end = body.indexOf(0);
  const value = decodeOptionalUtf8(end === -1 ? body : body.subarray(0, end));
  return value && value.length > 0 ? value : null;
}

function scanTarMetadataBody(entry, allowlist, failures, location, tarTextLimitBytes) {
  if (entry.body.length === 0) {
    if (isTarMetadataType(entry.type)) {
      add(failures, "tar-metadata-invalid", location);
    }
    return { linkName: null, name: null, owner: null };
  }
  if (entry.body.length > tarTextLimitBytes) {
    add(failures, "tar-metadata-size-limit", location);
    return { linkName: null, name: null, owner: null };
  }

  scanString(decodeSignatureText(entry.body), location, allowlist, failures, "tar-metadata");

  if (entry.type === "x" || entry.type === "g") {
    const records = parsePaxRecords(entry.body);
    if (records === PAX_DUPLICATE_KEY) {
      add(failures, "tar-metadata-duplicate-key", location);
      return { linkName: null, name: null, owner: null };
    }
    if (records === null) {
      add(failures, "tar-metadata-invalid", location);
      return { linkName: null, name: null, owner: null };
    }

    for (const key of records.keys()) {
      if (!PAX_ALLOWED_KEYS.has(key)) {
        add(failures, "tar-metadata-unsupported", location);
        return { linkName: null, name: null, owner: null };
      }
    }

    const name = records.get("path") ?? null;
    const linkName = records.get("linkpath") ?? null;
    const rawOwner = paxOwnerOverrides(records);
    const owner = normalizePaxOwnerOverrides(rawOwner, failures, location);
    if (entry.type === "g" && (name !== null || linkName !== null)) {
      add(failures, "tar-metadata-unsupported", location);
      return { linkName: null, name: null, owner: null };
    }
    if (entry.type === "g" && rawOwner !== null) {
      add(failures, "tar-owner-pax-global-unsupported", location);
      return { linkName: null, name: null, owner: null };
    }
    return { linkName, name, owner };
  }

  if (entry.type === "L") {
    const name = parseGnuLongValue(entry.body);
    if (name === null) add(failures, "tar-metadata-invalid", location);
    return { linkName: null, name, owner: null };
  }

  if (entry.type === "K") {
    const linkName = parseGnuLongValue(entry.body);
    if (linkName === null) add(failures, "tar-metadata-invalid", location);
    return { linkName, name: null, owner: null };
  }

  add(failures, "tar-metadata-unsupported", location);
  return { linkName: null, name: null, owner: null };
}

async function scanPackJson(packJsonPath, allowlist, failures) {
  const packJson = parseJson(
    decodeRequiredUtf8(await readFile(packJsonPath), "npm pack JSON"),
    "npm pack JSON"
  );
  if (!Array.isArray(packJson) || packJson.length !== 1 || !isMapping(packJson[0])) {
    add(failures, "pack-json-shape", "pack-json");
    return null;
  }

  scanJson(packJson, "pack-json", allowlist, failures, "pack-json");

  const [pack] = packJson;
  if (!Array.isArray(pack.files)) {
    add(failures, "pack-json-files-shape", "pack-json/files");
    return pack;
  }
  for (const [index, file] of pack.files.entries()) {
    if (!isMapping(file) || typeof file.path !== "string") {
      add(failures, "pack-json-file-shape", `pack-json/files/${index}`);
      continue;
    }
    scanPathName(file.path, allowlist, failures, "pack-json-path", `pack-json/files/${index}/path`);
  }

  return pack;
}

async function scanTarball(tarballPath, allowlist, failures, tarTextLimitBytes) {
  const gzipArchive = await readFile(tarballPath);
  const archive = decompressReviewedGzipMember(gzipArchive);
  const entries = parseTar(archive);
  let packageJson = null;
  let pendingLinkName = null;
  let pendingName = null;
  let pendingOwner = null;

  for (const [index, entry] of entries.entries()) {
    const location = safeTarLocation(index);
    const isMetadata = isTarMetadataType(entry.type);
    const effectiveName = !isMetadata && pendingName !== null ? pendingName : entry.name;
    const effectiveLinkName =
      !isMetadata && pendingLinkName !== null ? pendingLinkName : entry.linkName;
    const context = { tarEntryName: effectiveName };
    scanString(decodeSignatureText(entry.header), location, allowlist, failures, "tar-header");
    validateOwnerFields(entry.owner, failures, location);
    if (!isMetadata && pendingOwner !== null) {
      validateOwnerFields({ ...entry.owner, ...pendingOwner }, failures, location);
    }
    scanTarEntryPath(effectiveName, allowlist, failures, location);
    if (!isMetadata && effectiveName !== entry.name) {
      scanTarEntryPath(entry.name, allowlist, failures, location);
    }

    if (!REVIEWED_TAR_ENTRY_TYPES.has(entry.type)) {
      add(failures, "tar-entry-type-unsupported", location);
      pendingName = null;
      pendingLinkName = null;
      pendingOwner = null;
      continue;
    }

    if (effectiveLinkName !== null) {
      scanTarLinkTarget(effectiveLinkName, allowlist, failures, location);
    }
    if (!isMetadata && entry.linkName !== null && entry.linkName !== effectiveLinkName) {
      scanTarLinkTarget(entry.linkName, allowlist, failures, location);
    }

    if (isMetadata) {
      const metadata = scanTarMetadataBody(entry, allowlist, failures, location, tarTextLimitBytes);
      pendingName = metadata.name ?? pendingName;
      pendingLinkName = metadata.linkName ?? pendingLinkName;
      if (metadata.owner !== null) {
        pendingOwner = { ...pendingOwner, ...metadata.owner };
      }
      continue;
    }

    const isRegularFile = entry.type === "0";
    if (!isRegularFile) {
      if (entry.body.length > 0) {
        scanTarMetadataBody(entry, allowlist, failures, location, tarTextLimitBytes);
      }
      pendingName = null;
      pendingLinkName = null;
      pendingOwner = null;
      continue;
    }
    if (entry.body.length > tarTextLimitBytes) {
      add(failures, "tar-text-size-limit", location);
      pendingName = null;
      pendingLinkName = null;
      pendingOwner = null;
      continue;
    }

    const isReviewedText = isLikelyText(entry.body);
    if (effectiveName === "package/package.json") {
      if (!isReviewedText) {
        scanString(
          decodeSignatureText(entry.body),
          location,
          allowlist,
          failures,
          "tar-text",
          context
        );
        add(failures, "tar-binary-unreviewed", location);
      }
      const text = decodeRequiredUtf8(entry.body, "packed package/package.json");
      packageJson = parseJson(text, "packed package/package.json");
      scanJson(
        packageJson,
        "tar:package/package.json",
        allowlist,
        failures,
        "packed-package-json",
        context
      );
      scanPackageAuthor(
        packageJson.author,
        allowlist,
        failures,
        "packed-package",
        "tar:package/package.json/author"
      );
      pendingName = null;
      pendingLinkName = null;
      pendingOwner = null;
      continue;
    }

    scanString(decodeSignatureText(entry.body), location, allowlist, failures, "tar-text", context);
    if (!isReviewedText) {
      add(failures, "tar-binary-unreviewed", location);
    }
    pendingName = null;
    pendingLinkName = null;
    pendingOwner = null;
  }

  if (packageJson === null) {
    add(failures, "packed-package-json-missing", "tar:package/package.json");
  }
}

async function scanCurrentPackage(repoRoot, allowlist, failures) {
  const packageJsonPath = path.join(repoRoot, "packages/cli/package.json");
  const packageJson = parseJson(
    decodeRequiredUtf8(await readFile(packageJsonPath), "packages/cli/package.json"),
    "packages/cli/package.json"
  );
  scanPackageAuthor(
    packageJson.author,
    allowlist,
    failures,
    "source-package",
    "tracked:packages/cli/package.json/author"
  );
}

function scanHeadAuthor(repoRoot, allowlist, failures) {
  const raw = git(repoRoot, ["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"]).trimEnd();
  const [authorName, authorEmail, committerName, committerEmail] = raw.split("\0");
  if (!isAllowedIdentity(authorName ?? "", authorEmail ?? "", allowlist)) {
    add(failures, "release-commit-author", "git:HEAD author");
  }
  if (!isAllowedCommitterIdentity(committerName ?? "", committerEmail ?? "", allowlist)) {
    add(failures, "release-commit-committer", "git:HEAD committer");
  }
}

export async function verifyReleasePrivacy({
  allowlist,
  packJsonPath,
  repoRoot = repoDefaultRoot(),
  tarballPath,
  tarTextLimitBytes = DEFAULT_TAR_TEXT_LIMIT_BYTES,
  trackedTextLimitBytes = DEFAULT_TRACKED_TEXT_LIMIT_BYTES
} = {}) {
  if (!packJsonPath) fail("missing packJsonPath");
  if (!tarballPath) fail("missing tarballPath");

  const absoluteRepoRoot = path.resolve(repoRoot);
  const reviewedAllowlist = normalizeAllowlist(allowlist);
  const failures = [];

  scanHeadAuthor(absoluteRepoRoot, reviewedAllowlist, failures);
  await scanCurrentPackage(absoluteRepoRoot, reviewedAllowlist, failures);
  await scanTrackedText(absoluteRepoRoot, reviewedAllowlist, failures, trackedTextLimitBytes);
  await scanPackJson(path.resolve(packJsonPath), reviewedAllowlist, failures);
  await scanTarball(path.resolve(tarballPath), reviewedAllowlist, failures, tarTextLimitBytes);

  return failures;
}

export function formatFailures(failures) {
  return [
    `Release privacy check failed with ${failures.length} issue(s):`,
    ...failures.map((failure) => `- ${failure.category}: ${failure.location}`)
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const failures = await verifyReleasePrivacy(options);
  if (failures.length > 0) {
    console.error(formatFailures(failures));
    process.exit(1);
  }
  console.log("Release privacy check passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof PrivacyCheckError) {
      console.error(error.message);
    } else {
      console.error("Release privacy check failed unexpectedly");
    }
    process.exit(1);
  });
}
