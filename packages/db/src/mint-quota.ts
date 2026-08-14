/**
 * The self-service mint quota's clock — how many tokens one source address may
 * be handed, and over what stretch of time.
 *
 * The quota is a database count, not a counter in memory, so it survives a
 * restart: the rule is that long-window limits derive from stored rows and only
 * per-minute limits stay in process. The ceiling itself is configuration
 * (`selfServiceMintsPerIpPerDay`); this module owns only the window, and both
 * drivers answer to it so the two agree by construction.
 *
 * The window is a **rolling** 24 hours ending now, not a calendar day. A
 * calendar day resets at one instant every client can predict, which turns
 * "five a day" into "ten across midnight" for anyone willing to wait; a rolling
 * window has no such seam. It also needs no timezone, which a calendar day
 * would — and the answer to "whose midnight" is not one worth having.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back a mint still counts against its source address's quota. */
export const SELF_SERVICE_MINT_QUOTA_WINDOW_MS = DAY_MS;

/**
 * The oldest mint instant that still counts at `now`, as a value a driver can
 * compare a stored timestamp against.
 */
export function mintQuotaWindowStart(now: number): string {
  return new Date(now - SELF_SERVICE_MINT_QUOTA_WINDOW_MS).toISOString();
}

/** Whether a mint recorded at `createdAt` still counts against the quota at `now`. */
export function countsTowardMintQuota(createdAt: string, now: number): boolean {
  return Date.parse(createdAt) >= now - SELF_SERVICE_MINT_QUOTA_WINDOW_MS;
}
