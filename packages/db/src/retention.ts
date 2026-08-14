/**
 * The retention clock — how long a draft stays up, and what moves it.
 *
 * Retention is the clock; expiry is the consequence. Every draft carries one
 * expiry anchor and three rules act on it:
 *
 * - a new version upload resets the anchor to the full retention window;
 * - a served visit with less than the visit-extension window remaining moves
 *   the anchor to exactly that window out — a visit never shortens the clock,
 *   and never revives a draft whose clock already ran out;
 * - the expiry check is `expiresAt < now`, and nothing else.
 *
 * Both drivers answer to these functions so the two agree by construction.
 * The Postgres driver restates the visit rule as one SQL predicate; the
 * equivalence is asserted by the driver-parametrized contract suite, not by
 * inspection.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window an upload gives a draft. */
export const DRAFT_RETENTION_WINDOW_MS = 90 * DAY_MS;

/** What a visit tops the remaining time up to, when less than this remains. */
export const DRAFT_VISIT_EXTENSION_WINDOW_MS = 30 * DAY_MS;

/** The anchor a draft carries after an upload at `now`. */
export function expiryAfterUpload(now: number): string {
  return new Date(now + DRAFT_RETENTION_WINDOW_MS).toISOString();
}

/**
 * The anchor a visit at `now` moves the draft to, or `null` when the visit
 * changes nothing — because more than the visit-extension window still remains,
 * or because the draft has already expired and a visit cannot bring it back.
 */
export function expiryAfterVisit(expiresAt: string, now: number): string | null {
  if (hasExpired(expiresAt, now)) return null;

  const toppedUp = now + DRAFT_VISIT_EXTENSION_WINDOW_MS;
  if (!(Date.parse(expiresAt) < toppedUp)) return null;
  return new Date(toppedUp).toISOString();
}

/** The expiry check: a draft is gone from the moment `expiresAt` is in the past. */
export function hasExpired(expiresAt: string, now: number): boolean {
  return Date.parse(expiresAt) < now;
}
