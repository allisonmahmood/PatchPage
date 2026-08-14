# ADR-0001 — Trust model: self-service tokens, no tokenless upload

- **Status**: Accepted
- **Date**: 2026-08-14
- **Contexts**: Hosting (`apps/server`) and Publishing (`packages/cli`) — the decision spans both, so it lives in the root ADR home.
- **Source**: resolution of #90, from Wayfinder map #87; implemented by #108 and its successors under spec #106.

## Context

PatchPage is becoming a free, first-party-hosted service that is signup-less by
design. The obvious way to get there — letting anyone POST an upload with no
credential at all — is the posture the server already shipped behind
`PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`, off by default.

That posture does not survive contact with a public instance. A tokenless
upload produces a draft with no controller: nothing to rate-limit per author,
nothing to revoke when the page turns out to be abuse, nothing to attribute a
later report to. The existing implementation papered over this with sentinel
`acct_anonymous`/`tok_anonymous` principal rows that every anonymous draft was
parked under, plus an admin carve-out so a moderator could reach into that
shared bucket. One sentinel owner for all untrusted content is not an ownership
model; it is the absence of one.

Meanwhile the friction we actually wanted to remove was never the token — it
was the *signup*. An agent-driven workflow dead-ends at "get a token from the
operator", not at "send a bearer header".

## Decision

Separate the two ideas. Keep the bearer token; delete the signup.

1. **Tokenless upload is removed everywhere.** There is no upload without a
   bearer token, on any instance, under any configuration. The anonymous branch
   of the API guard, the server side of the `--anonymous` upload path, and the
   `acct_anonymous`/`tok_anonymous` sentinel principals and their seed code are
   all deleted. "Anonymous upload" is retired from the vocabulary: the new flow
   is **signup-less, not anonymous** — every draft has a controller from birth.

2. **"Anonymous allowed" is redefined as "self-service minting allowed."** When
   an instance enables it, anyone can have the server mint them a token. When
   it is off, tokens come only from an admin — today's private-instance posture,
   unchanged.

3. **Minting is a dedicated, server-side operation.** The server generates the
   token (`pp_` + random, stored as a SHA-256 hash like every other token) and
   returns the plaintext exactly once. It assigns an internal token name for
   admin legibility. Client-generated tokens were considered and rejected:
   token squatting, unverifiable entropy, and zero UX gain.

4. **Minting takes zero input.** No email, no name, no fields — no friction, and
   no fake signals we would never verify.

5. **No user-facing account concept.** Each mint creates a fresh 1:1 *principal*
   row so the existing account-scoped ownership checks are reused unchanged.
   That row is invisible plumbing, never surfaced in product language or API
   responses.

6. **Rights are own-drafts-only.** A self-service token can create drafts and
   update or delete the drafts it created. Never `admin`; it cannot mint further
   tokens. Self-minted principals carry a self-service provenance mark so
   guardrails can key on them.

7. **A lost token is unrecoverable by design.** There is no identity behind it
   to verify. Its drafts stay up until expiry or moderation, and nothing
   self-service can touch them. Admin revocation is the abuse kill switch.

8. **Retiring the old configuration is a startup failure, not a silent
   ignore.** `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` is replaced by
   `PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS` (strict bool, default `false`; the
   official instance turns it on), and
   `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE` by
   `PATCHPAGE_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE`, which governs mint rate.
   If either retired variable is set, the server refuses to start and names its
   successor.

## Consequences

**A self-hoster's deliberate security posture is never silently reinterpreted.**
This is the whole reason the rename breaks startup rather than falling back to a
default. Someone who wrote `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=false` chose a
posture; silently dropping that line and booting anyway would be the one failure
mode worse than downtime. The breaking rename is accepted deliberately: this
lands pre-launch, when there are effectively no self-hosters to break.

**Moderation gets simpler and narrower.** With no shared sentinel owner, the
admin carve-out that let admin-scoped credentials moderate anonymous-owned
drafts has no subject and is deleted. Draft disable and delete are now strictly
own-account operations; admin scope grants no cross-account reach. The
moderation loop the operator actually needs — reported draft to owning
principal, list that principal's drafts, revoke its token — is built explicitly
against real principals rather than inherited implicitly from a carve-out.

**Every draft is attributable, quota-able, and revocable from birth.** Per-token
quotas, per-IP mint limits, expiry clocks, and report-driven takedown all have a
subject to attach to. None of them were expressible against a sentinel.

**The CLI absorbs the friction instead of the user.** "No token configured" stops
being a dead end and becomes an auto-mint: the CLI mints, saves, announces, and
continues the upload. The user hears "your publishing key, saved on this
machine" and never learns the word token. That UX is specified separately; this
ADR only guarantees the server side it stands on.

**Self-hosting is untouched.** Self-service minting is off by default, so a
private instance keeps its admin-only token posture exactly as before. Nothing
here redirects a self-hoster's drafts or tokens to the official instance.

**A future accounts service has a hook, not a commitment.** The 1:1 principal
rows are where managed accounts could later hang. Building on them is a separate
effort and explicitly out of scope.

## Alternatives considered

- **Keep tokenless upload, add abuse controls on top.** Rejected: per-IP limits
  are the only lever available without an author identity, and they are both too
  blunt for legitimate shared networks and too weak against a rotating source.
  Nothing revocable exists after the fact.
- **Client-generated tokens** (the caller picks its own secret). Rejected: token
  squatting, unverifiable entropy, and no UX gain over the server minting one.
- **Per-draft edit keys** rather than a per-author token. Rejected: it splits a
  user's identity across every page they publish, makes "all my pages" an
  unanswerable question, and forecloses the self-rotation the principal model
  supports.
- **Real signup** (email, verification). Rejected: it reintroduces exactly the
  friction this service exists to remove, and produces a signal we would never
  actually verify.

## Follow-ups

The mint operation itself, the CLI auto-mint UX and `--anonymous` deprecation,
the guardrails keyed on the provenance mark, and the flip-time handling of
pre-existing sentinel rows are each separate tickets under spec #106. This ADR
records the model; #108 retires the old posture and establishes the new
configuration surface.
