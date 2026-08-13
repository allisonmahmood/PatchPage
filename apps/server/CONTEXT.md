# Hosting

The service that receives uploads and serves published pages. Includes its supporting packages `@patchpage/db`, `@patchpage/storage`, and `@patchpage/config`.

## Language

**Self-service token**:
An auth token the server mints for anyone who asks, on instances that allow it; it controls exactly the drafts it creates.
_Avoid_: anonymous token, first-run token

**Self-service minting**:
The zero-input, server-side operation that creates a self-service token and returns its plaintext exactly once.
_Avoid_: signup, registration, anonymous uploads (retired — there is no upload without a token)

**Principal**:
The internal ownership row behind a token, one per self-service mint. Plumbing, never surfaced to users.
_Avoid_: account (in product language)

**Draft expiry**:
The guardrail that removes a draft for good when its retention clock runs out. An upload resets the clock to the full window; a visit tops the remaining time up to the visit-extension window. Expiry is a hard delete — content and record both gone, no recovery — and applies to every draft regardless of who owns it, unless the draft is pinned.
_Avoid_: soft delete, archival, retention (for the act of deleting — retention is the clock, expiry is the consequence)

**Pinned draft**:
A draft exempted from expiry by an operator, for pages the instance itself maintains (welcome page, docs). Pinning is an admin-only act; a pinned draft is otherwise an ordinary draft.
_Avoid_: permanent draft, system page

**Revocation**:
An operator's act of permanently disabling an auth token. Revoked is a state the token enters, never a deletion — the record of where and when it was minted survives for later review. A revoked token can do nothing; its drafts stay up until draft expiry, but their clock only runs down from that moment: visits no longer top it up, and nothing self-service can touch them again.
_Avoid_: ban, token deletion

**Report**:
A reader's flag on a served draft asking the operator to review it. Filing one is acknowledged immediately and has no automatic consequence; disabling, deleting, or revoking is always an operator decision.
_Avoid_: takedown request (a report may lead to a takedown; it is not one)

**Serving guarantee**:
A fixed promise about how a published draft reaches its reader, binding on every served response. There are four, and they hold together: pages are **share-a-link-never-be-found** (`X-Robots-Tag: noindex` keeps them out of search results, and that is the only measure taken against discovery); readers are **unwatched** (no cookies, no auth or session on the serving host, a fully locked CSP with no script sources and so no analytics JavaScript); draft URLs are **open to machines** — never bot-blocked, challenged, or put behind a WAF human-check, because an agent handed a pasted link must be able to fetch it; and caching is **keyed to URL shape** — a version URL names content that can never change, so it is cached for a year and marked immutable, while the latest-draft URL follows the draft and gets a short window that lets an update land on its own. Everything else, API routes included, stays `no-store`. A cache lifetime is never coupled to a CDN purge API: the window expiring is the only invalidation there is.
_Avoid_: hardening, bot protection (the serving surface is deliberately open to machines), private (unlisted is not private)

**Circuit breaker**:
The spend threshold beyond which the instance is no longer willing to operate. Crossing it fires the kill switch automatically; no human confirms first.
_Avoid_: budget alert (an alert informs; the breaker acts)

**Kill switch**:
The automated act that takes the public instance fully offline — serving and uploads both — the moment the circuit breaker trips. Fail-closed by design: the instance goes dark rather than absorbing unbounded cost. Bringing it back is always an operator decision.
_Avoid_: maintenance mode, degraded mode (the kill switch is total, not partial)
