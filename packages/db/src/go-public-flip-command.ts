/**
 * The go-public flip's operator entry point — `pnpm db:go-public-flip`.
 *
 * It is deliberately two commands wearing one name. With no `--apply` it
 * inspects and writes nothing, which is both the dry run the operator reads
 * before the flip and the verification they read after it. With `--apply` it
 * performs the surgery once, then prints the same inspection of what it left.
 *
 * `--apply` is required rather than defaulted for the obvious reason and one
 * less obvious one: re-arming is the single step that is not idempotent, so a
 * second accidental `--apply` moves every retention anchor forward again. A
 * flag the operator has to type is what keeps a mistyped inspection from being
 * a second flip.
 *
 * The runbook is `docs/GO_PUBLIC_FLIP.md`. Nothing here decides anything the
 * runbook does not state; this is the part of it a machine can run.
 */

import { getServerConfig } from "@patchpage/config";
import { createPatchPageDb } from "./factory.js";
import { isGoPublicFlipPreconditionError } from "./go-public-flip.js";
import type { GoPublicFlipInspection, GoPublicFlipOutcome } from "./types.js";

const USAGE = `usage: pnpm db:go-public-flip [--re-home <id>[,<id>...]] [--no-re-home] [--apply]

Inspects the database the server config points at and reports what the
go-public flip would find. With --apply, performs the flip's data surgery once
and reports what it left.

  --re-home <ids>  Comma-separated api-token IDs to re-home onto fresh 1:1
                   principals. Repeatable. The teammate tokens, named from the
                   private token record — never guessed.
  --no-re-home     Say out loud that this flip re-homes nobody. Required with
                   --apply when no --re-home target is named.
  --apply          Perform the surgery. Without it nothing is written.

Reads PATCHPAGE_DB_DRIVER, DATABASE_URL and PATCHPAGE_JSON_DB_FILE from the
environment exactly as the server does.`;

/**
 * A refusal to read the arguments as anything, as opposed to a refusal by the
 * flip itself. Its own type so the entry point can answer every one of them
 * with the usage text: an operator who mistyped a flag mid-flip should see
 * what the command takes, not a stack trace.
 */
export class GoPublicFlipUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoPublicFlipUsageError";
  }
}

interface ParsedArguments {
  reHomeApiTokenIds: string[];
  apply: boolean;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const reHomeApiTokenIds: string[] = [];
  let apply = false;
  let noReHome = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // `pnpm run <script> -- <args>` forwards the separator itself. Ignoring it
    // is what lets the runbook's invocation be the one an operator can paste.
    if (argument === "--") continue;
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--no-re-home") {
      noReHome = true;
      continue;
    }
    if (argument === "--re-home") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new GoPublicFlipUsageError(
          "--re-home needs a comma-separated list of api-token IDs."
        );
      }
      index += 1;
      for (const id of value.split(",")) {
        const trimmed = id.trim();
        if (trimmed) reHomeApiTokenIds.push(trimmed);
      }
      continue;
    }
    throw new GoPublicFlipUsageError(`Unknown argument: ${argument}`);
  }

  const duplicates = reHomeApiTokenIds.filter(
    (id, index) => reHomeApiTokenIds.indexOf(id) !== index
  );
  if (duplicates.length > 0) {
    throw new GoPublicFlipUsageError(`Repeated re-home target: ${duplicates.join(", ")}`);
  }

  if (noReHome && reHomeApiTokenIds.length > 0) {
    throw new GoPublicFlipUsageError(
      "--no-re-home and --re-home say opposite things. Drop one."
    );
  }

  // The footgun this closes: `--apply` pasted without the token IDs is a
  // perfectly legal flip that re-arms every clock, drops the sentinel, and
  // silently re-homes nobody — and re-arming is the step that cannot be run
  // again for free, so the retry costs another 90 days on every draft. A
  // no-re-home flip is a real thing to want (a second instance, a rehearsal),
  // so this asks the operator to say so rather than forbidding it.
  if (apply && reHomeApiTokenIds.length === 0 && !noReHome) {
    throw new GoPublicFlipUsageError(
      "--apply with no --re-home target would flip without re-homing anyone. Name the teammate tokens with --re-home, or pass --no-re-home if that is really what you mean."
    );
  }

  return { reHomeApiTokenIds, apply };
}

