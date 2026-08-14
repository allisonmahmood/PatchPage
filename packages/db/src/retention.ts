/**
 * The retention clock — how long a draft stays up, and what moves it.
 *
 * Retention is the clock; expiry is the consequence. Every draft carries one
 * expiry anchor and four rules act on it:
 *
 * - a new version upload resets the anchor to the full retention window;
 * - a served visit with less than the visit-extension window remaining moves
 *   the anchor to exactly that window out — a visit never shortens the clock,
 *   and never revives a draft that has already expired;
 * - the clock check is `expiresAt < now`, and nothing else;
 * - a pinned draft is never expired, however far past its anchor now is. The
 *   pin is the whole exemption: it is why a pinned draft keeps serving and why
 *   the sweep leaves it alone, and unpinning simply hands the draft back to the
 *   clock it was always carrying.
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

/** What retention needs to know about a draft: its anchor, and its pin. */
export interface RetainedDraft {
  expiresAt: string;
  /** When an operator pinned the draft, or `null` for an ordinary one. */
  pinnedAt: string | null;
}

/** The anchor a draft carries after an upload at `now`. */
export function expiryAfterUpload(now: number): string {
  return new Date(now + DRAFT_RETENTION_WINDOW_MS).toISOString();
}

/**
 * The anchor a visit at `now` moves the draft to, or `null` when the visit
 * changes nothing — because more than the visit-extension window still remains,
 * or because the draft has expired and a visit cannot bring it back.
 *
 * A pinned draft is never expired, so a visit tops it up like any other: the
 * clock keeps running underneath the pin, which is what leaves a still-read
 * page a window to live in if it is ever unpinned.
 */
export function expiryAfterVisit(draft: RetainedDraft, now: number): string | null {
  if (isExpired(draft, now)) return null;

  const toppedUp = now + DRAFT_VISIT_EXTENSION_WINDOW_MS;
  if (!(Date.parse(draft.expiresAt) < toppedUp)) return null;
  return new Date(toppedUp).toISOString();
}

/**
 * The expiry check: a draft is expired from the moment `expiresAt` is in the
 * past, unless a pin holds it. Everything expiry means keys on this one
 * answer — an expired draft stops serving, refuses updates, and is what the
 * sweep hard-deletes.
 *
 * There is deliberately no term here for deleted or disabled drafts, because a
 * pin only ever sits on a draft that is in service: the store clears the pin
 * when a draft is deleted or disabled, and refuses to pin one that already is.
 * That invariant is what keeps this a single rule — without it, a pin on a
 * taken-down draft would exempt storage nobody can ever reach from the sweep.
 */
export function isExpired(draft: RetainedDraft, now: number): boolean {
  if (draft.pinnedAt !== null) return false;
  return hasClockRunOut(draft.expiresAt, now);
}

/** The clock alone, with no pin in the question: `expiresAt < now`. */
function hasClockRunOut(expiresAt: string, now: number): boolean {
  return Date.parse(expiresAt) < now;
}
