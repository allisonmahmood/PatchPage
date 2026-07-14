import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { escapeHtml, renderHome } from "./render.js";

const maintainerDefault = "https://post.patchyhq.com";
const configuredUrl = "https://self-host.example.test/base?tenant=O'Reilly&mode=review";
const setupToken = "render-setup-sentinel";
const inheritedOrigin = "https://hostile-inherited.example.test";
const inheritedApiToken = "hostile-inherited-api-token";
const inheritedToken = "hostile-inherited-token";

describe("renderHome", () => {
  it("renders a pinned, fail-closed quick start for the configured origin", () => {
    const html = renderHome({ publicBaseUrl: configuredUrl });
    const commands = extractQuickStart(html);

    expect(html).toContain(`Endpoint: <code>${escapeHtml(configuredUrl)}</code>`);
    expect(html).not.toContain(maintainerDefault);
    expect(html.indexOf("Requires Node.js 22 or newer.")).toBeLessThan(
      html.indexOf("data-patchpage-quick-start")
    );
    expect(commands).toContain(
      'npx --yes patchpage auth set --token-stdin --api-url "$PATCHPAGE_API_URL"'
    );
    expect(commandNames(commands)).toEqual(["auth", "whoami", "validate", "upload"]);

    const syntax = spawnSync("sh", ["-n"], { input: commands, encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);

    const success = runWithStubCli(commands);
    expect(success.status, success.stderr).toBe(0);
    expect(observedCommands(success.stdout)).toEqual(["auth", "whoami", "validate", "upload"]);
    expect(success.stdout).toContain(
      `PATCHPAGE_PROBE:auth|set|--token-stdin|--api-url|${configuredUrl}`
    );
    expect(success.stdout).toContain(
      `PATCHPAGE_ENV:auth|url=${configuredUrl}|api=unset|token=unset|setup=set`
    );
    expect(success.stdout).toContain(
      `PATCHPAGE_ENV:whoami|url=${configuredUrl}|api=unset|token=unset|setup=unset`
    );
    expect(success.stderr).not.toContain(setupToken);
    expect(success.stderr).not.toContain(inheritedApiToken);
    expect(success.stderr).not.toContain(inheritedToken);
  });

  it.each(["auth", "whoami", "validate"] as const)(
    "stops dependent quick-start commands when %s fails",
    (failedCommand) => {
      const commands = extractQuickStart(renderHome({ publicBaseUrl: configuredUrl }));
      const result = runWithStubCli(commands, failedCommand);
      const orderedCommands = ["auth", "whoami", "validate", "upload"];
      const expected = orderedCommands.slice(0, orderedCommands.indexOf(failedCommand) + 1);

      expect(result.status).not.toBe(0);
      expect(observedCommands(result.stdout)).toEqual(expected);
    }
  );
});

function extractQuickStart(html: string): string {
  const matches = [
    ...html.matchAll(/<pre><code data-patchpage-quick-start>([\s\S]*?)<\/code><\/pre>/g)
  ];
  expect(matches).toHaveLength(1);
  return decodeHtml(matches[0][1]);
}

function decodeHtml(source: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"'
  };
  return source.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|apos|gt|lt|quot);/gi, (_entity, name) => {
    if (!name.startsWith("#")) return namedEntities[name.toLowerCase()];
    const hexadecimal = name[1].toLowerCase() === "x";
    const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return String.fromCodePoint(codePoint);
  });
}

type QuickStartCommand = "auth" | "whoami" | "validate" | "upload";

function commandNames(commands: string): QuickStartCommand[] {
  return [...commands.matchAll(/\bnpx --yes patchpage (auth|whoami|validate|upload)\b/g)].map(
    (match) => match[1] as QuickStartCommand
  );
}

function runWithStubCli(commands: string, failOn: QuickStartCommand | "" = "") {
  const stub = `
npx() {
  if [ "\${1-}" != --yes ] || [ "\${2-}" != patchpage ]; then
    return 91
  fi
  shift 2
  command_name=$1

  if [ "\${PATCHPAGE_API_URL-}" != "$PATCHPAGE_EXPECTED_URL" ]; then
    return 92
  fi
  if [ "\${PATCHPAGE_API_TOKEN+x}" = x ] || [ "\${TOKEN+x}" = x ]; then
    return 93
  fi

  setup_state=unset
  if [ "\${PATCHPAGE_SETUP_TOKEN+x}" = x ]; then
    setup_state=set
  fi
  if [ "$command_name" = auth ]; then
    token_input=$(cat)
    if [ "$token_input" != "$PATCHPAGE_EXPECTED_SETUP_TOKEN" ]; then
      return 94
    fi
  elif [ "$setup_state" != unset ]; then
    return 95
  fi

  printf 'PATCHPAGE_ENV:%s|url=%s|api=unset|token=unset|setup=%s\\n' \\
    "$command_name" "$PATCHPAGE_API_URL" "$setup_state"
  printf 'PATCHPAGE_PROBE:%s' "$command_name"
  shift
  for argument do
    printf '|%s' "$argument"
  done
  printf '\\n'
  if [ "$command_name" = "$PATCHPAGE_FAIL_ON" ]; then
    return 97
  fi
}
`;
  return spawnSync("sh", ["-eux", "-c", `${stub}\n${commands}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATCHPAGE_API_TOKEN: inheritedApiToken,
      PATCHPAGE_API_URL: inheritedOrigin,
      PATCHPAGE_EXPECTED_SETUP_TOKEN: setupToken,
      PATCHPAGE_EXPECTED_URL: configuredUrl,
      PATCHPAGE_FAIL_ON: failOn,
      PATCHPAGE_SETUP_TOKEN: setupToken,
      TOKEN: inheritedToken
    }
  });
}

function observedCommands(output: string): QuickStartCommand[] {
  return [...output.matchAll(/^PATCHPAGE_PROBE:(auth|whoami|validate|upload)(?:\||$)/gm)].map(
    (match) => match[1] as QuickStartCommand
  );
}
