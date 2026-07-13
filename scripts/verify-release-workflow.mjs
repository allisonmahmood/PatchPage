import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

const repoRoot = path.resolve(
  process.env.PATCHPAGE_RELEASE_WORKFLOW_REPO_ROOT ??
    path.dirname(fileURLToPath(import.meta.url)),
  process.env.PATCHPAGE_RELEASE_WORKFLOW_REPO_ROOT ? "." : "..",
);
const workflowPath = path.join(repoRoot, ".github/workflows/release.yml");
const [
  workflowFile,
  ciWorkflowFile,
  packageSource,
  lockfile,
  dependabot,
  selfHostingFile,
  readmeFile,
  serverImageVerifier,
] =
  await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(repoRoot, ".github/dependabot.yml"), "utf8"),
    readFile(path.join(repoRoot, "docs/SELF_HOSTING.md"), "utf8"),
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "scripts/verify-server-image.sh"), "utf8"),
  ]);
const workflow = process.env.PATCHPAGE_RELEASE_WORKFLOW_SOURCE ?? workflowFile;
const ciWorkflow = process.env.PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE ?? ciWorkflowFile;
const selfHosting =
  process.env.PATCHPAGE_RELEASE_SELF_HOSTING_SOURCE ?? selfHostingFile;
const readme = process.env.PATCHPAGE_RELEASE_README_SOURCE ?? readmeFile;
const packageJson = JSON.parse(packageSource);
const failures = [];
let parsedWorkflow = null;
let workflowDocument = null;

function hasUnsupportedYamlIndirection(node) {
  if (node === null || typeof node !== "object") {
    return false;
  }
  if (isAlias(node) || typeof node.anchor === "string") {
    return true;
  }
  if (isMap(node)) {
    return node.items.some(
      (pair) =>
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        pair.key.value === "<<" ||
        hasUnsupportedYamlIndirection(pair.key) ||
        hasUnsupportedYamlIndirection(pair.value),
    );
  }
  if (isSeq(node)) {
    return node.items.some(hasUnsupportedYamlIndirection);
  }
  return false;
}

