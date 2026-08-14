import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSentence = "Requires Node.js 22 or newer.";
const surfacePaths = {
  rootReadme: "README.md",
  cliReadme: "packages/cli/README.md",
  selfHosting: "docs/SELF_HOSTING.md",
  skill: "skills/patchpage/SKILL.md",
  operatorSkill: ".agents/skills/patchpage-mint-token/SKILL.md",
  showcase: "examples/plan.html"
};
const surfaces = Object.fromEntries(
  await Promise.all(
    Object.entries(surfacePaths).map(async ([name, relativePath]) => [
      name,
      await readFile(path.join(repoRoot, relativePath), "utf8")
    ])
  )
);
// Tokenless upload is retired: no instance accepts an upload without a bearer
// token, on any configuration. These patterns fail the build if a shipped
// surface still advertises the retired posture.
const forbiddenClaimPatterns = [
  /anonymous(?: uploads?| creation| access)?[^.]{0,60}(?:is |are )?(?:enabled|allowed|available) by default/i,
  /(?:allows?|enables?|uses?) anonymous (?:uploads?|creation|access) by default|by default[^.]{0,60}(?:allows?|enables?) anonymous/i,
  /(?:tokens?|token authentication)[^.]{0,60}(?:not required|optional)/i,
  /(?:opt(?:ed)?[ -]in|opt in|explicitly enabled?|may enable|can enable)[^.]{0,100}anonymous (?:uploads?|creation|create|access)/i,
  /anonymous (?:uploads?|creation|create|access)[^.]{0,100}(?:opt(?:ed)?[ -]in|explicitly enabled?)/i,
  /(?:automatically )?(?:attempts?|falls? back to|retries? with) (?:an )?anonymous (?:upload|create|creation)/i,
  /PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS\s*=\s*true/i
];

for (const name of ["rootReadme", "cliReadme", "skill", "operatorSkill"]) {
  const surface = surfaces[name];
  const runtimeIndex = surface.indexOf(runtimeSentence);
  const firstPublicCommandIndex = surface.search(/\bnpx(?:\s+--yes)?\s+patchpage\b/);
  assert.ok(runtimeIndex >= 0, `${surfacePaths[name]} is missing the exact runtime sentence`);
  assert.ok(
    firstPublicCommandIndex >= 0 && runtimeIndex < firstPublicCommandIndex,
    `${surfacePaths[name]} must state the runtime requirement before its first public command`
  );
}
assert.ok(
  surfaces.showcase.includes(runtimeSentence),
  `${surfacePaths.showcase} is missing the exact runtime sentence`
);

for (const name of ["rootReadme", "cliReadme", "selfHosting", "skill", "showcase"]) {
  const source = surfaces[name];
  const text = visibleText(source);
  assert.match(
    text,
    /public(?:,\s*| and )unlisted/i,
    `${surfacePaths[name]} must describe viewer links as public and unlisted`
  );
  assert.match(text, /self-host/i, `${surfacePaths[name]} must identify the self-hosted mode`);
  assert.match(
    text,
    /(?:every|each|all|any) upload[^.]{0,100}(?:requires?|needs?)[^.]{0,60}(?:API )?token|no[^.]{0,60}upload[^.]{0,60}without[^.]{0,30}token|uploads?[^.]{0,60}(?:always )?requires?[^.]{0,40}(?:API )?token/i,
    `${surfacePaths[name]} must state that every upload requires a token`
  );
  assert.match(
    text,
    /(?:on |under |in )(?:every|any) configuration|regardless of[^.]{0,60}configuration|no configuration[^.]{0,80}(?:accepts?|admits?|allows?)/i,
    `${surfacePaths[name]} must state that the token requirement holds on every configuration`
  );
  for (const contradiction of forbiddenClaimPatterns) {
    assert.doesNotMatch(
      text,
      contradiction,
      `${surfacePaths[name]} contradicts the finalized authentication contract`
    );
  }
}

