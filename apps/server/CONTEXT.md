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

**Live draft**:
A draft that still counts against its creator's quota: neither deleted nor disabled. A draft leaves the tally the moment it is deleted or disabled, and for good when expiry hard-deletes it. Which token created it is fixed at creation; a later update by another token never moves it.
_Avoid_: active draft, published draft (every draft is published), open draft

**Draft quota**:
The ceiling on live drafts one token may hold at once. Counted from the database on every create, so it survives a restart — unlike the per-minute create limit, which is in-memory and may reset. Per token, not per account, and uniform: no exemption for admin tokens.
_Avoid_: draft limit (ambiguous with the per-minute create limit), storage quota (this counts drafts, not bytes)

**Pinned draft**:
A draft exempted from expiry by an operator, for pages the instance itself maintains (welcome page, docs). Pinning is an admin-only act; a pinned draft is otherwise an ordinary draft.
_Avoid_: permanent draft, system page

**Revocation**:
An operator's act of permanently disabling an auth token. Revoked is a state the token enters, never a deletion — the record of where and when it was minted survives for later review. A revoked token can do nothing; its drafts stay up until draft expiry, but their clock only runs down from that moment: visits no longer top it up, and nothing self-service can touch them again.
_Avoid_: ban, token deletion

**Report**:
A reader's flag on a served draft asking the operator to review it. Filing one is acknowledged immediately and has no automatic consequence; disabling, deleting, or revoking is always an operator decision.
_Avoid_: takedown request (a report may lead to a takedown; it is not one)

**Circuit breaker**:
The spend threshold beyond which the instance is no longer willing to operate. Crossing it fires the kill switch automatically; no human confirms first.
_Avoid_: budget alert (an alert informs; the breaker acts)

**Kill switch**:
The automated act that takes the public instance fully offline — serving and uploads both — the moment the circuit breaker trips. Fail-closed by design: the instance goes dark rather than absorbing unbounded cost. Bringing it back is always an operator decision.
_Avoid_: maintenance mode, degraded mode (the kill switch is total, not partial)