try {
  const document = parseDocument(workflow, { keepSourceTokens: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      failures.push(`release.yml must be valid YAML with unique map keys: ${error.message}`);
    }
  } else if (hasUnsupportedYamlIndirection(document.contents)) {
    failures.push(
      "release.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys",
    );
  } else {
    workflowDocument = document;
    parsedWorkflow = document.toJS();
  }
} catch (error) {
  failures.push(
    `release.yml must be valid YAML with unique map keys: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const reviewedNodeVersion = "24.18.0";
const exactVersionPattern = /^\d+\.\d+\.\d+$/;
const reviewedNpm = Object.freeze({
  version: "11.18.0",
  integrity:
    "sha512-T67M4L5wNm0cZ7EBLErcEkY1SmzEW/WJ+SADBzsFUY1UdAPfFHXFQtZ6SEXiK0+vzXysCvAsepbMaBTwnrAD+w==",
});
const reviewedActions = new Map([
  [
    "actions/checkout",
    {
      version: "v4.3.1",
      sha: "34e114876b0b11c390a56381ad16ebd13914f8d5",
    },
  ],
  [
    "actions/setup-node",
    {
      version: "v4.4.0",
      sha: "49933ea5288caeca8642d1e84afbd3f7d6820020",
    },
  ],
  [
    "pnpm/action-setup",
    {
      version: "v4.3.0",
      sha: "b906affcce14559ad1aafd4ab0e942779e9f58b1",
    },
  ],
  [
    "actions/upload-artifact",
    {
      version: "v7.0.1",
      sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    },
  ],
  [
    "actions/download-artifact",
    {
      version: "v8.0.1",
      sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    },
  ],
  [
    "docker/login-action",
    {
      version: "v3.7.0",
      sha: "c94ce9fb468520275223c153574b00df6fe4bcc9",
    },
  ],
]);
const reviewedUploadArtifact = `actions/upload-artifact@${reviewedActions.get("actions/upload-artifact").sha}`;
const reviewedDownloadArtifact = `actions/download-artifact@${reviewedActions.get("actions/download-artifact").sha}`;
const expectedVersionProducerRun = [
  "set -euo pipefail",
  "",
  "version=\"$(node -p \"require('./packages/cli/package.json').version\")\"",
  "if [[ ! \"$version\" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then",
  "  echo \"::error::Release version must be exact stable SemVer, got ${version}\"",
  "  exit 1",
  "fi",
  "",
  "expected_ref=\"v${version}\"",
  "",
  "if [[ \"$expected_ref\" != \"$GITHUB_REF_NAME\" ]]; then",
  "  echo \"::error::Tag ${GITHUB_REF_NAME} does not match packages/cli version ${expected_ref}\"",
  "  exit 1",
  "fi",
  "",
  "if ! grep -Fq \"## [${version}]\" CHANGELOG.md; then",
  "  echo \"::error::CHANGELOG.md is missing a ## [${version}] heading\"",
  "  exit 1",
  "fi",
  "",
  "revision=\"$(git rev-parse HEAD)\"",
  "if [[ ! \"$revision\" =~ ^[0-9a-f]{40}$ ]]; then",
  "  echo \"::error::Resolved release revision is not a full commit SHA: ${revision}\"",
  "  exit 1",
  "fi",
  "",
  "echo \"version=$version\" >> \"$GITHUB_OUTPUT\"",
  "echo \"revision=$revision\" >> \"$GITHUB_OUTPUT\"",
  "",
].join("\n");
const expectedNpmCliProducerRun = [
  "set -euo pipefail",
  "",
  "if [[ ! \"$EXPECTED_NPM_VERSION\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then",
  "  echo \"::error::Expected an exact npm version, got $EXPECTED_NPM_VERSION\"",
  "  exit 1",
  "fi",
  "",
  "npm_tarball=\"$RUNNER_TEMP/npm-${EXPECTED_NPM_VERSION}.tgz\"",
  "npm_cli_dir=\"$RUNNER_TEMP/npm-cli\"",
  "rm -f \"$npm_tarball\"",
  "rm -rf \"$npm_cli_dir\"",
  "",
  "curl --fail --silent --show-error \\",
  "  --proto '=https' \\",
  "  --tlsv1.2 \\",
  "  --output \"$npm_tarball\" \\",
  "  \"https://registry.npmjs.org/npm/-/npm-${EXPECTED_NPM_VERSION}.tgz\"",
  "",
  "actual_integrity=\"$(",
  "  node - \"$npm_tarball\" <<'NODE'",
  "const { createHash } = require(\"node:crypto\");",
  "const { readFileSync } = require(\"node:fs\");",
  "",
  "const digest = createHash(\"sha512\")",
  "  .update(readFileSync(process.argv[2]))",
  "  .digest(\"base64\");",
  "process.stdout.write(`sha512-${digest}`);",
  "NODE",
  ")\"",
  "",
  "if [[ \"$actual_integrity\" != \"$EXPECTED_NPM_INTEGRITY\" ]]; then",
  "  echo \"::error::npm registry tarball integrity mismatch\"",
  "  exit 1",
  "fi",
  "",
  "mkdir -p \"$npm_cli_dir\"",
  "tar -xzf \"$npm_tarball\" -C \"$npm_cli_dir\" --strip-components=1",
  "",
  "actual_version=\"$(node \"$npm_cli_dir/bin/npm-cli.js\" --version)\"",
  "if [[ \"$actual_version\" != \"$EXPECTED_NPM_VERSION\" ]]; then",
  "  echo \"::error::Verified npm CLI reported $actual_version, expected $EXPECTED_NPM_VERSION\"",
  "  exit 1",
  "fi",
  "",
  "echo \"version=$actual_version\" >> \"$GITHUB_OUTPUT\"",
  "",
].join("\n");
const expectedVerifyNpmCliRun = [
  "set -euo pipefail",
  "",
  "NPM_CLI=\"$RUNNER_TEMP/npm-cli/bin/npm-cli.js\"",
  "actual_version=\"$(node \"$NPM_CLI\" --version)\"",
  "if [[ \"$actual_version\" != \"$EXPECTED_NPM_VERSION\" ]]; then",
  "  echo \"::error::Downloaded npm CLI reported $actual_version, expected $EXPECTED_NPM_VERSION\"",
  "  exit 1",
  "fi",
  "",
  "echo \"NPM_CLI=$NPM_CLI\" >> \"$GITHUB_ENV\"",
  "",
].join("\n");
const expectedPackageProducerRun = [
  "set -euo pipefail",
  "",
  "package_dir=\"$RUNNER_TEMP/patchpage-package\"",
  "rm -rf \"$package_dir\"",
  "mkdir -p \"$package_dir\"",
  "",
  "cd packages/cli",
  "node \"$NPM_CLI\" pack \\",
  "  --ignore-scripts \\",
  "  --json \\",
  "  --pack-destination \"$package_dir\" \\",
  "  > \"$RUNNER_TEMP/patchpage-pack.json\"",
  "",
  "node - \"$RUNNER_TEMP/patchpage-pack.json\" <<'NODE'",
  "const fs = require(\"node:fs\");",
  "",
  "const pack = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\"))[0];",
  "const required = [\"dist/index.js\", \"skills/patchpage/SKILL.md\", \"LICENSE\", \"README.md\"];",
  "const files = new Set(pack.files.map((file) => file.path));",
  "const missing = required.filter((file) => !files.has(file));",
  "",
  "if (missing.length > 0) {",
  "  console.error(`Missing files from npm pack: ${missing.join(\", \")}`);",
  "  console.error(\"Packed files:\");",
  "  for (const file of [...files].sort()) {",
  "    console.error(`- ${file}`);",
  "  }",
  "  process.exit(1);",
  "}",
  "NODE",
  "",
  "reported_tarball=\"$(",
  "  node - \"$RUNNER_TEMP/patchpage-pack.json\" \"$package_dir\" <<'NODE'",
  "const fs = require(\"node:fs\");",
  "const path = require(\"node:path\");",
  "",
  "const pack = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\"))[0];",
  "console.log(path.resolve(process.argv[3], pack.filename));",
  "NODE",
  ")\"",
  "",
  "mapfile -t tarballs < <(find \"$package_dir\" -maxdepth 1 -type f -name 'patchpage-*.tgz' -print)",
  "if [[ \"${#tarballs[@]}\" -ne 1 ]]; then",
  "  echo \"::error::Expected exactly one PatchPage tarball, found ${#tarballs[@]}\"",
  "  exit 1",
  "fi",
  "",
  "tarball=\"${tarballs[0]}\"",
  "if [[ \"$tarball\" != \"$reported_tarball\" ]]; then",
  "  echo \"::error::npm pack reported $reported_tarball, but found $tarball\"",
  "  exit 1",
  "fi",
  "",
  "cli_version=\"$(node -p \"require('./package.json').version\")\"",
  "unique_tarball=\"$package_dir/patchpage-${cli_version}-run-attempt-${GITHUB_RUN_ATTEMPT}.tgz\"",
  "mv -- \"$tarball\" \"$unique_tarball\"",
  "tarball=\"$unique_tarball\"",
  "",
  "echo \"TARBALL=$tarball\" >> \"$GITHUB_ENV\"",
  "echo \"CLI_VERSION=$cli_version\" >> \"$GITHUB_ENV\"",
  "echo \"tarball-path=$tarball\" >> \"$GITHUB_OUTPUT\"",
  "echo \"filename=$(basename \"$tarball\")\" >> \"$GITHUB_OUTPUT\"",
  "echo \"sha256=$(sha256sum \"$tarball\" | awk '{print $1}')\" >> \"$GITHUB_OUTPUT\"",
  "",
].join("\n");
const expectedMinimumNodeSmokeRun = [
  "set -euo pipefail",
  "",
  "tmp_dir=\"$(mktemp -d)\"",
  "cd \"$tmp_dir\"",
  "node \"$NPM_CLI\" install --ignore-scripts \"$TARBALL\"",
  "",
  "output=\"$(./node_modules/.bin/patchpage --version)\"",
  "if [[ \"$output\" != \"$CLI_VERSION\" ]]; then",
  "  echo \"::error::Expected patchpage --version to print $CLI_VERSION, got $output\"",
  "  exit 1",
  "fi",
  "",
  "if [[ \"$output\" == \"0.0.0-dev\" ]]; then",
  "  echo \"::error::Installed patchpage binary reported 0.0.0-dev\"",
  "  exit 1",
  "fi",
  "",
  "./node_modules/.bin/patchpage validate \"$GITHUB_WORKSPACE/examples/plan.html\"",
  "",
  "actual_sha256=\"$(sha256sum \"$TARBALL\" | awk '{print $1}')\"",
  "if [[ \"$actual_sha256\" != \"$EXPECTED_TARBALL_SHA256\" ]]; then",
  "  echo \"::error::The tested tarball changed during the smoke install\"",
  "  exit 1",
  "fi",
  "",
].join("\n");
const expectedPublicationRun = [
  "set -euo pipefail",
  "",
  "shopt -s nullglob",
  "tarballs=(\"$RUNNER_TEMP/patchpage-package\"/*.tgz)",
  "if [[ \"${#tarballs[@]}\" -ne 1 ]]; then",
  "  echo \"::error::Expected exactly one downloaded PatchPage tarball, found ${#tarballs[@]}\"",
  "  exit 1",
  "fi",
  "",
  "tarball=\"${tarballs[0]}\"",
  "if [[ \"$(basename \"$tarball\")\" != \"$EXPECTED_FILENAME\" ]]; then",
  "  echo \"::error::Downloaded tarball name does not match the verified artifact\"",
  "  exit 1",
  "fi",
  "",
  "actual_sha256=\"$(sha256sum \"$tarball\" | awk '{print $1}')\"",
  "if [[ \"$actual_sha256\" != \"$EXPECTED_SHA256\" ]]; then",
  "  echo \"::error::Downloaded tarball digest does not match the verified artifact\"",
  "  exit 1",
  "fi",
  "",
  "IFS=$'\\t' read -r package_name package_version < <(",
  "  tar -xOf \"$tarball\" package/package.json \\",
  "    | node -e 'const fs = require(\"node:fs\"); const pkg = JSON.parse(fs.readFileSync(0, \"utf8\")); console.log(`${pkg.name}\\t${pkg.version}`)'",
  ")",
  "if [[ \"$package_name\" != \"patchpage\" ]]; then",
  "  echo \"::error::Downloaded package is named $package_name, expected patchpage\"",
  "  exit 1",
  "fi",
  "if [[ \"$package_version\" != \"$EXPECTED_VERSION\" ]]; then",
  "  echo \"::error::Downloaded package version $package_version does not match $EXPECTED_VERSION\"",
  "  exit 1",
  "fi",
  "",
  "npm_cli=\"$RUNNER_TEMP/npm-cli/bin/npm-cli.js\"",
  "actual_npm_version=\"$(node \"$npm_cli\" --version)\"",
  "if [[ \"$actual_npm_version\" != \"$EXPECTED_NPM_VERSION\" ]]; then",
  "  echo \"::error::Downloaded npm CLI reported $actual_npm_version, expected $EXPECTED_NPM_VERSION\"",
  "  exit 1",
  "fi",
  "",
  "registry_metadata=\"$RUNNER_TEMP/npm-registry-metadata.json\"",
  "curl_error=\"$RUNNER_TEMP/npm-registry-curl.err\"",
  "registry_url=\"https://registry.npmjs.org/${package_name}/${EXPECTED_VERSION}\"",
  "if ! http_status=\"$(",
  "  curl --silent --show-error \\",
  "    --proto '=https' \\",
  "    --tlsv1.2 \\",
  "    --output \"$registry_metadata\" \\",
  "    --write-out '%{http_code}' \\",
  "    \"$registry_url\" \\",
  "    2>\"$curl_error\"",
  ")\"; then",
  "  echo \"::error::Failed to query npm registry for patchpage@${EXPECTED_VERSION}\"",
  "  cat \"$curl_error\" >&2",
  "  exit 1",
  "fi",
  "",
  "case \"$http_status\" in",
  "  200)",
  "    registry_integrity=\"$(",
  "      node - \"$registry_metadata\" <<'NODE'",
  "const { readFileSync } = require(\"node:fs\");",
  "",
  "const metadata = JSON.parse(readFileSync(process.argv[2], \"utf8\"));",
  "const integrity = metadata.dist?.integrity;",
  "if (typeof integrity === \"string\" && integrity.length > 0) {",
  "  process.stdout.write(integrity);",
  "}",
  "NODE",
  "    )\"",
  "    if [[ -z \"$registry_integrity\" ]]; then",
  "      echo \"::error::npm registry metadata is missing dist.integrity\"",
  "      exit 1",
  "    fi",
  "",
  "    local_integrity=\"$(",
  "      node - \"$tarball\" <<'NODE'",
  "const { createHash } = require(\"node:crypto\");",
  "const { readFileSync } = require(\"node:fs\");",
  "",
  "const digest = createHash(\"sha512\")",
  "  .update(readFileSync(process.argv[2]))",
  "  .digest(\"base64\");",
  "process.stdout.write(`sha512-${digest}`);",
  "NODE",
  "    )\"",
  "    if [[ \"$registry_integrity\" != \"$local_integrity\" ]]; then",
  "      echo \"::error::patchpage@${EXPECTED_VERSION} exists with different integrity\"",
  "      exit 1",
  "    fi",
  "",
  "    echo \"patchpage@${EXPECTED_VERSION} already published with matching integrity, skipping\"",
  "    exit 0",
  "    ;;",
  "  404)",
  "    echo \"patchpage@${EXPECTED_VERSION} is absent from npm; publishing\"",
  "    ;;",
  "  *)",
  "    echo \"::error::Unexpected npm registry HTTP status: $http_status\"",
  "    exit 1",
  "    ;;",
  "esac",
  "",
  "node \"$npm_cli\" publish \"$tarball\" --ignore-scripts --provenance \\",
  "  --registry=https://registry.npmjs.org",
  "",
].join("\n");

function job(name) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);

  if (start === -1) {
    failures.push(`release.yml must define the ${name} job`);
    return "";
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactMapping(value, expected) {
  if (!isMapping(value)) {
    return false;
  }

  const expectedEntries = Object.entries(expected);
  return (
    Object.keys(value).length === expectedEntries.length &&
    expectedEntries.every(([key, expectedValue]) => value[key] === expectedValue)
  );
}

function hasExactKeys(value, expectedKeys) {
  if (!isMapping(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys
      .slice()
      .sort()
      .every((key, index) => key === actualKeys[index])
  );
}

function hasExactArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((item, index) => value[index] === item)
  );
}

function isExactRunStep(step, run) {
  return hasExactKeys(step, ["run"]) && step.run === run;
}

function parsedJob(name) {
  if (parsedWorkflow === null) {
    return null;
  }

  const jobs = isMapping(parsedWorkflow) ? parsedWorkflow.jobs : null;
  const selectedJob = isMapping(jobs) ? jobs[name] : null;
  if (!isMapping(selectedJob)) {
    failures.push(`release.yml must define ${name} as a parsed job map`);
    return null;
  }

  return selectedJob;
}

function parsedSteps(jobName, selectedJob) {
  if (selectedJob === null) {
    return [];
  }
  if (!Array.isArray(selectedJob.steps) || !selectedJob.steps.every(isMapping)) {
    failures.push(`${jobName} must define steps as parsed YAML maps`);
    return [];
  }
  return selectedJob.steps;
}

function uniqueStep(steps, predicate, description) {
  if (parsedWorkflow === null) {
    return null;
  }
  const matches = steps.filter(predicate);
  if (matches.length !== 1) {
    failures.push(`${description} must exist exactly once`);
    return null;
  }
  return matches[0];
}

function workflowLineNumber(offset) {
  return workflow.slice(0, offset).split("\n").length;
}

function parsedActionUses(document) {
  if (document === null) {
    return [];
  }

  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) {
    failures.push("release.yml must define jobs as a parsed YAML map");
    return [];
  }

  const actions = [];
  for (const jobPair of jobs.items) {
    const jobName = isScalar(jobPair.key) ? jobPair.key.value : null;
    if (!isMap(jobPair.value)) {
      failures.push("every release.yml job must be a parsed YAML map");
      continue;
    }
    const steps = jobPair.value.get("steps", true);
    if (!isSeq(steps)) {
      failures.push(`${String(jobName)} must define steps as a parsed YAML sequence`);
      continue;
    }

    for (const [stepIndex, step] of steps.items.entries()) {
      if (!isMap(step)) {
        failures.push(`${String(jobName)} step ${stepIndex + 1} must be a parsed YAML map`);
        continue;
      }
      const usesPairs = step.items.filter(
        (pair) => isScalar(pair.key) && pair.key.value === "uses",
      );
      if (usesPairs.length === 0) {
        continue;
      }
      if (usesPairs.length !== 1) {
        failures.push(`${String(jobName)} step ${stepIndex + 1} must define uses exactly once`);
        continue;
      }

      const [usesPair] = usesPairs;
      const valueRange = isScalar(usesPair.value) ? usesPair.value.range : null;
      const valueEnd = Array.isArray(valueRange) ? valueRange[1] : null;
      const lineEnd =
        typeof valueEnd === "number" ? workflow.indexOf("\n", valueEnd) : -1;

      actions.push({
        comment: isScalar(usesPair.value) ? usesPair.value.comment : null,
        coordinate: isScalar(usesPair.value) ? usesPair.value.value : null,
        inlineSuffix:
          typeof valueEnd === "number"
            ? workflow
                .slice(valueEnd, lineEnd === -1 ? workflow.length : lineEnd)
                .replace(/\r$/, "")
            : null,
        jobName,
        lineNumber: workflowLineNumber(usesPair.key.range?.[0] ?? 0),
      });
    }
  }

  return actions;
}

const actionUses = parsedActionUses(workflowDocument);

function ciJob(name) {
  const lines = ciWorkflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);

  if (start === -1) {
    failures.push(`ci.yml must define the ${name} job`);
    return "";
  }

  const end = lines.findIndex(
    (line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function jobNeeds(jobSource) {
  const lines = jobSource.split("\n");
  const index = lines.findIndex((line) => /^ {4}needs\s*:/.test(line));
  if (index === -1) return [];

  const value = lines[index].replace(/^ {4}needs\s*:\s*/, "").trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (value) return [value];

  const needs = [];
  for (const line of lines.slice(index + 1)) {
    const name = line.match(/^ {6}-\s+([a-zA-Z0-9_-]+)\s*$/)?.[1];
    if (!name) break;
    needs.push(name);
  }
  return needs;
}

function jobPermissions(jobSource) {
  const lines = jobSource.split("\n");
  const index = lines.findIndex((line) => /^ {4}permissions\s*:/.test(line));
  if (index === -1) return null;

  const value = lines[index].replace(/^ {4}permissions\s*:\s*/, "").trim();
  if (value === "{}") return new Map();
  if (value) return null;

  const permissions = new Map();
  for (const line of lines.slice(index + 1)) {
    const match = line.match(/^ {6}([a-z-]+)\s*:\s*([a-z-]+)\s*$/);
    if (!match) break;
    permissions.set(match[1], match[2]);
  }
  return permissions;
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function sameEntries(actual, expected) {
  return (
    actual instanceof Map &&
    actual.size === expected.size &&
    [...expected].every(([key, value]) => actual.get(key) === value)
  );
}

if (parsedWorkflow !== null && actionUses.length === 0) {
  failures.push("release.yml must use at least one external Action");
}

for (const { comment, coordinate, inlineSuffix, lineNumber } of actionUses) {
  if (typeof coordinate !== "string") {
    failures.push(
      `release.yml:${lineNumber} must pin an Action to a full commit SHA with an inline semver release comment`,
    );
    continue;
  }

  const coordinateMatch = coordinate.match(/^([^\s@]+)@([^\s@]+)$/);
  if (!coordinateMatch) {
    failures.push(
      `release.yml:${lineNumber} must pin an Action to a full commit SHA with an inline semver release comment`,
    );
    continue;
  }

  const [, actionName, reference] = coordinateMatch;
  const reviewed = reviewedActions.get(actionName);
  if (!reviewed) {
    failures.push(`release.yml:${lineNumber} uses unreviewed Action ${actionName}`);
  }

  if (!/^[0-9a-f]{40}$/.test(reference)) {
    failures.push(`release.yml:${lineNumber} must pin ${actionName} to a full commit SHA`);
  }

  if (reviewed && reviewed.sha !== reference) {
    failures.push(
      `release.yml:${lineNumber} must use reviewed coordinate ${actionName}@${reviewed.sha} # ${reviewed.version}`,
    );
  }

  const commentVersion =
    typeof comment === "string"
      ? comment.match(/^ (v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1]
      : null;
  if (commentVersion === null || inlineSuffix !== ` # ${commentVersion}`) {
    failures.push(
      `release.yml:${lineNumber} must pin an Action to a full commit SHA with an inline semver release comment`,
    );
  } else if (reviewed && reviewed.version !== commentVersion) {
    failures.push(
      `release.yml:${lineNumber} must use reviewed coordinate ${actionName}@${reviewed.sha} # ${reviewed.version}`,
    );
  }
}

const expectedActionCounts = new Map([
  ["actions/checkout", 4],
  ["actions/setup-node", 5],
  ["pnpm/action-setup", 1],
  ["actions/upload-artifact", 3],
  ["actions/download-artifact", 4],
  ["docker/login-action", 1],
]);
for (const [actionName, expectedCount] of expectedActionCounts) {
  const actualCount = actionUses.filter(
    ({ coordinate }) =>
      typeof coordinate === "string" && coordinate.startsWith(`${actionName}@`),
  ).length;
  if (actualCount !== expectedCount) {
    failures.push(
      `release.yml must retain all ${expectedCount} reviewed ${actionName} Action uses`,
    );
  }
}

const npmVersion = packageJson.devDependencies?.npm;
if (npmVersion !== reviewedNpm.version) {
  failures.push(
    `the publishing npm CLI must be the reviewed exact root devDependency ${reviewedNpm.version}`,
  );
} else {
  const rootImporter = lockfile.match(/^  \.:\n[\s\S]*?(?=^  \S)/m)?.[0] ?? "";
  const escapedNpmVersion = npmVersion.replaceAll(".", "\\.");
  const lockedNpm = new RegExp(
    `^      npm:\\n        specifier: ${npmVersion.replaceAll(".", "\\.")}\\n        version: ${npmVersion.replaceAll(".", "\\.")}$`,
    "m",
  );
  const lockedNpmIntegrity = lockfile.match(
    new RegExp(
      `^  npm@${escapedNpmVersion}:\\n    resolution: \\{integrity: (sha512-[^}]+)\\}$`,
      "m",
    ),
  )?.[1];

  if (!lockedNpm.test(rootImporter)) {
    failures.push(`pnpm-lock.yaml must lock the root npm devDependency at ${npmVersion}`);
  }
  if (lockedNpmIntegrity !== reviewedNpm.integrity) {
    failures.push(
      `pnpm-lock.yaml must retain the reviewed registry integrity for npm@${npmVersion}`,
    );
  }
}

if (/\bnpm@(latest|next|canary|\*)\b/.test(workflow)) {
  failures.push("release.yml must not use a floating npm release channel");
}

for (const ecosystem of ["npm", "github-actions"]) {
  if (!dependabot.includes(`package-ecosystem: ${ecosystem}`)) {
    failures.push(`Dependabot must cover the ${ecosystem} ecosystem`);
  }
}

const releaseConcurrency = workflow.match(
  /^concurrency:\n  group: ([^\n]+)\n  queue: max\n  cancel-in-progress: false$/m,
);
if (!releaseConcurrency) {
  failures.push(
    "release.yml must serialize all patchpage-server publishes in one package-wide max queue without canceling running or pending releases",
  );
} else if (releaseConcurrency[1] !== "release-ghcr-patchpage-server") {
  failures.push(
    "release.yml concurrency group must be the constant package-wide release-ghcr-patchpage-server group, not a ref/version-scoped group",
  );
}

const guardJob = job("guard");
const prepareNpmJob = job("prepare-npm");
const verifyJob = job("verify");
const publishJob = job("publish-npm");
const parsedGuardJob = parsedJob("guard");
const parsedPrepareNpmJob = parsedJob("prepare-npm");
const parsedVerifyJob = parsedJob("verify");
const parsedPublishJob = parsedJob("publish-npm");
const expectedReleaseJobs = [
  "guard",
  "prepare-npm",
  "verify",
  "publish-npm",
  "github-release",
  "verify-server-image",
  "docker-ghcr",
  "ghcr-anonymous-smoke",
  "npx-smoke",
];
if (
  parsedWorkflow !== null &&
  !hasExactKeys(parsedWorkflow.jobs, expectedReleaseJobs)
) {
  failures.push("release.yml must contain exactly the reviewed release jobs");
}
const guardSteps = parsedSteps("guard", parsedGuardJob);
const prepareNpmSteps = parsedSteps("prepare-npm", parsedPrepareNpmJob);
const verifySteps = parsedSteps("verify", parsedVerifyJob);
const publishSteps = parsedSteps("publish-npm", parsedPublishJob);
const guardCheckoutStep = uniqueStep(
  guardSteps,
  (step) => step.uses === `actions/checkout@${reviewedActions.get("actions/checkout").sha}`,
  "the guard checkout step",
);
const versionProducerStep = uniqueStep(
  guardSteps,
  (step) => step.id === "version",
  "the guard version producer step",
);
const npmCliUploadStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.name === "Upload the reviewed npm CLI",
  "the Upload the reviewed npm CLI step",
);
const npmCliProducerIdStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.id === "npm-cli",
  "the reviewed npm CLI producer step",
);
const npmCliProducerNameStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.name === "Fetch and verify the reviewed npm CLI",
  "the Fetch and verify the reviewed npm CLI step",
);
const serverImageJob = job("verify-server-image");
const dockerJob = job("docker-ghcr");
const anonymousImageJob = job("ghcr-anonymous-smoke");
const ciDockerJob = ciJob("docker");

const npmCliUploadIdStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.id === "npm-cli-artifact",
  "the npm-cli-artifact producer step",
);
const packageMetadataStep = uniqueStep(
  verifySteps,
  (step) => step.id === "package",
  "the package metadata producer step",
);
const packageMetadataNameStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Pack exactly one release tarball and verify contents",
  "the Pack exactly one release tarball and verify contents step",
);
const verifyNpmCliStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Verify the isolated npm CLI",
  "the Verify the isolated npm CLI step",
);
const verifyNpmCliDownloadStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Download the isolated npm CLI",
  "the Download the isolated npm CLI step",
);
const smokeInstallStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Install and run tarball on minimum supported Node",
  "the minimum-Node tarball smoke step",
);
const smokeInstallIndex = verifySteps.indexOf(smokeInstallStep);
const minimumNodeSetupStep =
  smokeInstallIndex > 0 ? verifySteps[smokeInstallIndex - 1] : null;
const packageUploadStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Upload the exact tested tarball",
  "the Upload the exact tested tarball step",
);
const packageUploadIdStep = uniqueStep(
  verifySteps,
  (step) => step.id === "package-artifact",
  "the package-artifact producer step",
);
const packageDownloadStep = uniqueStep(
  publishSteps,
  (step) => step.name === "Download the exact tested tarball",
  "the Download the exact tested tarball step",
);
const npmCliDownloadStep = uniqueStep(
  publishSteps,
  (step) => step.name === "Download the pinned publishing CLI",
  "the Download the pinned publishing CLI step",
);
const publicationStep = uniqueStep(
  publishSteps,
  (step) => step.name === "Publish the verified tarball to npm",
  "the Publish the verified tarball to npm step",
);
const publicationRun = typeof publicationStep?.run === "string" ? publicationStep.run : "";
const prepareSetupNodeStep = prepareNpmSteps[0] ?? null;
const verifyCheckoutStep = verifySteps[0] ?? null;
const verifyPnpmSetupStep = verifySteps[1] ?? null;
const verifySetupNodeStep = verifySteps[2] ?? null;
const publishSetupNodeStep = publishSteps[0] ?? null;

if (
  parsedWorkflow !== null &&
  !hasExactMapping(parsedGuardJob?.outputs, {
    version: "${{ steps.version.outputs.version }}",
    revision: "${{ steps.version.outputs.revision }}",
  })
) {
  failures.push("guard outputs must bind exactly to the version producer");
}

if (
  parsedWorkflow !== null &&
  (guardCheckoutStep === null ||
    !hasExactKeys(guardCheckoutStep, ["uses"]) ||
    guardSteps.indexOf(guardCheckoutStep) !== 0 ||
    versionProducerStep === null ||
    !hasExactKeys(versionProducerStep, ["id", "shell", "run"]) ||
    versionProducerStep.id !== "version" ||
    versionProducerStep.shell !== "bash" ||
    versionProducerStep.run !== expectedVersionProducerRun ||
    guardSteps.indexOf(versionProducerStep) !== 1)
) {
  failures.push(
    "guard must check out the repository before running the exact version producer",
  );
}

if (
  parsedWorkflow !== null &&
  (parsedPrepareNpmJob === null ||
    !hasExactKeys(parsedPrepareNpmJob, ["runs-on", "permissions", "outputs", "steps"]) ||
    parsedPrepareNpmJob["runs-on"] !== "ubuntu-latest" ||
    !hasExactMapping(parsedPrepareNpmJob.permissions, {}) ||
    prepareNpmSteps.length !== 3 ||
    prepareNpmSteps[0] !== prepareSetupNodeStep ||
    prepareNpmSteps[1] !== npmCliProducerIdStep ||
    prepareNpmSteps[2] !== npmCliUploadStep ||
    !hasExactKeys(prepareSetupNodeStep, ["uses", "with"]) ||
    prepareSetupNodeStep.uses !==
      `actions/setup-node@${reviewedActions.get("actions/setup-node").sha}` ||
    !hasExactMapping(prepareSetupNodeStep.with, {
      "node-version": reviewedNodeVersion,
    }))
) {
  failures.push("prepare-npm must contain exactly the reviewed job map and ordered steps");
}

if (
  parsedWorkflow !== null &&
  !hasExactMapping(parsedPrepareNpmJob?.outputs, {
    "npm-version": "${{ steps.npm-cli.outputs.version }}",
    "npm-cli-artifact-id": "${{ steps.npm-cli-artifact.outputs.artifact-id }}",
  })
) {
  failures.push("prepare-npm outputs must bind the exact reviewed npm CLI producers");
}

if (
  parsedWorkflow !== null &&
  (npmCliProducerIdStep === null ||
    npmCliProducerIdStep !== npmCliProducerNameStep ||
    !hasExactKeys(npmCliProducerIdStep, ["name", "id", "shell", "env", "run"]) ||
    npmCliProducerIdStep.shell !== "bash" ||
    !hasExactMapping(npmCliProducerIdStep.env, {
      EXPECTED_NPM_VERSION: reviewedNpm.version,
      EXPECTED_NPM_INTEGRITY: reviewedNpm.integrity,
    }) ||
    npmCliProducerIdStep.run !== expectedNpmCliProducerRun ||
    prepareNpmSteps.indexOf(npmCliProducerIdStep) >=
      prepareNpmSteps.indexOf(npmCliUploadStep))
) {
  failures.push(
    "prepare-npm must fetch, verify, and output the exact reviewed npm CLI before upload",
  );
}

if (
  parsedWorkflow !== null &&
  (npmCliUploadStep === null ||
    npmCliUploadStep !== npmCliUploadIdStep ||
    !hasExactKeys(npmCliUploadStep, ["name", "id", "uses", "with"]) ||
    npmCliUploadStep.uses !== reviewedUploadArtifact ||
    !hasExactMapping(npmCliUploadStep.with, {
      name: "npm-publishing-cli-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/npm-cli",
      "if-no-files-found": "error",
      "retention-days": 1,
      "include-hidden-files": true,
    }))
) {
  failures.push("prepare-npm must produce the exact isolated npm CLI artifact");
}

if (
  parsedWorkflow !== null &&
  (parsedVerifyJob === null ||
    !hasExactKeys(parsedVerifyJob, [
      "needs",
      "runs-on",
      "permissions",
      "outputs",
      "steps",
    ]) ||
    !hasExactArray(parsedVerifyJob.needs, ["guard", "prepare-npm"]) ||
    parsedVerifyJob["runs-on"] !== "ubuntu-latest" ||
    !hasExactMapping(parsedVerifyJob.permissions, { contents: "read" }) ||
    verifySteps.length !== 14 ||
    verifySteps[0] !== verifyCheckoutStep ||
    verifySteps[1] !== verifyPnpmSetupStep ||
    verifySteps[2] !== verifySetupNodeStep ||
    !hasExactKeys(verifyCheckoutStep, ["uses"]) ||
    verifyCheckoutStep.uses !==
      `actions/checkout@${reviewedActions.get("actions/checkout").sha}` ||
    !hasExactKeys(verifyPnpmSetupStep, ["uses", "with"]) ||
    verifyPnpmSetupStep.uses !==
      `pnpm/action-setup@${reviewedActions.get("pnpm/action-setup").sha}` ||
    !hasExactMapping(verifyPnpmSetupStep.with, { version: "11.5.2" }) ||
    !hasExactKeys(verifySetupNodeStep, ["uses", "with"]) ||
    verifySetupNodeStep.uses !==
      `actions/setup-node@${reviewedActions.get("actions/setup-node").sha}` ||
    !hasExactMapping(verifySetupNodeStep.with, {
      "node-version": reviewedNodeVersion,
      cache: "pnpm",
    }) ||
    !isExactRunStep(verifySteps[3], "pnpm install --frozen-lockfile") ||
    !isExactRunStep(verifySteps[4], "pnpm lint") ||
    !isExactRunStep(verifySteps[5], "pnpm typecheck") ||
    !isExactRunStep(verifySteps[6], "pnpm test") ||
    !isExactRunStep(verifySteps[7], "pnpm --filter patchpage build") ||
    verifySteps[8] !== verifyNpmCliDownloadStep ||
    !hasExactKeys(verifyNpmCliDownloadStep, ["name", "uses", "with"]) ||
    verifyNpmCliDownloadStep.uses !== reviewedDownloadArtifact ||
    !hasExactMapping(verifyNpmCliDownloadStep.with, {
      "artifact-ids": "${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}",
      path: "${{ runner.temp }}/npm-cli",
    }) ||
    verifySteps[9] !== verifyNpmCliStep ||
    verifySteps[10] !== packageMetadataStep ||
    verifySteps[11] !== minimumNodeSetupStep ||
    verifySteps[12] !== smokeInstallStep ||
    verifySteps[13] !== packageUploadStep)
) {
  failures.push(
    "verify must contain exactly the reviewed job map and ordered build and smoke steps",
  );
}

if (
  parsedWorkflow !== null &&
  (!hasExactMapping(parsedVerifyJob?.outputs, {
    "tarball-filename": "${{ steps.package.outputs.filename }}",
    "tarball-sha256": "${{ steps.package.outputs.sha256 }}",
    "package-artifact-id": "${{ steps.package-artifact.outputs.artifact-id }}",
  }) ||
    packageMetadataStep === null ||
    packageMetadataStep !== packageMetadataNameStep ||
    !hasExactKeys(packageMetadataStep, ["name", "id", "shell", "run"]) ||
    packageMetadataStep.name !== "Pack exactly one release tarball and verify contents" ||
    packageMetadataStep.id !== "package" ||
    packageMetadataStep.shell !== "bash" ||
    packageMetadataStep.run !== expectedPackageProducerRun)
) {
  failures.push(
    "verify outputs must bind to the exact package and artifact producers",
  );
}

if (
  parsedWorkflow !== null &&
  (packageUploadStep === null ||
    packageUploadStep !== packageUploadIdStep ||
    !hasExactKeys(packageUploadStep, ["name", "id", "uses", "with"]) ||
    packageUploadStep.uses !== reviewedUploadArtifact ||
    !hasExactMapping(packageUploadStep.with, {
      path: "${{ steps.package.outputs.tarball-path }}",
      "if-no-files-found": "error",
      "retention-days": 1,
      archive: false,
    }))
) {
  failures.push("verify must upload exactly the active single raw tarball input");
}