for (const name of ["rootReadme", "cliReadme", "skill", "showcase"]) {
  const text = visibleText(surfaces[name]);
  assert.match(
    text,
    /https:\/\/post\.patchyhq\.com/i,
    `${surfacePaths[name]} must name the default host`
  );
  assert.match(
    text,
    /private instance/i,
    `${surfacePaths[name]} must identify the maintainer instance`
  );
  // Both context glossaries avoid "signup" as domain vocabulary, so the
  // contract enforces the meaning rather than that word: the maintainer
  // instance hands out no tokens to callers who are not its operator.
  assert.match(
    text,
    /(?:issues|hands out|offers) no[^.]{0,40}tokens?|does not issue[^.]{0,40}tokens?/i,
    `${surfacePaths[name]} must say the maintainer instance issues no tokens to outside callers`
  );
}

for (const name of ["rootReadme", "cliReadme", "selfHosting", "skill", "operatorSkill"]) {
  for (const block of markdownShellBlocks(surfaces[name])) {
    assert.doesNotMatch(
      block.body,
      /(^|[=\s])<[^<>\n]+>/m,
      `${surfacePaths[name]} has a shell-significant angle-bracket placeholder`
    );
    assert.doesNotMatch(
      block.body,
      /\bnpx\s+patchpage\b/,
      `${surfacePaths[name]} must use npx --yes patchpage in shell commands`
    );
    assert.doesNotMatch(
      block.body,
      /\bpatchpage\s+auth\s+set[^\n]*(?:--token(?:=|\s)|\bpp_[a-z0-9])/i,
      `${surfacePaths[name]} places a credential in patchpage argv`
    );
    assert.doesNotMatch(
      block.body,
      /Authorization:\s*Bearer\s+(?!\$|%s)/i,
      `${surfacePaths[name]} places a bearer credential literal in a shell command`
    );
    assertNoAuthorizationBearerHeaderArgv(surfacePaths[name], block.body);
    if (block.language === "sh") assertPosixShellSyntax(surfacePaths[name], block.body);
    assertAuthenticatedQuickStartContract(surfacePaths[name], block.body);
    assertDependentCommandFailuresStop(surfacePaths[name], block.body);
  }
}

for (const name of ["cliReadme", "selfHosting", "skill", "operatorSkill"]) {
  assert.match(
    surfaces[name],
    /printf\s+'%s'\s+"\$[A-Z_]+"\s*\|\s*(?:npx\s+(?:--yes\s+)?)?patchpage auth set --token-stdin|(?:npx\s+(?:--yes\s+)?)?patchpage auth set[^\n]*--token-stdin[^\n]*<\s*"\$[A-Z_]+"/,
    `${surfacePaths[name]} must show automation passing a secret variable through stdin`
  );
}

const showcaseCommands = [
  ...surfaces.showcase.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)
].map((match) => decodeHtmlCode(match[1]));
assert.ok(showcaseCommands.length > 0, "showcase must render at least one public command sequence");
for (const commands of showcaseCommands) {
  assert.doesNotMatch(
    commands,
    /(^|[=\s])<[^<>\n]+>/m,
    "showcase has an angle-bracket command placeholder"
  );
  assert.doesNotMatch(
    commands,
    /\bnpx\s+patchpage\b/,
    "showcase must use npx --yes patchpage in shell commands"
  );
  assertPosixShellSyntax(surfacePaths.showcase, commands);
  assertAuthenticatedQuickStartContract(surfacePaths.showcase, commands);
  assertDependentCommandFailuresStop(surfacePaths.showcase, commands);
}
assert.match(surfaces.showcase, /<title>PatchPage artifact workflow<\/title>/i);
assert.doesNotMatch(
  visibleText(surfaces.showcase),
  /hosted testbed|before npm publish|publish the npm package|pre-publication checklist/i,
  "showcase must not render obsolete pre-publication work"
);
assert.doesNotMatch(
  surfaces.showcase,
  /<(?:script|form|input|iframe|embed|object|applet|link|base)\b/i,
  "showcase must remain a safe static HTML artifact"
);

