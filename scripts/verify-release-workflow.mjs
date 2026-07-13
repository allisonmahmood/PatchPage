import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/release.yml");
const [workflow, packageSource, lockfile, dependabot] = await Promise.all([
  readFile(workflowPath, "utf8"),
  readFile(path.join(repoRoot, "package.json"), "utf8"),
  readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"),
  readFile(path.join(repoRoot, ".github/dependabot.yml"), "utf8"),
]);
const packageJson = JSON.parse(packageSource);
const failures = [];
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

function stepContaining(jobSource, marker) {
  const lines = jobSource.split("\n");
  const markerIndex = lines.findIndex((line) => line.trim() === marker);

  if (markerIndex === -1) {
    return "";
  }

  let start = markerIndex;
  while (start >= 0 && !/^      - /.test(lines[start])) {
    start -= 1;
  }

  const end = lines.findIndex(
    (line, index) => index > markerIndex && /^      - /.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function exactLineCount(source, line) {
  return source.split("\n").filter((candidate) => candidate === line).length;
}

function failClosedGuardPosition(source, guardLine) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === guardLine);

  if (start === -1) {
    return -1;
  }

  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === "fi",
  );
  if (
    end === -1 ||
    !lines.slice(start + 1, end).some((line) => line.trim() === "exit 1")
  ) {
    return -1;
  }

  return lines.slice(0, start).join("\n").length + (start === 0 ? 0 : 1);
}

const actionLines = workflow
  .split("\n")
  .map((line, index) => ({ line, lineNumber: index + 1 }))
  .filter(({ line }) => /^\s+(?:-\s+)?uses:/.test(line));

if (actionLines.length === 0) {
  failures.push("release.yml must use at least one external Action");
}

