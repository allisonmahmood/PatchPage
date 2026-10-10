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

**Expiry sweep**:
The job that carries draft expiry out: it takes every draft whose clock has run out and no pin holds, deletes the record and the content behind it, and leaves nothing to restore. It runs in the serving process against the same clock the rest of the instance reads, is safe to run repeatedly and while serving, and is the moment a draft stops costing storage and stops counting against its creator's quota. A draft is expired the moment its clock runs out; the sweep is only when the row and the bytes actually go.
_Avoid_: cleanup job, garbage collection, reaper, purge

**Visit**:
One successful serving of a draft page, at either its latest or a version URL. A visit is the only thing besides an upload that moves a retention clock, and it only ever moves it forward: with less than the visit-extension window left it tops the draft up to exactly that window, and otherwise changes nothing at all. A visit never brings back a draft that has already expired.
_Avoid_: view, hit, page load (a visit is a serving that succeeded, not a request that arrived)

**Live draft**:
A draft that still counts against its creator's quota: neither deleted nor disabled. A draft leaves the tally the moment it is deleted or disabled, and for good when expiry hard-deletes it — an expired draft still counts until the sweep removes it, because its row and its stored content are both still there. Which token created it is fixed at creation; a later update by another token never moves it.
_Avoid_: active draft, published draft (every draft is published), open draft

**Mint record**:
The row a self-service mint leaves behind: which principal and token were created, from what source address, and when. It is what the mint quota counts, and it outlives revocation — a token can be turned off, but where it came from stays reviewable.
_Avoid_: audit log, signup record

**Mint quota**:
The ceiling on self-service mints one source address may be handed. Counted from the database at mint time over a rolling day, so it survives a restart — unlike the per-minute mint rate, which is in-memory and may reset. Mints the server could not attribute to an address share one bucket rather than each escaping the count.
_Avoid_: mint limit (ambiguous with the per-minute mint rate), signup limit

**Draft quota**:
The ceiling on live drafts one token may hold at once. Counted from the database on every create, so it survives a restart — unlike the per-minute create limit, which is in-memory and may reset. Per token, not per account, and uniform: no exemption for admin tokens.
_Avoid_: draft limit (ambiguous with the per-minute create limit), storage quota (this counts drafts, not bytes)

**Pinned draft**:
A draft exempted from expiry by an operator, for pages the instance itself maintains (welcome page, docs). Pinning is an admin-only act; a pinned draft is otherwise an ordinary draft — served, updatable by its owner, counted against its creator's quota. The clock keeps running underneath the pin and visits keep topping it up, so unpinning hands the draft back to whatever time it had left: a page still being read keeps its visit window, and one nobody has read in months expires at once. A pin only ever holds a draft that is in service: deleting or disabling one ends its pin, and a draft already deleted or disabled cannot be pinned — moderation and deletion outrank a pin, so neither can leave content the sweep may never take.
_Avoid_: permanent draft, system page

**Revocation**:
An operator's act of permanently disabling an auth token. Revoked is a state the token enters, never a deletion — the record of where and when it was minted survives for later review. A revoked token can do nothing; its drafts stay up until draft expiry, but their clock only runs down from that moment: visits no longer top it up, and nothing self-service can touch them again.
_Avoid_: ban, token deletion

**Report**:
A reader's flag on a served draft asking the operator to review it. Filing one is acknowledged immediately and has no automatic consequence; disabling, deleting, or revoking is always an operator decision. Filing is rate limited per source address per minute, which bounds how many rows one address can write and nothing more — being limited is never a judgement about the page, and no volume of reports moves the operator's hand.
_Avoid_: takedown request (a report may lead to a takedown; it is not one)

**Serving guarantee**:
A fixed promise about how a published draft reaches its reader, binding on every served response. There are four, and they hold together: pages are **share-a-link-never-be-found** (`X-Robots-Tag: noindex` keeps them out of search results, and that is the only measure taken against discovery); readers are **unwatched** (no cookies, no auth or session on the serving host, a fully locked CSP with no script sources and so no analytics JavaScript); draft URLs are **open to machines** — never bot-blocked, challenged, or put behind a WAF human-check, because an agent handed a pasted link must be able to fetch it; and caching is **keyed to URL shape** — a version URL names content that can never change, so it is cached for a year and marked immutable, while the latest-draft URL follows the draft and gets a short window that lets an update land on its own. Everything else, API routes included, stays `no-store`. A cache lifetime is never coupled to a CDN purge API: the window expiring is the only invalidation there is.
_Avoid_: hardening, bot protection (the serving surface is deliberately open to machines), private (unlisted is not private)

**Analytics event**:
One business moment the instance reports to itself: a token minted, a draft created, updated, reported, disabled, deleted, or expired. Server-side and nothing else — a served draft carries no analytics JavaScript, so a **visit is never one**, and no event carries a reader's address, the sentence they typed, page content, a filename, or a URL. Reporting is fire-and-forget: a failure is a line in the log and no difference at all to the response. An instance with no key configured reports nothing, which is the default and the private-instance posture.
_Avoid_: telemetry, tracking, pageview, metric (an analytics event names what happened in the domain, not what the process measured)

**Circuit breaker**:
The spend threshold beyond which the instance is no longer willing to operate. Crossing it fires the kill switch automatically; no human confirms first.
_Avoid_: budget alert (an alert informs; the breaker acts)

**Kill switch**:
The automated act that takes the public instance fully offline — serving and uploads both — the moment the circuit breaker trips. Fail-closed by design: the instance goes dark rather than absorbing unbounded cost. Bringing it back is always an operator decision.
_Avoid_: maintenance mode, degraded mode (the kill switch is total, not partial)