if (
  parsedWorkflow !== null &&
  (verifyNpmCliStep === null ||
    !hasExactKeys(verifyNpmCliStep, ["name", "shell", "env", "run"]) ||
    verifyNpmCliStep.shell !== "bash" ||
    !hasExactMapping(verifyNpmCliStep.env, {
      EXPECTED_NPM_VERSION: "${{ needs.prepare-npm.outputs.npm-version }}",
    }) ||
    verifyNpmCliStep.run !== expectedVerifyNpmCliRun)
) {
  failures.push("verify must bind and validate the exact isolated npm CLI");
}

if (
  parsedWorkflow !== null &&
  (smokeInstallStep === null ||
    minimumNodeSetupStep === null ||
    !hasExactKeys(minimumNodeSetupStep, ["uses", "with"]) ||
    minimumNodeSetupStep.uses !==
      `actions/setup-node@${reviewedActions.get("actions/setup-node").sha}` ||
    !hasExactMapping(minimumNodeSetupStep.with, {
      "node-version": 22,
    }) ||
    !hasExactKeys(smokeInstallStep, ["name", "shell", "env", "run"]) ||
    smokeInstallStep.shell !== "bash" ||
    !hasExactMapping(smokeInstallStep.env, {
      EXPECTED_TARBALL_SHA256: "${{ steps.package.outputs.sha256 }}",
    }) ||
    smokeInstallStep.run !== expectedMinimumNodeSmokeRun)
) {
  failures.push(
    "verify must run the exact tarball smoke contract on the minimum supported Node 22",
  );
}

if (
  parsedWorkflow !== null &&
  (verifyNpmCliStep === null ||
    packageMetadataStep === null ||
    smokeInstallStep === null ||
    packageUploadStep === null ||
    verifySteps.indexOf(verifyNpmCliStep) >= verifySteps.indexOf(packageMetadataStep) ||
    verifySteps.indexOf(packageMetadataStep) >= verifySteps.indexOf(smokeInstallStep) ||
    verifySteps.indexOf(smokeInstallStep) >= verifySteps.indexOf(packageUploadStep))
) {
  failures.push(
    "verify must validate the isolated npm CLI, produce the package, smoke-test it, then upload it",
  );
}

const expectedVerifyWorkflowCommandReferences = [
  {
    line: 'echo "NPM_CLI=$NPM_CLI" >> "$GITHUB_ENV"',
    step: verifyNpmCliStep,
  },
  ...expectedPackageProducerRun
    .split("\n")
    .filter((line) => line.includes("GITHUB_ENV") || line.includes("GITHUB_OUTPUT"))
    .map((line) => ({ line, step: packageMetadataStep })),
];
const verifyWorkflowCommandReferences = verifySteps.flatMap((step) =>
  typeof step.run === "string"
    ? step.run
        .split("\n")
        .filter((line) => line.includes("GITHUB_ENV") || line.includes("GITHUB_OUTPUT"))
        .map((line) => ({ line, step }))
    : [],
);
if (
  parsedWorkflow !== null &&
  (verifyWorkflowCommandReferences.length !==
    expectedVerifyWorkflowCommandReferences.length ||
    verifyWorkflowCommandReferences.some(
      (reference, index) =>
        reference.step !== expectedVerifyWorkflowCommandReferences[index].step ||
        reference.line !== expectedVerifyWorkflowCommandReferences[index].line,
    ))
) {
  failures.push(
    "verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines",
  );
}

if (
  parsedWorkflow !== null &&
  (parsedPublishJob === null ||
    !hasExactKeys(parsedPublishJob, ["needs", "runs-on", "permissions", "steps"]) ||
    !hasExactArray(parsedPublishJob.needs, ["guard", "prepare-npm", "verify"]) ||
    parsedPublishJob["runs-on"] !== "ubuntu-latest" ||
    !hasExactMapping(parsedPublishJob.permissions, { "id-token": "write" }) ||
    publishSteps.length !== 4 ||
    publishSteps[0] !== publishSetupNodeStep ||
    publishSteps[1] !== packageDownloadStep ||
    publishSteps[2] !== npmCliDownloadStep ||
    publishSteps[3] !== publicationStep ||
    !hasExactKeys(publishSetupNodeStep, ["uses", "with"]) ||
    publishSetupNodeStep.uses !==
      `actions/setup-node@${reviewedActions.get("actions/setup-node").sha}` ||
    !hasExactMapping(publishSetupNodeStep.with, {
      "node-version": reviewedNodeVersion,
    }))
) {
  failures.push(
    "publish-npm must contain exactly the reviewed privileged job map and ordered publication steps",
  );
}

const publishDownloadSteps = publishSteps.filter(
  (step) =>
    typeof step.uses === "string" && step.uses.startsWith("actions/download-artifact@"),
);
if (parsedWorkflow !== null && publishDownloadSteps.length !== 2) {
  failures.push("publish-npm must contain exactly two download-artifact steps");
}

if (
  parsedWorkflow !== null &&
  (packageDownloadStep === null ||
    !hasExactKeys(packageDownloadStep, ["name", "uses", "with"]) ||
    packageDownloadStep.uses !== reviewedDownloadArtifact ||
    !hasExactMapping(packageDownloadStep.with, {
      "artifact-ids": "${{ needs.verify.outputs.package-artifact-id }}",
      path: "${{ runner.temp }}/patchpage-package",
      "skip-decompress": true,
    }))
) {
  failures.push("publish-npm must download the exact raw package artifact by ID");
}

if (
  parsedWorkflow !== null &&
  (npmCliDownloadStep === null ||
    !hasExactKeys(npmCliDownloadStep, ["name", "uses", "with"]) ||
    npmCliDownloadStep.uses !== reviewedDownloadArtifact ||
    !hasExactMapping(npmCliDownloadStep.with, {
      "artifact-ids": "${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}",
      path: "${{ runner.temp }}/npm-cli",
    }))
) {
  failures.push("publish-npm must normally decompress the exact isolated npm CLI artifact");
}

const publicationStepIndex = publishSteps.indexOf(publicationStep);
if (
  parsedWorkflow !== null &&
  (publicationStep === null ||
    !hasExactKeys(publicationStep, ["name", "shell", "env", "run"]) ||
    publicationStep.shell !== "bash" ||
    publicationRun !== expectedPublicationRun ||
    publishSteps.indexOf(packageDownloadStep) >= publicationStepIndex ||
    publishSteps.indexOf(npmCliDownloadStep) >= publicationStepIndex)
) {
  failures.push(
    "the publication step must contain exactly name, shell, env, and the reviewed run after both isolated downloads",
  );
}

if (
  parsedWorkflow !== null &&
  !hasExactMapping(publicationStep?.env, {
    EXPECTED_FILENAME: "${{ needs.verify.outputs.tarball-filename }}",
    EXPECTED_NPM_VERSION: "${{ needs.prepare-npm.outputs.npm-version }}",
    EXPECTED_SHA256: "${{ needs.verify.outputs.tarball-sha256 }}",
    EXPECTED_VERSION: "${{ needs.guard.outputs.version }}",
  })
) {
  failures.push("the publication step must bind the exact verified filename, digest, versions");
}