for (const { line, lineNumber } of actionLines) {
  const match = line.match(
    /^\s+(?:-\s+)?uses:\s+([^\s@]+)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/,
  );

  if (!match) {
    failures.push(
      `release.yml:${lineNumber} must pin an Action to a full commit SHA with an inline semver release comment`,
    );
    continue;
  }

  const [, actionName, sha, version] = match;
  const reviewed = reviewedActions.get(actionName);
  if (!reviewed) {
    failures.push(`release.yml:${lineNumber} uses unreviewed Action ${actionName}`);
    continue;
  }

  if (reviewed.sha !== sha || reviewed.version !== version) {
    failures.push(
      `release.yml:${lineNumber} must use reviewed coordinate ${actionName}@${reviewed.sha} # ${reviewed.version}`,
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

const prepareNpmJob = job("prepare-npm");
const verifyJob = job("verify");
const publishJob = job("publish-npm");
const packageUploadStep = stepContaining(verifyJob, "id: package-artifact");
const packageDownloadStep = stepContaining(
  publishJob,
  "- name: Download the exact tested tarball",
);

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
  const prepareActions = [
    ...prepareNpmJob.matchAll(/uses:\s+([^\s@]+)@/g),
  ].map((match) => match[1]);
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
const packageArtifactIdDownloads = exactLineCount(
  publishJob,
  "          artifact-ids: ${{ needs.verify.outputs.package-artifact-id }}",
);

if (
  !packageUploadStep.includes("uses: actions/upload-artifact@") ||
  exactLineCount(
    packageUploadStep,
    "          path: ${{ steps.package.outputs.tarball-path }}",
  ) !== 1 ||
  exactLineCount(packageUploadStep, "          archive: false") !== 1 ||
  packageUploadStep.includes("\n          name:") ||
  packageUploadStep.includes("compression-level:") ||
  packageUploadStep.includes("*.tgz") ||
  !packageDownloadStep.includes("uses: actions/download-artifact@") ||
  exactLineCount(
    packageDownloadStep,
    "          artifact-ids: ${{ needs.verify.outputs.package-artifact-id }}",
  ) !== 1 ||
  exactLineCount(
    packageDownloadStep,
    "          path: ${{ runner.temp }}/patchpage-package",
  ) !== 1 ||
  exactLineCount(packageDownloadStep, "          skip-decompress: true") !== 1 ||
  packageArtifactIdDownloads !== 1 ||
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
for (const match of publishJob.matchAll(/uses:\s+([^\s@]+)@/g)) {
  if (!allowedPublishActions.has(match[1])) {
    failures.push(`publish-npm must not execute the ${match[1]} Action`);
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

const registryRequestStart = publishJob.indexOf('if ! http_status="$(');
const registryCaseStart = publishJob.indexOf('case "$http_status" in');
const registryRequest = publishJob.slice(registryRequestStart, registryCaseStart);
if (
  registryRequestStart === -1 ||
  registryCaseStart <= registryRequestStart ||
  !publishJob.includes("curl --silent --show-error") ||
  !publishJob.includes('--output "$registry_metadata"') ||
  !publishJob.includes("--write-out '%{http_code}'") ||
  !publishJob.includes(
    'registry_url="https://registry.npmjs.org/${package_name}/${EXPECTED_VERSION}"',
  ) ||
  !registryRequest.includes("exit 1") ||
  registryRequest.includes("|| true") ||
  publishJob.includes("curl --fail") ||
  publishJob.includes("curl --location")
) {
  failures.push(
    "publish-npm must distinguish registry HTTP status from curl transport failure",
  );
}

const registryCase = publishJob.match(
  /case "\$http_status" in([\s\S]*?)\n\s+esac/,
)?.[1];
if (!registryCase) {
  failures.push("publish-npm must explicitly handle registry HTTP statuses");
} else {
  const status200Match = registryCase.match(/\n\s+200\)([\s\S]*?)\n\s+;;/);
  const status404Match = registryCase.match(/\n\s+404\)([\s\S]*?)\n\s+;;/);
  const otherStatusMatch = registryCase.match(/\n\s+\*\)([\s\S]*?)\n\s+;;/);
  const status200 = status200Match?.[1] ?? "";
  const status404 = status404Match?.[1] ?? "";
  const otherStatus = otherStatusMatch?.[1] ?? "";
  const missingIntegrity = status200.indexOf('-z "$registry_integrity"');
  const localSri = status200.indexOf('createHash("sha512")');
  const integrityMismatch = status200.indexOf(
    '"$registry_integrity" != "$local_integrity"',
  );
  const matchingIntegritySkip = status200.lastIndexOf("exit 0");

  if (
    !status200Match ||
    !status200.includes("dist?.integrity") ||
    !status200.includes(
      'typeof integrity === "string" && integrity.length > 0',
    ) ||
    missingIntegrity === -1 ||
    localSri <= missingIntegrity ||
    !status200.includes('readFileSync(process.argv[2])') ||
    !status200.includes("process.stdout.write(`sha512-${digest}`)") ||
    integrityMismatch <= localSri ||
    matchingIntegritySkip <= integrityMismatch ||
    !status200.slice(missingIntegrity, localSri).includes("exit 1") ||
    !status200.slice(integrityMismatch, matchingIntegritySkip).includes("exit 1")
  ) {
    failures.push(
      "registry HTTP 200 must skip only when dist.integrity matches the local tarball SRI",
    );
  }

  if (!status404Match || /\bexit\b/.test(status404)) {
    failures.push("only registry HTTP 404 may fall through to publication");
  }

  if (!otherStatusMatch || !/exit\s+1/.test(otherStatus)) {
    failures.push("unexpected registry HTTP statuses must fail publication");
  }
}

const registryCaseEnd = publishJob.indexOf("      esac");
const npmPublish = publishJob.indexOf('node "$npm_cli" publish');
if (registryCaseEnd === -1 || npmPublish <= registryCaseEnd) {
  failures.push("npm publish must occur only after the registry HTTP state machine");
}

const packageNameGuard = failClosedGuardPosition(
  publishJob,
  'if [[ "$package_name" != "patchpage" ]]; then',
);
const packageVersionGuard = failClosedGuardPosition(
  publishJob,
  'if [[ "$package_version" != "$EXPECTED_VERSION" ]]; then',
);
const npmCliVersionExecution = publishJob.indexOf('node "$npm_cli" --version');

if (
  packageMetadataRead === -1 ||
  packageNameGuard <= packageMetadataRead ||
  packageVersionGuard <= packageNameGuard ||
  npmCliVersionExecution <= packageVersionGuard ||
  registryRequestStart <= packageVersionGuard ||
  npmPublish <= npmCliVersionExecution ||
  npmPublish <= registryRequestStart
) {
  failures.push(
    "publish-npm must read package metadata, fail closed on exact patchpage name and expected version, then perform registry or npm CLI activity before publishing",
  );
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

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${actionLines.length} pinned Actions, npm@${npmVersion}, and the exact-tarball publication boundary.`,
  );
}