assertModeTokenCaseLists(surfaces.selfHosting);
const selfHostingUploadWorkflows = markdownShellBlocks(surfaces.selfHosting).filter(
  ({ body }) => body.includes("UPLOAD_TOKEN_MODE") && /\bpatchpage\s+upload\b/.test(body)
);
assert.equal(
  selfHostingUploadWorkflows.length,
  1,
  "self-hosting guide must contain one protected upload-token workflow"
);
await assertUploadTokenModeTokens(selfHostingUploadWorkflows[0].body);

await assertSelfHostingBootstrapFiles(
  extractMarkedShellFence(surfaces.selfHosting, "self-hosting-source-start")
);
await assertOperatorMintRecovery(extractMarkedShellFence(surfaces.operatorSkill, "operator-mint"));

console.log("[public-surface-contract] PASS: shipped docs and rendered showcase contracts");

function extractMarkedShellFence(source, markerName) {
  const startMarker = `<!-- guide-test:${markerName}:start -->`;
  const endMarker = `<!-- guide-test:${markerName}:end -->`;
  assert.equal(
    source.split(startMarker).length - 1,
    1,
    `${markerName} must have one start marker`
  );
  assert.equal(source.split(endMarker).length - 1, 1, `${markerName} must have one end marker`);
  const start = source.indexOf(startMarker) + startMarker.length;
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${markerName} markers must be ordered`);
  const fence = source
    .slice(start, end)
    .match(/^\s*```(?:sh|bash)[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  assert.ok(fence, `${markerName} markers must wrap exactly one shell fence`);
  return fence[1].replaceAll("\r\n", "\n");
}

function assertModeTokenCaseLists(source) {
  const cases = [
    ...source.matchAll(/case "\$(?:BOOTSTRAP|UPLOAD)_TOKEN_MODE" in\r?\n([\s\S]*?)\r?\n\s*esac/g)
  ];
  assert.ok(cases.length >= 5, "self-hosting guide must validate every token-file mode");
  for (const match of cases) {
    const body = match[1];
    const acceptedArm = body.match(/^\s+([^)\r\n]+)\) ;;/m);
    assert.ok(acceptedArm, "token-file mode case must have one accepted arm");
    const expected = /generated bootstrap token/i.test(body)
      ? ["-rw-------", "-rw-------@", "-rw-------."]
      : [
          "-r--------",
          "-r--------@",
          "-r--------.",
          "-rw-------",
          "-rw-------@",
          "-rw-------."
        ];
    assert.deepEqual(
      acceptedArm[1].split("|"),
      expected,
      "token-file mode cases must accept only base, Darwin @, and SELinux . variants"
    );
  }
}

