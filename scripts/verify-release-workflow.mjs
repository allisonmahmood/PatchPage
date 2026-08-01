import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

const repoRoot = path.resolve(
  process.env.PATCHPAGE_RELEASE_WORKFLOW_REPO_ROOT ?? path.dirname(fileURLToPath(import.meta.url)),
  process.env.PATCHPAGE_RELEASE_WORKFLOW_REPO_ROOT ? "." : ".."
);
const workflowPath = path.join(repoRoot, ".github/workflows/release.yml");
const [
  workflowFile,
  reconcileWorkflowFile,
  ciWorkflowFile,
  packageSource,
  lockfile,
  dependabot,
  selfHostingFile,
  readmeFile,
  serverImageVerifier,
  dockerSaveValidator,
  ghcrOciReleaseTool,
  exactNpmPublisherFile
] = await Promise.all([
  readFile(workflowPath, "utf8"),
  readFile(path.join(repoRoot, ".github/workflows/reconcile-ghcr.yml"), "utf8"),
  readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
  readFile(path.join(repoRoot, "package.json"), "utf8"),
  readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"),
  readFile(path.join(repoRoot, ".github/dependabot.yml"), "utf8"),
  readFile(path.join(repoRoot, "docs/SELF_HOSTING.md"), "utf8"),
  readFile(path.join(repoRoot, "README.md"), "utf8"),
  readFile(path.join(repoRoot, "scripts/verify-server-image.sh"), "utf8"),
  readFile(path.join(repoRoot, "scripts/validate-docker-save-artifact.mjs")),
  readFile(path.join(repoRoot, "scripts/ghcr-oci-release.mjs")),
  readFile(path.join(repoRoot, "scripts/publish-exact-npm-artifact.mjs"), "utf8")
]);
const workflow = process.env.PATCHPAGE_RELEASE_WORKFLOW_SOURCE ?? workflowFile;
const reconcileWorkflow = process.env.PATCHPAGE_RECONCILE_WORKFLOW_SOURCE ?? reconcileWorkflowFile;
const ciWorkflow = process.env.PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE ?? ciWorkflowFile;
const dockerSaveValidatorSource = process.env.PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE;
const ghcrOciReleaseToolSource = process.env.PATCHPAGE_GHCR_OCI_RELEASE_SOURCE;
const exactNpmPublisher = process.env.PATCHPAGE_EXACT_NPM_PUBLISHER_SOURCE ?? exactNpmPublisherFile;
const effectiveDockerSaveValidator = dockerSaveValidatorSource
  ? Buffer.from(dockerSaveValidatorSource)
  : dockerSaveValidator;
const effectiveGhcrOciReleaseTool = ghcrOciReleaseToolSource
  ? Buffer.from(ghcrOciReleaseToolSource)
  : ghcrOciReleaseTool;
const selfHosting = process.env.PATCHPAGE_RELEASE_SELF_HOSTING_SOURCE ?? selfHostingFile;
const readme = process.env.PATCHPAGE_RELEASE_README_SOURCE ?? readmeFile;
const packageJson = JSON.parse(packageSource);
const failures = [];
let parsedWorkflow = null;
let workflowDocument = null;
let parsedReconcileWorkflow = null;
let reconcileWorkflowDocument = null;
let parsedCiWorkflow = null;
let ciWorkflowDocument = null;

function hasUnsupportedYamlIndirection(node) {
  if (node === null || typeof node !== "object") {
    return false;
  }
  if (isAlias(node) || typeof node.anchor === "string" || typeof node.tag === "string") {
    return true;
  }
  if (isMap(node)) {
    return node.items.some(
      (pair) =>
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        pair.key.value === "<<" ||
        hasUnsupportedYamlIndirection(pair.key) ||
        hasUnsupportedYamlIndirection(pair.value)
    );
  }
  if (isSeq(node)) {
    return node.items.some(hasUnsupportedYamlIndirection);
  }
  return false;
}

function isPlainResolvedValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isPlainResolvedValue);
  }
  if (isMapping(value)) {
    return Object.values(value).every(isPlainResolvedValue);
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
      "release.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys; explicit tags are forbidden"
    );
  } else {
    const resolvedWorkflow = document.toJS();
    if (!isPlainResolvedValue(resolvedWorkflow)) {
      failures.push("release.yml must resolve only to plain scalar, array, and object values");
    } else {
      workflowDocument = document;
      parsedWorkflow = resolvedWorkflow;
    }
  }
} catch (error) {
  failures.push(
    `release.yml must be valid YAML with unique map keys: ${error instanceof Error ? error.message : String(error)}`
  );
}

try {
  const document = parseDocument(reconcileWorkflow, {
    keepSourceTokens: true,
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      failures.push(`reconcile-ghcr.yml must be valid YAML with unique map keys: ${error.message}`);
    }
  } else if (hasUnsupportedYamlIndirection(document.contents)) {
    failures.push(
      "reconcile-ghcr.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys; explicit tags are forbidden"
    );
  } else {
    const resolvedWorkflow = document.toJS();
    if (!isPlainResolvedValue(resolvedWorkflow)) {
      failures.push(
        "reconcile-ghcr.yml must resolve only to plain scalar, array, and object values"
      );
    } else {
      reconcileWorkflowDocument = document;
      parsedReconcileWorkflow = resolvedWorkflow;
    }
  }
} catch (error) {
  failures.push(
    `reconcile-ghcr.yml must be valid YAML with unique map keys: ${error instanceof Error ? error.message : String(error)}`
  );
}

try {
  const document = parseDocument(ciWorkflow, {
    keepSourceTokens: true,
    uniqueKeys: true
  });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      failures.push(`ci.yml must be valid YAML with unique map keys: ${error.message}`);
    }
  } else if (hasUnsupportedYamlIndirection(document.contents)) {
    failures.push(
      "ci.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys; explicit tags are forbidden"
    );
  } else {
    const resolvedWorkflow = document.toJS();
    if (!isPlainResolvedValue(resolvedWorkflow)) {
      failures.push("ci.yml must resolve only to plain scalar, array, and object values");
    } else {
      ciWorkflowDocument = document;
      parsedCiWorkflow = resolvedWorkflow;
    }
  }
} catch (error) {
  failures.push(
    `ci.yml must be valid YAML with unique map keys: ${error instanceof Error ? error.message : String(error)}`
  );
}

const reviewedNodeVersion = "24.18.0";
const exactVersionPattern = /^\d+\.\d+\.\d+$/;
const reviewedNpm = Object.freeze({
  version: "12.0.2",
  integrity:
    "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw=="
});
const reviewedActions = new Map([
  [
    "actions/checkout",
    {
      version: "v7.0.1",
      sha: "3d3c42e5aac5ba805825da76410c181273ba90b1"
    }
  ],
  [
    "actions/setup-node",
    {
      version: "v7.0.0",
      sha: "820762786026740c76f36085b0efc47a31fe5020"
    }
  ],
  [
    "pnpm/action-setup",
    {
      version: "v6.0.9",
      sha: "0ebf47130e4866e96fce0953f49152a61190b271"
    }
  ],
  [
    "actions/upload-artifact",
    {
      version: "v7.0.1",
      sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
    }
  ],
  [
    "actions/download-artifact",
    {
      version: "v8.0.1",
      sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
    }
  ],
  [
    "docker/login-action",
    {
      version: "v3.7.0",
      sha: "c94ce9fb468520275223c153574b00df6fe4bcc9"
    }
  ]
]);
const reviewedUploadArtifact = `actions/upload-artifact@${reviewedActions.get("actions/upload-artifact").sha}`;
const reviewedDownloadArtifact = `actions/download-artifact@${reviewedActions.get("actions/download-artifact").sha}`;
const expectedVersionProducerRun = [
  "set -euo pipefail",
  "",
  'version="$(node -p "require(\'./packages/cli/package.json\').version")"',
  'if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then',
  '  echo "::error::Release version must be exact stable SemVer, got ${version}"',
  "  exit 1",
  "fi",
  "",
  'expected_ref="v${version}"',
  "",
  'if [[ "$expected_ref" != "$GITHUB_REF_NAME" ]]; then',
  '  echo "::error::Tag ${GITHUB_REF_NAME} does not match packages/cli version ${expected_ref}"',
  "  exit 1",
  "fi",
  "",
  'if ! grep -Fq "## [${version}]" CHANGELOG.md; then',
  '  echo "::error::CHANGELOG.md is missing a ## [${version}] heading"',
  "  exit 1",
  "fi",
  "",
  'revision="$(git rev-parse HEAD)"',
  'if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then',
  '  echo "::error::Resolved release revision is not a full commit SHA: ${revision}"',
  "  exit 1",
  "fi",
  "",
  'echo "version=$version" >> "$GITHUB_OUTPUT"',
  'echo "revision=$revision" >> "$GITHUB_OUTPUT"',
  ""
].join("\n");
const expectedNpmCliProducerRun = [
  "set -euo pipefail",
  "",
  'if [[ ! "$EXPECTED_NPM_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
  '  echo "::error::Expected an exact npm version, got $EXPECTED_NPM_VERSION"',
  "  exit 1",
  "fi",
  "",
  'npm_tarball="$RUNNER_TEMP/npm-${EXPECTED_NPM_VERSION}.tgz"',
  'npm_cli_dir="$RUNNER_TEMP/npm-cli"',
  'rm -f "$npm_tarball"',
  'rm -rf "$npm_cli_dir"',
  "",
  "curl --fail --silent --show-error \\",
  "  --proto '=https' \\",
  "  --tlsv1.2 \\",
  '  --output "$npm_tarball" \\',
  '  "https://registry.npmjs.org/npm/-/npm-${EXPECTED_NPM_VERSION}.tgz"',
  "",
  'actual_integrity="$(',
  "  node - \"$npm_tarball\" <<'NODE'",
  'const { createHash } = require("node:crypto");',
  'const { readFileSync } = require("node:fs");',
  "",
  'const digest = createHash("sha512")',
  "  .update(readFileSync(process.argv[2]))",
  '  .digest("base64");',
  "process.stdout.write(`sha512-${digest}`);",
  "NODE",
  ')"',
  "",
  'if [[ "$actual_integrity" != "$EXPECTED_NPM_INTEGRITY" ]]; then',
  '  echo "::error::npm registry tarball integrity mismatch"',
  "  exit 1",
  "fi",
  "",
  'mkdir -p "$npm_cli_dir"',
  'tar -xzf "$npm_tarball" -C "$npm_cli_dir" --strip-components=1',
  "",
  'actual_version="$(node "$npm_cli_dir/bin/npm-cli.js" --version)"',
  'if [[ "$actual_version" != "$EXPECTED_NPM_VERSION" ]]; then',
  '  echo "::error::Verified npm CLI reported $actual_version, expected $EXPECTED_NPM_VERSION"',
  "  exit 1",
  "fi",
  "",
  'echo "version=$actual_version" >> "$GITHUB_OUTPUT"',
  ""
].join("\n");
const expectedVerifyNpmCliRun = [
  "set -euo pipefail",
  "",
  'NPM_CLI="$RUNNER_TEMP/npm-cli/bin/npm-cli.js"',
  'actual_version="$(node "$NPM_CLI" --version)"',
  'if [[ "$actual_version" != "$EXPECTED_NPM_VERSION" ]]; then',
  '  echo "::error::Downloaded npm CLI reported $actual_version, expected $EXPECTED_NPM_VERSION"',
  "  exit 1",
  "fi",
  "",
  'echo "NPM_CLI=$NPM_CLI" >> "$GITHUB_ENV"',
  ""
].join("\n");
const expectedPackageProducerRun = [
  "set -euo pipefail",
  "",
  'package_dir="$RUNNER_TEMP/patchpage-package"',
  'rm -rf "$package_dir"',
  'mkdir -p "$package_dir"',
  "",
  "cd packages/cli",
  'node "$NPM_CLI" pack \\',
  "  --ignore-scripts \\",
  "  --json \\",
  '  --pack-destination "$package_dir" \\',
  '  > "$RUNNER_TEMP/patchpage-pack.json"',
  "",
  "node - \"$RUNNER_TEMP/patchpage-pack.json\" <<'NODE'",
  'const fs = require("node:fs");',
  "",
  'const pack = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))[0];',
  'const required = ["dist/index.js", "skills/patchpage/SKILL.md", "LICENSE", "README.md"];',
  "const files = new Set(pack.files.map((file) => file.path));",
  "const missing = required.filter((file) => !files.has(file));",
  "",
  "if (missing.length > 0) {",
  '  console.error(`Missing reviewed required npm pack files (${missing.length}): ${missing.join(", ")}`);',
  "  process.exit(1);",
  "}",
  "NODE",
  "",
  'reported_tarball="$(',
  '  node - "$RUNNER_TEMP/patchpage-pack.json" "$package_dir" <<\'NODE\'',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "",
  'const pack = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))[0];',
  "process.stdout.write(path.resolve(process.argv[3], pack.filename));",
  "NODE",
  ')"',
  "",
  "mapfile -t tarballs < <(find \"$package_dir\" -maxdepth 1 -type f -name 'patchpage-*.tgz' -print)",
  'if [[ "${#tarballs[@]}" -ne 1 ]]; then',
  '  echo "::error::Expected exactly one PatchPage tarball, found ${#tarballs[@]}"',
  "  exit 1",
  "fi",
  "",
  'tarball="${tarballs[0]}"',
  'if [[ "$tarball" != "$reported_tarball" ]]; then',
  '  echo "::error::npm pack reported a different tarball than the sole produced artifact"',
  "  exit 1",
  "fi",
  "",
  'cli_version="$(node -p "require(\'./package.json\').version")"',
  'unique_tarball="$package_dir/patchpage-${cli_version}-run-attempt-${GITHUB_RUN_ATTEMPT}.tgz"',
  'mv -- "$tarball" "$unique_tarball"',
  'tarball="$unique_tarball"',
  "",
  "node ../../scripts/verify-release-privacy.mjs \\",
  '  --pack-json "$RUNNER_TEMP/patchpage-pack.json" \\',
  '  --tarball "$tarball"',
  "",
  'echo "TARBALL=$tarball" >> "$GITHUB_ENV"',
  'echo "CLI_VERSION=$cli_version" >> "$GITHUB_ENV"',
  'echo "tarball-path=$tarball" >> "$GITHUB_OUTPUT"',
  'echo "filename=$(basename "$tarball")" >> "$GITHUB_OUTPUT"',
  'echo "sha256=$(sha256sum "$tarball" | awk \'{print $1}\')" >> "$GITHUB_OUTPUT"',
  ""
].join("\n");
const expectedMinimumNodeSmokeRun = [
  "set -euo pipefail",
  "",
  'tmp_dir="$(mktemp -d)"',
  'cd "$tmp_dir"',
  'node "$NPM_CLI" install --ignore-scripts "$TARBALL"',
  "",
  'output="$(./node_modules/.bin/patchpage --version)"',
  'if [[ "$output" != "$CLI_VERSION" ]]; then',
  '  echo "::error::Expected patchpage --version to print $CLI_VERSION, got $output"',
  "  exit 1",
  "fi",
  "",
  'if [[ "$output" == "0.0.0-dev" ]]; then',
  '  echo "::error::Installed patchpage binary reported 0.0.0-dev"',
  "  exit 1",
  "fi",
  "",
  './node_modules/.bin/patchpage validate "$GITHUB_WORKSPACE/examples/plan.html"',
  "",
  'actual_sha256="$(sha256sum "$TARBALL" | awk \'{print $1}\')"',
  'if [[ "$actual_sha256" != "$EXPECTED_TARBALL_SHA256" ]]; then',
  '  echo "::error::The tested tarball changed during the smoke install"',
  "  exit 1",
  "fi",
  ""
].join("\n");
const expectedPublisherPreparationRun = [
  "set -euo pipefail",
  "",
  'publisher="$GITHUB_WORKSPACE/scripts/publish-exact-npm-artifact.mjs"',
  'if [[ ! -f "$publisher" || -L "$publisher" ]]; then',
  '  echo "::error::The exact npm publisher source is unavailable"',
  "  exit 1",
  "fi",
  "",
  'echo "path=$publisher" >> "$GITHUB_OUTPUT"',
  'echo "sha256=$(sha256sum "$publisher" | awk \'{print $1}\')" >> "$GITHUB_OUTPUT"',
  ""
].join("\n");
const expectedPublicationRun = [
  "set -euo pipefail",
  "",
  "shopt -s nullglob",
  'tarballs=("$RUNNER_TEMP/patchpage-package"/*.tgz)',
  'if [[ "${#tarballs[@]}" -ne 1 ]]; then',
  '  echo "::error::The exact npm tarball artifact is unavailable"',
  "  exit 1",
  "fi",
  "",
  'tarball="${tarballs[0]}"',
  'if [[ "$(basename "$tarball")" != "$EXPECTED_FILENAME" ]]; then',
  '  echo "::error::The npm tarball artifact name is invalid"',
  "  exit 1",
  "fi",
  "",
  'actual_sha256="$(sha256sum "$tarball" | awk \'{print $1}\')"',
  'if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then',
  '  echo "::error::The npm tarball artifact digest is invalid"',
  "  exit 1",
  "fi",
  "",
  'publisher_scripts=("$RUNNER_TEMP/npm-publisher"/*.mjs)',
  'if [[ "${#publisher_scripts[@]}" -ne 1 ]]; then',
  '  echo "::error::The exact npm publisher artifact is unavailable"',
  "  exit 1",
  "fi",
  "",
  'publisher="${publisher_scripts[0]}"',
  'if [[ "$(basename "$publisher")" != "publish-exact-npm-artifact.mjs" ]]; then',
  '  echo "::error::The exact npm publisher artifact name is invalid"',
  "  exit 1",
  "fi",
  "",
  'actual_publisher_sha256="$(sha256sum "$publisher" | awk \'{print $1}\')"',
  'if [[ "$actual_publisher_sha256" != "$EXPECTED_PUBLISHER_SHA256" ]]; then',
  '  echo "::error::The exact npm publisher artifact digest is invalid"',
  "  exit 1",
  "fi",
  "",
  'npm_cli_dir="$RUNNER_TEMP/npm-cli"',
  'actual_npm_version="$(node "$npm_cli_dir/bin/npm-cli.js" --version)"',
  'if [[ "$actual_npm_version" != "$EXPECTED_NPM_VERSION" ]]; then',
  '  echo "::error::The pinned npm CLI artifact version is invalid"',
  "  exit 1",
  "fi",
  "",
  'node "$publisher" \\',
  '  --tarball "$tarball" \\',
  '  --expected-filename "$EXPECTED_FILENAME" \\',
  '  --expected-sha256 "$EXPECTED_SHA256" \\',
  "  --expected-name patchpage \\",
  '  --expected-version "$EXPECTED_VERSION" \\',
  '  --expected-npm-version "$EXPECTED_NPM_VERSION" \\',
  '  --npm-cli-dir "$npm_cli_dir"',
  ""
].join("\n");

function job(name) {
  return jobFrom(workflow, name, "release.yml");
}