if (prepareNpmJob) {
  if (!/^    permissions: \{\}$/m.test(prepareNpmJob)) {
    failures.push("prepare-npm must have no GitHub token permissions");
  }

  for (const forbidden of [
    "uses: actions/checkout@",
    "uses: pnpm/action-setup@",
    "GITHUB_WORKSPACE",
    "node_modules",
    "sudo ",
    "npm install",
    "npm exec",
    "npx ",
    "pnpm ",
  ]) {
    if (prepareNpmJob.includes(forbidden)) {
      failures.push(`prepare-npm must not contain ${forbidden}`);
    }
  }

  const allowedPrepareActions = new Set([
    "actions/setup-node",
    "actions/upload-artifact",
  ]);
  const prepareActions = actionUses
    .filter(({ jobName }) => jobName === "prepare-npm")
    .map(({ coordinate }) =>
      typeof coordinate === "string" ? coordinate.split("@")[0] : null,
    );
  for (const action of prepareActions) {
    if (!allowedPrepareActions.has(action)) {
      failures.push(`prepare-npm must not execute the ${action} Action`);
    }
  }
  if (
    prepareActions.length !== 2 ||
    prepareActions.filter((action) => action === "actions/setup-node").length !== 1 ||
    prepareActions.filter((action) => action === "actions/upload-artifact").length !== 1
  ) {
    failures.push("prepare-npm may execute only one setup-node and one artifact upload");
  }

  if (
    !prepareNpmJob.includes(`EXPECTED_NPM_VERSION: ${reviewedNpm.version}`) ||
    !prepareNpmJob.includes(`EXPECTED_NPM_INTEGRITY: ${reviewedNpm.integrity}`)
  ) {
    failures.push(
      "prepare-npm must bind its fetched npm version and integrity to the reviewed metadata",
    );
  }

  const prepareNodeVersions = [
    ...prepareNpmJob.matchAll(
      /uses: actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version:\s+([^\s#]+)/g,
    ),
  ].map((match) => match[1]);
  if (
    prepareNodeVersions.length !== 1 ||
    !exactVersionPattern.test(prepareNodeVersions[0]) ||
    prepareNodeVersions[0] !== reviewedNodeVersion
  ) {
    failures.push(
      `prepare-npm must use the reviewed exact Node runtime ${reviewedNodeVersion}`,
    );
  }

  if (
    !prepareNpmJob.includes(
      'https://registry.npmjs.org/npm/-/npm-${EXPECTED_NPM_VERSION}.tgz',
    ) ||
    !prepareNpmJob.includes("curl --fail --silent --show-error") ||
    !prepareNpmJob.includes("--proto '=https'") ||
    !prepareNpmJob.includes("--tlsv1.2")
  ) {
    failures.push("prepare-npm must fetch the exact versioned npm registry tarball");
  }

  const sriCalculation = prepareNpmJob.indexOf('createHash("sha512")');
  const sriComparison = prepareNpmJob.indexOf(
    '"$actual_integrity" != "$EXPECTED_NPM_INTEGRITY"',
  );
  const extraction = prepareNpmJob.indexOf("tar -xzf");
  const cliExecution = prepareNpmJob.indexOf(
    'node "$npm_cli_dir/bin/npm-cli.js" --version',
  );
  const cliVersionComparison = prepareNpmJob.indexOf(
    '"$actual_version" != "$EXPECTED_NPM_VERSION"',
  );
  const cliVersionOutput = prepareNpmJob.indexOf(
    'echo "version=$actual_version" >> "$GITHUB_OUTPUT"',
  );
  const artifactUpload = prepareNpmJob.indexOf("uses: actions/upload-artifact@");
  if (
    sriCalculation === -1 ||
    !prepareNpmJob.includes('.digest("base64")') ||
    !prepareNpmJob.includes("process.stdout.write(`sha512-${digest}`)") ||
    sriComparison <= sriCalculation ||
    !prepareNpmJob.slice(sriComparison, extraction).includes("exit 1") ||
    extraction <= sriComparison ||
    cliExecution <= extraction ||
    cliVersionComparison <= cliExecution ||
    !prepareNpmJob
      .slice(cliVersionComparison, cliVersionOutput)
      .includes("exit 1") ||
    cliVersionOutput <= cliVersionComparison ||
    artifactUpload <= cliVersionOutput
  ) {
    failures.push(
      "prepare-npm must verify the reviewed SRI before extracting or executing npm",
    );
  }

  if (
    !prepareNpmJob.includes(
      "npm-cli-artifact-id: ${{ steps.npm-cli-artifact.outputs.artifact-id }}",
    ) ||
    !prepareNpmJob.includes("npm-version: ${{ steps.npm-cli.outputs.version }}") ||
    !prepareNpmJob.includes(
      "name: npm-publishing-cli-${{ github.run_attempt }}",
    ) ||
    !prepareNpmJob.includes("uses: actions/upload-artifact@")
  ) {
    failures.push("prepare-npm must expose its immutable npm CLI artifact ID and version");
  }
}

const publishNodeVersions = [
  ...publishJob.matchAll(
    /uses: actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version:\s+([^\s#]+)/g,
  ),
].map((match) => match[1]);

if (
  publishNodeVersions.length !== 1 ||
  !exactVersionPattern.test(publishNodeVersions[0]) ||
  publishNodeVersions[0] !== reviewedNodeVersion
) {
  failures.push(
    `publish-npm must use the reviewed exact Node runtime ${reviewedNodeVersion}`,
  );
}

if (!/permissions:\n      contents: read\n    outputs:/.test(verifyJob)) {
  failures.push("verify must receive only read access to repository contents");
}

if (!/permissions:\n      id-token: write\n    steps:/.test(publishJob)) {
  failures.push("publish-npm must grant only id-token: write");
}

if (!/^    needs:.*\bverify\b/m.test(publishJob)) {
  failures.push("publish-npm must hard-depend on verify");
}

if (!/^    needs:.*\bprepare-npm\b/m.test(publishJob)) {
  failures.push("publish-npm must hard-depend directly on prepare-npm");
}

if (!/^    needs:.*\bprepare-npm\b/m.test(verifyJob)) {
  failures.push("verify must hard-depend on prepare-npm");
}

if (!verifyJob.includes("uses: actions/upload-artifact@")) {
  failures.push("verify must upload its tested publication bundle");
}

if (!publishJob.includes("uses: actions/download-artifact@")) {
  failures.push("publish-npm must download the verified publication bundle");
}

if (
  !verifyJob.includes(
    "package-artifact-id: ${{ steps.package-artifact.outputs.artifact-id }}",
  )
) {
  failures.push("verify must expose the immutable package artifact ID");
}
if (
  !publishJob.includes(
    "artifact-ids: ${{ needs.verify.outputs.package-artifact-id }}",
  )
) {
  failures.push("publish-npm must download the exact package artifact ID from verify");
}

const originalTarballDiscovery = verifyJob.indexOf("mapfile -t tarballs");
const originalTarballCountGuard = verifyJob.indexOf(
  'if [[ "${#tarballs[@]}" -ne 1 ]]; then',
);
const originalTarballAssignment = verifyJob.indexOf('tarball="${tarballs[0]}"');
const reportedTarballGuard = verifyJob.indexOf(
  'if [[ "$tarball" != "$reported_tarball" ]]; then',
);
const uniqueTarballName = verifyJob.indexOf(
  'unique_tarball="$package_dir/patchpage-${cli_version}-run-attempt-${GITHUB_RUN_ATTEMPT}.tgz"',
);
const uniqueTarballMove = verifyJob.indexOf('mv -- "$tarball" "$unique_tarball"');
const uniqueTarballAssignment = verifyJob.indexOf('tarball="$unique_tarball"');
const tarballEnvironmentOutput = verifyJob.indexOf(
  'echo "TARBALL=$tarball" >> "$GITHUB_ENV"',
);
const tarballPathOutput = verifyJob.indexOf(
  'echo "tarball-path=$tarball" >> "$GITHUB_OUTPUT"',
);
const tarballFilenameOutput = verifyJob.indexOf(
  'echo "filename=$(basename "$tarball")" >> "$GITHUB_OUTPUT"',
);
const tarballDigestOutput = verifyJob.indexOf(
  'echo "sha256=$(sha256sum "$tarball"',
);
const smokeInstall = verifyJob.indexOf(
  'node "$NPM_CLI" install --ignore-scripts "$TARBALL"',
);
const smokeDigestGuard = verifyJob.indexOf(
  'if [[ "$actual_sha256" != "$EXPECTED_TARBALL_SHA256" ]]; then',
);
const packageUpload = verifyJob.indexOf("id: package-artifact");
const rawTarballDiscovery = publishJob.indexOf(
  'tarballs=("$RUNNER_TEMP/patchpage-package"/*.tgz)',
);
const rawTarballCountGuard = publishJob.indexOf(
  'if [[ "${#tarballs[@]}" -ne 1 ]]; then',
);
const rawTarballAssignment = publishJob.indexOf('tarball="${tarballs[0]}"');
const rawBasenameGuard = publishJob.indexOf(
  'if [[ "$(basename "$tarball")" != "$EXPECTED_FILENAME" ]]; then',
);
const rawDigestCalculation = publishJob.indexOf(
  'actual_sha256="$(sha256sum "$tarball"',
);
const rawDigestGuard = publishJob.indexOf(
  'if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then',
);
const packageMetadataRead = publishJob.indexOf(
  'tar -xOf "$tarball" package/package.json',
);
const publishTarCommands = publishJob.match(/^\s+tar\s+/gm) ?? [];
const publishUnzipCommands = publishJob.match(/^\s+unzip(?:\s|$)/gm) ?? [];

if (
  originalTarballDiscovery === -1 ||
  originalTarballCountGuard <= originalTarballDiscovery ||
  originalTarballAssignment <= originalTarballCountGuard ||
  !verifyJob
    .slice(originalTarballCountGuard, originalTarballAssignment)
    .includes("exit 1") ||
  reportedTarballGuard <= originalTarballAssignment ||
  uniqueTarballName <= reportedTarballGuard ||
  uniqueTarballMove <= uniqueTarballName ||
  uniqueTarballAssignment <= uniqueTarballMove ||
  tarballEnvironmentOutput <= uniqueTarballAssignment ||
  tarballPathOutput <= uniqueTarballAssignment ||
  tarballFilenameOutput <= uniqueTarballAssignment ||
  tarballDigestOutput <= uniqueTarballAssignment ||
  smokeInstall <= tarballDigestOutput ||
  smokeDigestGuard <= smokeInstall ||
  packageUpload <= smokeDigestGuard ||
  rawTarballDiscovery === -1 ||
  rawTarballCountGuard <= rawTarballDiscovery ||
  rawTarballAssignment <= rawTarballCountGuard ||
  !publishJob
    .slice(rawTarballCountGuard, rawTarballAssignment)
    .includes("exit 1") ||
  rawBasenameGuard <= rawTarballAssignment ||
  rawDigestCalculation <= rawBasenameGuard ||
  !publishJob.slice(rawBasenameGuard, rawDigestCalculation).includes("exit 1") ||
  rawDigestGuard <= rawDigestCalculation ||
  packageMetadataRead <= rawDigestGuard ||
  !publishJob.slice(rawDigestGuard, packageMetadataRead).includes("exit 1") ||
  publishTarCommands.length !== 1 ||
  publishUnzipCommands.length !== 0
) {
  failures.push(
    "the package artifact must cross into publish-npm as one run-isolated raw tarball and pass basename and digest checks before metadata is read",
  );
}

if (
  !publishJob.includes(
    "artifact-ids: ${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}",
  ) ||
  !publishJob.includes(
    "EXPECTED_NPM_VERSION: ${{ needs.prepare-npm.outputs.npm-version }}",
  )
) {
  failures.push(
    "publish-npm must download the npm CLI artifact and version directly from prepare-npm",
  );
}

for (const forbidden of [
  "needs.verify.outputs.npm-cli-artifact-id",
  "needs.verify.outputs.npm-version",
]) {
  if (publishJob.includes(forbidden)) {
    failures.push(`publish-npm must not source the npm CLI through verify via ${forbidden}`);
  }
}

if (
  !verifyJob.includes(
    "artifact-ids: ${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}",
  ) ||
  !verifyJob.includes("uses: actions/download-artifact@")
) {
  failures.push("verify must download the exact npm CLI artifact from prepare-npm");
}

for (const forbidden of [
  "node_modules/.bin/npm",
  "node_modules/npm",
  "cp -RL",
  "npm-cli-artifact-id: ${{ steps.",
  "Upload the pinned publishing CLI",
]) {
  if (verifyJob.includes(forbidden)) {
    failures.push(`verify must not stage or upload npm via ${forbidden}`);
  }
}

const npmCliDownload = verifyJob.indexOf(
  "artifact-ids: ${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}",
);
const npmPack = verifyJob.indexOf('node "$NPM_CLI" pack');
const npmInstall = verifyJob.indexOf(
  'node "$NPM_CLI" install --ignore-scripts "$TARBALL"',
);
const packagedCliExecution = verifyJob.indexOf(
  "./node_modules/.bin/patchpage --version",
);
const projectExecutionMarkers = [
  "pnpm install --frozen-lockfile",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm --filter patchpage build",
];
if (
  projectExecutionMarkers.some((marker) => {
    const markerPosition = verifyJob.indexOf(marker);
    return markerPosition === -1 || markerPosition >= npmCliDownload;
  }) ||
  npmCliDownload === -1 ||
  npmPack <= npmCliDownload ||
  npmInstall <= npmPack ||
  packagedCliExecution <= npmInstall
) {
  failures.push(
    "verify must finish project execution before using the isolated npm CLI to pack and install",
  );
}

if (
  !verifyJob.includes(
    "EXPECTED_NPM_VERSION: ${{ needs.prepare-npm.outputs.npm-version }}",
  ) ||
  !verifyJob.includes('NPM_CLI="$RUNNER_TEMP/npm-cli/bin/npm-cli.js"') ||
  !verifyJob.includes('node "$NPM_CLI" --version')
) {
  failures.push("verify must recheck the downloaded isolated npm CLI version");
}

for (const forbidden of [
  "uses: actions/checkout@",
  "uses: pnpm/action-setup@",
  "GITHUB_WORKSPACE",
  "node_modules/.bin",
  "prepack",
  "prepublishOnly",
]) {
  if (publishJob.includes(forbidden)) {
    failures.push(`publish-npm must not contain ${forbidden}`);
  }
}

const allowedPublishActions = new Set(["actions/setup-node", "actions/download-artifact"]);
for (const { coordinate } of actionUses.filter(
  ({ jobName }) => jobName === "publish-npm",
)) {
  const action = typeof coordinate === "string" ? coordinate.split("@")[0] : null;
  if (!allowedPublishActions.has(action)) {
    failures.push(`publish-npm must not execute the ${String(action)} Action`);
  }
}

if (/^\s+(?:npm|pnpm|npx)\s+/m.test(publishJob)) {
  failures.push("publish-npm must not invoke a package manager outside the staged npm CLI");
}

const allowedNpmCommands = new Set(["--version", "publish"]);
for (const match of publishJob.matchAll(/node\s+"\$npm_cli"\s+([A-Za-z-]+)/g)) {
  if (!allowedNpmCommands.has(match[1])) {
    failures.push(`publish-npm must not run npm ${match[1]}`);
  }
}

if (publishJob.includes('node "$npm_cli" view')) {
  failures.push("publish-npm must not infer package absence from npm view");
}

if ((verifyJob.match(/node "\$NPM_CLI" pack/g) ?? []).length !== 1) {
  failures.push("verify must pack exactly one release tarball with the pinned npm CLI");
}

if (!/node "\$NPM_CLI" pack \\\n\s+--ignore-scripts/.test(verifyJob)) {
  failures.push("verify must suppress pack lifecycle scripts after the explicit build");
}

if (!/node "\$NPM_CLI" install --ignore-scripts "\$TARBALL"/.test(verifyJob)) {
  failures.push("verify must smoke-install the same tarball with the pinned npm CLI");
}

const npmPublishCommands =
  publishJob.match(/^[ \t]+node "\$npm_cli" publish\b/gm) ?? [];
const exactProductionPublish =
  /^[ \t]+node "\$npm_cli" publish "\$tarball" --ignore-scripts --provenance(?:[ \t]+--registry=https:\/\/registry\.npmjs\.org|[ \t]+\\\n[ \t]+--registry=https:\/\/registry\.npmjs\.org)[ \t]*$/m;
if (
  npmPublishCommands.length !== 1 ||
  !exactProductionPublish.test(publishJob)
) {
  failures.push(
    "publish-npm must use the exact reviewed npm publish command and production registry",
  );
}

if (serverImageJob) {
  if (!sameMembers(jobNeeds(serverImageJob), ["guard"])) {
    failures.push("verify-server-image must depend only on the release guard");
  }

  if (
    !sameEntries(
      jobPermissions(serverImageJob),
      new Map([["contents", "read"]]),
    )
  ) {
    failures.push("verify-server-image must receive only repository read access");
  }

  if (
    !serverImageJob.includes("image-tar-filename: ${{ steps.image.outputs.filename }}") ||
    !serverImageJob.includes("image-tar-sha256: ${{ steps.image.outputs.sha256 }}") ||
    !serverImageJob.includes("image-id: ${{ steps.image.outputs.image-id }}") ||
    !serverImageJob.includes("config-id: ${{ steps.image.outputs.config-id }}") ||
    !serverImageJob.includes(
      "image-artifact-id: ${{ steps.image-artifact.outputs.artifact-id }}",
    )
  ) {
    failures.push(
      "verify-server-image must expose filename, SHA-256, image/config ID, and artifact ID outputs",
    );
  }

  if (
    !/^\s+VERSION\s*:\s*\$\{\{\s*needs\.guard\.outputs\.version\s*\}\}\s*$/m.test(
      serverImageJob,
    ) ||
    !/^\s+REVISION\s*:\s*\$\{\{\s*needs\.guard\.outputs\.revision\s*\}\}\s*$/m.test(
      serverImageJob,
    )
  ) {
    failures.push("verify-server-image must bind image metadata to guard outputs");
  }

  if (
    (serverImageJob.match(/\bdocker build\b/g) ?? []).length !== 1 ||
    !serverImageJob.includes('--build-arg "VERSION=$VERSION"') ||
    !serverImageJob.includes('--build-arg "REVISION=$REVISION"') ||
    !serverImageJob.includes("-f apps/server/Dockerfile") ||
    !serverImageJob.includes('scripts/verify-server-image.sh "$image" "$VERSION" "$REVISION"') ||
    !serverImageJob.includes('docker save "$image" --output "$tar_path"') ||
    !serverImageJob.includes('sha256sum "$tar_path"') ||
    !serverImageJob.includes('patchpage-server-${VERSION}-${REVISION}-${GITHUB_RUN_ATTEMPT}.tar')
  ) {
    failures.push(
      "verify-server-image must build, behaviorally verify, and save the exact metadata-bound image tar",
    );
  }

  const build = serverImageJob.indexOf("docker build");
  const builtImageId = serverImageJob.search(
    /built_image_id\s*=\s*"\$\(docker image inspect/,
  );
  const verifyImage = serverImageJob.indexOf(
    'scripts/verify-server-image.sh "$image" "$VERSION" "$REVISION"',
  );
  const verifiedImageId = serverImageJob.search(
    /verified_image_id\s*=\s*"\$\(docker image inspect/,
  );
  const saveImage = serverImageJob.indexOf('docker save "$image" --output "$tar_path"');
  const uploadImage = serverImageJob.indexOf("uses: actions/upload-artifact@");
  if (
    build === -1 ||
    builtImageId <= build ||
    verifyImage <= builtImageId ||
    verifiedImageId <= verifyImage ||
    !serverImageJob.includes('"$verified_image_id" != "$built_image_id"') ||
    saveImage <= verifiedImageId ||
    uploadImage <= saveImage ||
    !serverImageJob.includes("archive: false") ||
    serverImageJob.includes("\n          name:") ||
    !serverImageJob.includes("if-no-files-found: error")
  ) {
    failures.push(
      "verify-server-image must upload a run-attempt-isolated raw tar only after verification",
    );
  }

  for (const forbidden of [
    "docker/login-action",
    "docker login",
    "docker pull",
    "docker push",
    "packages:",
    "GITHUB_TOKEN",
    "github.token",
  ]) {
    if (serverImageJob.includes(forbidden)) {
      failures.push(`verify-server-image must not contain ${forbidden}`);
    }
  }
}

if (dockerJob) {
  if (!sameMembers(jobNeeds(dockerJob), ["guard", "publish-npm", "verify-server-image"])) {
    failures.push("docker-ghcr must depend on guard, publish-npm, and verify-server-image");
  }

  if (!sameEntries(jobPermissions(dockerJob), new Map([["packages", "write"]]))) {
    failures.push("docker-ghcr must grant only packages: write");
  }

  if (
    !dockerJob.includes(
      "manifest-digest: ${{ steps.publish-image.outputs.manifest-digest }}",
    )
  ) {
    failures.push("docker-ghcr must expose the verified GHCR manifest digest");
  }

  for (const forbidden of [
    "uses: actions/checkout@",
    "uses: pnpm/action-setup@",
    "docker run",
    "docker save",
    "scripts/verify-server-image.sh",
    "pnpm ",
    "npm ",
    "GITHUB_WORKSPACE",
    "contents:",
  ]) {
    if (dockerJob.includes(forbidden)) {
      failures.push(`docker-ghcr publisher must not contain ${forbidden}`);
    }
  }
  if (/\bdocker build(?:\s|$)/.test(dockerJob)) {
    failures.push("docker-ghcr publisher must not contain docker build");
  }

  if (
    !dockerJob.includes(
      "artifact-ids: ${{ needs.verify-server-image.outputs.image-artifact-id }}",
    ) ||
    !dockerJob.includes("skip-decompress: true")
  ) {
    failures.push("docker-ghcr must download the exact raw image artifact ID");
  }

  const downloadImage = dockerJob.indexOf(
    "artifact-ids: ${{ needs.verify-server-image.outputs.image-artifact-id }}",
  );
  const validateArtifact = dockerJob.indexOf(
    "Validate and load the verified server image artifact before login",
  );
  const tarCountCheck = dockerJob.indexOf('Expected exactly one downloaded server image tar');
  const basenameCheck = dockerJob.indexOf('Downloaded server image tar name does not match');
  const shaCheck = dockerJob.indexOf('Downloaded server image tar digest does not match');
  const loadImage = dockerJob.indexOf('docker load --input "$tar_path"');
  const localTagCheck = dockerJob.indexOf('does not contain the expected local release tag');
  const imageIdCheck = dockerJob.indexOf('"$loaded_image_id" != "$EXPECTED_IMAGE_ID"');
  const configIdCheck = dockerJob.indexOf('"$EXPECTED_CONFIG_ID" != "$EXPECTED_IMAGE_ID"');
  const deleteTar = dockerJob.indexOf('rm -f "$tar_path"');
  const login = dockerJob.indexOf("uses: docker/login-action@");
  const publishImage = dockerJob.indexOf("id: publish-image");
  if (
    downloadImage === -1 ||
    validateArtifact <= downloadImage ||
    tarCountCheck <= validateArtifact ||
    basenameCheck <= tarCountCheck ||
    shaCheck <= basenameCheck ||
    loadImage <= shaCheck ||
    localTagCheck <= loadImage ||
    imageIdCheck <= localTagCheck ||
    configIdCheck <= validateArtifact ||
    deleteTar <= imageIdCheck ||
    login <= deleteTar ||
    publishImage <= login
  ) {
    failures.push(
      "docker-ghcr must validate filename, SHA-256, local tag, and image/config ID before login",
    );
  }

  if (
    !/ghcr_image\s*=\s*"ghcr\.io\/allisonmahmood\/patchpage-server"/.test(dockerJob) ||
    !dockerJob.includes('semver_target="${ghcr_image}:${EXPECTED_VERSION}"') ||
    !dockerJob.includes('revision_target="${ghcr_image}:${EXPECTED_REVISION}"') ||
    !dockerJob.includes('latest_target="${ghcr_image}:latest"') ||
    dockerJob.includes("GITHUB_REF_NAME")
  ) {
    failures.push("docker-ghcr must derive semver, full-revision, and latest targets safely");
  }

  if (
    !dockerJob.includes("docker buildx imagetools inspect \"$target\"") ||
    !dockerJob.includes("docker buildx imagetools inspect --raw \"$target\"") ||
    !dockerJob.includes('if [[ "$remote_config_id" != "$EXPECTED_IMAGE_ID" ]]; then') ||
    !dockerJob.includes('if ! docker pull "$target"; then') ||
    !dockerJob.includes('"$pulled_image_id" != "$EXPECTED_IMAGE_ID"') ||
    !dockerJob.includes("already exists with verified image ID") ||
    dockerJob.includes("Immutable GHCR tag already exists")
  ) {
    failures.push(
      "docker-ghcr must accept only existing immutable tags with the verified image/config ID",
    );
  }
  const existingImmutableBranch = dockerJob.indexOf(
    'if inspect_remote_target "$target" remote_digest remote_config_id; then',
  );
  const existingImmutableMismatch = dockerJob.indexOf(
    "Existing immutable GHCR tag ${target} has config",
    existingImmutableBranch,
  );
  const existingImmutablePull = dockerJob.indexOf('if ! docker pull "$target"; then');
  const existingImmutablePrefix =
    existingImmutableBranch === -1 || existingImmutableMismatch === -1
      ? ""
      : dockerJob.slice(existingImmutableBranch, existingImmutableMismatch);
  if (
    existingImmutableBranch === -1 ||
    existingImmutableMismatch <= existingImmutableBranch ||
    existingImmutablePull <= existingImmutableMismatch ||
    !existingImmutablePrefix.includes(
      'if [[ "$remote_config_id" != "$EXPECTED_IMAGE_ID" ]]; then',
    )
  ) {
    failures.push(
      "docker-ghcr must reject existing immutable tag mismatches before pulling or accepting them",
    );
  }

  if (
    !dockerJob.includes('immutable_state["$target"]="missing"') ||
    !dockerJob.includes('push_verified_target "$target"') ||
    !dockerJob.includes('push_verified_target "$latest_target"') ||
    !dockerJob.includes('docker tag "$LOCAL_RELEASE_TAG" "$target"') ||
    !dockerJob.includes('docker push "$target"') ||
    !dockerJob.includes('remote digest ${remote_digest} drifted from pushed digest') ||
    !dockerJob.includes('remote config ${remote_config_id} does not match')
  ) {
    failures.push(
      "docker-ghcr must push missing immutable tags and reconcile latest from the verified image",
    );
  }

  if (
    !dockerJob.includes('verified_manifest_digest=""') ||
    !dockerJob.includes('"$digest" != "$verified_manifest_digest"') ||
    !dockerJob.includes("does not match previously verified GHCR digest") ||
    !dockerJob.includes('echo "manifest-digest=$verified_manifest_digest" >> "$GITHUB_OUTPUT"')
  ) {
    failures.push(
      "docker-ghcr must fail closed on remote digest drift and output one verified digest",
    );
  }

  const immutableDigestEstablished = dockerJob.indexOf(
    "Immutable GHCR tags did not establish the current release manifest digest",
  );
  const latestInspect = dockerJob.indexOf(
    'if inspect_remote_target "$latest_target" latest_remote_digest latest_remote_config_id; then',
  );
  const latestPull = dockerJob.indexOf('if ! docker pull "$latest_target"; then');
  const latestImageId = dockerJob.indexOf(
    'latest_pulled_image_id="$(docker image inspect --format',
  );
  const latestImageIdGuard = dockerJob.indexOf(
    'if [[ "$latest_pulled_image_id" != "$latest_remote_config_id" ]]; then',
  );
  const latestVersionRead = dockerJob.indexOf(
    'latest_version="$(docker image inspect --format',
  );
  const latestVersionGuard = dockerJob.indexOf(
    'if [[ ! "$latest_version" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then',
  );
  const latestComparison = dockerJob.indexOf('if ! latest_comparison="$(');
  const latestCaseStart = dockerJob.indexOf('case "$latest_comparison" in');
  const manifestDigestOutput = dockerJob.indexOf(
    'echo "manifest-digest=$verified_manifest_digest" >> "$GITHUB_OUTPUT"',
  );

  if (
    immutableDigestEstablished === -1 ||
    latestInspect <= immutableDigestEstablished ||
    latestPull <= latestInspect ||
    latestImageId <= latestPull ||
    latestImageIdGuard <= latestImageId ||
    latestVersionRead <= latestImageIdGuard ||
    latestVersionGuard <= latestVersionRead ||
    latestComparison <= latestVersionGuard ||
    latestCaseStart <= latestComparison ||
    manifestDigestOutput <= latestCaseStart
  ) {
    failures.push(
      "docker-ghcr must establish the immutable release digest before inspecting and gating latest, then output the immutable digest afterward",
    );
  }

  const latestGate =
    latestInspect === -1 || manifestDigestOutput === -1
      ? ""
      : dockerJob.slice(latestInspect, manifestDigestOutput);
  const latestCase = latestGate.match(
    /case "\$latest_comparison" in([\s\S]*?)\n\s+esac/,
  )?.[1];
  const latestOlder = latestCase?.match(/\n\s+older\)([\s\S]*?)\n\s+;;/)?.[1] ?? "";
  const latestEqual = latestCase?.match(/\n\s+equal\)([\s\S]*?)\n\s+;;/)?.[1] ?? "";
  const latestNewer = latestCase?.match(/\n\s+newer\)([\s\S]*?)\n\s+;;/)?.[1] ?? "";
  const latestUnknown = latestCase?.match(/\n\s+\*\)([\s\S]*?)\n\s+;;/)?.[1] ?? "";
  const latestAbsent = latestGate.match(
    /\n\s+else\n\s+echo "Latest GHCR tag is absent; publishing current release \$\{EXPECTED_VERSION\}"\n\s+push_verified_target "\$latest_target"\n\s+fi\s*$/,
  )?.[0] ?? "";

  if (
    !latestGate.includes("raw manifest config") ||
    !latestGate.includes("org.opencontainers.image.version") ||
    !latestGate.includes("Existing latest GHCR tag version metadata is invalid") ||
    !latestGate.includes('python3 - "$latest_version" "$EXPECTED_VERSION"') ||
    !latestGate.includes("existing_parts = [int(part) for part in existing.split(\".\")]") ||
    !latestGate.includes("expected_parts = [int(part) for part in expected.split(\".\")]") ||
    !latestGate.includes("Could not compare existing latest version") ||
    !latestGate.includes("Latest GHCR tag is absent; publishing current release")
  ) {
    failures.push(
      "docker-ghcr must fail closed while reading latest config, version label, and numeric semver comparison state",
    );
  }

  if (!latestAbsent) {
    failures.push("absent latest must be published from the verified current release image");
  }

  if (
    !latestOlder.includes('push_verified_target "$latest_target"') ||
    !latestOlder.includes("older than current release")
  ) {
    failures.push("older latest must be updated from the verified current release image");
  }

  if (
    !latestEqual.includes('if [[ "$latest_remote_config_id" != "$EXPECTED_IMAGE_ID" ]]; then') ||
    !latestEqual.includes(
      'if [[ "$latest_remote_digest" != "$verified_manifest_digest" ]]; then',
    ) ||
    latestEqual.includes('push_verified_target "$latest_target"')
  ) {
    failures.push(
      "equal latest must already match the current release config and immutable digest without mutation",
    );
  }

  const newerTarget = latestNewer.indexOf(
    'newer_target="${ghcr_image}:${latest_version}"',
  );
  const newerInspect = latestNewer.indexOf(
    'if ! inspect_remote_target "$newer_target" newer_remote_digest newer_remote_config_id; then',
  );
  const newerPull = latestNewer.indexOf('if ! docker pull "$newer_target"; then');
  const newerPulledImageId = latestNewer.indexOf(
    'newer_pulled_image_id="$(docker image inspect --format',
  );
  const newerPulledImageIdGuard = latestNewer.indexOf(
    'if [[ "$newer_pulled_image_id" != "$newer_remote_config_id" ]]; then',
  );
  const newerDigestGuard = latestNewer.indexOf(
    'if [[ "$newer_remote_digest" != "$latest_remote_digest" ]]; then',
  );
  const newerConfigGuard = latestNewer.indexOf(
    'if [[ "$newer_remote_config_id" != "$latest_remote_config_id" ]]; then',
  );
  const newerSkip = latestNewer.indexOf("leaving latest untouched");
  if (
    newerTarget === -1 ||
    newerInspect <= newerTarget ||
    newerPull <= newerInspect ||
    newerPulledImageId <= newerPull ||
    newerPulledImageIdGuard <= newerPulledImageId ||
    newerDigestGuard <= newerPulledImageIdGuard ||
    newerConfigGuard <= newerDigestGuard ||
    newerSkip <= newerConfigGuard ||
    !latestNewer.includes("newer than current release") ||
    latestNewer.includes('push_verified_target "$latest_target"') ||
    latestNewer.includes("$EXPECTED_IMAGE_ID") ||
    latestNewer.includes("$verified_manifest_digest")
  ) {
    failures.push(
      "newer latest must match its immutable semver tag by digest and pulled config before being left untouched",
    );
  }

  if (!latestUnknown.includes("exit 1")) {
    failures.push("unknown latest semver comparison results must fail closed");
  }
}

