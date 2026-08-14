/**
 * The serving guarantees every published draft is delivered under.
 *
 * Standing rule: draft URLs are never bot-blocked, challenged, or put behind a
 * WAF human-check. Pages are share-a-link-never-be-found — `X-Robots-Tag:
 * noindex` keeps them out of search results, and that is the only measure taken
 * against discovery. Anything that makes an agent fail to fetch a pasted link is
 * a defect, not a defence.
 *
 * Readers are unwatched: no cookies, no auth or session on the serving host, and
 * a fully locked CSP with no script sources of any kind (no analytics JS).
 *
 * Cache lifetimes are keyed to URL shape and are never coupled to a CDN purge
 * API. A version URL names immutable content, so it is cached for a year; the
 * latest-draft URL follows the draft, so it gets a short window that lets an
 * update land on its own.
 */

export const DRAFT_ROBOTS_TAG = "noindex";

export const DRAFT_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "frame-src 'self' about:",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

/**
 * The report page's own policy. A served draft's CSP is a fixed promise and does
 * not move for this: `form-action 'none'` there means a form inside the draft
 * wrapper could never submit, so the footer's report link is a plain navigation
 * to a *separate* page, and that page carries the form under its own headers.
 *
 * Same shape as the draft policy in every other respect — still no script source
 * of any kind, so the flow works with JavaScript disabled — except that it may
 * post back to itself, and it has no reason to frame anything.
 */
export const REPORT_PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "base-uri 'none'",
  "form-action 'self'"
].join("; ");

/** Everything that is not a served draft — API routes included — stays uncached. */
export const NO_STORE_CACHE_CONTROL = "no-store";

const LATEST_DRAFT_CACHE_CONTROL = "public, max-age=60";

const DRAFT_VERSION_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function servedDraftCacheControl(versionNumber: number | undefined): string {
  return versionNumber === undefined ? LATEST_DRAFT_CACHE_CONTROL : DRAFT_VERSION_CACHE_CONTROL;
}
