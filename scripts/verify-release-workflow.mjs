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
  }
}

const npmVersion = packageJson.devDependencies?.npm;
if (typeof npmVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(npmVersion)) {
  failures.push("the publishing npm CLI must be an exact root devDependency");
} else {
  const rootImporter = lockfile.match(/^  \.:\n[\s\S]*?(?=^  \S)/m)?.[0] ?? "";
  const lockedNpm = new RegExp(
    `^      npm:\\n        specifier: ${npmVersion.replaceAll(".", "\\.")}\\n        version: ${npmVersion.replaceAll(".", "\\.")}$`,
    "m",
  );

  if (!lockedNpm.test(rootImporter)) {
    failures.push(`pnpm-lock.yaml must lock the root npm devDependency at ${npmVersion}`);
  }
  if (!lockfile.includes(`  npm@${npmVersion}:\n    resolution: {integrity: sha512-`)) {
    failures.push(`pnpm-lock.yaml must retain registry integrity for npm@${npmVersion}`);
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

const verifyJob = job("verify");
const publishJob = job("publish-npm");

if (!/permissions:\n      contents: read\n    outputs:/.test(verifyJob)) {
  failures.push("verify must receive only read access to repository contents");
}

if (!/permissions:\n      id-token: write\n    steps:/.test(publishJob)) {
  failures.push("publish-npm must grant only id-token: write");
}

if (!/^    needs:.*\bverify\b/m.test(publishJob)) {
  failures.push("publish-npm must hard-depend on verify");
}

if (!verifyJob.includes("uses: actions/upload-artifact@")) {
  failures.push("verify must upload its tested publication bundle");
}

if (!publishJob.includes("uses: actions/download-artifact@")) {
  failures.push("publish-npm must download the verified publication bundle");
}

for (const artifact of ["package-artifact", "npm-cli-artifact"]) {
  if (!verifyJob.includes(`${artifact}-id: \${{ steps.${artifact}.outputs.artifact-id }}`)) {
    failures.push(`verify must expose the immutable ${artifact} ID`);
  }
  if (!publishJob.includes(`artifact-ids: \${{ needs.verify.outputs.${artifact}-id }}`)) {
    failures.push(`publish-npm must download the exact ${artifact} ID from verify`);
  }
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

const allowedNpmCommands = new Set(["--version", "view", "publish"]);
for (const match of publishJob.matchAll(/node\s+"\$npm_cli"\s+([A-Za-z-]+)/g)) {
  if (!allowedNpmCommands.has(match[1])) {
    failures.push(`publish-npm must not run npm ${match[1]}`);
  }
}

if ((verifyJob.match(/node_modules\/\.bin\/npm" pack/g) ?? []).length !== 1) {
  failures.push("verify must pack exactly one release tarball with the pinned npm CLI");
}

if (!/node_modules\/\.bin\/npm" pack \\\n\s+--ignore-scripts/.test(verifyJob)) {
  failures.push("verify must suppress pack lifecycle scripts after the explicit build");
}

if (!/node_modules\/\.bin\/npm" install --ignore-scripts "\$TARBALL"/.test(verifyJob)) {
  failures.push("verify must smoke-install the same tarball with the pinned npm CLI");
}

if (!verifyJob.includes("path: ${{ runner.temp }}/patchpage-package/*.tgz")) {
  failures.push("verify must upload only the tested PatchPage tarball as the package artifact");
}

if (!/publish\s+"\$tarball"[^\n]*--ignore-scripts[^\n]*--provenance/.test(publishJob)) {
  failures.push("publish-npm must publish the downloaded tarball with lifecycle scripts disabled");
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