if (ciDockerJob) {
  if (
    !/^\s+VERSION\s*:\s*0\.0\.0-ci\s*$/m.test(ciDockerJob) ||
    !/^\s+REVISION\s*:\s*"0000000000000000000000000000000000000000"\s*$/m.test(
      ciDockerJob,
    )
  ) {
    failures.push("CI must use deterministic string image version and quoted revision metadata");
  }

  const build = ciDockerJob.indexOf("docker build");
  const verifyImage = ciDockerJob.search(
    /scripts\/verify-server-image\.sh\s+"\$image"\s+"\$VERSION"\s+"\$REVISION"/,
  );
  const buildCommand = ciDockerJob.slice(build, verifyImage);
  if (
    (ciDockerJob.match(/\bdocker build\b/g) ?? []).length !== 1 ||
    build === -1 ||
    verifyImage <= build ||
    !buildCommand.includes('--build-arg "VERSION=$VERSION"') ||
    !buildCommand.includes('--build-arg "REVISION=$REVISION"') ||
    !/-f\s+apps\/server\/Dockerfile/.test(buildCommand) ||
    !/-t\s+"\$image"\s+\./.test(buildCommand)
  ) {
    failures.push("CI must run the behavioral contract on its one metadata-bound image build");
  }

  for (const forbidden of [
    "docker login",
    "docker pull",
    "docker push",
    "ghcr.io/allisonmahmood/patchpage-server",
  ]) {
    if (ciDockerJob.includes(forbidden)) {
      failures.push(`CI's local image contract must not contain ${forbidden}`);
    }
  }
}