async function assertUploadTokenModeTokens(commands) {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpage upload mode contract "));
  const tokenPath = path.join(root, "protected upload token");
  try {
    await writeFile(tokenPath, "upload-token");
    clearExtendedAttributes(tokenPath);
    await chmod(tokenPath, 0o400);
    for (const { token, accepted } of [
      { token: "-r--------", accepted: true },
      { token: "-r--------@", accepted: true },
      { token: "-r--------.", accepted: true },
      { token: "-rw-------", accepted: true },
      { token: "-rw-------@", accepted: true },
      { token: "-rw-------.", accepted: true },
      { token: "-r--------+", accepted: false },
      { token: "-r--------!", accepted: false },
      { token: "-rw-r-----", accepted: false },
      { token: "dr--------", accepted: false }
    ]) {
      const prelude = `
ls() {
  if test "\${1-}" = "-ld"; then
    printf '%s 1 owner group 1 Jan 1 00:00 token\\n' "$SYNTHETIC_MODE_TOKEN"
    return 0
  fi
  command ls "$@"
}
patchpage() { return 0; }
npx() {
  if test "\${1-}" = "--yes"; then shift; fi
  test "\${1-}" = patchpage || return 97
  shift
  patchpage "$@"
}
`;
      const result = spawnSync("sh", ["-c", `${prelude}\n${commands}`], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATCHPAGE_API_TOKEN: "hostile-inherited-api-token",
          PATCHPAGE_UPLOAD_TOKEN_FILE: tokenPath,
          SYNTHETIC_MODE_TOKEN: token
        }
      });
      if (accepted) {
        assert.equal(result.status, 0, `upload token loader rejected ${token}:\n${result.stderr}`);
      } else {
        assert.notEqual(result.status, 0, `upload token loader accepted ${token}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertSelfHostingBootstrapFiles(commands) {
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpage bootstrap contract "));
  try {
    for (const scenario of [
      { name: "0400-newline", mode: 0o400, newline: true, accepted: true },
      { name: "0400-no-newline", mode: 0o400, newline: false, accepted: true },
      { name: "0600-newline", mode: 0o600, newline: true, accepted: true },
      { name: "0600-no-newline", mode: 0o600, newline: false, accepted: true },
      { name: "0400-darwin-mode", mode: 0o400, newline: true, modeToken: "-r--------@", accepted: true },
      { name: "0600-darwin-mode", mode: 0o600, newline: true, modeToken: "-rw-------@", accepted: true },
      { name: "0400-selinux-mode", mode: 0o400, newline: true, modeToken: "-r--------.", accepted: true },
      { name: "0600-selinux-mode", mode: 0o600, newline: true, modeToken: "-rw-------.", accepted: true },
      { name: "acl-suffix", mode: 0o400, newline: true, modeToken: "-r--------+", accepted: false },
      { name: "unknown-suffix", mode: 0o400, newline: true, modeToken: "-r--------!", accepted: false },
      { name: "unreadable", mode: 0o000, newline: true, accepted: false },
      { name: "group-readable", mode: 0o640, newline: true, accepted: false },
      { name: "other-readable", mode: 0o604, newline: true, accepted: false },
      { name: "empty", mode: 0o400, newline: false, accepted: false },
      { name: "directory", kind: "directory", accepted: false },
      { name: "symlink", kind: "symlink", accepted: false }
    ]) {
      const scenarioRoot = path.join(root, scenario.name);
      const tokenPath = path.join(scenarioRoot, "mounted bootstrap token");
      const expectedToken = scenario.name === "empty" ? "" : `bootstrap-${scenario.name}`;
      await mkdir(scenarioRoot);
      if (scenario.kind === "directory") {
        await mkdir(tokenPath);
      } else if (scenario.kind === "symlink") {
        const target = path.join(scenarioRoot, "real token");
        await writeFile(target, `${expectedToken}\n`);
        await chmod(target, 0o400);
        await symlink(target, tokenPath);
      } else {
        await writeFile(tokenPath, `${expectedToken}${scenario.newline ? "\n" : ""}`);
        clearExtendedAttributes(tokenPath);
        await chmod(tokenPath, scenario.mode);
      }

      const result = runBootstrapCommands(commands, {
        tokenPath,
        expectedToken,
        home: scenarioRoot,
        modeToken: scenario.modeToken
      });
      if (scenario.accepted) {
        assert.equal(
          result.status,
          0,
          `self-hosting source block rejected ${scenario.name}:\n${result.stderr}`
        );
        assert.match(result.stdout, /^SERVER_STARTED$/m);
        assert.doesNotMatch(
          result.stdout,
          /^CUSTOM_TOKEN_CHMOD$/m,
          "custom bootstrap files must never be chmodded"
        );
        assert.equal((await stat(tokenPath)).mode & 0o777, scenario.mode);
      } else {
        assert.notEqual(result.status, 0, `self-hosting source block accepted ${scenario.name}`);
        assert.doesNotMatch(result.stdout, /^SERVER_STARTED$/m);
      }
    }
    await assertGeneratedBootstrapModeTokens(commands, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function clearExtendedAttributes(candidate) {
  if (process.platform !== "darwin") return;
  const result = spawnSync("xattr", ["-c", candidate], { encoding: "utf8" });
  assert.equal(result.status, 0, `could not clear test fixture metadata: ${result.stderr}`);
}

function runBootstrapCommands(commands, { tokenPath, expectedToken, home, modeToken }) {
  const prelude = `
chmod() {
  last_argument=''
  for last_argument do :; done
  if [ "$last_argument" = "$CUSTOM_BOOTSTRAP_FILE" ]; then
    printf 'CUSTOM_TOKEN_CHMOD\\n'
    return 97
  fi
  command chmod "$@"
}
ls() {
  if test -n "$SYNTHETIC_MODE_TOKEN" &&
     test "\${1-}" = "-ld"; then
    printf '%s 1 owner group 1 Jan 1 00:00 token\\n' "$SYNTHETIC_MODE_TOKEN"
    return 0
  fi
  command ls "$@"
}
openssl() { return 98; }
pnpm() {
  test "$*" = "--filter @patchpage/server dev" || return 96
  test "\${PATCHPAGE_BOOTSTRAP_API_TOKEN-}" = "$EXPECTED_BOOTSTRAP_TOKEN" || return 95
  printf 'SERVER_STARTED\\n'
}
`;
  const env = {
    ...process.env,
    CUSTOM_BOOTSTRAP_FILE: tokenPath,
    EXPECTED_BOOTSTRAP_TOKEN: expectedToken,
    SYNTHETIC_MODE_TOKEN: modeToken ?? "",
    HOME: home,
    PATCHPAGE_BOOTSTRAP_TOKEN_FILE: tokenPath,
    PATCHPAGE_SERVER_MODE: "development",
    XDG_CONFIG_HOME: path.join(home, "config")
  };
  delete env.PATCHPAGE_BOOTSTRAP_API_TOKEN;
  return spawnSync("sh", ["-c", `${prelude}\n${commands}`], {
    cwd: home,
    encoding: "utf8",
    env
  });
}
async function assertGeneratedBootstrapModeTokens(commands, root) {
  for (const [index, { token, accepted }] of [
    { token: "-rw-------", accepted: true },
    { token: "-rw-------@", accepted: true },
    { token: "-rw-------.", accepted: true },
    { token: "-rw-------+", accepted: false },
    { token: "-rw-------!", accepted: false },
    { token: "-rw-r-----", accepted: false },
    { token: "drw-------", accepted: false }
  ].entries()) {
    const scenarioRoot = path.join(root, `generated-${index}`);
    await mkdir(scenarioRoot);
    const prelude = `
ls() {
  if test "\${1-}" = "-ld"; then
    printf '%s 1 owner group 1 Jan 1 00:00 token\\n' "$SYNTHETIC_MODE_TOKEN"
    return 0
  fi
  command ls "$@"
}
openssl() {
  test "$*" = "rand -hex 32" || return 97
  printf '%s\\n' "$EXPECTED_BOOTSTRAP_TOKEN"
}
pnpm() {
  test "$*" = "--filter @patchpage/server dev" || return 96
  test "\${PATCHPAGE_BOOTSTRAP_API_TOKEN-}" = "$EXPECTED_BOOTSTRAP_TOKEN" || return 95
  printf 'SERVER_STARTED\\n'
}
`;
    const env = {
      ...process.env,
      EXPECTED_BOOTSTRAP_TOKEN: "generated-bootstrap-token",
      HOME: scenarioRoot,
      PATCHPAGE_SERVER_MODE: "development",
      SYNTHETIC_MODE_TOKEN: token,
      XDG_CONFIG_HOME: path.join(scenarioRoot, "config")
    };
    delete env.PATCHPAGE_BOOTSTRAP_API_TOKEN;
    delete env.PATCHPAGE_BOOTSTRAP_TOKEN_FILE;
    const result = spawnSync("sh", ["-c", `${prelude}\n${commands}`], {
      cwd: scenarioRoot,
      encoding: "utf8",
      env
    });
    if (accepted) {
      assert.equal(result.status, 0, `generated token loader rejected ${token}:\n${result.stderr}`);
      assert.match(result.stdout, /^SERVER_STARTED$/m);
    } else {
      assert.notEqual(result.status, 0, `generated token loader accepted ${token}`);
      assert.doesNotMatch(result.stdout, /^SERVER_STARTED$/m);
    }
  }
}


async function assertOperatorMintRecovery(commands) {
  const testableCommands = replaceOperatorAdminPrompt(commands);
  const root = await mkdtemp(path.join(os.tmpdir(), "patchpage operator contract "));
  try {
    for (const scenario of ["jq-failure", "auth-failure", "whoami-failure", "success"]) {
      const scenarioRoot = path.join(root, scenario);
      const mintRoot = path.join(scenarioRoot, "protected mint result");
      const scriptPath = path.join(scenarioRoot, "operator workflow.sh");
      await mkdir(scenarioRoot);
      await writeFile(scriptPath, `${operatorMintPrelude()}\n${testableCommands}\n`);
      await chmod(scriptPath, 0o700);

      const env = {
        ...process.env,
        PATCHPAGE_OPERATOR_SCENARIO: scenario,
        TEST_ADMIN_TOKEN: "operator-admin-token",
        TEST_MINT_TMP: mintRoot
      };
      const result = spawnSync("bash", [scriptPath], {
        cwd: scenarioRoot,
        encoding: "utf8",
        env,
        timeout: 20_000
      });

      if (scenario === "success") {
        assert.equal(result.status, 0, `operator success failed:\n${result.stderr}`);
        assert.equal(await pathExists(mintRoot), false, "full success must remove mint secrets");
        continue;
      }

      assert.notEqual(result.status, 0, `operator workflow accepted ${scenario}`);
      const responsePath = path.join(mintRoot, "response.json");
      const tokenPath = path.join(mintRoot, "minted-upload-token");
      assert.equal(
        await pathExists(responsePath),
        true,
        `${scenario} removed the mint response:\n${result.stdout}\n${result.stderr}`
      );
      assert.equal((await stat(responsePath)).mode & 0o777, 0o600);
      assert.equal(await pathExists(tokenPath), true, `${scenario} removed the minted token file`);
      assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
      if (scenario !== "jq-failure") {
        assert.equal(await readFile(tokenPath, "utf8"), "minted-upload-token");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function replaceOperatorAdminPrompt(commands) {
  const promptStart = "printf 'Admin token: ' > /dev/tty";
  const workflowResume = 'if ! MINT_TMP_DIR="$(mktemp -d)"';
  assert.equal(commands.split(promptStart).length - 1, 1, "operator block must have one admin prompt");
  assert.equal(
    commands.split(workflowResume).length - 1,
    1,
    "operator block must have one mint workspace creation"
  );
  const start = commands.indexOf(promptStart);
  const resume = commands.indexOf(workflowResume, start);
  assert.ok(resume > start, "operator prompt must precede mint workspace creation");
  return `${commands.slice(0, start)}ADMIN_TOKEN=$TEST_ADMIN_TOKEN\n${commands.slice(resume)}`;
}
function operatorMintPrelude() {

  return `
mktemp() {
  test "$1" = "-d" || return 96
  mkdir -p "$TEST_MINT_TMP"
  printf '%s\\n' "$TEST_MINT_TMP"
}
curl() {
  output_file=''
  while test "$#" -gt 0; do
    if test "$1" = "--output"; then
      shift
      output_file=$1
    fi
    shift
  done
  test -n "$output_file" || return 95
  printf '%s' '{"token":"minted-upload-token"}' > "$output_file"
}
jq() {
  test "$PATCHPAGE_OPERATOR_SCENARIO" != "jq-failure" || return 94
  printf '%s' 'minted-upload-token'
}
npx() {
  if [ "\${1-}" = "--yes" ]; then shift; fi
  test "\${1-}" = patchpage || return 93
  shift
  command_name=$1
  if test "$command_name" = auth &&
     test "$PATCHPAGE_OPERATOR_SCENARIO" = "auth-failure"; then
    return 92
  fi
  if test "$command_name" = whoami &&
     test "$PATCHPAGE_OPERATOR_SCENARIO" = "whoami-failure"; then
    return 91
  fi
}
`;
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function visibleText(source) {
  return source.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

function decodeHtmlCode(source) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"'
  };
  return source.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|apos|gt|lt|quot);/gi, (entity, name) => {
    if (!name.startsWith("#")) return namedEntities[name.toLowerCase()];
    const hexadecimal = name[1].toLowerCase() === "x";
    const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return String.fromCodePoint(codePoint);
  });
}

function markdownShellBlocks(source) {
  return [...source.matchAll(/```(sh|bash|shell)\s*\n([\s\S]*?)```/g)].map((match) => ({
    language: match[1],
    body: match[2]
  }));
}

function assertNoAuthorizationBearerHeaderArgv(surfacePath, commands) {
  const logicalLines = commands.replaceAll(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const line of logicalLines) {
    if (!/\bcurl\b/.test(line)) continue;
    assert.doesNotMatch(
      line,
      /(?:^|\s)(?:-H(?:=|\s*)|--header(?:=|\s+))["']?Authorization:\s*Bearer(?:\s|["']|$)/i,
      `${surfacePath} must keep bearer credentials out of curl argv`
    );
  }
}

function assertAuthenticatedQuickStartContract(surfacePath, commands) {
  const matches = [
    ...commands.matchAll(/\b(?:npx\s+(?:--yes\s+)?)?patchpage\s+(auth|whoami|validate|upload)\b/g)
  ];
  const sequence = matches.map((match) => match[1]);
  if (!sequence.includes("auth")) {
    return;
  }
  const npxCount = [...commands.matchAll(/\bnpx\b/g)].length;
  const noninteractiveNpxCount = [
    ...commands.matchAll(/\bnpx\s+--yes\s+patchpage\b/g)
  ].length;
  assert.equal(
    noninteractiveNpxCount,
    npxCount,
    `${surfacePath} authenticated quick start must use npx --yes patchpage`
  );
  assert.doesNotMatch(
    commands,
    /\bnpx\s+patchpage\b/,
    `${surfacePath} authenticated quick start must not use bare npx patchpage`
  );
  if (!sequence.includes("upload")) return;

  const authIndex = sequence.indexOf("auth");
  const whoamiIndex = sequence.indexOf("whoami");
  const validateIndex = sequence.indexOf("validate");
  const uploadIndex = sequence.indexOf("upload");
  assert.equal(authIndex, 0, `${surfacePath} authenticated quick start must begin with auth`);
  assert.ok(whoamiIndex > authIndex, `${surfacePath} must run whoami after auth`);
  assert.ok(uploadIndex > whoamiIndex, `${surfacePath} must run whoami before upload`);
  if (validateIndex >= 0) {
    assert.ok(validateIndex > whoamiIndex, `${surfacePath} must run whoami before validation`);
    assert.ok(uploadIndex > validateIndex, `${surfacePath} must validate before upload`);
  }

  const authOffset = matches[authIndex].index;
  for (const [label, pattern] of [
    ["assign PATCHPAGE_API_URL", /(?:^|\n)\s*PATCHPAGE_API_URL=[^\n]+/m],
    ["export PATCHPAGE_API_URL", /(?:^|\n)\s*export PATCHPAGE_API_URL(?:\s|$)/m],
    ["unset PATCHPAGE_API_TOKEN", /(?:^|\n)\s*unset PATCHPAGE_API_TOKEN(?:\s|$)/m]
  ]) {
    const match = commands.match(pattern);
    assert.ok(
      match?.index !== undefined && match.index < authOffset,
      `${surfacePath} must ${label} before authentication`
    );
  }
  const urlAssignment = commands.match(/(?:^|\n)\s*PATCHPAGE_API_URL=([^\n]+)/m);
  assert.doesNotMatch(
    urlAssignment[1],
    /^["']?\$\{?PATCHPAGE_API_URL\b/,
    `${surfacePath} must pin PATCHPAGE_API_URL instead of reusing an inherited value`
  );
  assert.match(
    commands.slice(0, matches[authIndex + 1]?.index ?? commands.length),
    /printf\s+'%s'\s+"\$[A-Z_]+"\s*\|\s*(?:npx\s+(?:--yes\s+)?)?patchpage auth set[^\n]*--token-stdin|(?:npx\s+(?:--yes\s+)?)?patchpage auth set[^\n]*--token-stdin[^\n]*<\s*"\$[A-Z_]+"/,
    `${surfacePath} authenticated quick start must pass its setup token through stdin`
  );
}

function assertDependentCommandFailuresStop(surfacePath, commands) {
  const sequence = [
    ...commands.matchAll(/\b(?:npx\s+(?:--yes\s+)?)?patchpage\s+(auth|whoami|validate|upload)\b/g)
  ].map((match) => match[1]);
  if (sequence.length < 2) return;
  if (/\b(?:curl|jq|mktemp|openssl)\b|\/dev\/tty/.test(commands)) {
    for (const command of sequence.slice(0, -1)) {
      const negativeGuard = new RegExp(
        `if\\s+!\\s+(?:npx\\s+(?:--yes\\s+)?)?patchpage\\s+${command}\\b[^\\n]*;\\s*then[\\s\\S]{0,400}?\\bexit\\b`
      );
      const successBranchGuard = new RegExp(
        `if\\b[\\s\\S]{0,200}?(?:npx\\s+(?:--yes\\s+)?)?patchpage\\s+${command}\\b[^\\n]*;\\s*then[\\s\\S]{0,400}?\\belse\\b[\\s\\S]{0,200}?\\bexit\\b`
      );
      assert.ok(
        negativeGuard.test(commands) || successBranchGuard.test(commands),
        `${surfacePath} must explicitly exit when ${command} fails before a dependent command`
      );
    }
    return;
  }

  const probePrelude = `
PATCHPAGE_CONTRACT_TOKEN_FILE="\${TMPDIR:-/tmp}/patchpage-public-surface-token-$$"
(umask 077; printf '%s' 'public-surface-upload-token' > "$PATCHPAGE_CONTRACT_TOKEN_FILE")
if command -v xattr >/dev/null 2>&1; then
  xattr -c "$PATCHPAGE_CONTRACT_TOKEN_FILE"
fi
PATCHPAGE_UPLOAD_TOKEN_FILE=$PATCHPAGE_CONTRACT_TOKEN_FILE
export PATCHPAGE_UPLOAD_TOKEN_FILE
trap 'rm -f "$PATCHPAGE_CONTRACT_TOKEN_FILE"' 0
patchpage() {
  command_name=$1
  printf 'PATCHPAGE_PROBE:%s\\n' "$command_name"
  if [ "$command_name" = "$PATCHPAGE_CONTRACT_FAIL_ON" ]; then
    return 97
  fi
}
npx() {
  if [ "\${1-}" = "--yes" ]; then shift; fi
  if [ "\${1-}" = patchpage ]; then
    shift
    patchpage "$@"
  fi
}
npm() { return 0; }
`;

  for (let index = 0; index < sequence.length - 1; index += 1) {
    const failedCommand = sequence[index];
    const result = spawnSync("sh", ["-c", `${probePrelude}\n${commands}`], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACT_PATH: "./review artifact.html",
        PATCHPAGE_API_URL: "https://hostile.invalid",
        PATCHPAGE_API_TOKEN: "hostile-inherited-api-token",
        PATCHPAGE_URL: "https://patchpage.example.com",
        PATCHPAGE_SETUP_URL: "https://patchpage.example.com",
        PATCHPAGE_SETUP_TOKEN: "public-surface-contract-setup-token",
        TOKEN: "hostile-inherited-token",
        PATCHPAGE_CONTRACT_FAIL_ON: failedCommand
      }
    });
    const observed = [
      ...result.stdout.matchAll(/^PATCHPAGE_PROBE:(auth|whoami|validate|upload)$/gm)
    ].map(
      (match) => match[1]
    );
    assert.notEqual(
      result.status,
      0,
      `${surfacePath} must exit when ${failedCommand} fails:\n${commands}`
    );
    assert.equal(
      observed[index],
      failedCommand,
      `${surfacePath} must reach ${failedCommand} before testing its failure:\n${result.stderr}`
    );
    assert.deepEqual(
      observed.slice(index + 1),
      [],
      `${surfacePath} continued to a dependent command after ${failedCommand} failed`
    );
  }
}

function assertPosixShellSyntax(surfacePath, commands) {
  const result = spawnSync("sh", ["-n"], { input: commands, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${surfacePath} has invalid POSIX sh syntax:\n${result.stderr || commands}`
  );
}