function renderInspection(inspection: GoPublicFlipInspection): string[] {
  const lines = [
    `Schema:                 ${inspection.appliedMigrations.length} applied` +
      (inspection.pendingMigrations.length > 0
        ? `, PENDING: ${inspection.pendingMigrations.join(", ")}`
        : ", none pending"),
    `Bootstrap principal:    ${
      inspection.bootstrapPrincipalPresent ? "present" : "ABSENT"
    }, holding ${inspection.bootstrapPrincipalApiTokenIds.length} token(s): ${
      inspection.bootstrapPrincipalApiTokenIds.join(", ") || "none"
    }`,
    `Pinned drafts:          ${inspection.pinnedDraftIds.join(", ") || "none"}`,
    `Anonymous sentinel:     principal ${
      inspection.anonymousSentinel.principalPresent ? "present" : "absent"
    }, token ${inspection.anonymousSentinel.tokenPresent ? "present" : "absent"}, ${
      inspection.anonymousSentinel.draftCount
    } draft(s), ${inspection.anonymousSentinel.historyRowCount} history row(s)`,
    `Drafts in service:      ${inspection.draftsInService}`,
    `Drafts out of service:  ${inspection.draftsOutOfService}`,
    `Earliest anchor:        ${inspection.earliestInServiceExpiry ?? "n/a"}`,
    "Live drafts per token (the quota applies to every line, admin included):"
  ];

  if (inspection.liveDraftTallies.length === 0) {
    lines.push("  none");
  }
  for (const tally of inspection.liveDraftTallies) {
    lines.push(
      `  ${tally.apiTokenId}  ${String(tally.liveDraftCount).padStart(5)} live  ` +
        `principal ${tally.principalId}${tally.admin ? "  [admin]" : ""}  ${tally.apiTokenName}`
    );
  }
  return lines;
}

function renderOutcome(outcome: GoPublicFlipOutcome): string[] {
  const lines = [`Flipped at:             ${outcome.flippedAt}`, "Re-homed tokens:"];
  if (outcome.reHomed.length === 0) lines.push("  none named");
  for (const token of outcome.reHomed) {
    lines.push(
      `  ${token.apiTokenId} -> ${token.principalId}` +
        `${token.alreadyReHomed ? "  (already re-homed, unchanged)" : ""}  ${token.apiTokenName}`
    );
  }
  lines.push(
    `Re-armed drafts:        ${outcome.reArmedDraftCount}`,
    `Left on their clock:    ${outcome.leftOnTheirClockCount} (deleted or disabled)`,
    `Anonymous sentinel:     ${outcome.anonymousSentinel.disposition}` +
      `, ${outcome.anonymousSentinel.draftCount} draft(s) found` +
      `, ${outcome.anonymousSentinel.reArmedDraftCount} re-armed`
  );
  return lines;
}

export async function runGoPublicFlipCommand(
  argv: readonly string[],
  log: (line: string) => void = console.log
): Promise<void> {
  const parsed = parseArguments(argv);
  const config = getServerConfig();
  const db = createPatchPageDb({
    driver: config.dbDriver,
    databaseUrl: config.databaseUrl,
    jsonDbFile: config.jsonDbFile
  });

  try {
    if (!parsed.apply) {
      log("PatchPage go-public flip — INSPECTION ONLY, nothing written.");
      log(
        `Would re-home: ${
          parsed.reHomeApiTokenIds.join(", ") ||
          "no tokens named (--apply would need --no-re-home)"
        }`
      );
      log("");
      for (const line of renderInspection(await db.inspectGoPublicFlip())) log(line);
      log("");
      log("Rerun with --apply to perform the flip. See docs/GO_PUBLIC_FLIP.md.");
      return;
    }

    const outcome = await db.applyGoPublicFlip({
      reHomeApiTokenIds: parsed.reHomeApiTokenIds
    });
    log("PatchPage go-public flip — APPLIED.");
    log("");
    for (const line of renderOutcome(outcome)) log(line);
    log("");
    log("The database as the flip left it:");
    for (const line of renderInspection(outcome.after)) log(line);
    log("");
    log("Next: flip PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS, then publish and pin the");
    log("welcome draft. See docs/GO_PUBLIC_FLIP.md.");
  } finally {
    await db.close();
  }
}

// `import.meta.main` is Node 24+; this package targets the server's Node, so
// the entry check stays on the argv comparison every version answers.
const invokedDirectly = process.argv[1]?.endsWith("go-public-flip-command.ts") === true;
if (invokedDirectly) {
  try {
    await runGoPublicFlipCommand(process.argv.slice(2));
  } catch (error) {
    if (isGoPublicFlipPreconditionError(error)) {
      console.error(`Flip refused. ${error.message}`);
      console.error("Nothing was written. Resolve the condition above and rerun.");
      process.exitCode = 1;
    } else if (error instanceof GoPublicFlipUsageError) {
      console.error(error.message);
      console.error(USAGE);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