if (packageJson.scripts?.["test:server-image"] !== "bash scripts/verify-server-image.sh") {
  failures.push("package.json must expose the focused server image contract verifier");
}

if (
  !serverImageVerifier.includes('[[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]') ||
  !serverImageVerifier.includes("Expected revision must be a quoted 40-character lowercase hex string")
) {
  failures.push("verify-server-image.sh must reject coerced or non-40-hex revisions");
}

const supportedImage = "ghcr.io/allisonmahmood/patchpage-server";
if (!readme.includes(supportedImage) || !readme.includes("`/data`")) {
  failures.push("README must name the supported image and its persistence mount");
}

for (const required of [
  supportedImage,
  "patchpage-data:/data",
  "PATCHPAGE_DB_FILE=/data/patchpage-db.json",
  "PATCHPAGE_STORAGE_DIR=/data/drafts",
]) {
  if (!selfHosting.includes(required)) {
    failures.push(`self-hosting docs must document ${required}`);
  }
}
if (!/non[- ]root/i.test(selfHosting)) {
  failures.push("self-hosting docs must document the unprivileged runtime user");
}
if (!/semver[^\n]*immutable/i.test(selfHosting) || !/full\s+commit\s+SHA/i.test(selfHosting)) {
  failures.push("self-hosting docs must document both immutable image tag forms");
}
if (!/stable semver[^\n]*prerelease/i.test(selfHosting)) {
  failures.push(
    "self-hosting docs must document the stable-only release policy and prerelease rejection",
  );
}
if (!/(?:moving[^\n]*`latest`|`latest`[^\n]*(?:follows|moves))/i.test(selfHosting)) {
  failures.push("self-hosting docs must distinguish the moving latest tag");
}
if (
  !/newer `latest`[^\n]*manifest digest[^\n]*config[^\n]*immutable tag/i.test(selfHosting)
) {
  failures.push(
    "self-hosting docs must explain how a newer latest tag is authenticated before it is retained",
  );
}
for (const required of [
  "GHCR Public visibility",
  "does not change package visibility",
  "anonymous GHCR smoke",
  "issue #17",
]) {
  if (!selfHosting.includes(required)) {
    failures.push(`self-hosting docs must document the first-package visibility gate: ${required}`);
  }
}
if (
  !readme.includes("configured to publish") ||
  !readme.includes("anonymous GHCR smoke") ||
  !readme.includes("not a claim that the first package is already public")
) {
  failures.push("README must describe the GHCR public-visibility gate without claiming live availability");
}

if (anonymousImageJob) {
  if (!sameMembers(jobNeeds(anonymousImageJob), ["guard", "docker-ghcr"])) {
    failures.push("ghcr-anonymous-smoke must wait for guard and docker-ghcr");
  }

  if (!sameEntries(jobPermissions(anonymousImageJob), new Map())) {
    failures.push("ghcr-anonymous-smoke must have no GitHub token permissions");
  }

  for (const forbidden of [
    "uses:",
    "actions/checkout",
    "docker/login-action",
    "docker login",
    "docker build",
    "docker tag",
    "docker load",
    "docker save",
    "github.token",
    "GITHUB_TOKEN",
    "GITHUB_REF_NAME",
    ":latest",
    "packages:",
    "actions/download-artifact",
  ]) {
    if (anonymousImageJob.includes(forbidden)) {
      failures.push(`ghcr-anonymous-smoke must not contain ${forbidden}`);
    }
  }

  const pull = anonymousImageJob.indexOf('docker pull "$image"');
  const boot = anonymousImageJob.indexOf('docker run -d');
  const portInspect = anonymousImageJob.indexOf("docker container inspect");
  const healthRequest = anonymousImageJob.search(
    /body\s*=\s*"\$\(curl\s+-fsS\s+"http:\/\/127\.0\.0\.1:\$\{host_port\}\/healthz"[^\n]*\)"/,
  );
  const exactHealth = anonymousImageJob.search(
    /\[\[\s*"\$body"\s*==\s*'\{"ok":true\}'\s*\]\]/,
  );
  if (
    !/image\s*=\s*"ghcr\.io\/allisonmahmood\/patchpage-server:\$\{\{\s*needs\.guard\.outputs\.version\s*\}\}"/.test(
      anonymousImageJob,
    ) ||
    !anonymousImageJob.includes(
      "EXPECTED_DIGEST: ${{ needs.docker-ghcr.outputs.manifest-digest }}",
    ) ||
    pull === -1 ||
    boot <= pull ||
    portInspect <= boot ||
    !anonymousImageJob.slice(boot).includes('"$image"')
  ) {
    failures.push(
      "ghcr-anonymous-smoke must pull and boot the published immutable version tag",
    );
  }

  if (healthRequest <= boot || exactHealth <= healthRequest) {
    failures.push(
      "ghcr-anonymous-smoke must obtain and require the exact live /healthz response",
    );
  }

  if (
    !/docker_config\s*=\s*"\$\(mktemp -d\)"/.test(anonymousImageJob) ||
    !/export\s+DOCKER_CONFIG\s*=\s*"\$docker_config"/.test(anonymousImageJob) ||
    !anonymousImageJob.includes("-p 127.0.0.1::3000") ||
    !anonymousImageJob.includes("Docker did not publish the server port")
  ) {
    failures.push("ghcr-anonymous-smoke must isolate anonymous Docker credentials and host port");
  }

  const repoDigest = anonymousImageJob.indexOf("mapfile -t repo_digests");
  const digestCompare = anonymousImageJob.indexOf('"$actual_digest" != "$EXPECTED_DIGEST"');
  if (
    repoDigest <= pull ||
    digestCompare <= repoDigest ||
    boot <= digestCompare ||
    !anonymousImageJob.includes(
      "does not match the publisher-verified GHCR digest",
    ) ||
    !anonymousImageJob.includes(
      "Verify public pull, publisher digest, and health without credentials",
    )
  ) {
    failures.push(
      "ghcr-anonymous-smoke must compare the anonymous repo digest to the docker-ghcr output before boot",
    );
  }
}

function replaceOnce(source, search, replacement) {
  if (!source.includes(search)) {
    throw new Error(`mutation search string was not found: ${search}`);
  }
  return source.replace(search, replacement);
}

