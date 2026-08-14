/**
 * The go-public flip — the one-shot data surgery that turns the maintainer's
 * private instance into the public one, at a single moment in time.
 *
 * This is deliberately **not** a schema migration. A migration is a property of
 * the schema every deployment shares, and it runs on a self-hoster's database
 * the next time their server starts. Nothing here is like that: it re-homes
 * three named tokens on one instance, re-arms one instance's retention clocks,
 * and drops rows only that instance ever had. It is one operator's act against
 * one database, so it is a port operation an operator invokes on purpose, and
 * `pnpm db:migrate` will never reach it.
 *
 * Four things happen together, and this module owns the rules for all of them.
 *
 * **Re-home.** Each named token moves from the bootstrap principal onto a fresh
 * principal of its own — the same 1:1 shape a self-service mint produces, which
 * is the whole point: the account-scoped ownership checks are then already
 * correct, with no second authorization model anywhere. The token itself is
 * untouched. Its holder keeps publishing with it and owns everything they make
 * from here; what they lose is edit rights over the drafts they made before,
 * because those drafts stay on the bootstrap principal. That consequence is
 * accepted, not a bug: a cached draft mapping from before the flip will start
 * failing its update, and nothing here should "fix" that.
 *
 * **Re-arm.** Every draft in service is treated as having been uploaded at the
 * flip moment, so it leaves with a whole retention window ahead of it. Drafts
 * already out of service — deleted or disabled — keep the clock they had, so
 * the sweep still reclaims their storage on schedule; re-arming those would
 * hold content nobody can reach for another 90 days at exactly the moment cost
 * starts mattering. Only the anchor moves: `updatedAt` still means "when the
 * content last changed", and backdating that would make every page on the
 * instance look freshly edited.
 *
 * **Assert and drop.** The retired anonymous sentinel principal must own no
 * drafts. When it owns none and no version or upload event still names its
 * token, both rows go. When it owns some, the drop is deferred and those drafts
 * get revoked-style treatment instead — a full window from the flip like every
 * other draft in service, with top-ups already frozen because the sentinel
 * token has carried a revocation stamp since the day it was seeded.
 *
 * **Leave alone.** The operator's own upload tokens and the bootstrap admin
 * token stay exactly where they are, and nothing is pinned: the welcome draft
 * is the instance's first pin, set through the admin pin surface after the flip
 * and not by this operation.
 *
 * Quotas need no step here at all, and that is the point of checking them: the
 * live-draft ceiling is recounted from the database on every create and the
 * mint ceiling is counted at mint time, so both start applying to every
 * pre-existing token — the bootstrap admin token included — the moment the flip
 * lands. The inspection tallies live drafts per token so an operator can *see*
 * that uniformity rather than trust it.
 */

import { BOOTSTRAP_PRINCIPAL_ID } from "./internal-principals.js";
import { SCHEMA_MIGRATION_IDS } from "./migrations.js";

/**
 * Why a flip refused. Each one is a state the operator has to resolve before
 * the flip is safe to run, never something this operation should work around.
 */
export type GoPublicFlipPreconditionCode =
  | "migrations_pending"
  | "bootstrap_principal_missing"
  | "rehome_target_unknown"
  | "rehome_target_is_bootstrap_token"
  | "rehome_target_has_admin_scope"
  | "rehome_target_principal_shared"
  | "draft_already_pinned";

/**
 * A refused flip. Nothing has been written when this is thrown: every
 * precondition is checked before the first mutation, inside the same
 * transaction or state mutation the surgery would have used.
 */
export class GoPublicFlipPreconditionError extends Error {
  constructor(
    readonly code: GoPublicFlipPreconditionCode,
    readonly detail: string
  ) {
    super(`${PRECONDITION_SENTENCES[code]} ${detail}`);
    this.name = "GoPublicFlipPreconditionError";
  }
}

export function isGoPublicFlipPreconditionError(
  error: unknown
): error is GoPublicFlipPreconditionError {
  return error instanceof GoPublicFlipPreconditionError;
}

/**
 * One sentence per refusal, naming the cause and the next action — the same
 * rule the CLI's errors follow, for the same reason: the operator reading this
 * is mid-flip and needs to know what to do, not what went wrong internally.
 *
 * They live here rather than in either driver so the two refuse identically.
 */
const PRECONDITION_SENTENCES: Record<GoPublicFlipPreconditionCode, string> = {
  migrations_pending:
    "The database is not at the current schema, so the flip would run against columns that may not exist. Deploy the current server or run pnpm db:migrate first. Pending:",
  bootstrap_principal_missing:
    "The bootstrap principal is absent, so there is nothing to re-home tokens off. Start the server once with PATCHPAGE_BOOTSTRAP_API_TOKEN set, then rerun. Expected principal:",
  rehome_target_unknown:
    "A token named for re-homing does not exist in this database. Check the IDs against the private token record and rerun. Unknown:",
  rehome_target_is_bootstrap_token:
    "The bootstrap admin token is never re-homed — it stays on the bootstrap principal with the operator's own upload tokens. Remove it from the re-home list and rerun. Named:",
  rehome_target_has_admin_scope:
    "A token named for re-homing carries the admin scope, and re-homing it would put admin reach on a principal outside the operator's. Revoke or re-scope it first, or drop it from the list. Named:",
  rehome_target_principal_shared:
    "A token named for re-homing is already off the bootstrap principal but shares that principal with other tokens, so it is neither pre-flip nor already re-homed. Resolve it by hand before flipping. Named:",
  draft_already_pinned:
    "A draft is already pinned, and the flip expects the welcome draft to be the instance's first pin. Unpin it through the admin surface, or accept it deliberately and rerun. Pinned:"
};

/** The shipped migration IDs this database is still missing, in apply order. */
export function pendingMigrationIds(applied: readonly string[]): string[] {
  const recorded = new Set(applied);
  return SCHEMA_MIGRATION_IDS.filter((id) => !recorded.has(id));
}

/**
 * What the flip should do with one named token, given the principal it sits on
 * and how many tokens share that principal.
 *
 * `already` is what makes a second run a no-op: a token that has been re-homed
 * is alone on a principal that is not the bootstrap one, which is exactly the
 * state this operation puts it in. That reading is deliberately structural
 * rather than a marker column — the property the flip cares about is "this
 * token controls its own principal", and a token that always sat alone
 * somewhere else already satisfies it.
 */
export type ReHomeDisposition = "rehome" | "already" | "shared";

export function reHomeDisposition(
  principalId: string,
  tokensOnPrincipal: number
): ReHomeDisposition {
  if (principalId === BOOTSTRAP_PRINCIPAL_ID) return "rehome";
  return tokensOnPrincipal === 1 ? "already" : "shared";
}

/** Whether a draft row is in service — the set the flip re-arms. */
export function isInService(draft: {
  deletedAt: string | null;
  disabledAt: string | null;
}): boolean {
  return draft.deletedAt === null && draft.disabledAt === null;
}