function jobFrom(source, name, label) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);

  if (start === -1) {
    failures.push(`${label} must define the ${name} job`);
    return "";
  }

  const end = lines.findIndex((line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function isMapping(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function parsedCiJob(name) {
  if (parsedCiWorkflow === null) {
    return null;
  }

  const jobs = isMapping(parsedCiWorkflow) ? parsedCiWorkflow.jobs : null;
  const selectedJob = isMapping(jobs) ? jobs[name] : null;
  if (!isMapping(selectedJob)) {
    failures.push(`ci.yml must define ${name} as a parsed job map`);
    return null;
  }

  return selectedJob;
}

function parsedCiSteps(jobName, selectedJob) {
  if (selectedJob === null) {
    return [];
  }
  if (!Array.isArray(selectedJob.steps) || !selectedJob.steps.every(isMapping)) {
    failures.push(`ci ${jobName} must define steps as parsed YAML maps`);
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

function workflowLineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function parsedActionUses(document, source, label) {
  if (document === null) {
    return [];
  }

  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) {
    failures.push(`${label} must define jobs as a parsed YAML map`);
    return [];
  }

  const actions = [];
  for (const jobPair of jobs.items) {
    const jobName = isScalar(jobPair.key) ? jobPair.key.value : null;
    if (!isMap(jobPair.value)) {
      failures.push(`every ${label} job must be a parsed YAML map`);
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
        (pair) => isScalar(pair.key) && pair.key.value === "uses"
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
      const lineEnd = typeof valueEnd === "number" ? source.indexOf("\n", valueEnd) : -1;

      actions.push({
        comment: isScalar(usesPair.value) ? usesPair.value.comment : null,
        coordinate: isScalar(usesPair.value) ? usesPair.value.value : null,
        inlineSuffix:
          typeof valueEnd === "number"
            ? source.slice(valueEnd, lineEnd === -1 ? source.length : lineEnd).replace(/\r$/, "")
            : null,
        jobName,
        label,
        lineNumber: workflowLineNumber(source, usesPair.key.range?.[0] ?? 0)
      });
    }
  }

  return actions;
}

const actionUses = parsedActionUses(workflowDocument, workflow, "release.yml");
const reconcileActionUses = parsedActionUses(
  reconcileWorkflowDocument,
  reconcileWorkflow,
  "reconcile-ghcr.yml"
);

function ciJob(name) {
  const lines = ciWorkflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);

  if (start === -1) {
    failures.push(`ci.yml must define the ${name} job`);
    return "";
  }

  const end = lines.findIndex((line, index) => index > start && /^  [a-zA-Z0-9_-]+:$/.test(line));
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

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function embeddedGzipPayload(source, marker) {
  const heredocStart = source.indexOf(`<<'${marker}'`);
  if (heredocStart === -1) return null;
  const payloadStart = source.indexOf("\n", heredocStart);
  const payloadEnd = source.indexOf(`\n          ${marker}`, payloadStart);
  if (payloadStart === -1 || payloadEnd === -1) return null;
  return source.slice(payloadStart + 1, payloadEnd).replace(/\s+/g, "");
}

function decodedEmbeddedSource(source, marker) {
  const payload = embeddedGzipPayload(source, marker);
  if (!payload) return null;
  try {
    return gunzipSync(Buffer.from(payload, "base64"));
  } catch {
    return null;
  }
}

if (parsedWorkflow !== null && actionUses.length === 0) {
  failures.push("release.yml must use at least one external Action");
}
if (parsedReconcileWorkflow !== null && reconcileActionUses.length === 0) {
  failures.push("reconcile-ghcr.yml must use at least one external Action");
}

for (const { comment, coordinate, inlineSuffix, label, lineNumber } of [
  ...actionUses,
  ...reconcileActionUses
]) {
  if (typeof coordinate !== "string") {
    failures.push(
      `${label}:${lineNumber} must pin an Action to a full commit SHA with an inline semver release comment`
    );
    continue;
  }

  const coordinateMatch = coordinate.match(/^([^\s@]+)@([^\s@]+)$/);
  if (!coordinateMatch) {
    failures.push(
      `${label}:${lineNumber} must pin an Action to a full commit SHA with an inline semver release comment`
    );
    continue;
  }

  const [, actionName, reference] = coordinateMatch;
  const reviewed = reviewedActions.get(actionName);
  if (!reviewed) {
    failures.push(`${label}:${lineNumber} uses unreviewed Action ${actionName}`);
  }

  if (!/^[0-9a-f]{40}$/.test(reference)) {
    failures.push(`${label}:${lineNumber} must pin ${actionName} to a full commit SHA`);
  }

  if (reviewed && reviewed.sha !== reference) {
    failures.push(
      `${label}:${lineNumber} must use reviewed coordinate ${actionName}@${reviewed.sha} # ${reviewed.version}`
    );
  }

  const commentVersion =
    typeof comment === "string"
      ? comment.match(/^ (v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1]
      : null;
  if (commentVersion === null || inlineSuffix !== ` # ${commentVersion}`) {
    failures.push(
      `${label}:${lineNumber} must pin an Action to a full commit SHA with an inline semver release comment`
    );
  } else if (reviewed && reviewed.version !== commentVersion) {
    failures.push(
      `${label}:${lineNumber} must use reviewed coordinate ${actionName}@${reviewed.sha} # ${reviewed.version}`
    );
  }
}

const expectedActionCounts = new Map([
  ["actions/checkout", 4],
  ["actions/setup-node", 5],
  ["pnpm/action-setup", 1],
  ["actions/upload-artifact", 4],
  ["actions/download-artifact", 5],
  ["docker/login-action", 0]
]);
for (const [actionName, expectedCount] of expectedActionCounts) {
  const actualCount = actionUses.filter(
    ({ coordinate }) => typeof coordinate === "string" && coordinate.startsWith(`${actionName}@`)
  ).length;
  if (actualCount !== expectedCount) {
    failures.push(
      `release.yml must retain all ${expectedCount} reviewed ${actionName} Action uses`
    );
  }
}

const expectedReconcileActionCounts = new Map([
  ["actions/checkout", 2],
  ["actions/setup-node", 1],
  ["pnpm/action-setup", 0],
  ["actions/upload-artifact", 3],
  ["actions/download-artifact", 3],
  ["docker/login-action", 0]
]);
for (const [actionName, expectedCount] of expectedReconcileActionCounts) {
  const actualCount = reconcileActionUses.filter(
    ({ coordinate }) => typeof coordinate === "string" && coordinate.startsWith(`${actionName}@`)
  ).length;
  if (actualCount !== expectedCount) {
    failures.push(
      `reconcile-ghcr.yml must retain all ${expectedCount} reviewed ${actionName} Action uses`
    );
  }
}

const npmVersion = packageJson.devDependencies?.npm;
if (npmVersion !== reviewedNpm.version) {
  failures.push(
    `the publishing npm CLI must be the reviewed exact root devDependency ${reviewedNpm.version}`
  );
} else {
  const rootImporter = lockfile.match(/^  \.:\n[\s\S]*?(?=^  \S)/m)?.[0] ?? "";
  const escapedNpmVersion = npmVersion.replaceAll(".", "\\.");
  const lockedNpm = new RegExp(
    `^      npm:\\n        specifier: ${npmVersion.replaceAll(".", "\\.")}\\n        version: ${npmVersion.replaceAll(".", "\\.")}$`,
    "m"
  );
  const lockedNpmIntegrity = lockfile.match(
    new RegExp(
      `^  npm@${escapedNpmVersion}:\\n    resolution: \\{integrity: (sha512-[^}]+)\\}$`,
      "m"
    )
  )?.[1];

  if (!lockedNpm.test(rootImporter)) {
    failures.push(`pnpm-lock.yaml must lock the root npm devDependency at ${npmVersion}`);
  }
  if (lockedNpmIntegrity !== reviewedNpm.integrity) {
    failures.push(
      `pnpm-lock.yaml must retain the reviewed registry integrity for npm@${npmVersion}`
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
  /^concurrency:\n  group: ([^\n]+)\n  queue: max\n  cancel-in-progress: false$/m
);
if (!releaseConcurrency) {
  failures.push(
    "release.yml must serialize all patchpage-server publishes in one package-wide max queue without canceling running or pending releases; GitHub caps max at 100 pending runs"
  );
} else if (releaseConcurrency[1] !== "release-ghcr-patchpage-server") {
  failures.push(
    "release.yml concurrency group must be the constant package-wide release-ghcr-patchpage-server group, not a ref/version-scoped group"
  );
}

if (
  parsedWorkflow !== null &&
  (!hasExactKeys(parsedWorkflow, ["name", "on", "permissions", "concurrency", "jobs"]) ||
    parsedWorkflow.name !== "Release" ||
    !hasExactKeys(parsedWorkflow.on, ["push"]) ||
    !hasExactKeys(parsedWorkflow.on.push, ["tags"]) ||
    !hasExactArray(parsedWorkflow.on.push.tags, ["v*"]) ||
    !hasExactMapping(parsedWorkflow.permissions, {}) ||
    !hasExactMapping(parsedWorkflow.concurrency, {
      group: "release-ghcr-patchpage-server",
      queue: "max",
      "cancel-in-progress": false
    }))
) {
  failures.push(
    "release.yml root must contain exactly the reviewed trigger, permissions, concurrency, and jobs"
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
  "npx-smoke"
];
const reviewedReleaseJobContracts = new Map([
  [
    "guard",
    {
      digest: "e8a2912ef90d47893a66b8b981bfdf57bb333131d95671a96036cc9fae021319",
      permissions: { contents: "read" }
    }
  ],
  [
    "prepare-npm",
    {
      digest: "e5ba61286d82671bbff3e22a9ec98b66a388b8618bea30cfbb2567a0e9f25ef7",
      permissions: {}
    }
  ],
  [
    "verify",
    {
      digest: "12fe8f367c6dee8d4a2d14494f3034dd0155d78d0202f1ee94fba6c8fbd516d5",
      permissions: { contents: "read" }
    }
  ],
  [
    "publish-npm",
    {
      digest: "552499142e433bb6af278ef3dd63dd5695bcacd43fc7534ff1c4077f01e519a1",
      permissions: { "id-token": "write" }
    }
  ],
  [
    "github-release",
    {
      digest: "7e17684a3aca97672523bc322e2fa2338a0c295a4f83e8092086abc8f06d4008",
      permissions: { contents: "write" }
    }
  ],
  [
    "verify-server-image",
    {
      digest: "31e26ce666c88fdc4f23e1434deac4b9afda2402ee05e5c3ed226de41af87811",
      permissions: { contents: "read" }
    }
  ],
  [
    "docker-ghcr",
    {
      digest: "d4e7b62918f5d9150011f384b1514a24a5a637cb617dc69ece3d769b7155ed20",
      permissions: { packages: "write" }
    }
  ],
  [
    "ghcr-anonymous-smoke",
    {
      digest: "24b6be0ef3359d0a1a46e6a76f4d0fd61e6db93924594f7962d1ea91bda99d63",
      permissions: {}
    }
  ],
  [
    "npx-smoke",
    {
      digest: "d2d5559c6e5f42281254494a024445dbee365476dcb00672ce5d9e093436d945",
      permissions: {}
    }
  ]
]);
if (parsedWorkflow !== null && !hasExactKeys(parsedWorkflow.jobs, expectedReleaseJobs)) {
  failures.push("release.yml must contain exactly the reviewed release jobs");
}
if (parsedWorkflow !== null) {
  for (const [jobName, contract] of reviewedReleaseJobContracts) {
    const selectedJob = parsedWorkflow.jobs[jobName];
    const digest = isMapping(selectedJob)
      ? createHash("sha256").update(JSON.stringify(selectedJob)).digest("hex")
      : null;
    if (
      !isMapping(selectedJob) ||
      !hasExactMapping(selectedJob.permissions, contract.permissions) ||
      digest !== contract.digest
    ) {
      failures.push(
        `${jobName} must match the exact reviewed job map, permissions, and ordered steps`
      );
    }
  }
}

const reviewedReconcileRoot = {
  name: "Reconcile GHCR",
  on: {
    workflow_dispatch: {
      inputs: {
        target: {
          description: "Optional exact stable release tag, for example v1.2.3",
          required: false,
          type: "string"
        },
        "batch-size": {
          description: "Maximum missing or incomplete stable releases to replay",
          required: false,
          default: "3",
          type: "string"
        }
      }
    },
    schedule: [{ cron: "17 */6 * * *" }]
  },
  permissions: {},
  concurrency: {
    group: "release-ghcr-patchpage-server",
    queue: "max",
    "cancel-in-progress": false
  },
  jobs: null
};
if (
  parsedReconcileWorkflow !== null &&
  JSON.stringify({ ...parsedReconcileWorkflow, jobs: null }) !==
    JSON.stringify(reviewedReconcileRoot)
) {
  failures.push(
    "reconcile-ghcr.yml root must contain exactly the reviewed triggers, permissions, concurrency, and jobs"
  );
}

const expectedReconcileJobs = [
  "inspect",
  "rebuild",
  "publish-ghcr",
  "reconcile-latest",
  "bind-publish-results",
  "ghcr-anonymous-acceptance"
];
const reviewedReconcileJobContracts = new Map([
  [
    "inspect",
    {
      digest: "814dcf4ce06e6bec2e09535b635ebfae5773ab247048e684ec08ee21b239a0f9",
      permissions: { contents: "read", packages: "read" }
    }
  ],
  [
    "rebuild",
    {
      digest: "920fd409c864dae2f92f54f7ef14c57ceed3c45b0042ff084fca306dd8f69f55",
      permissions: { contents: "read" }
    }
  ],
  [
    "publish-ghcr",
    {
      digest: "23a606d3857b15b976ce5c7741fda0cd714836fe8b392ab5a318a0bca4699e91",
      permissions: { actions: "read", packages: "write" }
    }
  ],
  [
    "reconcile-latest",
    {
      digest: "c8adfe1de7a9dda6fc626bd6d64b771ef1237ba57415e87cb229825f49667c18",
      permissions: { packages: "write" }
    }
  ],
  [
    "bind-publish-results",
    {
      digest: "6b3dfd61bb2338e0ee62030893e92eb3631d95ace341e7d0997966194f89b956",
      permissions: { actions: "read" }
    }
  ],
  [
    "ghcr-anonymous-acceptance",
    {
      digest: "94c89f3c826ae9744e7d122069254b988dcf56f4aa3d63f2397ad0871ec9db8f",
      permissions: {}
    }
  ]
]);
if (
  parsedReconcileWorkflow !== null &&
  !hasExactKeys(parsedReconcileWorkflow.jobs, expectedReconcileJobs)
) {
  failures.push("reconcile-ghcr.yml must contain exactly the reviewed reconciliation jobs");
}
if (parsedReconcileWorkflow !== null) {
  for (const [jobName, contract] of reviewedReconcileJobContracts) {
    const selectedJob = parsedReconcileWorkflow.jobs[jobName];
    const digest = isMapping(selectedJob)
      ? createHash("sha256").update(JSON.stringify(selectedJob)).digest("hex")
      : null;
    if (
      !isMapping(selectedJob) ||
      !hasExactMapping(selectedJob.permissions, contract.permissions) ||
      digest !== contract.digest
    ) {
      failures.push(
        `reconcile-ghcr ${jobName} must match the exact reviewed job map, permissions, and ordered steps`
      );
    }
  }
}
const guardSteps = parsedSteps("guard", parsedGuardJob);
const prepareNpmSteps = parsedSteps("prepare-npm", parsedPrepareNpmJob);
const verifySteps = parsedSteps("verify", parsedVerifyJob);
const publishSteps = parsedSteps("publish-npm", parsedPublishJob);
const guardCheckoutStep = uniqueStep(
  guardSteps,
  (step) => step.uses === `actions/checkout@${reviewedActions.get("actions/checkout").sha}`,
  "the guard checkout step"
);
const versionProducerStep = uniqueStep(
  guardSteps,
  (step) => step.id === "version",
  "the guard version producer step"
);
const npmCliUploadStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.name === "Upload the reviewed npm CLI",
  "the Upload the reviewed npm CLI step"
);
const npmCliProducerIdStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.id === "npm-cli",
  "the reviewed npm CLI producer step"
);
const npmCliProducerNameStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.name === "Fetch and verify the reviewed npm CLI",
  "the Fetch and verify the reviewed npm CLI step"
);
const serverImageJob = job("verify-server-image");
const dockerJob = job("docker-ghcr");
const anonymousImageJob = job("ghcr-anonymous-smoke");
const ciLintJob = ciJob("lint");
const ciDockerJob = ciJob("docker");
const parsedCiLintJob = parsedCiJob("lint");
const ciLintSteps = parsedCiSteps("lint", parsedCiLintJob);

const npmCliUploadIdStep = uniqueStep(
  prepareNpmSteps,
  (step) => step.id === "npm-cli-artifact",
  "the npm-cli-artifact producer step"
);
const packageMetadataStep = uniqueStep(
  verifySteps,
  (step) => step.id === "package",
  "the package metadata producer step"
);
const packageMetadataNameStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Pack exactly one release tarball and verify contents",
  "the Pack exactly one release tarball and verify contents step"
);
const verifyNpmCliStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Verify the isolated npm CLI",
  "the Verify the isolated npm CLI step"
);
const verifyNpmCliDownloadStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Download the isolated npm CLI",
  "the Download the isolated npm CLI step"
);
const smokeInstallStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Install and run tarball on minimum supported Node",
  "the minimum-Node tarball smoke step"
);
const smokeInstallIndex = verifySteps.indexOf(smokeInstallStep);
const minimumNodeSetupStep = smokeInstallIndex > 0 ? verifySteps[smokeInstallIndex - 1] : null;
const packageUploadStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Upload the exact tested tarball",
  "the Upload the exact tested tarball step"
);
const packageUploadIdStep = uniqueStep(
  verifySteps,
  (step) => step.id === "package-artifact",
  "the package-artifact producer step"
);
const publisherPreparationStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Prepare the exact npm publisher",
  "the Prepare the exact npm publisher step"
);
const publisherUploadStep = uniqueStep(
  verifySteps,
  (step) => step.name === "Upload the exact npm publisher",
  "the Upload the exact npm publisher step"
);
const publisherUploadIdStep = uniqueStep(
  verifySteps,
  (step) => step.id === "publisher-artifact",
  "the publisher-artifact producer step"
);
const packageDownloadStep = uniqueStep(
  publishSteps,
  (step) => step.name === "Download the exact tested tarball",
  "the Download the exact tested tarball step"
);
const npmCliDownloadStep = uniqueStep(
  publishSteps,
  (step) => step.name === "Download the pinned publishing CLI",
  "the Download the pinned publishing CLI step"
);
const publisherDownloadStep = uniqueStep(
  publishSteps,
  (step) => step.name === "Download the exact npm publisher",
  "the Download the exact npm publisher step"
);
const publicationStep = uniqueStep(
  publishSteps,
  (step) => step.name === "Publish the verified tarball to npm",
  "the Publish the verified tarball to npm step"
);
const publicationRun = typeof publicationStep?.run === "string" ? publicationStep.run : "";
const prepareSetupNodeStep = prepareNpmSteps[0] ?? null;
const verifyCheckoutStep = verifySteps[0] ?? null;
const verifyPnpmSetupStep = verifySteps[3] ?? null;
const verifySetupNodeStep = verifySteps[4] ?? null;
const publishSetupNodeStep = publishSteps[0] ?? null;

if (
  parsedWorkflow !== null &&
  !hasExactMapping(parsedGuardJob?.outputs, {
    version: "${{ steps.version.outputs.version }}",
    revision: "${{ steps.version.outputs.revision }}"
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
  failures.push("guard must check out the repository before running the exact version producer");
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
      "node-version": reviewedNodeVersion
    }))
) {
  failures.push("prepare-npm must contain exactly the reviewed job map and ordered steps");
}

if (
  parsedWorkflow !== null &&
  !hasExactMapping(parsedPrepareNpmJob?.outputs, {
    "npm-version": "${{ steps.npm-cli.outputs.version }}",
    "npm-cli-artifact-id": "${{ steps.npm-cli-artifact.outputs.artifact-id }}"
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
      EXPECTED_NPM_INTEGRITY: reviewedNpm.integrity
    }) ||
    npmCliProducerIdStep.run !== expectedNpmCliProducerRun ||
    prepareNpmSteps.indexOf(npmCliProducerIdStep) >= prepareNpmSteps.indexOf(npmCliUploadStep))
) {
  failures.push(
    "prepare-npm must fetch, verify, and output the exact reviewed npm CLI before upload"
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
      "include-hidden-files": true
    }))
) {
  failures.push("prepare-npm must produce the exact isolated npm CLI artifact");
}

if (
  parsedWorkflow !== null &&
  (parsedVerifyJob === null ||
    !hasExactKeys(parsedVerifyJob, ["needs", "runs-on", "permissions", "outputs", "steps"]) ||
    !hasExactArray(parsedVerifyJob.needs, ["guard", "prepare-npm"]) ||
    parsedVerifyJob["runs-on"] !== "ubuntu-latest" ||
    !hasExactMapping(parsedVerifyJob.permissions, { contents: "read" }) ||
    verifySteps.length !== 16 ||
    verifySteps[0] !== verifyCheckoutStep ||
    verifySteps[1] !== publisherPreparationStep ||
    verifySteps[2] !== publisherUploadStep ||
    verifySteps[3] !== verifyPnpmSetupStep ||
    verifySteps[4] !== verifySetupNodeStep ||
    !hasExactKeys(verifyCheckoutStep, ["uses"]) ||
    verifyCheckoutStep.uses !== `actions/checkout@${reviewedActions.get("actions/checkout").sha}` ||
    !hasExactKeys(verifyPnpmSetupStep, ["uses", "with"]) ||
    verifyPnpmSetupStep.uses !==
      `pnpm/action-setup@${reviewedActions.get("pnpm/action-setup").sha}` ||
    !hasExactMapping(verifyPnpmSetupStep.with, { version: "11.5.2" }) ||
    !hasExactKeys(verifySetupNodeStep, ["uses", "with"]) ||
    verifySetupNodeStep.uses !==
      `actions/setup-node@${reviewedActions.get("actions/setup-node").sha}` ||
    !hasExactMapping(verifySetupNodeStep.with, {
      "node-version": reviewedNodeVersion,
      cache: "pnpm"
    }) ||
    !isExactRunStep(verifySteps[5], "pnpm install --frozen-lockfile") ||
    !isExactRunStep(verifySteps[6], "pnpm lint") ||
    !isExactRunStep(verifySteps[7], "pnpm typecheck") ||
    !isExactRunStep(verifySteps[8], "pnpm test") ||
    !isExactRunStep(verifySteps[9], "pnpm --filter patchpage build") ||
    verifySteps[10] !== verifyNpmCliDownloadStep ||
    !hasExactKeys(verifyNpmCliDownloadStep, ["name", "uses", "with"]) ||
    verifyNpmCliDownloadStep.uses !== reviewedDownloadArtifact ||
    !hasExactMapping(verifyNpmCliDownloadStep.with, {
      "artifact-ids": "${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}",
      path: "${{ runner.temp }}/npm-cli"
    }) ||
    verifySteps[11] !== verifyNpmCliStep ||
    verifySteps[12] !== packageMetadataStep ||
    verifySteps[13] !== minimumNodeSetupStep ||
    verifySteps[14] !== smokeInstallStep ||
    verifySteps[15] !== packageUploadStep)
) {
  failures.push(
    "verify must contain exactly the reviewed job map and ordered build and smoke steps"
  );
}

