/**
 * The two principals this store names by a fixed ID rather than a generated
 * one. Everything else — every self-service mint, every re-homed teammate —
 * gets a `newInternalId` and is found by lookup.
 *
 * A fixed ID is a contract with a deployed database, so these strings live in
 * one place: the drivers seed the bootstrap pair from here, and the go-public
 * flip's assert-and-drop finds the retired sentinel pair from here. Spelling
 * either one inline a second time is how the two copies drift.
 */

/** The operator's own principal, seeded by `initialize` when a bootstrap token is configured. */
export const BOOTSTRAP_PRINCIPAL_ID = "acct_bootstrap";

/** The bootstrap admin token. Seeded alongside the principal above, and never re-homed. */
export const BOOTSTRAP_API_TOKEN_ID = "tok_bootstrap";

/**
 * The retired anonymous-upload sentinel principal and its internal token.
 *
 * Nothing creates these any more — the trust-model cutover removed tokenless
 * upload and the seeding behind it, so a database built after that never had
 * them. A database that predates it still holds the rows, and the go-public
 * flip is what finally takes them: it asserts the sentinel owns no drafts, then
 * drops both rows. They are named here and nowhere else.
 */
export const RETIRED_ANONYMOUS_PRINCIPAL_ID = "acct_anonymous";
export const RETIRED_ANONYMOUS_API_TOKEN_ID = "tok_anonymous";