async function runMutationChecks() {
  const mutationFailures = [];
  const packageNameGuard = [
    '          if [[ "$package_name" != "patchpage" ]]; then',
    '            echo "::error::Downloaded package is named $package_name, expected patchpage"',
    "            exit 1",
    "          fi",
  ].join("\n");
  const basenameGuard = [
    '          if [[ "$(basename "$tarball")" != "$EXPECTED_FILENAME" ]]; then',
    '            echo "::error::Downloaded tarball name does not match the verified artifact"',
    "            exit 1",
    "          fi",
  ].join("\n");
  const shaGuard = [
    '          if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then',
    '            echo "::error::Downloaded tarball digest does not match the verified artifact"',
    "            exit 1",
    "          fi",
  ].join("\n");
  const publicationContractFailure =
    /publication step must contain exactly name, shell, env, and the reviewed run/;
  let checks;
  try {
    checks = [
      {
        name: "reject build and repository verifier moved into docker-ghcr",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish or accept immutable GHCR tags, then reconcile latest",
            [
              "      - name: Rebuild inside publisher",
              "        shell: bash",
              "        run: |",
              "          docker build .",
              '          scripts/verify-server-image.sh "$image" "$VERSION" "$REVISION"',
              "      - name: Publish or accept immutable GHCR tags, then reconcile latest",
            ].join("\n"),
          ),
        },
        expected:
          /docker-ghcr publisher must not contain (?:docker build|scripts\/verify-server-image\.sh)/,
      },
      {
        name: "reject stable SemVer validation deferred beyond the release guard",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            [
              '          if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then',
              '            echo "::error::Release version must be exact stable SemVer, got ${version}"',
              "            exit 1",
              "          fi",
              "",
            ].join("\n"),
            "",
          ),
        },
        expected:
          /guard must check out the repository before running the exact version producer/,
      },
      {
        name: "reject image artifact selected by name instead of immutable ID",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "artifact-ids: ${{ needs.verify-server-image.outputs.image-artifact-id }}",
            "name: patchpage-server-image-${{ github.run_attempt }}",
          ),
        },
        expected: /docker-ghcr must download the exact raw image artifact ID/,
      },
      {
        name: "reject GHCR login before artifact validation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Validate and load the verified server image artifact before login",
            [
              "      - uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0",
              "        with:",
              "          registry: ghcr.io",
              "          username: ${{ github.repository_owner }}",
              "          password: ${{ github.token }}",
              "      - name: Validate and load the verified server image artifact before login",
            ].join("\n"),
          ),
        },
        expected:
          /docker-ghcr must validate filename, SHA-256, local tag, and image\/config ID before login|release\.yml must retain all 1 reviewed docker\/login-action Action uses/,
      },
      {
        name: "reject accepting mismatched existing immutable tags",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            [
              '              if [[ "$remote_config_id" != "$EXPECTED_IMAGE_ID" ]]; then',
              '                echo "::error::Existing immutable GHCR tag ${target} has config ${remote_config_id}, expected ${EXPECTED_IMAGE_ID}"',
            ].join("\n"),
            [
              "              if false; then",
              '                echo "::error::Existing immutable GHCR tag ${target} has config ${remote_config_id}, expected ${EXPECTED_IMAGE_ID}"',
            ].join("\n"),
          ),
        },
        expected:
          /docker-ghcr must reject existing immutable tag mismatches before pulling or accepting them/,
      },
      {
        name: "reject always failing on existing immutable tags",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "already exists with verified image ID",
            "Immutable GHCR tag already exists",
          ),
        },
        expected:
          /docker-ghcr must accept only existing immutable tags with the verified image\/config ID/,
      },
      {
        name: "reject a single pending release queue",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  queue: max",
            "  queue: single",
          ),
        },
        expected:
          /release\.yml must serialize all patchpage-server publishes in one package-wide max queue without canceling running or pending releases/,
      },
      {
        name: "reject missing release concurrency",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            [
              "concurrency:",
              "  group: release-ghcr-patchpage-server",
              "  queue: max",
              "  cancel-in-progress: false",
              "",
            ].join("\n"),
            "",
          ),
        },
        expected: /release\.yml must serialize all patchpage-server publishes/,
      },
      {
        name: "reject removed GHCR digest output",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "manifest-digest: ${{ steps.publish-image.outputs.manifest-digest }}",
            "manifest-digest-removed: true",
          ),
        },
        expected: /docker-ghcr must expose the verified GHCR manifest digest/,
      },
      {
        name: "reject trusting an unattested newer latest version label",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '                if [[ "$newer_remote_digest" != "$latest_remote_digest" ]]; then',
            "                if false; then",
          ),
        },
        expected:
          /newer latest must match its immutable semver tag by digest and pulled config before being left untouched/,
      },
      {
        name: "reject older release overwriting authenticated newer latest",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '                echo "Existing latest GHCR tag version ${latest_version} is newer than current release ${EXPECTED_VERSION} and matches immutable tag ${newer_target} at ${latest_remote_digest}; leaving latest untouched"',
            [
              '                push_verified_target "$latest_target"',
              '                echo "Existing latest GHCR tag version ${latest_version} is newer than current release ${EXPECTED_VERSION} and matches immutable tag ${newer_target} at ${latest_remote_digest}; leaving latest untouched"',
            ].join("\n"),
          ),
        },
        expected:
          /newer latest must match its immutable semver tag by digest and pulled config before being left untouched/,
      },
      {
        name: "reject unquoted CI revision",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            'REVISION: "0000000000000000000000000000000000000000"',
            "REVISION: 0000000000000000000000000000000000000000",
          ),
        },
        expected: /CI must use deterministic string image version and quoted revision metadata/,
      },
      {
        name: "reject identity guard after false AND continuation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          false &&\n${packageNameGuard}`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject identity guard after backslash OR continuation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          true \\\n            ||\n${packageNameGuard}`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject identity guard after pipeline continuation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          true |\n${packageNameGuard}`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject identity guard rendered as multiline quoted text",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          : '\n${packageNameGuard}\n          '`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject identity guard rendered as escaped heredoc data",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          cat <<\\EOF\n${packageNameGuard}\n          EOF`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject identity guard rendered as multiple-heredoc data",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            [
              "          cat <<'FIRST' <<'SECOND'",
              "          harmless",
              "          FIRST",
              packageNameGuard,
              "          SECOND",
            ].join("\n"),
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject identity guard nested in split-line case",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            [
              '          case "safe"',
              "          in",
              "            never)",
              packageNameGuard,
              "              ;;",
              "          esac",
            ].join("\n"),
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject basename guard nested under false",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            basenameGuard,
            `          if false; then\n${basenameGuard}\n          fi`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject digest guard nested under false",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            shaGuard,
            `          if false; then\n${shaGuard}\n          fi`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject package name reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          package_name="patchpage"\n${packageNameGuard}`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject package version reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          if [[ "$package_version" != "$EXPECTED_VERSION" ]]; then',
            '          package_version="$EXPECTED_VERSION"\n          if [[ "$package_version" != "$EXPECTED_VERSION" ]]; then',
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject expected filename reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            basenameGuard,
            `          EXPECTED_FILENAME="$(basename "$tarball")"\n${basenameGuard}`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject expected digest reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            shaGuard,
            `          EXPECTED_SHA256="$actual_sha256"\n${shaGuard}`,
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject expected package version reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          if [[ "$package_version" != "$EXPECTED_VERSION" ]]; then',
            '          EXPECTED_VERSION="$package_version"\n          if [[ "$package_version" != "$EXPECTED_VERSION" ]]; then',
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject expected npm version reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          if [[ "$actual_npm_version" != "$EXPECTED_NPM_VERSION" ]]; then',
            '          EXPECTED_NPM_VERSION="$actual_npm_version"\n          if [[ "$actual_npm_version" != "$EXPECTED_NPM_VERSION" ]]; then',
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject disabled publication step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm\n        shell: bash",
            "      - name: Publish the verified tarball to npm\n        if: false\n        shell: bash",
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject continue-on-error publication step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm\n        shell: bash",
            "      - name: Publish the verified tarball to npm\n        continue-on-error: true\n        shell: bash",
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject extra publication step keys",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm\n        shell: bash",
            "      - name: Publish the verified tarball to npm\n        timeout-minutes: 1\n        shell: bash",
          ),
        },
        expected: publicationContractFailure,
      },
      {
        name: "reject unreviewed Action behind quoted uses key",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - id: version",
            '      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - "uses": attacker/action@main # v1.0.0\n      - id: version',
          ),
        },
        expected: /uses unreviewed Action attacker\/action/,
      },
      {
        name: "reject unreviewed Action behind alias mapping key",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            replaceOnce(
              workflow,
              "name: Release\n",
              "name: Release\nx-uses-key: &uses_key uses\n",
            ),
            "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - id: version",
            "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - *uses_key : attacker/action@main # v1.0.0\n      - id: version",
          ),
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/,
      },
      {
        name: "reject unreviewed Action behind alias value",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            replaceOnce(
              workflow,
              "name: Release\n",
              "name: Release\nx-attacker-action: &attacker_action attacker/action@main\n",
            ),
            "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - id: version",
            "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - uses: *attacker_action # v1.0.0\n      - id: version",
          ),
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/,
      },
      {
        name: "reject unreviewed Action behind merged step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            replaceOnce(
              workflow,
              "name: Release\n",
              "name: Release\nx-attacker-step: &attacker_step\n  uses: attacker/action@main\n",
            ),
            "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - id: version",
            "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n      - <<: *attacker_step\n      - id: version",
          ),
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/,
      },
      {
        name: "reject guard output producer rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      version: ${{ steps.version.outputs.version }}",
            "      version: ${{ steps.attacker.outputs.version }}",
          ),
        },
        expected: /guard outputs must bind exactly to the version producer/,
      },
      {
        name: "reject guard producer ID rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - id: version",
            "      - id: attacker",
          ),
        },
        expected: /guard version producer step must exist exactly once/,
      },
      {
        name: "reject guard producer run changes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "revision=$revision" >> "$GITHUB_OUTPUT"',
            '          echo "revision=$revision" >> "$GITHUB_OUTPUT"\n          : changed',
          ),
        },
        expected: /guard must check out the repository before running the exact version producer/,
      },
      {
        name: "reject package filename output rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      tarball-filename: ${{ steps.package.outputs.filename }}",
            "      tarball-filename: ${{ steps.attacker.outputs.filename }}",
          ),
        },
        expected: /verify outputs must bind to the exact package and artifact producers/,
      },
      {
        name: "reject package digest output rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      tarball-sha256: ${{ steps.package.outputs.sha256 }}",
            "      tarball-sha256: ${{ steps.attacker.outputs.sha256 }}",
          ),
        },
        expected: /verify outputs must bind to the exact package and artifact producers/,
      },
      {
        name: "reject package producer run changes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "sha256=$(sha256sum "$tarball" | awk \'{print $1}\')" >> "$GITHUB_OUTPUT"',
            '          echo "sha256=$(sha256sum "$tarball" | awk \'{print $1}\')" >> "$GITHUB_OUTPUT"\n          : changed',
          ),
        },
        expected: /verify outputs must bind to the exact package and artifact producers/,
      },
      {
        name: "reject later GITHUB_ENV writes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Rebind package environment\n        shell: bash\n        run: echo "TARBALL=/tmp/attacker.tgz" >> "$GITHUB_ENV"\n      - name: Upload the exact tested tarball',
          ),
        },
        expected: /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/,
      },
      {
        name: "reject later GITHUB_OUTPUT writes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Add later output\n        id: later\n        shell: bash\n        run: echo "sha256=attacker" >> "$GITHUB_OUTPUT"\n      - name: Upload the exact tested tarball',
          ),
        },
        expected: /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/,
      },
      {
        name: "reject later GITHUB_ENV redirection",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Redirect package environment\n        shell: bash\n        run: printf "%s\\n" "TARBALL=/tmp/attacker.tgz" > "${GITHUB_ENV}"\n      - name: Upload the exact tested tarball',
          ),
        },
        expected: /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/,
      },
      {
        name: "reject later GITHUB_OUTPUT redirection",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Redirect later output\n        id: later\n        shell: bash\n        run: printf "%s\\n" "sha256=attacker" > "${GITHUB_OUTPUT}"\n      - name: Upload the exact tested tarball',
          ),
        },
        expected: /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/,
      },
      {
        name: "reject top-level jobs alias override",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "jobs:\n",
            [
              "x-jobs-key: &jobs_key jobs",
              "? *jobs_key",
              ":",
              "  attacker:",
              "    runs-on: ubuntu-latest",
              "    permissions:",
              "      id-token: write",
              "    steps:",
              "      - run: echo attacker",
              "jobs:",
            ].join("\n") + "\n",
          ),
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/,
      },
      {
        name: "reject unexpected privileged release job",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  guard:\n",
            [
              "  attacker:",
              "    runs-on: ubuntu-latest",
              "    permissions:",
              "      contents: write",
              "      id-token: write",
              "      packages: write",
              "    steps:",
              "      - run: echo attacker",
              "  guard:",
            ].join("\n") + "\n",
          ),
        },
        expected: /release\.yml must contain exactly the reviewed release jobs/,
      },
      {
        name: "reject npm CLI replacement after producer output",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "version=$actual_version" >> "$GITHUB_OUTPUT"',
            '          echo "version=$actual_version" >> "$GITHUB_OUTPUT"\n          printf "%s\\n" "#!/usr/bin/env node" "console.log(\\"$EXPECTED_NPM_VERSION\\")" > "$npm_cli_dir/bin/npm-cli.js"',
          ),
        },
        expected:
          /prepare-npm must fetch, verify, and output the exact reviewed npm CLI before upload/,
      },
      {
        name: "reject executable step between npm CLI producer and upload",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the reviewed npm CLI",
            '      - name: Replace reviewed npm CLI\n        shell: bash\n        run: echo attacker > "$RUNNER_TEMP/npm-cli/bin/npm-cli.js"\n      - name: Upload the reviewed npm CLI',
          ),
        },
        expected: /prepare-npm must contain exactly the reviewed job map and ordered steps/,
      },
      {
        name: "reject npm CLI replacement after verify-side version check",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "NPM_CLI=$NPM_CLI" >> "$GITHUB_ENV"',
            '          echo "NPM_CLI=$NPM_CLI" >> "$GITHUB_ENV"\n          echo attacker > "$NPM_CLI"',
          ),
        },
        expected: /verify must bind and validate the exact isolated npm CLI/,
      },
      {
        name: "reject disabled minimum-Node smoke step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash",
            "      - name: Install and run tarball on minimum supported Node\n        if: false\n        shell: bash",
          ),
        },
        expected: /verify must run the exact tarball smoke contract on the minimum supported Node 22/,
      },
      {
        name: "reject continue-on-error minimum-Node smoke step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash",
            "      - name: Install and run tarball on minimum supported Node\n        continue-on-error: true\n        shell: bash",
          ),
        },
        expected: /verify must run the exact tarball smoke contract on the minimum supported Node 22/,
      },
      {
        name: "reject changed minimum supported Node",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          node-version: 22\n      - name: Install and run tarball on minimum supported Node",
            "          node-version: 23\n      - name: Install and run tarball on minimum supported Node",
          ),
        },
        expected: /verify must run the exact tarball smoke contract on the minimum supported Node 22/,
      },
      {
        name: "reject minimum-Node smoke run changes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash\n        env:\n          EXPECTED_TARBALL_SHA256: ${{ steps.package.outputs.sha256 }}\n        run: |\n          set -euo pipefail",
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash\n        env:\n          EXPECTED_TARBALL_SHA256: ${{ steps.package.outputs.sha256 }}\n        run: |\n          set -euo pipefail\n          : changed",
          ),
        },
        expected: /verify must run the exact tarball smoke contract on the minimum supported Node 22/,
      },
      {
        name: "reject minimum-Node smoke environment rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          EXPECTED_TARBALL_SHA256: ${{ steps.package.outputs.sha256 }}",
            "          EXPECTED_TARBALL_SHA256: attacker",
          ),
        },
        expected: /verify must run the exact tarball smoke contract on the minimum supported Node 22/,
      },
      {
        name: "reject extra minimum-Node smoke key",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash",
            "      - name: Install and run tarball on minimum supported Node\n        timeout-minutes: 1\n        shell: bash",
          ),
        },
        expected: /verify must run the exact tarball smoke contract on the minimum supported Node 22/,
      },
      {
        name: "reject dist rewrite before package producer",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Pack exactly one release tarball and verify contents",
            '      - name: Rewrite built CLI\n        shell: bash\n        run: echo attacker > packages/cli/dist/index.js\n      - name: Pack exactly one release tarball and verify contents',
          ),
        },
        expected:
          /verify must contain exactly the reviewed job map and ordered build and smoke steps/,
      },
      {
        name: "reject executable step between publication downloads and publish",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm",
            '      - name: Replace publishing CLI\n        shell: bash\n        run: echo attacker > "$RUNNER_TEMP/npm-cli/bin/npm-cli.js"\n      - name: Publish the verified tarball to npm',
          ),
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/,
      },
      {
        name: "reject executable step after publication",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "\n  github-release:",
            '\n      - name: Run after npm publication\n        shell: bash\n        run: echo attacker\n\n  github-release:',
          ),
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/,
      },
      {
        name: "reject prepare-npm container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  prepare-npm:\n    runs-on: ubuntu-latest",
            "  prepare-npm:\n    runs-on: ubuntu-latest\n    container: attacker/image:latest",
          ),
        },
        expected: /prepare-npm must contain exactly the reviewed job map and ordered steps/,
      },
      {
        name: "reject verify container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  verify:\n    needs: [guard, prepare-npm]\n    runs-on: ubuntu-latest",
            "  verify:\n    needs: [guard, prepare-npm]\n    runs-on: ubuntu-latest\n    container: attacker/image:latest",
          ),
        },
        expected:
          /verify must contain exactly the reviewed job map and ordered build and smoke steps/,
      },
      {
        name: "reject publish-npm container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    container: attacker/image:latest",
          ),
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/,
      },
      {
        name: "reject publish-npm services",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    services:\n      attacker:\n        image: attacker/image:latest",
          ),
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/,
      },
      {
        name: "reject conditional publish-npm job",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    if: false",
          ),
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/,
      },
      {
        name: "reject publish-npm strategy",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        attacker: [true]",
          ),
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/,
      },
      {
        name: "reject publish-npm job environment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    env:\n      NODE_OPTIONS: attacker",
          ),
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/,
      },
    ];
  } catch (error) {
    mutationFailures.push(error.message);
    return mutationFailures;
  }

  for (const check of checks) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...check.env,
        PATCHPAGE_RELEASE_WORKFLOW_SKIP_MUTATION_CHECKS: "1",
      },
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status === 0) {
      mutationFailures.push(`${check.name}: mutated workflow was accepted`);
      continue;
    }
    if (!check.expected.test(output)) {
      mutationFailures.push(
        `${check.name}: expected failure was not reported; saw ${output.trim()}`,
      );
    }
  }

  return mutationFailures;
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  const mutationFailures =
    process.env.PATCHPAGE_RELEASE_WORKFLOW_SKIP_MUTATION_CHECKS === "1"
      ? []
      : await runMutationChecks();

  if (mutationFailures.length > 0) {
    for (const failure of mutationFailures) {
      console.error(`- mutation check failed: ${failure}`);
    }
    process.exitCode = 1;
  } else {
  console.log(
      `Verified ${actionUses.length} pinned Actions, npm@${npmVersion}, exact release image identity, anonymous GHCR gate, and mutation checks.`,
  );
  }
}