if (
  parsedWorkflow !== null &&
  (!hasExactMapping(parsedVerifyJob?.outputs, {
    "tarball-filename": "${{ steps.package.outputs.filename }}",
    "tarball-sha256": "${{ steps.package.outputs.sha256 }}",
    "package-artifact-id": "${{ steps.package-artifact.outputs.artifact-id }}",
    "publisher-sha256": "${{ steps.publisher.outputs.sha256 }}",
    "publisher-artifact-id": "${{ steps.publisher-artifact.outputs.artifact-id }}"
  }) ||
    packageMetadataStep === null ||
    packageMetadataStep !== packageMetadataNameStep ||
    !hasExactKeys(packageMetadataStep, ["name", "id", "shell", "run"]) ||
    packageMetadataStep.name !== "Pack exactly one release tarball and verify contents" ||
    packageMetadataStep.id !== "package" ||
    packageMetadataStep.shell !== "bash" ||
    packageMetadataStep.run !== expectedPackageProducerRun)
) {
  failures.push("verify outputs must bind to the exact package and artifact producers");
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
      archive: false
    }))
) {
  failures.push("verify must upload exactly the active single raw tarball input");
}

if (
  parsedWorkflow !== null &&
  (publisherPreparationStep === null ||
    !hasExactKeys(publisherPreparationStep, ["name", "id", "shell", "run"]) ||
    publisherPreparationStep.id !== "publisher" ||
    publisherPreparationStep.shell !== "bash" ||
    publisherPreparationStep.run !== expectedPublisherPreparationRun ||
    publisherUploadStep === null ||
    publisherUploadStep !== publisherUploadIdStep ||
    !hasExactKeys(publisherUploadStep, ["name", "id", "uses", "with"]) ||
    publisherUploadStep.uses !== reviewedUploadArtifact ||
    !hasExactMapping(publisherUploadStep.with, {
      path: "${{ steps.publisher.outputs.path }}",
      "if-no-files-found": "error",
      "retention-days": 1,
      archive: false
    }) ||
    verifySteps.indexOf(verifyCheckoutStep) >= verifySteps.indexOf(publisherPreparationStep) ||
    verifySteps.indexOf(publisherPreparationStep) >= verifySteps.indexOf(publisherUploadStep) ||
    verifySteps.indexOf(publisherUploadStep) >= verifySteps.indexOf(verifyPnpmSetupStep))
) {
  failures.push("verify must hash and upload the exact raw npm publisher as a separate artifact");
}

if (
  parsedWorkflow !== null &&
  (verifyNpmCliStep === null ||
    !hasExactKeys(verifyNpmCliStep, ["name", "shell", "env", "run"]) ||
    verifyNpmCliStep.shell !== "bash" ||
    !hasExactMapping(verifyNpmCliStep.env, {
      EXPECTED_NPM_VERSION: "${{ needs.prepare-npm.outputs.npm-version }}"
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
      "node-version": 22
    }) ||
    !hasExactKeys(smokeInstallStep, ["name", "shell", "env", "run"]) ||
    smokeInstallStep.shell !== "bash" ||
    !hasExactMapping(smokeInstallStep.env, {
      EXPECTED_TARBALL_SHA256: "${{ steps.package.outputs.sha256 }}"
    }) ||
    smokeInstallStep.run !== expectedMinimumNodeSmokeRun)
) {
  failures.push(
    "verify must run the exact tarball smoke contract on the minimum supported Node 22"
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
    "verify must validate the isolated npm CLI, produce the package, smoke-test it, then upload it"
  );
}

const expectedVerifyWorkflowCommandReferences = [
  ...expectedPublisherPreparationRun
    .split("\n")
    .filter((line) => line.includes("GITHUB_ENV") || line.includes("GITHUB_OUTPUT"))
    .map((line) => ({ line, step: publisherPreparationStep })),
  {
    line: 'echo "NPM_CLI=$NPM_CLI" >> "$GITHUB_ENV"',
    step: verifyNpmCliStep
  },
  ...expectedPackageProducerRun
    .split("\n")
    .filter((line) => line.includes("GITHUB_ENV") || line.includes("GITHUB_OUTPUT"))
    .map((line) => ({ line, step: packageMetadataStep }))
];
const verifyWorkflowCommandReferences = verifySteps.flatMap((step) =>
  typeof step.run === "string"
    ? step.run
        .split("\n")
        .filter((line) => line.includes("GITHUB_ENV") || line.includes("GITHUB_OUTPUT"))
        .map((line) => ({ line, step }))
    : []
);
if (
  parsedWorkflow !== null &&
  (verifyWorkflowCommandReferences.length !== expectedVerifyWorkflowCommandReferences.length ||
    verifyWorkflowCommandReferences.some(
      (reference, index) =>
        reference.step !== expectedVerifyWorkflowCommandReferences[index].step ||
        reference.line !== expectedVerifyWorkflowCommandReferences[index].line
    ))
) {
  failures.push(
    "verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines"
  );
}

if (
  parsedWorkflow !== null &&
  (parsedPublishJob === null ||
    !hasExactKeys(parsedPublishJob, ["needs", "runs-on", "permissions", "steps"]) ||
    !hasExactArray(parsedPublishJob.needs, ["guard", "prepare-npm", "verify"]) ||
    parsedPublishJob["runs-on"] !== "ubuntu-latest" ||
    !hasExactMapping(parsedPublishJob.permissions, { "id-token": "write" }) ||
    publishSteps.length !== 5 ||
    publishSteps[0] !== publishSetupNodeStep ||
    publishSteps[1] !== packageDownloadStep ||
    publishSteps[2] !== npmCliDownloadStep ||
    publishSteps[3] !== publisherDownloadStep ||
    publishSteps[4] !== publicationStep ||
    !hasExactKeys(publishSetupNodeStep, ["uses", "with"]) ||
    publishSetupNodeStep.uses !==
      `actions/setup-node@${reviewedActions.get("actions/setup-node").sha}` ||
    !hasExactMapping(publishSetupNodeStep.with, {
      "node-version": reviewedNodeVersion
    }))
) {
  failures.push(
    "publish-npm must contain exactly the reviewed privileged job map and ordered publication steps"
  );
}

const publishDownloadSteps = publishSteps.filter(
  (step) => typeof step.uses === "string" && step.uses.startsWith("actions/download-artifact@")
);
if (parsedWorkflow !== null && publishDownloadSteps.length !== 3) {
  failures.push("publish-npm must contain exactly three download-artifact steps");
}

if (
  parsedWorkflow !== null &&
  (packageDownloadStep === null ||
    !hasExactKeys(packageDownloadStep, ["name", "uses", "with"]) ||
    packageDownloadStep.uses !== reviewedDownloadArtifact ||
    !hasExactMapping(packageDownloadStep.with, {
      "artifact-ids": "${{ needs.verify.outputs.package-artifact-id }}",
      path: "${{ runner.temp }}/patchpage-package",
      "skip-decompress": true
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
      path: "${{ runner.temp }}/npm-cli"
    }))
) {
  failures.push("publish-npm must normally decompress the exact isolated npm CLI artifact");
}

if (
  parsedWorkflow !== null &&
  (publisherDownloadStep === null ||
    !hasExactKeys(publisherDownloadStep, ["name", "uses", "with"]) ||
    publisherDownloadStep.uses !== reviewedDownloadArtifact ||
    !hasExactMapping(publisherDownloadStep.with, {
      "artifact-ids": "${{ needs.verify.outputs.publisher-artifact-id }}",
      path: "${{ runner.temp }}/npm-publisher",
      "skip-decompress": true
    }))
) {
  failures.push("publish-npm must download the exact raw npm publisher artifact by ID");
}

const publicationStepIndex = publishSteps.indexOf(publicationStep);
if (
  parsedWorkflow !== null &&
  (publicationStep === null ||
    !hasExactKeys(publicationStep, ["name", "shell", "env", "run"]) ||
    publicationStep.shell !== "bash" ||
    publicationRun !== expectedPublicationRun ||
    publishSteps.indexOf(packageDownloadStep) >= publicationStepIndex ||
    publishSteps.indexOf(npmCliDownloadStep) >= publicationStepIndex ||
    publishSteps.indexOf(publisherDownloadStep) >= publicationStepIndex)
) {
  failures.push(
    "the publication step must contain the reviewed exact-publisher run after all isolated downloads"
  );
}

