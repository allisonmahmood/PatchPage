/**
 * The flip's operator surface: what the command accepts, and whether the
 * runbook still describes the command that exists.
 *
 * The second half is a static scan rather than an execution, which is the same
 * bargain `infra/azure/tests/guide_commands_test.sh` strikes for the Azure
 * guide: the parts of an operator document that can drift silently are the
 * command names and flags, so those are pinned against the real surface, while
 * the judgment around them stays prose for a human to read. A runbook step
 * nobody can run because it names a script that was renamed is the failure
 * this catches.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseArguments } from "./go-public-flip-command.js";
import {
  GoPublicFlipPreconditionError,
  isGoPublicFlipPreconditionError
} from "./go-public-flip.js";
import type { GoPublicFlipPreconditionCode } from "./go-public-flip.js";

const RUNBOOK_URL = new URL("../../../docs/GO_PUBLIC_FLIP.md", import.meta.url);
const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);

async function readRunbook(): Promise<string> {
  return readFile(RUNBOOK_URL, "utf8");
}

describe("go-public flip command arguments", () => {
  it("inspects by default and writes only when --apply is typed", () => {
    expect(parseArguments([])).toEqual({ reHomeApiTokenIds: [], apply: false });
    expect(parseArguments(["--apply"])).toEqual({ reHomeApiTokenIds: [], apply: true });
  });

  it("takes re-home targets as a comma list, repeatably, and trims them", () => {
    expect(parseArguments(["--re-home", "tok_a, tok_b ,tok_c"])).toEqual({
      reHomeApiTokenIds: ["tok_a", "tok_b", "tok_c"],
      apply: false
    });
    expect(parseArguments(["--re-home", "tok_a", "--re-home", "tok_b", "--apply"])).toEqual({
      reHomeApiTokenIds: ["tok_a", "tok_b"],
      apply: true
    });
  });

  it("refuses input that would silently mean something else", () => {
    // A repeated target would re-home one token twice in one run. The port
    // would treat the second as already-re-homed and report it, which reads
    // like a successful no-op rather than the typo it is.
    expect(() => parseArguments(["--re-home", "tok_a,tok_a"])).toThrow(/Repeated re-home target/);
    // `--re-home --apply` would otherwise swallow the flag as a token ID.
    expect(() => parseArguments(["--re-home", "--apply"])).toThrow(/needs a comma/);
    expect(() => parseArguments(["--re-home"])).toThrow(/needs a comma/);
    expect(() => parseArguments(["--dry-run"])).toThrow(/Unknown argument: --dry-run/);
  });
});

describe("go-public flip refusals", () => {
  it("names a cause and a next action, once per code", () => {
    const codes: GoPublicFlipPreconditionCode[] = [
      "migrations_pending",
      "bootstrap_principal_missing",
      "rehome_target_unknown",
      "rehome_target_is_bootstrap_token",
      "rehome_target_has_admin_scope",
      "rehome_target_principal_shared",
      "draft_already_pinned"
    ];

    for (const code of codes) {
      const error = new GoPublicFlipPreconditionError(code, "tok_detail");
      expect(isGoPublicFlipPreconditionError(error)).toBe(true);
      // The detail is always carried through — an operator mid-flip needs to
      // know which token or draft, not just which rule.
      expect(error.message).toContain("tok_detail");
      // A sentence, not an identifier: every message is prose ending in a
      // period before the detail it names.
      expect(error.message).toMatch(/\. [A-Z]/);
      expect(error.message).not.toContain(code);
    }
  });
});

describe("the runbook and the command it documents", () => {
  it("names the package script that actually exists", async () => {
    const manifest = JSON.parse(await readFile(PACKAGE_JSON_URL, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["db:go-public-flip"]).toBe("tsx src/go-public-flip-command.ts");

    const runbook = await readRunbook();
    expect(runbook).toContain("pnpm --filter @patchpage/db db:go-public-flip");
  });

  it("uses only flags the command accepts", async () => {
    const runbook = await readRunbook();
    const flags = new Set(runbook.match(/--[a-z][a-z-]*/g) ?? []);
    // `--filter` and `--new` belong to pnpm and the publishing CLI; everything
    // else the runbook types at this command has to parse.
    for (const flag of flags) {
      if (flag === "--filter" || flag === "--new" || flag === "--json") continue;
      expect(() => parseArguments([flag === "--re-home" ? "--apply" : flag])).not.toThrow(
        /Unknown argument/
      );
    }
  });

  it("still states the decisions a reader must not have to rediscover", async () => {
    const runbook = await readRunbook();

    // The accepted consequence. If this sentence ever leaves the runbook, the
    // next operator will try to "fix" it during the flip.
    expect(runbook).toContain("draft mappings will start erroring on update");
    expect(runbook).toContain('Do not "fix" this at flip time.');

    // The two gaps the flip inherits rather than closes.
    expect(runbook).toContain("No per-IP rate limit on the report endpoint");
    expect(runbook).toContain("only unauthenticated write on");
    expect(runbook).toContain("defaultHostHint");

    // The ordering that is load-bearing: surgery, then the environment flip,
    // then the first pin.
    expect(runbook.indexOf("### 5. Apply the surgery")).toBeLessThan(
      runbook.indexOf("### 6. Turn self-service minting on")
    );
    expect(runbook.indexOf("### 6. Turn self-service minting on")).toBeLessThan(
      runbook.indexOf("### 7. Publish and pin the welcome draft")
    );

    // The rollback lever, and what it is not.
    expect(runbook).toContain("The environment variable is the rollback lever.");
    expect(runbook).toContain("The kill switch is the emergency lever**, not the rollback lever");
  });

  it("keeps its runnable steps out of shell fences, as the Azure guide does", async () => {
    const runbook = await readRunbook();
    // `infra/azure/README.md` reserves ```sh for `ops.sh` commands, and its
    // harness enforces that. This file documents commands that are not
    // `ops.sh` commands, so it uses ```txt throughout for the same reason:
    // a fence an operator can paste blind is a fence that will be pasted blind.
    expect(runbook).not.toContain("```sh");
    expect(runbook).toContain("```txt");
  });
});