if (
  parsedWorkflow !== null &&
  !hasExactMapping(publicationStep?.env, {
    EXPECTED_FILENAME: "${{ needs.verify.outputs.tarball-filename }}",
    EXPECTED_NPM_VERSION: "${{ needs.prepare-npm.outputs.npm-version }}",
    EXPECTED_PUBLISHER_SHA256: "${{ needs.verify.outputs.publisher-sha256 }}",
    EXPECTED_SHA256: "${{ needs.verify.outputs.tarball-sha256 }}",
    EXPECTED_VERSION: "${{ needs.guard.outputs.version }}"
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
    "pnpm "
  ]) {
    if (prepareNpmJob.includes(forbidden)) {
      failures.push(`prepare-npm must not contain ${forbidden}`);
    }
  }

  const allowedPrepareActions = new Set(["actions/setup-node", "actions/upload-artifact"]);
  const prepareActions = actionUses
    .filter(({ jobName }) => jobName === "prepare-npm")
    .map(({ coordinate }) => (typeof coordinate === "string" ? coordinate.split("@")[0] : null));
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
      "prepare-npm must bind its fetched npm version and integrity to the reviewed metadata"
    );
  }

  const prepareNodeVersions = [
    ...prepareNpmJob.matchAll(
      /uses: actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version:\s+([^\s#]+)/g
    )
  ].map((match) => match[1]);
  if (
    prepareNodeVersions.length !== 1 ||
    !exactVersionPattern.test(prepareNodeVersions[0]) ||
    prepareNodeVersions[0] !== reviewedNodeVersion
  ) {
    failures.push(`prepare-npm must use the reviewed exact Node runtime ${reviewedNodeVersion}`);
  }

  if (
    !prepareNpmJob.includes("https://registry.npmjs.org/npm/-/npm-${EXPECTED_NPM_VERSION}.tgz") ||
    !prepareNpmJob.includes("curl --fail --silent --show-error") ||
    !prepareNpmJob.includes("--proto '=https'") ||
    !prepareNpmJob.includes("--tlsv1.2")
  ) {
    failures.push("prepare-npm must fetch the exact versioned npm registry tarball");
  }

  const sriCalculation = prepareNpmJob.indexOf('createHash("sha512")');
  const sriComparison = prepareNpmJob.indexOf('"$actual_integrity" != "$EXPECTED_NPM_INTEGRITY"');
  const extraction = prepareNpmJob.indexOf("tar -xzf");
  const cliExecution = prepareNpmJob.indexOf('node "$npm_cli_dir/bin/npm-cli.js" --version');
  const cliVersionComparison = prepareNpmJob.indexOf(
    '"$actual_version" != "$EXPECTED_NPM_VERSION"'
  );
  const cliVersionOutput = prepareNpmJob.indexOf(
    'echo "version=$actual_version" >> "$GITHUB_OUTPUT"'
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
    !prepareNpmJob.slice(cliVersionComparison, cliVersionOutput).includes("exit 1") ||
    cliVersionOutput <= cliVersionComparison ||
    artifactUpload <= cliVersionOutput
  ) {
    failures.push("prepare-npm must verify the reviewed SRI before extracting or executing npm");
  }

  if (
    !prepareNpmJob.includes(
      "npm-cli-artifact-id: ${{ steps.npm-cli-artifact.outputs.artifact-id }}"
    ) ||
    !prepareNpmJob.includes("npm-version: ${{ steps.npm-cli.outputs.version }}") ||
    !prepareNpmJob.includes("name: npm-publishing-cli-${{ github.run_attempt }}") ||
    !prepareNpmJob.includes("uses: actions/upload-artifact@")
  ) {
    failures.push("prepare-npm must expose its immutable npm CLI artifact ID and version");
  }
}

const publishNodeVersions = [
  ...publishJob.matchAll(
    /uses: actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version:\s+([^\s#]+)/g
  )
].map((match) => match[1]);

if (
  publishNodeVersions.length !== 1 ||
  !exactVersionPattern.test(publishNodeVersions[0]) ||
  publishNodeVersions[0] !== reviewedNodeVersion
) {
  failures.push(`publish-npm must use the reviewed exact Node runtime ${reviewedNodeVersion}`);
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

if (!verifyJob.includes("package-artifact-id: ${{ steps.package-artifact.outputs.artifact-id }}")) {
  failures.push("verify must expose the immutable package artifact ID");
}
if (!publishJob.includes("artifact-ids: ${{ needs.verify.outputs.package-artifact-id }}")) {
  failures.push("publish-npm must download the exact package artifact ID from verify");
}
if (
  !verifyJob.includes(
    "publisher-artifact-id: ${{ steps.publisher-artifact.outputs.artifact-id }}"
  ) ||
  !verifyJob.includes("publisher-sha256: ${{ steps.publisher.outputs.sha256 }}") ||
  !publishJob.includes("artifact-ids: ${{ needs.verify.outputs.publisher-artifact-id }}")
) {
  failures.push("the exact npm publisher must cross jobs as a digest-bound raw artifact by ID");
}

const originalTarballDiscovery = verifyJob.indexOf("mapfile -t tarballs");
const originalTarballCountGuard = verifyJob.indexOf('if [[ "${#tarballs[@]}" -ne 1 ]]; then');
const originalTarballAssignment = verifyJob.indexOf('tarball="${tarballs[0]}"');
const reportedTarballGuard = verifyJob.indexOf('if [[ "$tarball" != "$reported_tarball" ]]; then');
const uniqueTarballName = verifyJob.indexOf(
  'unique_tarball="$package_dir/patchpage-${cli_version}-run-attempt-${GITHUB_RUN_ATTEMPT}.tgz"'
);
const uniqueTarballMove = verifyJob.indexOf('mv -- "$tarball" "$unique_tarball"');
const uniqueTarballAssignment = verifyJob.indexOf('tarball="$unique_tarball"');
const releasePrivacyGate = verifyJob.indexOf("node ../../scripts/verify-release-privacy.mjs \\");
const releasePrivacyPackJson = verifyJob.indexOf(
  '  --pack-json "$RUNNER_TEMP/patchpage-pack.json" \\',
  releasePrivacyGate
);
const releasePrivacyTarball = verifyJob.indexOf('  --tarball "$tarball"', releasePrivacyGate);
const tarballEnvironmentOutput = verifyJob.indexOf('echo "TARBALL=$tarball" >> "$GITHUB_ENV"');
const tarballPathOutput = verifyJob.indexOf('echo "tarball-path=$tarball" >> "$GITHUB_OUTPUT"');
const tarballFilenameOutput = verifyJob.indexOf(
  'echo "filename=$(basename "$tarball")" >> "$GITHUB_OUTPUT"'
);
const tarballDigestOutput = verifyJob.indexOf('echo "sha256=$(sha256sum "$tarball"');
const smokeInstall = verifyJob.indexOf('node "$NPM_CLI" install --ignore-scripts "$TARBALL"');
const smokeDigestGuard = verifyJob.indexOf(
  'if [[ "$actual_sha256" != "$EXPECTED_TARBALL_SHA256" ]]; then'
);
const packageUpload = verifyJob.indexOf("id: package-artifact");
const rawTarballDiscovery = publishJob.indexOf('tarballs=("$RUNNER_TEMP/patchpage-package"/*.tgz)');
const rawTarballCountGuard = publishJob.indexOf('if [[ "${#tarballs[@]}" -ne 1 ]]; then');
const rawTarballAssignment = publishJob.indexOf('tarball="${tarballs[0]}"');
const rawBasenameGuard = publishJob.indexOf(
  'if [[ "$(basename "$tarball")" != "$EXPECTED_FILENAME" ]]; then'
);
const rawDigestCalculation = publishJob.indexOf('actual_sha256="$(sha256sum "$tarball"');
const rawDigestGuard = publishJob.indexOf('if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then');
const publisherDigestGuard = publishJob.indexOf(
  'if [[ "$actual_publisher_sha256" != "$EXPECTED_PUBLISHER_SHA256" ]]; then'
);
const publisherInvocation = publishJob.indexOf('node "$publisher" \\');
const publishTarCommands = publishJob.match(/^\s+tar\s+/gm) ?? [];
const publishUnzipCommands = publishJob.match(/^\s+unzip(?:\s|$)/gm) ?? [];
const releasePrivacyGateMessage =
  "verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload";
const reviewedPrivacyGateLines = [
  "node ../../scripts/verify-release-privacy.mjs \\",
  '  --pack-json "$RUNNER_TEMP/patchpage-pack.json" \\',
  '  --tarball "$tarball"'
];
const packageProducerRun =
  typeof packageMetadataStep?.run === "string" ? packageMetadataStep.run : "";
const packageProducerRunLines = packageProducerRun.split(/\r?\n/);
const packagePrivacyMentions = packageProducerRunLines.filter((line) =>
  line.includes("verify-release-privacy.mjs")
);
const packagePrivacyGateStarts = [];
for (
  let index = 0;
  index <= packageProducerRunLines.length - reviewedPrivacyGateLines.length;
  index += 1
) {
  if (
    reviewedPrivacyGateLines.every(
      (line, offset) => packageProducerRunLines[index + offset] === line
    )
  ) {
    packagePrivacyGateStarts.push(index);
  }
}
const packageTarballBindingLine = packageProducerRunLines.lastIndexOf('tarball="$unique_tarball"');
const packageFirstOutputLine = Math.min(
  ...[
    'echo "TARBALL=$tarball" >> "$GITHUB_ENV"',
    'echo "CLI_VERSION=$cli_version" >> "$GITHUB_ENV"',
    'echo "tarball-path=$tarball" >> "$GITHUB_OUTPUT"',
    'echo "filename=$(basename "$tarball")" >> "$GITHUB_OUTPUT"'
  ]
    .map((line) => packageProducerRunLines.indexOf(line))
    .filter((index) => index !== -1)
);
const packagePrivacyGateStart = packagePrivacyGateStarts[0] ?? -1;
const packagePrivacyGateEnd =
  packagePrivacyGateStart === -1
    ? -1
    : packagePrivacyGateStart + reviewedPrivacyGateLines.length - 1;
const preGatePackageRun = packageProducerRunLines
  .slice(0, packagePrivacyGateStart === -1 ? undefined : packagePrivacyGateStart)
  .join("\n");
const preGatePackPathLoggingMessage =
  "package producer must not log npm pack file paths before the privacy gate";
if (
  /console\.(?:error|log|warn)\s*\([^\n]*(?:pack\.files|file\.path|\[\.\.\.files\]|\$\{file\})/.test(
    preGatePackageRun
  ) ||
  /(?:echo|printf)[^\n]*(?:\$reported_tarball|\$tarball)/.test(preGatePackageRun)
) {
  failures.push(preGatePackPathLoggingMessage);
}

if (
  parsedVerifyJob === null ||
  Object.hasOwn(parsedVerifyJob, "if") ||
  Object.hasOwn(parsedVerifyJob, "continue-on-error") ||
  packageMetadataStep === null ||
  Object.hasOwn(packageMetadataStep, "if") ||
  Object.hasOwn(packageMetadataStep, "continue-on-error") ||
  packagePrivacyMentions.length !== 1 ||
  packagePrivacyGateStarts.length !== 1 ||
  packageTarballBindingLine === -1 ||
  packagePrivacyGateStart <= packageTarballBindingLine ||
  !Number.isFinite(packageFirstOutputLine) ||
  packageFirstOutputLine <= packagePrivacyGateEnd ||
  releasePrivacyGate === -1 ||
  releasePrivacyGate <= uniqueTarballAssignment ||
  releasePrivacyPackJson <= releasePrivacyGate ||
  releasePrivacyTarball <= releasePrivacyPackJson ||
  smokeInstall <= releasePrivacyTarball ||
  packageUpload <= releasePrivacyTarball
) {
  failures.push(releasePrivacyGateMessage);
}

if (
  originalTarballDiscovery === -1 ||
  originalTarballCountGuard <= originalTarballDiscovery ||
  originalTarballAssignment <= originalTarballCountGuard ||
  !verifyJob.slice(originalTarballCountGuard, originalTarballAssignment).includes("exit 1") ||
  reportedTarballGuard <= originalTarballAssignment ||
  uniqueTarballName <= reportedTarballGuard ||
  uniqueTarballMove <= uniqueTarballName ||
  uniqueTarballAssignment <= uniqueTarballMove ||
  releasePrivacyGate <= uniqueTarballAssignment ||
  releasePrivacyPackJson <= releasePrivacyGate ||
  releasePrivacyTarball <= releasePrivacyPackJson ||
  tarballEnvironmentOutput <= uniqueTarballAssignment ||
  tarballEnvironmentOutput <= releasePrivacyTarball ||
  tarballPathOutput <= uniqueTarballAssignment ||
  tarballPathOutput <= releasePrivacyTarball ||
  tarballFilenameOutput <= uniqueTarballAssignment ||
  tarballDigestOutput <= uniqueTarballAssignment ||
  tarballDigestOutput <= releasePrivacyTarball ||
  smokeInstall <= tarballDigestOutput ||
  smokeDigestGuard <= smokeInstall ||
  packageUpload <= smokeDigestGuard ||
  rawTarballDiscovery === -1 ||
  rawTarballCountGuard <= rawTarballDiscovery ||
  rawTarballAssignment <= rawTarballCountGuard ||
  !publishJob.slice(rawTarballCountGuard, rawTarballAssignment).includes("exit 1") ||
  rawBasenameGuard <= rawTarballAssignment ||
  rawDigestCalculation <= rawBasenameGuard ||
  !publishJob.slice(rawBasenameGuard, rawDigestCalculation).includes("exit 1") ||
  rawDigestGuard <= rawDigestCalculation ||
  publisherDigestGuard <= rawDigestGuard ||
  publisherInvocation <= publisherDigestGuard ||
  publishTarCommands.length !== 0 ||
  publishUnzipCommands.length !== 0
) {
  failures.push(
    "the exact raw tarball and publisher must pass basename and digest checks before the publisher invocation"
  );
}

if (
  !publishJob.includes("artifact-ids: ${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}") ||
  !publishJob.includes("EXPECTED_NPM_VERSION: ${{ needs.prepare-npm.outputs.npm-version }}")
) {
  failures.push(
    "publish-npm must download the npm CLI artifact and version directly from prepare-npm"
  );
}

for (const forbidden of [
  "needs.verify.outputs.npm-cli-artifact-id",
  "needs.verify.outputs.npm-version"
]) {
  if (publishJob.includes(forbidden)) {
    failures.push(`publish-npm must not source the npm CLI through verify via ${forbidden}`);
  }
}

if (
  !verifyJob.includes("artifact-ids: ${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}") ||
  !verifyJob.includes("uses: actions/download-artifact@")
) {
  failures.push("verify must download the exact npm CLI artifact from prepare-npm");
}

for (const forbidden of [
  "node_modules/.bin/npm",
  "node_modules/npm",
  "cp -RL",
  "npm-cli-artifact-id: ${{ steps.",
  "Upload the pinned publishing CLI"
]) {
  if (verifyJob.includes(forbidden)) {
    failures.push(`verify must not stage or upload npm via ${forbidden}`);
  }
}

const npmCliDownload = verifyJob.indexOf(
  "artifact-ids: ${{ needs.prepare-npm.outputs.npm-cli-artifact-id }}"
);
const npmPack = verifyJob.indexOf('node "$NPM_CLI" pack');
const npmInstall = verifyJob.indexOf('node "$NPM_CLI" install --ignore-scripts "$TARBALL"');
const packagedCliExecution = verifyJob.indexOf("./node_modules/.bin/patchpage --version");
const projectExecutionMarkers = [
  "pnpm install --frozen-lockfile",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm test",
  "pnpm --filter patchpage build"
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
    "verify must finish project execution before using the isolated npm CLI to pack and install"
  );
}

if (
  !verifyJob.includes("EXPECTED_NPM_VERSION: ${{ needs.prepare-npm.outputs.npm-version }}") ||
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
  "prepublishOnly"
]) {
  if (publishJob.includes(forbidden)) {
    failures.push(`publish-npm must not contain ${forbidden}`);
  }
}

const allowedPublishActions = new Set(["actions/setup-node", "actions/download-artifact"]);
for (const { coordinate } of actionUses.filter(({ jobName }) => jobName === "publish-npm")) {
  const action = typeof coordinate === "string" ? coordinate.split("@")[0] : null;
  if (!allowedPublishActions.has(action)) {
    failures.push(`publish-npm must not execute the ${String(action)} Action`);
  }
}

if (/^\s+(?:npm|pnpm|npx)\s+/m.test(publishJob)) {
  failures.push("publish-npm must not invoke a package manager outside the staged npm CLI");
}

if (/node\s+["']?[^\n]*npm-cli\.js["']?\s+publish\b|\bnpm\s+publish\b/.test(publishJob)) {
  failures.push("publish-npm must not directly publish a tarball or directory with npm");
}
if (
  /^\s+(?:npm|pnpm)\s+(?:pack|publish)\b|(?:^|\s)cd\s+(?:packages\/cli|\$GITHUB_WORKSPACE)/m.test(
    publishJob
  )
) {
  failures.push("publish-npm must not repack or use a relative-path publishing workaround");
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

const exactPublisherInvocations = publishJob.match(/^[ \t]+node "\$publisher" \\$/gm) ?? [];
if (
  exactPublisherInvocations.length !== 1 ||
  !publishJob.includes('  --tarball "$tarball" \\') ||
  !publishJob.includes('  --expected-sha256 "$EXPECTED_SHA256" \\') ||
  !publishJob.includes('  --npm-cli-dir "$npm_cli_dir"')
) {
  failures.push("publish-npm must invoke the reviewed exact-artifact publisher once");
}

if (serverImageJob) {
  if (!sameMembers(jobNeeds(serverImageJob), ["guard"])) {
    failures.push("verify-server-image must depend only on the release guard");
  }

  if (!sameEntries(jobPermissions(serverImageJob), new Map([["contents", "read"]]))) {
    failures.push("verify-server-image must receive only repository read access");
  }

  if (
    !serverImageJob.includes("image-tar-filename: ${{ steps.image.outputs.filename }}") ||
    !serverImageJob.includes("image-tar-sha256: ${{ steps.image.outputs.sha256 }}") ||
    !serverImageJob.includes("image-id: ${{ steps.image.outputs.image-id }}") ||
    !serverImageJob.includes("config-id: ${{ steps.image.outputs.config-id }}") ||
    !serverImageJob.includes("image-artifact-id: ${{ steps.image-artifact.outputs.artifact-id }}")
  ) {
    failures.push(
      "verify-server-image must expose filename, SHA-256, image/config ID, and artifact ID outputs"
    );
  }

  if (
    !/^\s+VERSION\s*:\s*\$\{\{\s*needs\.guard\.outputs\.version\s*\}\}\s*$/m.test(serverImageJob) ||
    !/^\s+REVISION\s*:\s*\$\{\{\s*needs\.guard\.outputs\.revision\s*\}\}\s*$/m.test(serverImageJob)
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
    !serverImageJob.includes("patchpage-server-${VERSION}-${REVISION}-${GITHUB_RUN_ATTEMPT}.tar")
  ) {
    failures.push(
      "verify-server-image must build, behaviorally verify, and save the exact metadata-bound image tar"
    );
  }

  const build = serverImageJob.indexOf("docker build");
  const builtImageId = serverImageJob.search(/built_image_id\s*=\s*"\$\(docker image inspect/);
  const verifyImage = serverImageJob.indexOf(
    'scripts/verify-server-image.sh "$image" "$VERSION" "$REVISION"'
  );
  const verifiedImageId = serverImageJob.search(
    /verified_image_id\s*=\s*"\$\(docker image inspect/
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
      "verify-server-image must upload a run-attempt-isolated raw tar only after verification"
    );
  }

  for (const forbidden of [
    "docker/login-action",
    "docker login",
    "docker pull",
    "docker push",
    "packages:",
    "GITHUB_TOKEN",
    "github.token"
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
    !dockerJob.includes("manifest-digest: ${{ steps.publish-image.outputs.manifest-digest }}") ||
    !dockerJob.includes("config-digest: ${{ steps.publish-image.outputs.config-digest }}")
  ) {
    failures.push("docker-ghcr must expose the verified GHCR manifest and config digests");
  }

  for (const forbidden of [
    "uses: actions/checkout@",
    "uses: pnpm/action-setup@",
    "uses: docker/login-action@",
    "docker login",
    "docker run",
    "docker save",
    "docker push",
    "docker buildx",
    "docker tag",
    "scripts/verify-server-image.sh",
    "pnpm ",
    "npm ",
    "GITHUB_WORKSPACE",
    "contents:",
    "If-Match",
    "If-None-Match"
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
      "artifact-ids: ${{ needs.verify-server-image.outputs.image-artifact-id }}"
    ) ||
    !dockerJob.includes("skip-decompress: true")
  ) {
    failures.push("docker-ghcr must download the exact raw image artifact ID");
  }

  const validatorSource = decodedEmbeddedSource(
    dockerJob,
    "PATCHPAGE_VALIDATE_DOCKER_SAVE_ARTIFACT"
  );
  const ociSource = decodedEmbeddedSource(dockerJob, "PATCHPAGE_GHCR_OCI_RELEASE");
  const validatorSha = sha256Hex(effectiveDockerSaveValidator);
  const ociSha = sha256Hex(effectiveGhcrOciReleaseTool);
  if (!validatorSource || !validatorSource.equals(effectiveDockerSaveValidator)) {
    failures.push("docker-ghcr must embed the tested docker-save validator source byte-for-byte");
  }
  if (!ociSource || !ociSource.equals(effectiveGhcrOciReleaseTool)) {
    failures.push("docker-ghcr must embed the tested OCI release tool source byte-for-byte");
  }
  if (
    !dockerJob.includes(`validator_sha256="${validatorSha}"`) ||
    !dockerJob.includes(`oci_tool_sha256="${ociSha}"`) ||
    !dockerJob.includes("Embedded docker-save validator source hash mismatch") ||
    !dockerJob.includes("Embedded OCI release tool source hash mismatch")
  ) {
    failures.push("docker-ghcr must hash-check both embedded release tools before use");
  }

  const downloadImage = dockerJob.indexOf(
    "artifact-ids: ${{ needs.verify-server-image.outputs.image-artifact-id }}"
  );
  const installTools = dockerJob.indexOf("Install reviewed checkout-free release tools");
  const validateArtifact = dockerJob.indexOf(
    "Validate and load the verified server image artifact before registry auth"
  );
  const validatorCall = dockerJob.indexOf('node "$VALIDATE_DOCKER_SAVE_ARTIFACT"');
  const loadImage = dockerJob.indexOf('docker load --input "$tar_path"');
  const localTagCheck = dockerJob.indexOf("does not contain the expected local release tag");
  const imageIdCheck = dockerJob.indexOf('"$loaded_image_id" != "$EXPECTED_IMAGE_ID"');
  const publishImage = dockerJob.indexOf("id: publish-image");
  const publishRelease = dockerJob.indexOf('node "$GHCR_OCI_RELEASE" publish-release');
  const reconcileLatest = dockerJob.indexOf('node "$GHCR_OCI_RELEASE" reconcile-latest');
  const configDigestOutput = dockerJob.indexOf(
    'echo "config-digest=$config_digest" >> "$GITHUB_OUTPUT"'
  );
  const manifestDigestOutput = dockerJob.indexOf(
    'echo "manifest-digest=$manifest_digest" >> "$GITHUB_OUTPUT"'
  );
  if (
    downloadImage === -1 ||
    installTools <= downloadImage ||
    validateArtifact <= installTools ||
    validatorCall <= validateArtifact ||
    loadImage <= validatorCall ||
    localTagCheck <= loadImage ||
    imageIdCheck <= localTagCheck ||
    publishImage <= imageIdCheck ||
    publishRelease <= publishImage ||
    reconcileLatest <= publishRelease ||
    configDigestOutput <= reconcileLatest ||
    manifestDigestOutput <= configDigestOutput
  ) {
    failures.push(
      "docker-ghcr must install reviewed tools, validate the raw tar before docker load, then publish and reconcile through OCI state"
    );
  }

  if (
    !dockerJob.includes('--artifact-dir "$RUNNER_TEMP/server-image"') ||
    !dockerJob.includes('--expected-filename "$EXPECTED_FILENAME"') ||
    !dockerJob.includes('--expected-sha256 "$EXPECTED_SHA256"') ||
    !dockerJob.includes('--expected-repo-tag "$expected_local_tag"') ||
    !dockerJob.includes('--expected-config-id "$EXPECTED_IMAGE_ID"') ||
    !dockerJob.includes('expected_local_tag="${ghcr_image}:${EXPECTED_VERSION}"') ||
    !dockerJob.includes('echo "image-tar=$tar_path" >> "$GITHUB_OUTPUT"')
  ) {
    failures.push(
      "docker-ghcr must pass filename, artifact digest, expected RepoTag, and config ID into the tar validator"
    );
  }

  if (
    !dockerJob.includes("GHCR_IMAGE_TAR: ${{ steps.load-image.outputs.image-tar }}") ||
    !dockerJob.includes("GITHUB_TOKEN: ${{ github.token }}") ||
    !dockerJob.includes("--registry-url https://ghcr.io") ||
    !dockerJob.includes('--name "$ghcr_name"') ||
    !dockerJob.includes('--version "$EXPECTED_VERSION"') ||
    !dockerJob.includes('--revision "$EXPECTED_REVISION"') ||
    !dockerJob.includes('--image-tar "$GHCR_IMAGE_TAR"') ||
    !dockerJob.includes('--expected-repo-tag "${ghcr_image}:${EXPECTED_VERSION}"') ||
    !dockerJob.includes('--expected-config-id "$EXPECTED_IMAGE_ID"') ||
    !dockerJob.includes("--allow-first-package true") ||
    !dockerJob.includes("const state = JSON.parse(process.argv[1])")
  ) {
    failures.push(
      "docker-ghcr must publish the validated tar through the reviewed OCI release tool with exact release identity"
    );
  }

  if (
    !effectiveGhcrOciReleaseTool.includes("Docker-Content-Digest") ||
    !effectiveGhcrOciReleaseTool.includes("if (responseMediaType !== OCI_MANIFEST_MEDIA_TYPE)") ||
    !effectiveGhcrOciReleaseTool.includes("if (manifest?.mediaType !== OCI_MANIFEST_MEDIA_TYPE)") ||
    !effectiveGhcrOciReleaseTool.includes("MANIFEST_UNKNOWN") ||
    !effectiveGhcrOciReleaseTool.includes("NAME_UNKNOWN") ||
    !effectiveGhcrOciReleaseTool.includes("/tags/list?n=100") ||
    !effectiveGhcrOciReleaseTool.includes("repository:${this.name}:${this.scopeActions}") ||
    !effectiveGhcrOciReleaseTool.includes("FIRST_PACKAGE_REPOSITORY") ||
    !effectiveGhcrOciReleaseTool.includes(
      "return error.code === expectedCode && detailMatchesTarget(error.detail, target);"
    ) ||
    !effectiveGhcrOciReleaseTool.includes("registry bearer realm changed origin") ||
    !effectiveGhcrOciReleaseTool.includes("blob upload Location changed registry origin") ||
    !effectiveGhcrOciReleaseTool.includes("response.status !== 201") ||
    !effectiveGhcrOciReleaseTool.includes("configDigestHeader") ||
    !effectiveGhcrOciReleaseTool.includes("selectHighestCompleteRelease") ||
    !effectiveGhcrOciReleaseTool.includes("leftMatch.slice(1).map(BigInt)") ||
    !effectiveGhcrOciReleaseTool.includes('const MINIMUM_SUPPORTED_IMAGE_VERSION = "0.1.1"') ||
    !effectiveGhcrOciReleaseTool.includes("isStableSemver(tag) && isSupportedImageRelease(tag)") ||
    !effectiveGhcrOciReleaseTool.includes("const MAX_CONFIG_BYTES = 1024 * 1024") ||
    !effectiveGhcrOciReleaseTool.includes("if (configSize > MAX_CONFIG_BYTES)") ||
    !effectiveGhcrOciReleaseTool.includes("readCappedResponseBody") ||
    !effectiveGhcrOciReleaseTool.includes("response.body?.getReader()") ||
    !effectiveGhcrOciReleaseTool.includes("expectedBytes: configSize") ||
    effectiveGhcrOciReleaseTool.includes("arrayBuffer()") ||
    !effectiveGhcrOciReleaseTool.includes("authenticateLatestCandidate") ||
    !effectiveGhcrOciReleaseTool.includes(
      "post-write latest and re-enumerated highest complete release"
    ) ||
    !effectiveGhcrOciReleaseTool.includes("post-write release pair and canonical image") ||
    !effectiveGhcrOciReleaseTool.includes("publishRelease") ||
    !effectiveGhcrOciReleaseTool.includes("putManifest") ||
    effectiveGhcrOciReleaseTool.includes("If-Match") ||
    effectiveGhcrOciReleaseTool.includes("If-None-Match")
  ) {
    failures.push(
      "ghcr-oci-release.mjs must implement exact digest-bound OCI reads, paginated highest-complete selection, latest authentication, and unconditional manifest PUTs without CAS claims"
    );
  }

  if (
    !effectiveDockerSaveValidator.includes("validateDockerSaveTar") ||
    !effectiveDockerSaveValidator.includes(
      "if (descriptor?.mediaType !== OCI_MANIFEST_MEDIA_TYPE)"
    ) ||
    !effectiveDockerSaveValidator.includes(
      "if (ociManifest?.mediaType !== OCI_MANIFEST_MEDIA_TYPE)"
    ) ||
    !effectiveDockerSaveValidator.includes("createGunzip") ||
    !effectiveDockerSaveValidator.includes("createZstdDecompress") ||
    !effectiveDockerSaveValidator.includes("MAX_UNCOMPRESSED_LAYER_BYTES") ||
    !effectiveDockerSaveValidator.includes("const MAX_LAYER_EXPANSION_RATIO = 200") ||
    !effectiveDockerSaveValidator.includes("await uncompressedLayerDigest") ||
    !effectiveDockerSaveValidator.includes("expected top uncompressed diff ID") ||
    !effectiveDockerSaveValidator.includes("manifest.json must contain exactly one image") ||
    !effectiveDockerSaveValidator.includes("tar entry is a link") ||
    !effectiveDockerSaveValidator.includes("legacy config") ||
    !effectiveDockerSaveValidator.includes("rootfs.diff_ids") ||
    !effectiveDockerSaveValidator.includes("nodes.length !== diffIds.length") ||
    !effectiveDockerSaveValidator.includes("if (roots.length !== 1)") ||
    !effectiveDockerSaveValidator.includes("if (children.has(node.parent))") ||
    !effectiveDockerSaveValidator.includes("graph contains disconnected nodes or a cycle") ||
    !effectiveDockerSaveValidator.includes("if (!allowedKeys.has(key))") ||
    !effectiveDockerSaveValidator.includes("has an invalid container_config") ||
    !effectiveDockerSaveValidator.includes(
      'for (const key of ["config", "architecture", "variant"])'
    ) ||
    !effectiveDockerSaveValidator.includes("if (!isLeaf && hasOwn(node.legacy, key))") ||
    !effectiveDockerSaveValidator.includes(
      `    const stableRuntimeFields = [
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
    ];`
    ) ||
    !effectiveDockerSaveValidator.includes(
      "!isDeepStrictEqual(leafRuntimeConfig[key], ociRuntimeConfig[key])"
    ) ||
    !effectiveDockerSaveValidator.includes("if (node.legacy.os !== config.os)") ||
    !effectiveDockerSaveValidator.includes(
      "if (hasOwn(leaf.legacy, key) && leaf.legacy[key] !== config[key])"
    ) ||
    !effectiveDockerSaveValidator.includes(
      "legacy config graph must contain exactly one parentless root"
    ) ||
    !effectiveDockerSaveValidator.includes(
      "if (repositoryTags[tag] !== expectedRepositoryLayer)"
    ) ||
    !effectiveDockerSaveValidator.includes("repositories must contain exactly") ||
    !effectiveDockerSaveValidator.includes("unreferenced or unexpected file")
  ) {
    failures.push(
      "validate-docker-save-artifact.mjs must retain the structural docker-save graph validator"
    );
  }
}

const reconcileInspectJob = jobFrom(reconcileWorkflow, "inspect", "reconcile-ghcr.yml");
const reconcileRebuildJob = jobFrom(reconcileWorkflow, "rebuild", "reconcile-ghcr.yml");
const reconcilePublishJob = jobFrom(reconcileWorkflow, "publish-ghcr", "reconcile-ghcr.yml");
const reconcileLatestJob = jobFrom(reconcileWorkflow, "reconcile-latest", "reconcile-ghcr.yml");
const reconcileBindJob = jobFrom(reconcileWorkflow, "bind-publish-results", "reconcile-ghcr.yml");
const reconcileAnonymousJob = jobFrom(
  reconcileWorkflow,
  "ghcr-anonymous-acceptance",
  "reconcile-ghcr.yml"
);

if (
  !/^on:\n  workflow_dispatch:[\s\S]*\n  schedule:\n    - cron: /m.test(reconcileWorkflow) ||
  !/^concurrency:\n  group: release-ghcr-patchpage-server\n  queue: max\n  cancel-in-progress: false$/m.test(
    reconcileWorkflow
  )
) {
  failures.push(
    "reconcile-ghcr.yml must be scheduled/manual and reuse the package-wide max queue, capped by GitHub at 100 pending runs"
  );
}

if (reconcileInspectJob) {
  if (
    !sameEntries(
      jobPermissions(reconcileInspectJob),
      new Map([
        ["contents", "read"],
        ["packages", "read"]
      ])
    ) ||
    !reconcileInspectJob.includes("gh api --paginate") ||
    !reconcileInspectJob.includes("git fetch --force --tags --prune --prune-tags") ||
    !reconcileInspectJob.includes("inspect-release") ||
    !reconcileInspectJob.includes("batch-size must be an integer from 1 to 25") ||
    !reconcileInspectJob.includes("target must be an exact stable vX.Y.Z tag") ||
    !reconcileInspectJob.includes("stable GitHub tag") ||
    !reconcileInspectJob.includes("isSupportedImageRelease") ||
    !reconcileInspectJob.includes("MINIMUM_SUPPORTED_IMAGE_VERSION") ||
    !reconcileInspectJob.includes(".filter((tag) => isSupportedImageRelease(tag.slice(1)))") ||
    !reconcileInspectJob.includes("predates first supported image release") ||
    !reconcileInspectJob.includes("const rows = tags.map((tag) => {") ||
    !reconcileInspectJob.includes('if [[ -z "$INPUT_TARGET" || "$tag" == "$INPUT_TARGET" ]]') ||
    reconcileInspectJob.includes("const selected =") ||
    reconcileInspectJob.includes("tags.slice(") ||
    reconcileInspectJob.split('split(".").map(BigInt)').length - 1 !== 2 ||
    !reconcileInspectJob.includes("snapshot: ${{ steps.plan.outputs.snapshot }}") ||
    !reconcileInspectJob.includes("complete-count: ${{ steps.plan.outputs.complete-count }}") ||
    !reconcileInspectJob.includes("reconcile-snapshot.json") ||
    !reconcileInspectJob.includes("complete inspect state digests are invalid") ||
    !reconcileInspectJob.includes("if (( needed_count < INPUT_BATCH_SIZE ))") ||
    !reconcileInspectJob.includes("needed_count=$((needed_count + 1))") ||
    reconcileInspectJob.includes("needed_count >= INPUT_BATCH_SIZE") ||
    reconcileInspectJob.includes("break") ||
    reconcileInspectJob.includes(").slice(0, batchSize)") ||
    !reconcileInspectJob.includes("row.manifestDigest = state.manifestDigest") ||
    !reconcileInspectJob.includes("row.configDigest = state.configDigest") ||
    !reconcileInspectJob.includes("complete_count=") ||
    !reconcileInspectJob.includes("missing") ||
    !reconcileInspectJob.includes("incomplete")
  ) {
    failures.push(
      "reconcile inspect must paginate stable GitHub tags, verify fetch completeness, inspect GHCR, and choose a bounded missing/incomplete batch"
    );
  }
}

if (reconcileRebuildJob) {
  const buildImage = reconcileRebuildJob.indexOf("docker build");
  const verifyImage = reconcileRebuildJob.indexOf(
    'scripts/verify-server-image.sh "$image" "$VERSION" "$REVISION"'
  );
  const saveImage = reconcileRebuildJob.indexOf('docker save "$image" --output "$tar_path"');
  const validateTar = reconcileRebuildJob.indexOf("node scripts/validate-docker-save-artifact.mjs");
  const uploadImage = reconcileRebuildJob.indexOf("Upload exact replay server image raw tar");
  if (
    !sameEntries(jobPermissions(reconcileRebuildJob), new Map([["contents", "read"]])) ||
    !reconcileRebuildJob.includes("max-parallel: 1") ||
    reconcileRebuildJob.includes("ref: ${{ matrix.tag }}") ||
    !reconcileRebuildJob.includes("fetch-depth: 0") ||
    !reconcileRebuildJob.includes("git fetch --force --tags --prune --prune-tags") ||
    !reconcileRebuildJob.includes('git worktree add --detach "$source_dir" "$REVISION"') ||
    !reconcileRebuildJob.includes('"$actual_revision" == "$REVISION"') ||
    buildImage === -1 ||
    verifyImage <= buildImage ||
    saveImage <= verifyImage ||
    validateTar <= saveImage ||
    uploadImage <= validateTar ||
    !reconcileRebuildJob.includes('--artifact-dir "$artifact_dir"') ||
    !reconcileRebuildJob.includes("archive: false") ||
    !reconcileRebuildJob.includes("artifactId") ||
    !reconcileRebuildJob.includes(
      'cat > "$RUNNER_TEMP/reconcile-handoff-${{ matrix.version }}.json"'
    ) ||
    !reconcileRebuildJob.includes(
      "path: ${{ runner.temp }}/reconcile-handoff-${{ matrix.version }}.json"
    ) ||
    !reconcileRebuildJob.includes("overwrite: true") ||
    reconcileRebuildJob.split("retention-days: 30").length - 1 !== 2 ||
    reconcileRebuildJob.includes(
      "reconcile-handoff-${{ matrix.version }}-${{ github.run_attempt }}.json"
    ) ||
    reconcileRebuildJob.includes("          name: reconcile-handoff-") ||
    reconcileRebuildJob.includes("docker login") ||
    reconcileRebuildJob.includes("docker push") ||
    reconcileRebuildJob.includes("npm publish")
  ) {
    failures.push(
      "reconcile rebuild must use current reviewed verifiers on an exact detached historical source worktree before handing off a raw image artifact"
    );
  }
}

if (reconcilePublishJob) {
  const validatorSource = decodedEmbeddedSource(
    reconcilePublishJob,
    "PATCHPAGE_VALIDATE_DOCKER_SAVE_ARTIFACT"
  );
  const ociSource = decodedEmbeddedSource(reconcilePublishJob, "PATCHPAGE_GHCR_OCI_RELEASE");
  if (!validatorSource || !validatorSource.equals(effectiveDockerSaveValidator)) {
    failures.push(
      "reconcile publisher must embed the tested docker-save validator source byte-for-byte"
    );
  }
  if (!ociSource || !ociSource.equals(effectiveGhcrOciReleaseTool)) {
    failures.push(
      "reconcile publisher must embed the tested OCI release tool source byte-for-byte"
    );
  }
  if (
    !sameEntries(
      jobPermissions(reconcilePublishJob),
      new Map([
        ["actions", "read"],
        ["packages", "write"]
      ])
    ) ||
    !reconcilePublishJob.includes("max-parallel: 1") ||
    !reconcilePublishJob.includes("actions/download-artifact@") ||
    !reconcilePublishJob.includes("Resolve replay handoff artifact ID") ||
    !reconcilePublishJob.includes("Expected exactly one replay handoff artifact named") ||
    !reconcilePublishJob.includes('handoff_name="reconcile-handoff-${{ matrix.version }}.json"') ||
    !reconcilePublishJob.includes('"reconcile-handoff-${{ matrix.version }}.json"') ||
    reconcilePublishJob.includes(
      "reconcile-handoff-${{ matrix.version }}-${{ github.run_attempt }}.json"
    ) ||
    !reconcilePublishJob.includes(
      "artifact-ids: ${{ steps.handoff-artifact.outputs.artifact-id }}"
    ) ||
    !reconcilePublishJob.includes("handoff directory must contain exactly one entry") ||
    !reconcilePublishJob.includes("handoff file must be a regular non-link file") ||
    !reconcilePublishJob.includes("handoff JSON must be canonical") ||
    !reconcilePublishJob.includes("handoff JSON keys are invalid") ||
    !reconcilePublishJob.includes("const entries = fs.readdirSync(directory);") ||
    !reconcilePublishJob.includes("if (entries.length !== 1)") ||
    !reconcilePublishJob.includes("handoffStat.nlink !== 1") ||
    !reconcilePublishJob.includes("JSON.stringify(Object.keys(value)) !== JSON.stringify(keys)") ||
    !reconcilePublishJob.includes("raw !== `${JSON.stringify(value)}\\n`") ||
    !reconcilePublishJob.includes("imageFilenamePattern") ||
    !reconcilePublishJob.includes("handoff image filename is invalid for the release identity") ||
    !reconcilePublishJob.includes("handoff configId does not match imageId") ||
    !reconcilePublishJob.includes("artifact-ids: ${{ steps.handoff.outputs.image-artifact-id }}") ||
    !reconcilePublishJob.includes("Validate and load replay image before registry auth") ||
    !reconcilePublishJob.includes("Publish replay image to GHCR") ||
    reconcilePublishJob.split("\n").filter((line) => line === "          skip-decompress: true")
      .length < 2 ||
    reconcilePublishJob.includes("actions/artifacts/${artifact_id}/zip") ||
    reconcilePublishJob.includes("unzip ") ||
    !reconcilePublishJob.includes('node "$VALIDATE_DOCKER_SAVE_ARTIFACT"') ||
    !reconcilePublishJob.includes('docker load --input "$tar_path"') ||
    !reconcilePublishJob.includes('node "$GHCR_OCI_RELEASE" publish-release') ||
    !reconcilePublishJob.includes("Upload immutable replay publication result") ||
    !reconcilePublishJob.includes(
      'result_path="$RUNNER_TEMP/reconcile-publish-result-${version}-${revision}.json"'
    ) ||
    !reconcilePublishJob.includes(
      "const bound = { version, revision, manifestDigest: value.manifestDigest, configDigest: value.configDigest };"
    ) ||
    !reconcilePublishJob.includes("actions/upload-artifact@") ||
    !reconcilePublishJob.includes("path: ${{ steps.publish-image.outputs.result-path }}") ||
    !reconcilePublishJob.includes("archive: false") ||
    !reconcilePublishJob.includes("overwrite: true") ||
    reconcilePublishJob.includes('node "$GHCR_OCI_RELEASE" reconcile-latest') ||
    !reconcilePublishJob.includes("--allow-first-package true") ||
    reconcilePublishJob.includes("uses: actions/checkout@") ||
    reconcilePublishJob.includes("pnpm ") ||
    reconcilePublishJob.includes("npm publish") ||
    reconcilePublishJob.includes("docker build") ||
    reconcilePublishJob.includes("docker push") ||
    reconcilePublishJob.includes("docker login")
  ) {
    failures.push(
      "reconcile publisher must be checkout-free packages:write only, validate exact raw artifacts, and publish only GHCR through the reviewed OCI tool"
    );
  }
}
if (reconcileLatestJob) {
  const validatorSource = decodedEmbeddedSource(
    reconcileLatestJob,
    "PATCHPAGE_RECONCILE_LATEST_VALIDATOR"
  );
  const ociSource = decodedEmbeddedSource(
    reconcileLatestJob,
    "PATCHPAGE_RECONCILE_LATEST_OCI_RELEASE"
  );
  if (!validatorSource || !validatorSource.equals(effectiveDockerSaveValidator)) {
    failures.push(
      "reconcile latest must embed the tested docker-save validator dependency byte-for-byte"
    );
  }
  if (!ociSource || !ociSource.equals(effectiveGhcrOciReleaseTool)) {
    failures.push("reconcile latest must embed the tested OCI release tool source byte-for-byte");
  }
  if (
    !sameEntries(jobPermissions(reconcileLatestJob), new Map([["packages", "write"]])) ||
    !reconcileLatestJob.includes("always()") ||
    !reconcileLatestJob.includes("needs.inspect.result == 'success'") ||
    !reconcileLatestJob.includes("needs.publish-ghcr.result == 'success'") ||
    !reconcileLatestJob.includes("needs.publish-ghcr.result == 'skipped'") ||
    !reconcileLatestJob.includes("needs.inspect.outputs.count == '0'") ||
    !reconcileLatestJob.includes("needs.inspect.outputs.complete-count != '0'") ||
    !reconcileLatestJob.includes("Embedded docker-save validator source hash mismatch") ||
    !reconcileLatestJob.includes(
      'chmod 500 "$tools_dir/validate-docker-save-artifact.mjs" "$tools_dir/ghcr-oci-release.mjs"'
    ) ||
    !reconcileLatestJob.includes("Embedded OCI release tool source hash mismatch") ||
    !reconcileLatestJob.includes('node "$GHCR_OCI_RELEASE" reconcile-latest') ||
    reconcileLatestJob.includes("uses: actions/checkout@") ||
    reconcileLatestJob.includes("uses: actions/download-artifact@") ||
    reconcileLatestJob.includes("pnpm ") ||
    reconcileLatestJob.includes("npm publish") ||
    reconcileLatestJob.includes("docker ")
  ) {
    failures.push(
      "reconcile latest must run checkout-free after replay or for an already-complete supported release, but skip the pre-support empty schedule"
    );
  }
}
if (reconcileBindJob) {
  if (
    !sameEntries(jobPermissions(reconcileBindJob), new Map([["actions", "read"]])) ||
    !reconcileBindJob.includes("always()") ||
    !reconcileBindJob.includes("needs.inspect.result == 'success'") ||
    !reconcileBindJob.includes("needs.publish-ghcr.result == 'success'") ||
    !reconcileBindJob.includes("needs.publish-ghcr.result == 'skipped'") ||
    !reconcileBindJob.includes("needs.inspect.outputs.count == '0'") ||
    !reconcileBindJob.includes("needs: [inspect, publish-ghcr]") ||
    !reconcileBindJob.includes("GH_TOKEN: ${{ github.token }}") ||
    !reconcileBindJob.includes("REPAIR_COUNT: ${{ needs.inspect.outputs.count }}") ||
    !reconcileBindJob.includes("REPAIR_MATRIX: ${{ needs.inspect.outputs.matrix }}") ||
    !reconcileBindJob.includes("RELEASE_SNAPSHOT: ${{ needs.inspect.outputs.snapshot }}") ||
    !reconcileBindJob.includes("gh api --paginate") ||
    !reconcileBindJob.includes("/actions/runs/${GITHUB_RUN_ID}/artifacts?per_page=100") ||
    !reconcileBindJob.includes(".created_at") ||
    !reconcileBindJob.includes('row.status === "complete"') ||
    !reconcileBindJob.includes('source: "snapshot"') ||
    !reconcileBindJob.includes('source: "artifact"') ||
    !reconcileBindJob.includes('!["missing", "incomplete"].includes(snapshotRow.status)') ||
    !reconcileBindJob.includes(
      ".filter((artifact) => artifact.name === name && !artifact.expired)"
    ) ||
    !reconcileBindJob.includes("right.created - left.created") ||
    !reconcileBindJob.includes("BigInt(right.id) > BigInt(left.id)") ||
    !reconcileBindJob.includes("if (matches.length === 0)") ||
    !reconcileBindJob.includes("artifactId: matches[0].id") ||
    !reconcileBindJob.includes("manifestDigest: row.manifestDigest") ||
    !reconcileBindJob.includes("configDigest: row.configDigest") ||
    !reconcileBindJob.includes("process.stdout.write(JSON.stringify({ include }));") ||
    reconcileBindJob.includes("resultArtifacts.length") ||
    reconcileBindJob.includes("matches.length !== 1")
  ) {
    failures.push(
      "reconcile result binder must accept every complete snapshot row, select the newest exact per-row publication artifact after successful repair, and ignore unrelated stale run artifacts"
    );
  }
}

async function verifyReconcileBinderBehavior() {
  const run = parsedReconcileWorkflow?.jobs?.["bind-publish-results"]?.steps?.find(
    (step) => step.id === "bind"
  )?.run;
  const marker =
    'node - "$RELEASE_SNAPSHOT" "$REPAIR_MATRIX" "$REPAIR_COUNT" "$artifacts" <<\'NODE\'\n';
  const scriptStart = typeof run === "string" ? run.indexOf(marker) + marker.length : -1;
  const scriptEnd = scriptStart >= marker.length ? run.indexOf("\nNODE\n", scriptStart) : -1;
  if (scriptStart < marker.length || scriptEnd < scriptStart) {
    return ["reconcile result binder behavioral fixture could not extract its inline program"];
  }

  const revisionA = "a".repeat(40);
  const revisionB = "b".repeat(40);
  const revisionC = "c".repeat(40);
  const manifestA = `sha256:${"1".repeat(64)}`;
  const configA = `sha256:${"2".repeat(64)}`;
  const manifestC = `sha256:${"5".repeat(64)}`;
  const configC = `sha256:${"6".repeat(64)}`;
  const completeA = {
    tag: "v1.0.0",
    version: "1.0.0",
    revision: revisionA,
    status: "complete",
    manifestDigest: manifestA,
    configDigest: configA
  };
  const completeC = {
    tag: "v1.2.0",
    version: "1.2.0",
    revision: revisionC,
    status: "complete",
    manifestDigest: manifestC,
    configDigest: configC
  };
  const snapshotBinding = (row) => ({
    tag: row.tag,
    version: row.version,
    revision: row.revision,
    source: "snapshot",
    artifactId: "",
    manifestDigest: row.manifestDigest,
    configDigest: row.configDigest
  });
  const repairedB = {
    tag: "v1.1.0",
    version: "1.1.0",
    revision: revisionB
  };
  const artifactBindingB = {
    ...repairedB,
    source: "artifact",
    artifactId: "99",
    manifestDigest: "",
    configDigest: ""
  };
  const artifactNameB = `reconcile-publish-result-1.1.0-${revisionB}.json`;
  const artifactNameC = `reconcile-publish-result-1.2.0-${revisionC}.json`;
  const fixtures = [
    {
      name: "zero-repair run accepts every complete supported release",
      snapshot: [completeA, completeC],
      repairMatrix: { include: [] },
      artifacts: "",
      expected: { include: [snapshotBinding(completeA), snapshotBinding(completeC)] }
    },
    {
      name: "next run retains a successful sibling and binds the repaired row",
      snapshot: [completeA, { ...repairedB, status: "missing" }],
      repairMatrix: { include: [repairedB] },
      artifacts: [
        `42\t${artifactNameB}\tfalse\t2026-07-14T01:00:00Z`,
        `99\t${artifactNameB}\tfalse\t2026-07-14T02:00:00Z`,
        `100\treconcile-publish-result-unrelated.json\tfalse\t2026-07-14T03:00:00Z`,
        `101\t${artifactNameB}\ttrue\t2026-07-14T04:00:00Z`
      ].join("\n"),
      expected: { include: [snapshotBinding(completeA), artifactBindingB] }
    },
    {
      name: "smaller rerun matrix ignores stale prior-attempt artifacts",
      snapshot: [
        completeA,
        { ...repairedB, status: "incomplete" },
        {
          tag: "v1.2.0",
          version: "1.2.0",
          revision: revisionC,
          status: "missing"
        }
      ],
      repairMatrix: { include: [repairedB] },
      artifacts: [
        `99\t${artifactNameB}\tfalse\t2026-07-14T02:00:00Z`,
        `77\t${artifactNameC}\tfalse\t2026-07-13T23:00:00Z`
      ].join("\n"),
      expected: { include: [snapshotBinding(completeA), artifactBindingB] }
    },
    {
      name: "pre-support empty schedule produces no acceptance rows",
      snapshot: [],
      repairMatrix: { include: [] },
      artifacts: "",
      expected: { include: [] }
    }
  ];

  const directory = await mkdtemp(path.join(tmpdir(), "patchpage-reconcile-binder-"));
  const fixtureFailures = [];
  try {
    for (const fixture of fixtures) {
      const artifactPath = path.join(directory, "artifacts.tsv");
      await writeFile(artifactPath, fixture.artifacts);
      const result = spawnSync(
        process.execPath,
        [
          "-",
          JSON.stringify(fixture.snapshot),
          JSON.stringify(fixture.repairMatrix),
          String(fixture.repairMatrix.include.length),
          artifactPath
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          input: run.slice(scriptStart, scriptEnd)
        }
      );
      let actual;
      try {
        actual = JSON.parse(result.stdout);
      } catch {
        actual = null;
      }
      if (result.status !== 0 || JSON.stringify(actual) !== JSON.stringify(fixture.expected)) {
        fixtureFailures.push(
          `reconcile result binder behavioral fixture failed: ${fixture.name}; ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return fixtureFailures;
}

if (!process.env.PATCHPAGE_RELEASE_WORKFLOW_SKIP_MUTATION_CHECKS) {
  failures.push(...(await verifyReconcileBinderBehavior()));
}

if (reconcileAnonymousJob) {
  const semverPull = reconcileAnonymousJob.indexOf('pull_anonymously "$semver_image"');
  const revisionPull = reconcileAnonymousJob.indexOf('pull_anonymously "$revision_image"');
  const digestPull = reconcileAnonymousJob.indexOf('pull_anonymously "$digest_image"');
  const boot = reconcileAnonymousJob.indexOf("docker run -d");
  if (
    !sameEntries(jobPermissions(reconcileAnonymousJob), new Map()) ||
    !reconcileAnonymousJob.includes("needs.reconcile-latest.result == 'success'") ||
    !reconcileAnonymousJob.includes("needs.bind-publish-results.result == 'success'") ||
    !reconcileAnonymousJob.includes(
      "matrix: ${{ fromJson(needs.bind-publish-results.outputs.matrix) }}"
    ) ||
    !reconcileAnonymousJob.includes("Download exact immutable publication result") ||
    !reconcileAnonymousJob.includes("if: matrix.source == 'artifact'") ||
    !reconcileAnonymousJob.includes("artifact-ids: ${{ matrix.artifactId }}") ||
    !reconcileAnonymousJob.includes("skip-decompress: true") ||
    !reconcileAnonymousJob.includes("Resolve the exact snapshot or publication result binding") ||
    !reconcileAnonymousJob.includes('if (source === "snapshot")') ||
    !reconcileAnonymousJob.includes('} else if (source === "artifact")') ||
    !reconcileAnonymousJob.includes(
      "snapshot acceptance must not consume a publication artifact"
    ) ||
    !reconcileAnonymousJob.includes(
      "publication result directory must contain exactly the expected file"
    ) ||
    !reconcileAnonymousJob.includes("publication result must be a regular non-link file") ||
    !reconcileAnonymousJob.includes("publication result JSON must be canonical") ||
    !reconcileAnonymousJob.includes("publication result identity does not match the matrix") ||
    !reconcileAnonymousJob.includes(
      "EXPECTED_MANIFEST_DIGEST: ${{ steps.bound-result.outputs.manifest-digest }}"
    ) ||
    !reconcileAnonymousJob.includes(
      "EXPECTED_CONFIG_DIGEST: ${{ steps.bound-result.outputs.config-digest }}"
    ) ||
    semverPull === -1 ||
    revisionPull <= semverPull ||
    digestPull <= revisionPull ||
    boot <= digestPull ||
    reconcileAnonymousJob.split("require_bound_image").length - 1 < 4 ||
    !reconcileAnonymousJob.includes('actual_digest" == "$EXPECTED_MANIFEST_DIGEST"') ||
    !reconcileAnonymousJob.includes('actual_config" == "$EXPECTED_CONFIG_DIGEST"') ||
    !reconcileAnonymousJob.includes("trap cleanup EXIT") ||
    !reconcileAnonymousJob.includes("DOCKER_CONFIG") ||
    !reconcileAnonymousJob.includes("/healthz") ||
    !reconcileAnonymousJob.includes('{"ok":true}') ||
    reconcileAnonymousJob.includes("inspect-release") ||
    reconcileAnonymousJob.includes("github.token") ||
    /^\s+GITHUB_TOKEN:/m.test(reconcileAnonymousJob) ||
    /^\s+GH_TOKEN:/m.test(reconcileAnonymousJob) ||
    /^\s+DOCKER_AUTH_CONFIG:/m.test(reconcileAnonymousJob) ||
    reconcileAnonymousJob.includes("docker login") ||
    reconcileAnonymousJob.includes("actions/checkout") ||
    reconcileAnonymousJob.includes("pnpm ") ||
    reconcileAnonymousJob.includes("npm ")
  ) {
    failures.push(
      "anonymous reconciliation acceptance must consume either the exact complete-release snapshot or the newest exact publisher artifact ID, bind semver/full-SHA/config without credentials, and boot only its digest"
    );
  }
}

if (ciDockerJob) {
  if (
    !/^\s+VERSION\s*:\s*0\.0\.0-ci\s*$/m.test(ciDockerJob) ||
    !/^\s+REVISION\s*:\s*"0000000000000000000000000000000000000000"\s*$/m.test(ciDockerJob)
  ) {
    failures.push("CI must use deterministic string image version and quoted revision metadata");
  }

  const build = ciDockerJob.indexOf("docker build");
  const saveImage = ciDockerJob.indexOf('docker save "$image"');
  const validateSavedImage = ciDockerJob.indexOf("node scripts/validate-docker-save-artifact.mjs");
  const verifyImage = ciDockerJob.search(
    /scripts\/verify-server-image\.sh\s+"\$image"\s+"\$VERSION"\s+"\$REVISION"/
  );
  const buildCommand = ciDockerJob.slice(build, verifyImage);
  if (
    (ciDockerJob.match(/\bdocker build\b/g) ?? []).length !== 1 ||
    build === -1 ||
    verifyImage <= build ||
    saveImage <= build ||
    validateSavedImage <= saveImage ||
    verifyImage <= validateSavedImage ||
    !ciDockerJob.includes('--expected-repo-tag "$image"') ||
    !ciDockerJob.includes('--expected-config-id "$image_id"') ||
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
    "ghcr.io/allisonmahmood/patchpage-server"
  ]) {
    if (ciDockerJob.includes(forbidden)) {
      failures.push(`CI's local image contract must not contain ${forbidden}`);
    }
  }
}

const requiredExactPublisherMarkers = [
  'createRequire(path.join(npmCliDir, "package.json"))',
  'requireFromNpm("./node_modules/pacote")',
  'requireFromNpm("./lib/utils/oidc.js")',
  'requireFromNpm("./node_modules/libnpmpublish")',
  'key.startsWith("_")',
  "AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS)",
  "await enforceLatestTagHighWaterMark(",
  'defaultTag: "latest"',
  'sha(tarball, "sha256", "hex") !== options["expected-sha256"]',
  'manifest.name !== options["expected-name"]',
  'manifest.version !== options["expected-version"]',
  "containsForbiddenMetadata(manifest)",
  "await verifiedRegistryState(runtime.fetch ?? globalThis.fetch, expected)",
  "for (let attempt = 0; attempt < POSTPUBLISH_MAX_ATTEMPTS; attempt += 1)",
  "validateRegistryManifest(result.metadata, expected)",
  "if (!hasProvenance(metadata)) fail",
  "await modules.publish(manifest, tarball, opts)",
  'typeof opts[key] !== "string"'
];
for (const marker of requiredExactPublisherMarkers) {
  if (!exactNpmPublisher.includes(marker)) {
    failures.push(
      "the exact npm publisher must retain artifact, OIDC, metadata, and provenance validation"
    );
    break;
  }
}
if (
  /(?:console\.(?:log|error|warn)|process\.(?:stdout|stderr)\.write)[^\n]*(?:tarballPath|metadata|token|secretValue)/.test(
    exactNpmPublisher
  )
) {
  failures.push("the exact npm publisher diagnostics must remain category-only");
}

if (packageJson.scripts?.["test:server-image"] !== "bash scripts/verify-server-image.sh") {
  failures.push("package.json must expose the focused server image contract verifier");
}
if (packageJson.scripts?.["test:ghcr-oci"] !== "node scripts/ghcr-oci-release.test.mjs") {
  failures.push("package.json must expose the focused GHCR OCI mock suite");
}
if (
  packageJson.scripts?.["test:docker-save"] !==
  "node scripts/validate-docker-save-artifact.test.mjs"
) {
  failures.push("package.json must expose the focused docker-save validator fixture suite");
}
if (
  packageJson.scripts?.["test:release-privacy"] !==
  "node --test scripts/verify-release-privacy.test.mjs"
) {
  failures.push("package.json must expose the focused release privacy fixture suite");
}
if (
  packageJson.scripts?.["test:exact-npm-publisher"] !==
  "node --test scripts/publish-exact-npm-artifact.test.mjs"
) {
  failures.push("package.json must expose the focused exact npm publisher suite");
}
const ciReleaseWorkflowTest = ciLintSteps.findIndex((step) =>
  isExactRunStep(step, "pnpm test:release-workflow")
);
const ciReleasePrivacyRuns = ciLintSteps.filter(
  (step) => typeof step.run === "string" && step.run.includes("pnpm test:release-privacy")
);
const ciReleasePrivacyExact = ciReleasePrivacyRuns.filter((step) =>
  isExactRunStep(step, "pnpm test:release-privacy")
);
const ciReleasePrivacyTest = ciLintSteps.findIndex((step) =>
  isExactRunStep(step, "pnpm test:release-privacy")
);
const ciExactPublisherRuns = ciLintSteps.filter(
  (step) => typeof step.run === "string" && step.run.includes("pnpm test:exact-npm-publisher")
);
const ciExactPublisherExact = ciExactPublisherRuns.filter((step) =>
  isExactRunStep(step, "pnpm test:exact-npm-publisher")
);
const ciExactPublisherTest = ciLintSteps.findIndex((step) =>
  isExactRunStep(step, "pnpm test:exact-npm-publisher")
);
const ciGhcrOciTest = ciLintSteps.findIndex((step) => isExactRunStep(step, "pnpm test:ghcr-oci"));
const ciDockerSaveTest = ciLintSteps.findIndex((step) =>
  isExactRunStep(step, "pnpm test:docker-save")
);
if (
  parsedCiWorkflow === null ||
  parsedCiLintJob === null ||
  Object.hasOwn(parsedCiWorkflow, "defaults") ||
  Object.hasOwn(parsedCiWorkflow, "env") ||
  Object.hasOwn(parsedCiLintJob, "defaults") ||
  Object.hasOwn(parsedCiLintJob, "env") ||
  Object.hasOwn(parsedCiLintJob, "if") ||
  Object.hasOwn(parsedCiLintJob, "continue-on-error") ||
  ciReleaseWorkflowTest === -1 ||
  ciReleasePrivacyRuns.length !== 1 ||
  ciReleasePrivacyExact.length !== 1 ||
  ciReleasePrivacyTest <= ciReleaseWorkflowTest ||
  ciExactPublisherRuns.length !== 1 ||
  ciExactPublisherExact.length !== 1 ||
  ciExactPublisherTest <= ciReleasePrivacyTest ||
  ciGhcrOciTest <= ciExactPublisherTest ||
  ciDockerSaveTest <= ciGhcrOciTest
) {
  failures.push(
    "CI lint job must run exactly one unconditional run-only release privacy fixture step in order"
  );
}

if (
  !serverImageVerifier.includes('[[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]') ||
  !serverImageVerifier.includes(
    "Expected revision must be a quoted 40-character lowercase hex string"
  )
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
  "PATCHPAGE_STORAGE_DIR=/data/drafts"
]) {
  if (!selfHosting.includes(required)) {
    failures.push(`self-hosting docs must document ${required}`);
  }
}
if (!/non[- ]root/i.test(selfHosting)) {
  failures.push("self-hosting docs must document the unprivileged runtime user");
}
if (
  !/semver[^\n]*intended not to move/i.test(selfHosting) ||
  !/full\s+commit\s+SHA[^\n]*intended not to move/i.test(selfHosting) ||
  !/immutable deployment pin[^\n]*manifest digest/i.test(selfHosting)
) {
  failures.push(
    "self-hosting docs must distinguish intended fixed tags from immutable digest pins"
  );
}
if (!/stable semver[^\n]*prerelease/i.test(selfHosting)) {
  failures.push(
    "self-hosting docs must document the stable-only release policy and prerelease rejection"
  );
}
if (!/(?:moving[^\n]*`latest`|`latest`[^\n]*(?:follows|moves))/i.test(selfHosting)) {
  failures.push("self-hosting docs must distinguish the moving latest tag");
}
if (
  !/newer `latest`[^\n]*manifest digest[^\n]*config[^\n]*paired release tags/i.test(selfHosting)
) {
  failures.push(
    "self-hosting docs must explain how a newer latest tag is authenticated before it is retained"
  );
}
for (const required of [
  "GHCR Public visibility",
  "does not change package visibility",
  "anonymous GHCR smoke",
  "issue #17"
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
  failures.push(
    "README must describe the GHCR public-visibility gate without claiming live availability"
  );
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
    "actions/download-artifact"
  ]) {
    if (anonymousImageJob.includes(forbidden)) {
      failures.push(`ghcr-anonymous-smoke must not contain ${forbidden}`);
    }
  }

  const tagPull = anonymousImageJob.indexOf('pull_anonymously "$tag_image"');
  const digestPull = anonymousImageJob.indexOf('pull_anonymously "$digest_image"');
  const boot = anonymousImageJob.indexOf("docker run -d");
  const portInspect = anonymousImageJob.indexOf("docker container inspect");
  const healthRequest = anonymousImageJob.search(
    /body\s*=\s*"\$\(curl\s+-fsS\s+"http:\/\/127\.0\.0\.1:\$\{host_port\}\/healthz"[^\n]*\)"/
  );
  const exactHealth = anonymousImageJob.search(/\[\[\s*"\$body"\s*==\s*'\{"ok":true\}'\s*\]\]/);
  if (
    !anonymousImageJob.includes(
      "EXPECTED_DIGEST: ${{ needs.docker-ghcr.outputs.manifest-digest }}"
    ) ||
    !anonymousImageJob.includes(
      "EXPECTED_CONFIG_ID: ${{ needs.docker-ghcr.outputs.config-digest }}"
    ) ||
    !anonymousImageJob.includes("VERSION: ${{ needs.guard.outputs.version }}") ||
    !anonymousImageJob.includes('tag_image="${ghcr_image}:${VERSION}"') ||
    !anonymousImageJob.includes('digest_image="${ghcr_image}@${EXPECTED_DIGEST}"') ||
    tagPull === -1 ||
    digestPull <= tagPull ||
    boot <= digestPull ||
    portInspect <= boot ||
    !anonymousImageJob.slice(boot).includes('"$digest_image"') ||
    anonymousImageJob.split("require_publisher_binding").length - 1 < 3 ||
    !anonymousImageJob.includes('actual_digest" == "$EXPECTED_DIGEST"') ||
    !anonymousImageJob.includes('actual_config" == "$EXPECTED_CONFIG_ID"')
  ) {
    failures.push(
      "ghcr-anonymous-smoke must bind the semver tag and exact digest to the publisher manifest and verified config before boot"
    );
  }

  if (healthRequest <= boot || exactHealth <= healthRequest) {
    failures.push("ghcr-anonymous-smoke must obtain and require the exact live /healthz response");
  }

  if (
    !/docker_config\s*=\s*"\$\(mktemp -d\)"/.test(anonymousImageJob) ||
    !/export\s+DOCKER_CONFIG\s*=\s*"\$docker_config"/.test(anonymousImageJob) ||
    !anonymousImageJob.includes("printf '{\"auths\":{}}\\n'") ||
    !anonymousImageJob.includes("-p 127.0.0.1::3000") ||
    !anonymousImageJob.includes("Docker did not publish the server port")
  ) {
    failures.push("ghcr-anonymous-smoke must isolate anonymous Docker credentials and host port");
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
  const packageNameGuard = "            --expected-name patchpage \\";
  const basenameGuard = [
    '          if [[ "$(basename "$tarball")" != "$EXPECTED_FILENAME" ]]; then',
    '            echo "::error::The npm tarball artifact name is invalid"',
    "            exit 1",
    "          fi"
  ].join("\n");
  const shaGuard = [
    '          if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then',
    '            echo "::error::The npm tarball artifact digest is invalid"',
    "            exit 1",
    "          fi"
  ].join("\n");
  const publicationContractFailure =
    /publication step must contain the reviewed exact-publisher run/;
  let checks;
  try {
    checks = [
      {
        name: "reject build and repository verifier moved into docker-ghcr",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish or accept the release tag pair with exact OCI state, then reconcile latest",
            [
              "      - name: Rebuild inside publisher",
              "        shell: bash",
              "        run: |",
              "          docker build .",
              '          scripts/verify-server-image.sh "$image" "$VERSION" "$REVISION"',
              "      - name: Publish or accept the release tag pair with exact OCI state, then reconcile latest"
            ].join("\n")
          )
        },
        expected:
          /docker-ghcr publisher must not contain (?:docker build|scripts\/verify-server-image\.sh)/
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
              ""
            ].join("\n"),
            ""
          )
        },
        expected: /guard must check out the repository before running the exact version producer/
      },
      {
        name: "reject image artifact selected by name instead of immutable ID",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "artifact-ids: ${{ needs.verify-server-image.outputs.image-artifact-id }}",
            "name: patchpage-server-image-${{ github.run_attempt }}"
          )
        },
        expected: /docker-ghcr must download the exact raw image artifact ID/
      },
      {
        name: "reject validator moved after docker load",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          docker load --input "$tar_path"',
            [
              '          docker load --input "$tar_path"',
              '          node "$VALIDATE_DOCKER_SAVE_ARTIFACT" --artifact-dir "$RUNNER_TEMP/server-image" --expected-filename "$EXPECTED_FILENAME" --expected-sha256 "$EXPECTED_SHA256" --expected-repo-tag "$expected_local_tag" --expected-config-id "$EXPECTED_IMAGE_ID"'
            ].join("\n")
          ).replace(
            /\n          node "\$VALIDATE_DOCKER_SAVE_ARTIFACT" \\\n            --artifact-dir "\$RUNNER_TEMP\/server-image" \\\n            --expected-filename "\$EXPECTED_FILENAME" \\\n            --expected-sha256 "\$EXPECTED_SHA256" \\\n            --expected-repo-tag "\$expected_local_tag" \\\n            --expected-config-id "\$EXPECTED_IMAGE_ID"\n/,
            "\n"
          )
        },
        expected: /validate the raw tar before docker load/
      },
      {
        name: "reject missing embedded validator hash check",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "Embedded docker-save validator source hash mismatch",
            "validator hash check removed"
          )
        },
        expected: /docker-ghcr must hash-check both embedded release tools before use/
      },
      {
        name: "reject missing OCI publish command",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            'node "$GHCR_OCI_RELEASE" publish-release',
            'node "$GHCR_OCI_RELEASE" select-latest'
          )
        },
        expected:
          /publish and reconcile through OCI state|publish the validated tar through the reviewed OCI release tool/
      },
      {
        name: "reject missing latest reconciliation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            'node "$GHCR_OCI_RELEASE" reconcile-latest',
            'node "$GHCR_OCI_RELEASE" select-latest'
          )
        },
        expected: /publish and reconcile through OCI state/
      },
      {
        name: "reject adding Docker login to publisher",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Validate and load the verified server image artifact before registry auth",
            [
              "      - uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0",
              "        with:",
              "          registry: ghcr.io",
              "          username: ${{ github.repository_owner }}",
              "          password: ${{ github.token }}",
              "      - name: Validate and load the verified server image artifact before registry auth"
            ].join("\n")
          )
        },
        expected:
          /docker-ghcr publisher must not contain uses: docker\/login-action@|release\.yml must retain all 0 reviewed docker\/login-action Action uses/
      },
      {
        name: "reject numeric queue syntax",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(workflow, "  queue: max", "  queue: 100")
        },
        expected:
          /release\.yml must serialize all patchpage-server publishes in one package-wide max queue/
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
              ""
            ].join("\n"),
            ""
          )
        },
        expected: /release\.yml must serialize all patchpage-server publishes/
      },
      {
        name: "reject removed GHCR digest output",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "manifest-digest: ${{ steps.publish-image.outputs.manifest-digest }}",
            "manifest-digest-removed: true"
          )
        },
        expected: /docker-ghcr must expose the verified GHCR manifest and config digests/
      },
      {
        name: "reject removed GHCR config digest output",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "config-digest: ${{ steps.publish-image.outputs.config-digest }}",
            "config-digest-removed: true"
          )
        },
        expected: /docker-ghcr must expose the verified GHCR manifest and config digests/
      },
      {
        name: "reject release smoke skipping the anonymous semver pull",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          pull_anonymously "$tag_image"',
            '          echo "skipped anonymous semver pull"'
          )
        },
        expected: /ghcr-anonymous-smoke must bind the semver tag and exact digest/
      },
      {
        name: "reject release smoke semver retarget acceptance",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            'actual_digest" == "$EXPECTED_DIGEST"',
            '-n "$actual_digest"'
          )
        },
        expected: /ghcr-anonymous-smoke must bind the semver tag and exact digest/
      },
      {
        name: "reject release smoke config substitution",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            'actual_config" == "$EXPECTED_CONFIG_ID"',
            '-n "$actual_config"'
          )
        },
        expected: /ghcr-anonymous-smoke must bind the semver tag and exact digest/
      },
      {
        name: "reject reconcile single queue",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "  queue: max",
            "  queue: 1"
          )
        },
        expected:
          /reconcile-ghcr\.yml must be scheduled\/manual and reuse the package-wide max queue/
      },
      {
        name: "reject reconcile slicing before inspection",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "const rows = tags.map((tag) => {",
            "const rows = tags.slice(0, 1).map((tag) => {"
          )
        },
        expected: /reconcile inspect must paginate stable GitHub tags/
      },
      {
        name: "reject precision-losing reconciler semver ordering",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            'split(".").map(BigInt)',
            'split(".").map(Number)'
          )
        },
        expected:
          /reconcile inspect must paginate stable GitHub tags|reconcile-ghcr inspect must match the exact reviewed job map/
      },
      {
        name: "reject reconciling legacy image tags",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            ".filter((tag) => isSupportedImageRelease(tag.slice(1)))",
            ".filter(() => true)"
          )
        },
        expected: /reconcile inspect must paginate stable GitHub tags/
      },
      {
        name: "reject lowering the first supported image release",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            'const MINIMUM_SUPPORTED_IMAGE_VERSION = "0.1.1"',
            'const MINIMUM_SUPPORTED_IMAGE_VERSION = "0.1.0"'
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject bypassing the reviewed remote config size ceiling",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "if (configSize > MAX_CONFIG_BYTES) {",
            "if (false) {"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject reading a config without its exact descriptor size",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "expectedBytes: configSize",
            "expectedBytes: null"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject bypassing the streaming registry body reader",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "response.body?.getReader()",
            "null"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject comparing config diff IDs to compressed descriptors",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "await uncompressedLayerDigest",
            "await Promise.resolve"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject weakening the compressed layer expansion ceiling",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "const MAX_LAYER_EXPANSION_RATIO = 200",
            "const MAX_LAYER_EXPANSION_RATIO = Number.MAX_SAFE_INTEGER"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject accepting the wrong number of Moby legacy nodes",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (nodes.length !== diffIds.length)",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject accepting ambiguous Moby legacy roots",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (roots.length !== 1)",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject repositories detached from the final uncompressed diff ID",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (repositoryTags[tag] !== expectedRepositoryLayer)",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject allowing unexpected Moby V1 metadata keys",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (!allowedKeys.has(key))",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject accepting forked Moby legacy graphs",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (children.has(node.parent))",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject runtime config fields on non-leaf Moby nodes",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (!isLeaf && hasOwn(node.legacy, key))",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject dropping a stable leaf runtime projection",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            '      "Labels",\n',
            ""
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject leaf runtime projections detached from the OCI config",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "!isDeepStrictEqual(leafRuntimeConfig[key], ociRuntimeConfig[key])",
            "false"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject Moby node operating systems detached from the OCI config",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (node.legacy.os !== config.os)",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject leaf platform fields detached from the OCI config",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (hasOwn(leaf.legacy, key) && leaf.legacy[key] !== config[key])",
            "if (false)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject CI skipping validation of the actual docker-save output",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "node scripts/validate-docker-save-artifact.mjs",
            "echo skipped-docker-save-validation"
          )
        },
        expected: /CI must run the behavioral contract on its one metadata-bound image build/
      },
      {
        name: "reject CI skipping release privacy fixtures",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            "- run: echo skipped-release-privacy"
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI lint job continue-on-error",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "  lint:\n    runs-on: ubuntu-latest",
            "  lint:\n    continue-on-error: true\n    runs-on: ubuntu-latest"
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI lint job conditional",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "  lint:\n    runs-on: ubuntu-latest",
            "  lint:\n    if: always()\n    runs-on: ubuntu-latest"
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI workflow run-shell defaults",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "permissions:\n  contents: read",
            'defaults:\n  run:\n    shell: "bash {0} || true"\n\npermissions:\n  contents: read'
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI lint job run-shell defaults",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "  lint:\n    runs-on: ubuntu-latest",
            '  lint:\n    defaults:\n      run:\n        shell: "bash {0} || true"\n    runs-on: ubuntu-latest'
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI workflow ambient mutation-skip environment",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "permissions:\n  contents: read",
            'env:\n  PATCHPAGE_RELEASE_WORKFLOW_SKIP_MUTATION_CHECKS: "1"\n\npermissions:\n  contents: read'
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI lint job ambient mutation-skip environment",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "  lint:\n    runs-on: ubuntu-latest",
            '  lint:\n    env:\n      PATCHPAGE_RELEASE_WORKFLOW_SKIP_MUTATION_CHECKS: "1"\n    runs-on: ubuntu-latest'
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI release privacy suffix",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            '- run: "pnpm test:release-privacy || true"'
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI release privacy comment suffix",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            '- run: "pnpm test:release-privacy # comment"'
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI release privacy shell key",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            "- run: pnpm test:release-privacy\n        shell: bash"
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI release privacy continue-on-error",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            "- run: pnpm test:release-privacy\n        continue-on-error: true"
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI release privacy conditional",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            "- if: always()\n        run: pnpm test:release-privacy"
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI duplicate near-match release privacy fixtures",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            '- run: pnpm test:release-privacy\n      - run: "pnpm test:release-privacy || true"'
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject CI duplicate release privacy fixtures",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "- run: pnpm test:release-privacy",
            "- run: pnpm test:release-privacy\n      - run: pnpm test:release-privacy"
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject stopping inspection after the bounded repair batch",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "                  needed_count=$((needed_count + 1))\n                fi",
            "                  needed_count=$((needed_count + 1))\n                  break\n                fi"
          )
        },
        expected: /reconcile inspect must paginate stable GitHub tags/
      },
      {
        name: "reject latest reconciliation for a pre-support empty schedule",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "      needs.inspect.outputs.complete-count != '0'))",
            "      true))"
          )
        },
        expected: /reconcile latest must run checkout-free/
      },
      {
        name: "reject skipping zero-repair result binding and anonymous acceptance",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "  bind-publish-results:\n    if: >-\n      always() &&",
            "  bind-publish-results:\n    if: >-\n      needs.inspect.outputs.count != '0' &&"
          )
        },
        expected: /reconcile result binder must accept every complete snapshot row/
      },
      {
        name: "reject result binding after an aggregate publisher failure",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            [
              "  bind-publish-results:",
              "    if: >-",
              "      always() &&",
              "      needs.inspect.result == 'success' &&",
              "      (needs.publish-ghcr.result == 'success' ||"
            ].join("\n"),
            [
              "  bind-publish-results:",
              "    if: >-",
              "      always() &&",
              "      needs.inspect.result == 'success' &&",
              "      (needs.publish-ghcr.result == 'failure' ||"
            ].join("\n")
          )
        },
        expected: /reconcile result binder must accept every complete snapshot row/
      },
      {
        name: "reject dropping a prior successful row from the inspect snapshot",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            '                source: "snapshot",',
            '                source: "disabled-snapshot",'
          )
        },
        expected: /reconcile result binder must accept every complete snapshot row/
      },
      {
        name: "reject selecting an unrelated stale publication result artifact",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            ".filter((artifact) => artifact.name === name && !artifact.expired)",
            '.filter((artifact) => artifact.name.startsWith("reconcile-publish-result-") && !artifact.expired)'
          )
        },
        expected: /reconcile result binder must accept every complete snapshot row/
      },
      {
        name: "reject selecting an older exact publication result artifact",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "artifactId: matches[0].id",
            "artifactId: matches.at(-1).id"
          )
        },
        expected: /reconcile result binder must accept every complete snapshot row/
      },
      {
        name: "reject anonymous acceptance bypass for complete snapshot rows",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            'if (source === "snapshot")',
            'if (source === "disabled-snapshot")'
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject anonymous publication result selected by mutable name",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "artifact-ids: ${{ matrix.artifactId }}",
            "name: reconcile-publish-result-${{ matrix.version }}-${{ matrix.revision }}.json"
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject credentials in anonymous reconciliation acceptance",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            [
              "      - name: Pull both bound release tags anonymously, then boot the exact digest",
              "        shell: bash",
              "        env:"
            ].join("\n"),
            [
              "      - name: Pull both bound release tags anonymously, then boot the exact digest",
              "        shell: bash",
              "        env:",
              "          GITHUB_TOKEN: ${{ github.token }}"
            ].join("\n")
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject missing anonymous reconciliation semver pull",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            '          pull_anonymously "$semver_image"',
            '          echo "skipped anonymous semver pull"'
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject missing anonymous reconciliation full-SHA pull",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            '          pull_anonymously "$revision_image"',
            '          echo "skipped anonymous revision pull"'
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject anonymous reconciliation tag retarget race",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            'actual_digest" == "$EXPECTED_MANIFEST_DIGEST"',
            '-n "$actual_digest"'
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject anonymous reconciliation config substitution",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            'actual_config" == "$EXPECTED_CONFIG_DIGEST"',
            '-n "$actual_config"'
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject mutable registry reselection in anonymous reconciliation",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            '          pull_anonymously "$semver_image"',
            [
              '          node "$GHCR_OCI_RELEASE" inspect-release',
              '          pull_anonymously "$semver_image"'
            ].join("\n")
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject inexact anonymous reconciliation health",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            `            if [[ "$body" == '{"ok":true}' ]]; then`,
            '            if [[ -n "$body" ]]; then'
          )
        },
        expected: /anonymous reconciliation acceptance must consume either/
      },
      {
        name: "reject reconcile handoff selected by artifact name",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "          artifact-ids: ${{ steps.handoff-artifact.outputs.artifact-id }}",
            "          name: reconcile-handoff-${{ matrix.version }}-${{ github.run_attempt }}"
          )
        },
        expected: /reconcile publisher must be checkout-free packages:write only/
      },
      {
        name: "reject reconcile zip wrapper extraction",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "      - name: Validate and load replay image before registry auth",
            [
              "      - name: Extract image artifact wrapper",
              "        run: |",
              '          gh api "/repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip" --output "$RUNNER_TEMP/raw-artifact.zip"',
              '          unzip -q "$RUNNER_TEMP/raw-artifact.zip" -d "$RUNNER_TEMP/server-image"',
              "      - name: Validate and load replay image before registry auth"
            ].join("\n")
          )
        },
        expected: /reconcile publisher must be checkout-free packages:write only/
      },
      {
        name: "reject mutable reconciler Action coordinate",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
            "uses: actions/checkout@main # v7.0.1"
          )
        },
        expected: /reconcile-ghcr\.yml:\d+ must pin actions\/checkout to a full commit SHA/
      },
      {
        name: "reject reconciler YAML anchor",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "permissions: {}",
            "permissions: &shared {}"
          )
        },
        expected: /reconcile-ghcr\.yml must not use YAML anchors/
      },
      {
        name: "reject reconciler custom YAML tag",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "permissions: {}",
            "permissions: !!omap []"
          )
        },
        expected: /reconcile-ghcr\.yml must not use YAML anchors.*explicit tags are forbidden/
      },
      {
        name: "reject reconciler duplicate root key",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "permissions: {}\n\nconcurrency:",
            "permissions: {}\npermissions: {}\n\nconcurrency:"
          )
        },
        expected: /reconcile-ghcr\.yml must be valid YAML with unique map keys/
      },
      {
        name: "reject reconciler root environment",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "\njobs:\n",
            "\nenv:\n  NODE_OPTIONS: attacker\n\njobs:\n"
          )
        },
        expected: /reconcile-ghcr\.yml root must contain exactly the reviewed triggers/
      },
      {
        name: "reject privileged run added to reconciler publisher",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "      - name: Resolve replay handoff artifact ID",
            "      - name: Attacker package step\n        run: echo attacker\n      - name: Resolve replay handoff artifact ID"
          )
        },
        expected: /reconcile-ghcr publish-ghcr must match the exact reviewed job map/
      },
      {
        name: "reject reconciler publisher permission elevation",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "    permissions:\n      actions: read\n      packages: write",
            "    permissions:\n      actions: read\n      packages: write\n      id-token: write"
          )
        },
        expected: /reconcile-ghcr publish-ghcr must match the exact reviewed job map/
      },
      {
        name: "reject missing explicit first-package probe in release publisher",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "--allow-first-package true",
            "--first-package-probe-disabled true"
          )
        },
        expected: /docker-ghcr must publish the validated tar through the reviewed OCI release tool/
      },
      {
        name: "reject historical checkout replacing detached source worktree",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            'git worktree add --detach "$source_dir" "$REVISION"',
            'git checkout "$TAG"'
          )
        },
        expected: /reconcile rebuild must use current reviewed verifiers/
      },
      {
        name: "reject unvalidated reconciliation rebuild tar",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "node scripts/validate-docker-save-artifact.mjs",
            "echo skipped-current-docker-save-validator"
          )
        },
        expected: /reconcile rebuild must use current reviewed verifiers/
      },
      {
        name: "reject configured name for unarchived reconciliation handoff",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "          path: ${{ runner.temp }}/reconcile-handoff-${{ matrix.version }}.json",
            "          name: reconcile-handoff-${{ matrix.version }}\n          path: ${{ runner.temp }}/reconcile-handoff-${{ matrix.version }}.json"
          )
        },
        expected: /reconcile rebuild must use current reviewed verifiers/
      },
      {
        name: "reject attempt-scoped reconciliation handoff lookup",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            'handoff_name="reconcile-handoff-${{ matrix.version }}.json"',
            'handoff_name="reconcile-handoff-${{ matrix.version }}-${{ github.run_attempt }}.json"'
          )
        },
        expected: /reconcile publisher must be checkout-free packages:write only/
      },
      {
        name: "reject reconciliation handoff extra-entry bypass",
        env: {
          PATCHPAGE_RECONCILE_WORKFLOW_SOURCE: replaceOnce(
            reconcileWorkflow,
            "if (entries.length !== 1)",
            "if (entries.length < 1)"
          )
        },
        expected: /reconcile publisher must be checkout-free packages:write only/
      },
      {
        name: "reject CAS header claims in publisher",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            'node "$GHCR_OCI_RELEASE" publish-release',
            [
              'curl -H "If-Match: ${EXPECTED_IMAGE_ID}" https://ghcr.io/v2/',
              'node "$GHCR_OCI_RELEASE" publish-release'
            ].join("\n")
          )
        },
        expected: /docker-ghcr publisher must not contain If-Match/
      },
      {
        name: "reject missing exact OCI error target binding",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "return error.code === expectedCode && detailMatchesTarget(error.detail, target);",
            "return error.code === expectedCode;"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject accepting a non-OCI registry manifest",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "if (responseMediaType !== OCI_MANIFEST_MEDIA_TYPE)",
            "if (!responseMediaType)"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject accepting a non-OCI Docker-save manifest",
        env: {
          PATCHPAGE_DOCKER_SAVE_VALIDATOR_SOURCE: replaceOnce(
            effectiveDockerSaveValidator.toString("utf8"),
            "if (descriptor?.mediaType !== OCI_MANIFEST_MEDIA_TYPE)",
            "if (!descriptor?.mediaType)"
          )
        },
        expected:
          /validate-docker-save-artifact\.mjs must retain the structural docker-save graph validator/
      },
      {
        name: "reject precision-losing OCI semver ordering",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "leftMatch.slice(1).map(BigInt)",
            "leftMatch.slice(1).map(Number)"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject missing manifest PUT status binding",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "response.status !== 201",
            "!response.ok"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject bypassing latest final reinspection",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "post-write latest and re-enumerated highest complete release",
            "post-write latest"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject bypassing release-pair final reinspection",
        env: {
          PATCHPAGE_GHCR_OCI_RELEASE_SOURCE: replaceOnce(
            effectiveGhcrOciReleaseTool.toString("utf8"),
            "post-write release pair and canonical image",
            "post-write release pair"
          )
        },
        expected: /ghcr-oci-release\.mjs must implement exact digest-bound OCI reads/
      },
      {
        name: "reject unquoted CI revision",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            'REVISION: "0000000000000000000000000000000000000000"',
            "REVISION: 0000000000000000000000000000000000000000"
          )
        },
        expected: /CI must use deterministic string image version and quoted revision metadata/
      },
      {
        name: "reject identity guard after false AND continuation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          false &&\n${packageNameGuard}`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject identity guard after backslash OR continuation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          true \\\n            ||\n${packageNameGuard}`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject identity guard after pipeline continuation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          true |\n${packageNameGuard}`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject identity guard rendered as multiline quoted text",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          : '\n${packageNameGuard}\n          '`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject identity guard rendered as escaped heredoc data",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          cat <<\\EOF\n${packageNameGuard}\n          EOF`
          )
        },
        expected: publicationContractFailure
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
              "          SECOND"
            ].join("\n")
          )
        },
        expected: publicationContractFailure
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
              "          esac"
            ].join("\n")
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject basename guard nested under false",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            basenameGuard,
            `          if false; then\n${basenameGuard}\n          fi`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject digest guard nested under false",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            shaGuard,
            `          if false; then\n${shaGuard}\n          fi`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject package name reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            packageNameGuard,
            `          expected_name="patchpage"\n${packageNameGuard}`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject package version reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '            --expected-version "$EXPECTED_VERSION" \\',
            '            --expected-version "$EXPECTED_VERSION" || true \\'
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject expected filename reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            basenameGuard,
            `          EXPECTED_FILENAME="$(basename "$tarball")"\n${basenameGuard}`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject expected digest reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            shaGuard,
            `          EXPECTED_SHA256="$actual_sha256"\n${shaGuard}`
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject expected package version reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '            --expected-version "$EXPECTED_VERSION" \\',
            '            --expected-version "$EXPECTED_VERSION" || false \\'
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject expected npm version reassignment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          if [[ "$actual_npm_version" != "$EXPECTED_NPM_VERSION" ]]; then',
            '          EXPECTED_NPM_VERSION="$actual_npm_version"\n          if [[ "$actual_npm_version" != "$EXPECTED_NPM_VERSION" ]]; then'
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject disabled publication step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm\n        shell: bash",
            "      - name: Publish the verified tarball to npm\n        if: false\n        shell: bash"
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject continue-on-error publication step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm\n        shell: bash",
            "      - name: Publish the verified tarball to npm\n        continue-on-error: true\n        shell: bash"
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject extra publication step keys",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm\n        shell: bash",
            "      - name: Publish the verified tarball to npm\n        timeout-minutes: 1\n        shell: bash"
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject unreviewed Action behind quoted uses key",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - id: version",
            '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - "uses": attacker/action@main # v1.0.0\n      - id: version'
          )
        },
        expected: /uses unreviewed Action attacker\/action/
      },
      {
        name: "reject unreviewed Action behind alias mapping key",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            replaceOnce(workflow, "name: Release\n", "name: Release\nx-uses-key: &uses_key uses\n"),
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - id: version",
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - *uses_key : attacker/action@main # v1.0.0\n      - id: version"
          )
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/
      },
      {
        name: "reject unreviewed Action behind alias value",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            replaceOnce(
              workflow,
              "name: Release\n",
              "name: Release\nx-attacker-action: &attacker_action attacker/action@main\n"
            ),
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - id: version",
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: *attacker_action # v1.0.0\n      - id: version"
          )
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/
      },
      {
        name: "reject unreviewed Action behind merged step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            replaceOnce(
              workflow,
              "name: Release\n",
              "name: Release\nx-attacker-step: &attacker_step\n  uses: attacker/action@main\n"
            ),
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - id: version",
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - <<: *attacker_step\n      - id: version"
          )
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/
      },
      {
        name: "reject guard output producer rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      version: ${{ steps.version.outputs.version }}",
            "      version: ${{ steps.attacker.outputs.version }}"
          )
        },
        expected: /guard outputs must bind exactly to the version producer/
      },
      {
        name: "reject guard producer ID rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - id: version",
            "      - id: attacker"
          )
        },
        expected: /guard version producer step must exist exactly once/
      },
      {
        name: "reject guard producer run changes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "revision=$revision" >> "$GITHUB_OUTPUT"',
            '          echo "revision=$revision" >> "$GITHUB_OUTPUT"\n          : changed'
          )
        },
        expected: /guard must check out the repository before running the exact version producer/
      },
      {
        name: "reject package filename output rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      tarball-filename: ${{ steps.package.outputs.filename }}",
            "      tarball-filename: ${{ steps.attacker.outputs.filename }}"
          )
        },
        expected: /verify outputs must bind to the exact package and artifact producers/
      },
      {
        name: "reject package digest output rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      tarball-sha256: ${{ steps.package.outputs.sha256 }}",
            "      tarball-sha256: ${{ steps.attacker.outputs.sha256 }}"
          )
        },
        expected: /verify outputs must bind to the exact package and artifact producers/
      },
      {
        name: "reject package producer run changes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "sha256=$(sha256sum "$tarball" | awk \'{print $1}\')" >> "$GITHUB_OUTPUT"',
            '          echo "sha256=$(sha256sum "$tarball" | awk \'{print $1}\')" >> "$GITHUB_OUTPUT"\n          : changed'
          )
        },
        expected: /verify outputs must bind to the exact package and artifact producers/
      },
      {
        name: "reject pre-gate npm pack path logging",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '            console.error(`Missing reviewed required npm pack files (${missing.length}): ${missing.join(", ")}`);',
            [
              '            console.error(`Missing reviewed required npm pack files (${missing.length}): ${missing.join(", ")}`);',
              '            console.error(pack.files.map((file) => file.path).join("\\n"));'
            ].join("\n")
          )
        },
        expected: /package producer must not log npm pack file paths before the privacy gate/
      },
      {
        name: "reject release privacy gate removal",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          node ../../scripts/verify-release-privacy.mjs \\\n            --pack-json "$RUNNER_TEMP/patchpage-pack.json" \\\n            --tarball "$tarball"',
            "          : privacy gate disabled"
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject release privacy gate before renamed tarball binding",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          mv -- "$tarball" "$unique_tarball"\n          tarball="$unique_tarball"\n\n          node ../../scripts/verify-release-privacy.mjs \\\n            --pack-json "$RUNNER_TEMP/patchpage-pack.json" \\\n            --tarball "$tarball"',
            '          mv -- "$tarball" "$unique_tarball"\n          node ../../scripts/verify-release-privacy.mjs \\\n            --pack-json "$RUNNER_TEMP/patchpage-pack.json" \\\n            --tarball "$tarball"\n          tarball="$unique_tarball"'
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject release privacy gate tarball rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '            --tarball "$tarball"',
            '            --tarball "$reported_tarball"'
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject release privacy gate suffix",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          node ../../scripts/verify-release-privacy.mjs \\",
            "          node ../../scripts/verify-release-privacy.mjs \\ || true"
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject release privacy gate commented duplicate",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          node ../../scripts/verify-release-privacy.mjs \\",
            "          # node ../../scripts/verify-release-privacy.mjs \\\n          node ../../scripts/verify-release-privacy.mjs \\"
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject release privacy gate step continue-on-error",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Pack exactly one release tarball and verify contents\n        id: package\n        shell: bash\n        run: |",
            "      - name: Pack exactly one release tarball and verify contents\n        id: package\n        shell: bash\n        continue-on-error: true\n        run: |"
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject verify job continue-on-error around release privacy gate",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  verify:\n    needs: [guard, prepare-npm]\n    runs-on: ubuntu-latest",
            "  verify:\n    needs: [guard, prepare-npm]\n    continue-on-error: true\n    runs-on: ubuntu-latest"
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject verify job conditional around release privacy gate",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  verify:\n    needs: [guard, prepare-npm]\n    runs-on: ubuntu-latest",
            "  verify:\n    needs: [guard, prepare-npm]\n    if: always()\n    runs-on: ubuntu-latest"
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject release privacy gate conditional wrapper",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          node ../../scripts/verify-release-privacy.mjs \\",
            "          if node ../../scripts/verify-release-privacy.mjs \\"
          )
        },
        expected:
          /verify must run the release privacy gate against the exact pack JSON and renamed tarball before smoke and upload/
      },
      {
        name: "reject later GITHUB_ENV writes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Rebind package environment\n        shell: bash\n        run: echo "TARBALL=/tmp/attacker.tgz" >> "$GITHUB_ENV"\n      - name: Upload the exact tested tarball'
          )
        },
        expected:
          /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/
      },
      {
        name: "reject later GITHUB_OUTPUT writes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Add later output\n        id: later\n        shell: bash\n        run: echo "sha256=attacker" >> "$GITHUB_OUTPUT"\n      - name: Upload the exact tested tarball'
          )
        },
        expected:
          /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/
      },
      {
        name: "reject later GITHUB_ENV redirection",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Redirect package environment\n        shell: bash\n        run: printf "%s\\n" "TARBALL=/tmp/attacker.tgz" > "${GITHUB_ENV}"\n      - name: Upload the exact tested tarball'
          )
        },
        expected:
          /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/
      },
      {
        name: "reject later GITHUB_OUTPUT redirection",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the exact tested tarball",
            '      - name: Redirect later output\n        id: later\n        shell: bash\n        run: printf "%s\\n" "sha256=attacker" > "${GITHUB_OUTPUT}"\n      - name: Upload the exact tested tarball'
          )
        },
        expected:
          /verify may write GITHUB_ENV and GITHUB_OUTPUT only at the reviewed producer lines/
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
              "jobs:"
            ].join("\n") + "\n"
          )
        },
        expected:
          /release\.yml must not use YAML anchors, aliases, merge keys, or non-scalar mapping keys/
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
              "  guard:"
            ].join("\n") + "\n"
          )
        },
        expected: /release\.yml must contain exactly the reviewed release jobs/
      },
      {
        name: "reject npm CLI replacement after producer output",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "version=$actual_version" >> "$GITHUB_OUTPUT"',
            '          echo "version=$actual_version" >> "$GITHUB_OUTPUT"\n          printf "%s\\n" "#!/usr/bin/env node" "console.log(\\"$EXPECTED_NPM_VERSION\\")" > "$npm_cli_dir/bin/npm-cli.js"'
          )
        },
        expected:
          /prepare-npm must fetch, verify, and output the exact reviewed npm CLI before upload/
      },
      {
        name: "reject executable step between npm CLI producer and upload",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Upload the reviewed npm CLI",
            '      - name: Replace reviewed npm CLI\n        shell: bash\n        run: echo attacker > "$RUNNER_TEMP/npm-cli/bin/npm-cli.js"\n      - name: Upload the reviewed npm CLI'
          )
        },
        expected: /prepare-npm must contain exactly the reviewed job map and ordered steps/
      },
      {
        name: "reject npm CLI replacement after verify-side version check",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          echo "NPM_CLI=$NPM_CLI" >> "$GITHUB_ENV"',
            '          echo "NPM_CLI=$NPM_CLI" >> "$GITHUB_ENV"\n          echo attacker > "$NPM_CLI"'
          )
        },
        expected: /verify must bind and validate the exact isolated npm CLI/
      },
      {
        name: "reject disabled minimum-Node smoke step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash",
            "      - name: Install and run tarball on minimum supported Node\n        if: false\n        shell: bash"
          )
        },
        expected:
          /verify must run the exact tarball smoke contract on the minimum supported Node 22/
      },
      {
        name: "reject continue-on-error minimum-Node smoke step",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash",
            "      - name: Install and run tarball on minimum supported Node\n        continue-on-error: true\n        shell: bash"
          )
        },
        expected:
          /verify must run the exact tarball smoke contract on the minimum supported Node 22/
      },
      {
        name: "reject changed minimum supported Node",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          node-version: 22\n      - name: Install and run tarball on minimum supported Node",
            "          node-version: 23\n      - name: Install and run tarball on minimum supported Node"
          )
        },
        expected:
          /verify must run the exact tarball smoke contract on the minimum supported Node 22/
      },
      {
        name: "reject minimum-Node smoke run changes",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash\n        env:\n          EXPECTED_TARBALL_SHA256: ${{ steps.package.outputs.sha256 }}\n        run: |\n          set -euo pipefail",
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash\n        env:\n          EXPECTED_TARBALL_SHA256: ${{ steps.package.outputs.sha256 }}\n        run: |\n          set -euo pipefail\n          : changed"
          )
        },
        expected:
          /verify must run the exact tarball smoke contract on the minimum supported Node 22/
      },
      {
        name: "reject minimum-Node smoke environment rebind",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          EXPECTED_TARBALL_SHA256: ${{ steps.package.outputs.sha256 }}",
            "          EXPECTED_TARBALL_SHA256: attacker"
          )
        },
        expected:
          /verify must run the exact tarball smoke contract on the minimum supported Node 22/
      },
      {
        name: "reject extra minimum-Node smoke key",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Install and run tarball on minimum supported Node\n        shell: bash",
            "      - name: Install and run tarball on minimum supported Node\n        timeout-minutes: 1\n        shell: bash"
          )
        },
        expected:
          /verify must run the exact tarball smoke contract on the minimum supported Node 22/
      },
      {
        name: "reject dist rewrite before package producer",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Pack exactly one release tarball and verify contents",
            "      - name: Rewrite built CLI\n        shell: bash\n        run: echo attacker > packages/cli/dist/index.js\n      - name: Pack exactly one release tarball and verify contents"
          )
        },
        expected:
          /verify must contain exactly the reviewed job map and ordered build and smoke steps/
      },
      {
        name: "reject executable step between publication downloads and publish",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Publish the verified tarball to npm",
            '      - name: Replace publishing CLI\n        shell: bash\n        run: echo attacker > "$RUNNER_TEMP/npm-cli/bin/npm-cli.js"\n      - name: Publish the verified tarball to npm'
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject executable step after publication",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "\n  github-release:",
            "\n      - name: Run after npm publication\n        shell: bash\n        run: echo attacker\n\n  github-release:"
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject prepare-npm container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  prepare-npm:\n    runs-on: ubuntu-latest",
            "  prepare-npm:\n    runs-on: ubuntu-latest\n    container: attacker/image:latest"
          )
        },
        expected: /prepare-npm must contain exactly the reviewed job map and ordered steps/
      },
      {
        name: "reject verify container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  verify:\n    needs: [guard, prepare-npm]\n    runs-on: ubuntu-latest",
            "  verify:\n    needs: [guard, prepare-npm]\n    runs-on: ubuntu-latest\n    container: attacker/image:latest"
          )
        },
        expected:
          /verify must contain exactly the reviewed job map and ordered build and smoke steps/
      },
      {
        name: "reject publish-npm container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    container: attacker/image:latest"
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject publish-npm services",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    services:\n      attacker:\n        image: attacker/image:latest"
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject conditional publish-npm job",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    if: false"
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject publish-npm strategy",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        attacker: [true]"
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject publish-npm job environment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest",
            "  publish-npm:\n    needs: [guard, prepare-npm, verify]\n    runs-on: ubuntu-latest\n    env:\n      NODE_OPTIONS: attacker"
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject privileged run added to github-release",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Create GitHub release",
            "      - name: Attacker release step\n        shell: bash\n        run: echo attacker\n      - name: Create GitHub release"
          )
        },
        expected:
          /github-release must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject github-release permission elevation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write",
            '  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n      "id-token": write\n      packages: write'
          )
        },
        expected:
          /github-release must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject github-release container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest",
            "  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    container: attacker/image:latest"
          )
        },
        expected:
          /github-release must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject github-release services",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest",
            "  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    services:\n      attacker:\n        image: attacker/image:latest"
          )
        },
        expected:
          /github-release must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject privileged run added to docker-ghcr",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Download the immutable verified server image artifact",
            "      - name: Attacker package step\n        shell: bash\n        run: echo attacker\n      - name: Download the immutable verified server image artifact"
          )
        },
        expected:
          /docker-ghcr must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject docker-ghcr quoted permission elevation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  docker-ghcr:\n    name: Publish verified server image to GHCR (no checkout)\n    needs: [guard, publish-npm, verify-server-image]\n    runs-on: ubuntu-latest\n    permissions:\n      packages: write",
            '  docker-ghcr:\n    name: Publish verified server image to GHCR (no checkout)\n    needs: [guard, publish-npm, verify-server-image]\n    runs-on: ubuntu-latest\n    permissions:\n      packages: write\n      "id-token": write'
          )
        },
        expected:
          /docker-ghcr must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject docker-ghcr container",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  docker-ghcr:\n    name: Publish verified server image to GHCR (no checkout)\n    needs: [guard, publish-npm, verify-server-image]\n    runs-on: ubuntu-latest",
            "  docker-ghcr:\n    name: Publish verified server image to GHCR (no checkout)\n    needs: [guard, publish-npm, verify-server-image]\n    runs-on: ubuntu-latest\n    container: attacker/image:latest"
          )
        },
        expected:
          /docker-ghcr must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject docker-ghcr services",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  docker-ghcr:\n    name: Publish verified server image to GHCR (no checkout)\n    needs: [guard, publish-npm, verify-server-image]\n    runs-on: ubuntu-latest",
            "  docker-ghcr:\n    name: Publish verified server image to GHCR (no checkout)\n    needs: [guard, publish-npm, verify-server-image]\n    runs-on: ubuntu-latest\n    services:\n      attacker:\n        image: attacker/image:latest"
          )
        },
        expected:
          /docker-ghcr must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject verify-server-image quoted permission elevation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  verify-server-image:\n    name: Build and verify server image without registry credentials\n    needs: guard\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read",
            '  verify-server-image:\n    name: Build and verify server image without registry credentials\n    needs: guard\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      "id-token": write'
          )
        },
        expected:
          /verify-server-image must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject guard permission elevation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  guard:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read",
            "  guard:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write"
          )
        },
        expected: /guard must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject anonymous smoke permission elevation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  ghcr-anonymous-smoke:\n    name: Anonymous GHCR public-visibility gate (manual visibility required)\n    needs: [guard, docker-ghcr]\n    runs-on: ubuntu-latest\n    permissions: {}",
            "  ghcr-anonymous-smoke:\n    name: Anonymous GHCR public-visibility gate (manual visibility required)\n    needs: [guard, docker-ghcr]\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write"
          )
        },
        expected:
          /ghcr-anonymous-smoke must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject npx smoke permission elevation",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  npx-smoke:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions: {}",
            "  npx-smoke:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write"
          )
        },
        expected: /npx-smoke must match the exact reviewed job map, permissions, and ordered steps/
      },
      {
        name: "reject top-level NODE_OPTIONS environment",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "permissions: {}\n\nconcurrency:",
            "permissions: {}\nenv:\n  NODE_OPTIONS: --require=/tmp/attacker.cjs\n\nconcurrency:"
          )
        },
        expected:
          /release\.yml root must contain exactly the reviewed trigger, permissions, concurrency, and jobs/
      },
      {
        name: "reject top-level run defaults",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "permissions: {}\n\nconcurrency:",
            "permissions: {}\ndefaults:\n  run:\n    shell: bash -c attacker\n    working-directory: /tmp\n\nconcurrency:"
          )
        },
        expected:
          /release\.yml root must contain exactly the reviewed trigger, permissions, concurrency, and jobs/
      },
      {
        name: "reject ordered-map permissions",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  ghcr-anonymous-smoke:\n    name: Anonymous GHCR public-visibility gate (manual visibility required)\n    needs: [guard, docker-ghcr]\n    runs-on: ubuntu-latest\n    permissions: {}",
            '  ghcr-anonymous-smoke:\n    name: Anonymous GHCR public-visibility gate (manual visibility required)\n    needs: [guard, docker-ghcr]\n    runs-on: ubuntu-latest\n    permissions: !!omap [ { "id-token": write } ]'
          )
        },
        expected: /explicit tags are forbidden/
      },
      {
        name: "reject pairs root permissions",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "permissions: {}\n\nconcurrency:",
            "permissions: !!pairs [ { id-token: write } ]\n\nconcurrency:"
          )
        },
        expected: /explicit tags are forbidden/
      },
      {
        name: "reject set permissions",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  npx-smoke:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions: {}",
            "  npx-smoke:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions: !!set { id-token: null }"
          )
        },
        expected: /explicit tags are forbidden/
      },
      {
        name: "reject custom tag on root map",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "name: Release",
            "--- !attacker\nname: Release"
          )
        },
        expected: /explicit tags are forbidden/
      },
      {
        name: "reject custom tag on job map",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  github-release:\n",
            "  github-release: !attacker\n"
          )
        },
        expected: /explicit tags are forbidden/
      },
      {
        name: "reject direct npm tarball publishing",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          node "$publisher" \\',
            '          node "$npm_cli_dir/bin/npm-cli.js" publish "$tarball" \\'
          )
        },
        expected: /must not directly publish a tarball or directory with npm/
      },
      {
        name: "reject relative tarball publishing workaround",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '            --tarball "$tarball" \\',
            '            --tarball "./patchpage.tgz" \\'
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject directory repacking in npm publisher",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          node "$publisher" \\',
            '          cd "$RUNNER_TEMP/repack" && npm publish . \\'
          )
        },
        expected:
          /must not (?:directly publish a tarball or directory with npm|repack or use a relative-path publishing workaround)/
      },
      {
        name: "reject repository checkout in npm publisher",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "      - name: Download the exact tested tarball",
            "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - name: Download the exact tested tarball"
          )
        },
        expected:
          /publish-npm must contain exactly the reviewed privileged job map and ordered publication steps/
      },
      {
        name: "reject exact publisher artifact omission",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            [
              "      - name: Download the exact npm publisher",
              "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
              "        with:",
              "          artifact-ids: ${{ needs.verify.outputs.publisher-artifact-id }}",
              "          path: ${{ runner.temp }}/npm-publisher",
              "          skip-decompress: true",
              ""
            ].join("\n"),
            ""
          )
        },
        expected:
          /exact npm publisher step must exist exactly once|must contain exactly the reviewed privileged job map/
      },
      {
        name: "reject exact publisher artifact substitution",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "          artifact-ids: ${{ needs.verify.outputs.publisher-artifact-id }}",
            "          artifact-ids: ${{ needs.verify.outputs.package-artifact-id }}"
          )
        },
        expected: /must download the exact raw npm publisher artifact by ID/
      },
      {
        name: "reject exact publisher digest bypass",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            '          if [[ "$actual_publisher_sha256" != "$EXPECTED_PUBLISHER_SHA256" ]]; then',
            '          EXPECTED_PUBLISHER_SHA256="$actual_publisher_sha256"\n          if [[ "$actual_publisher_sha256" != "$EXPECTED_PUBLISHER_SHA256" ]]; then'
          )
        },
        expected: publicationContractFailure
      },
      {
        name: "reject sensitive exact publisher diagnostics",
        env: {
          PATCHPAGE_EXACT_NPM_PUBLISHER_SOURCE: replaceOnce(
            exactNpmPublisher,
            "async function main() {",
            'async function main() {\n  console.error("metadata");'
          )
        },
        expected: /exact npm publisher diagnostics must remain category-only/
      },
      {
        name: "reject missing final registry metadata validation",
        env: {
          PATCHPAGE_EXACT_NPM_PUBLISHER_SOURCE: replaceOnce(
            exactNpmPublisher,
            "  if (result.status === 200) validateRegistryManifest(result.metadata, expected);",
            "  if (result.status === 200) void result.metadata;"
          )
        },
        expected:
          /exact npm publisher must retain artifact, OIDC, metadata, and provenance validation/
      },
      {
        name: "reject missing registry provenance validation",
        env: {
          PATCHPAGE_EXACT_NPM_PUBLISHER_SOURCE: replaceOnce(
            exactNpmPublisher,
            '  if (!hasProvenance(metadata)) fail("registry-provenance");',
            "  void metadata.dist;"
          )
        },
        expected:
          /exact npm publisher must retain artifact, OIDC, metadata, and provenance validation/
      },
      {
        name: "reject missing registry request timeout",
        env: {
          PATCHPAGE_EXACT_NPM_PUBLISHER_SOURCE: replaceOnce(
            exactNpmPublisher,
            "signal: AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS)",
            "signal: undefined"
          )
        },
        expected:
          /exact npm publisher must retain artifact, OIDC, metadata, and provenance validation/
      },
      {
        name: "reject missing latest tag high-water guard",
        env: {
          PATCHPAGE_EXACT_NPM_PUBLISHER_SOURCE: replaceOnce(
            exactNpmPublisher,
            "  await enforceLatestTagHighWaterMark(",
            "  await Promise.resolve("
          )
        },
        expected:
          /exact npm publisher must retain artifact, OIDC, metadata, and provenance validation/
      },
      {
        name: "reject unbounded postpublish polling substitution",
        env: {
          PATCHPAGE_EXACT_NPM_PUBLISHER_SOURCE: replaceOnce(
            exactNpmPublisher,
            "  for (let attempt = 0; attempt < POSTPUBLISH_MAX_ATTEMPTS; attempt += 1) {",
            "  for (let attempt = 0; ; attempt += 1) {"
          )
        },
        expected:
          /exact npm publisher must retain artifact, OIDC, metadata, and provenance validation/
      },
      {
        name: "reject exact publisher CI omission",
        env: {
          PATCHPAGE_RELEASE_CI_WORKFLOW_SOURCE: replaceOnce(
            ciWorkflow,
            "      - run: pnpm test:exact-npm-publisher\n",
            ""
          )
        },
        expected:
          /CI lint job must run exactly one unconditional run-only release privacy fixture step in order/
      },
      {
        name: "reject custom tag on step map",
        env: {
          PATCHPAGE_RELEASE_WORKFLOW_SOURCE: replaceOnce(
            workflow,
            "  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
            "  github-release:\n    needs: publish-npm\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - !attacker\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"
          )
        },
        expected: /explicit tags are forbidden/
      }
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
        PATCHPAGE_RELEASE_WORKFLOW_SKIP_MUTATION_CHECKS: "1"
      }
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status === 0) {
      mutationFailures.push(`${check.name}: mutated workflow was accepted`);
      continue;
    }
    if (!check.expected.test(output)) {
      mutationFailures.push(
        `${check.name}: expected failure was not reported; saw ${output.trim()}`
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
      `Verified ${actionUses.length + reconcileActionUses.length} pinned Actions, npm@${npmVersion}, exact release image identity, reconciliation rerun fixtures, anonymous GHCR gate, and mutation checks.`
    );
  }
}
