# The go-public flip

The one-time operation that turns the maintainer's private PatchPage instance
into the free public service: a data surgery, an environment change, and a
first pinned page, in that order.

This runbook is for the operator executing the flip. It is written to be read
start to finish before anything is run — several of its steps are irreversible,
and the order is load-bearing. The decisions behind every step were settled in
issue #105 and recorded in the spec, #106; where this file states a consequence
as **accepted**, that is a decision already made and not a problem to solve
during the flip.

## What the flip is, and what it is not

**Is:** three teammate tokens move onto principals of their own, every draft in
service gets a fresh 90-day clock as if it had just been uploaded, the retired
anonymous sentinel rows go, `PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS` turns on, and
the welcome draft becomes the instance's first pinned page.

**Is not:** a schema migration. Nothing here runs on a self-hoster's database,
ever. `pnpm db:migrate` does not reach it, the server does not run it at
startup, and a self-hosted deployment that pulls this release is unaffected.
The flip is one operator's act against one database.

**Is not:** reversible as a whole. See [Rollback posture](#rollback-posture)
before you start.

### The accepted consequence, stated once

The three teammates keep their tokens and lose edit rights over the drafts they
published before the flip. Those drafts stay on the operator's bootstrap
principal — that is the point of an in-place flip — so **each teammate's cached
draft mappings will start erroring on update**. A `patchpage upload` against a
pre-flip draft will report the draft as unavailable, and re-uploading with
`--new` creates a fresh draft the teammate then owns.

Do not "fix" this at flip time. Do not move drafts, do not hand out admin
scope, do not clear anyone's local cache for them. Tell the teammates what
happened and what to do (`--new`, or ask the operator to update a page that
must keep its URL). This is step 9.

## Before you start

### Launch-blocking guardrails, verified live

Every one of these must be true of the **running production instance**, not of
the repository. Verify each against the live origin; a merged PR is not
evidence.

- [ ] **Draft expiry and the sweep are running.** The sweep is in-process and
      hourly (`apps/server/src/expiry-sweep.ts`, scheduled in `start.ts`), so
      "running" means the current revision is deployed and has been up long
      enough to have swept once. Confirm from the container logs.
- [ ] **Quotas are enforced.** `PATCHPAGE_LIVE_DRAFTS_PER_TOKEN` and the
      per-minute limits are set on the live revision. The live-draft ceiling is
      recounted from the database on every create, so a restart does not reset
      it; the per-minute limits are in memory and do.
- [ ] **The report path serves.** A served draft's footer carries the report
      link, and `POST /report/:draftId` acknowledges and stores.
- [ ] **Serving guarantees hold.** `X-Robots-Tag: noindex` on served drafts,
      the immutable cache header on version URLs, the 60-second window on
      latest URLs, `no-store` on API routes, no cookies.
- [ ] **Analytics events are flowing.** Token minted, draft created, updated,
      reported, disabled, deleted, expired.
- [ ] **The kill switch is armed and drilled.** See step 3.
- [ ] **Replicas are min 1 / max 1.** The in-memory rate limiter is correct only
      on a single replica. This is a standing invariant, not a setting.
- [ ] **The skill onboarding is merged to the default branch (#122, #123).**
      This is #106's rollout step 1 and it gates step 2, which is what this
      runbook choreographs. The order is load-bearing rather than tidy: the
      skills CLI installs straight from the default branch, live and
      unversioned, so a user who follows the setup prompt the moment the
      instance opens gets whatever is on `main` at that second. Opening the
      instance first means the first arrivals onboard against a skill that
      does not exist yet.

### Two known gaps that are not this repository's server code

Both were raised during the work leading up to the flip and neither is closed
by the change that added this runbook. Decide on each before flipping.

- [ ] **No per-IP rate limit on the report endpoint.** `GET/POST /report/:draftId`
      is unauthenticated by design and is **the only unauthenticated write on
      the service**. PR #138 shipped it deliberately without a limiter — #106's
      quota section enumerates the service's limits exhaustively and reports are
      not among them — and the review on that PR flagged, and the operator
      agreed, that it should not stay that way through the flip.

      What already bounds it: the draft must be servable, so an unknown,
      deleted, disabled, or expired ID is a 404 that writes nothing; the form
      body is capped at 8 KiB; the stored reason is capped at 255 characters by
      both drivers. What is **not** bounded is volume from one address against a
      real draft. There is no correctness risk — reports have no automatic
      consequence, so this can never take a page down — but on a free service
      behind a $200 circuit breaker it is unbounded row growth and write load
      for the cost of a loop.

      The fix is small and fits the existing rule that only per-minute limits
      live in memory: a fourth `FixedWindowRateLimiter` in
      `apps/server/src/rate-limit.ts` keyed by source address, with its own
      config knob to match house style. **Treat it as launch-blocking**, and
      land it in the same change that turns `PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS`
      on — that is when the instance becomes worth abusing. It is out of scope
      for the ticket that wrote this runbook (#124), so it needs its own.

- [ ] **The CLI's default-host hint still says the instance issues no public
      tokens.** `defaultHostHint` in `packages/cli/src/index.ts` prints
      "`post.patchyhq.com` is the maintainer's private instance and does not
      issue public tokens" on a 401 or 403 against the default host. `whoami`
      was already made posture-neutral, but this string was not, and it is
      wrong the moment the flip lands.

      #106 puts this flip in **step 2's change**, so leaving the string live
      across the environment flip publishes a claim about the service that is
      no longer true — a user who hits a 401 is told the instance issues no
      public tokens at the moment it does. Correcting it needs a CLI release,
      not a server change, which is exactly why it cannot be fixed during the
      flip and has to be settled before it.

      **Treat this as a hard gate, not a cosmetic follow-up:** either confirm
      the CLI release (#121) shipped the corrected copy, or ship that
      correction first. The blast radius is genuinely small — auto-mint does
      not go through this path, and after the flip a 401/403 on the default
      host means a bad token — but "small and published" is still published.

      The same stale framing lives in `README.md`, `packages/cli/README.md`,
      `docs/SELF_HOSTING.md` and the skill. Those are #126's, which runs after
      the flip by design.

### Records to have open

Have the private records to hand before step 4. None of these values belong in
a commit, an issue, a PR, or a chat message.

| Record                                     | Why                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| The three teammate api-token IDs           | The flip re-homes exactly the tokens you name and never guesses which are somebody else's |
| The operator's two upload token IDs        | To confirm they were left on the bootstrap principal                                      |
| `DATABASE_URL` for the production database | The flip script connects directly; the release identity deliberately cannot               |
| The verified deployment and state records  | `infrastructure-change` needs them in step 6                                              |
| `PATCHPAGE_BOOTSTRAP_API_TOKEN`            | Publishing and pinning the welcome draft in step 7                                        |

## The flip

### 1. Take a database recovery point

The data surgery is not undoable in place. Confirm the PostgreSQL flexible
server's backup retention covers the moment before the surgery, and record the
exact timestamp you are about to run at as the restore target. See
[Backups and data durability](../infra/azure/README.md#backups-and-data-durability):
source-local retention is not an independent backup, and a restore you have not
drilled is not a restore.

### 2. Choose a quiet window

The instance keeps serving throughout. Two races are worth knowing about, and
neither is dangerous:

- A **visit** landing during the surgery only ever moves a clock forward, and
  the surgery's re-arm is a full window from the flip. Nothing is lost either
  way.
- A **teammate upload** landing between the surgery's start and their token
  moving would create a draft on the bootstrap principal — one more page they
  cannot edit afterwards. The re-home holds a row lock, so the outcome is one
  or the other, never half. Pick a window when nobody is publishing.

### 3. Run the kill-switch fire drill

Rehearse it **before** the instance is public, following
[Kill switch fire drill](../infra/azure/README.md#kill-switch-fire-drill):
fire the action, observe the instance go dark, note that the automation holds
no start permission, restore as the operator, verify service is back.

Record how long steps 1 through 5 of that drill took. That number is the
instance's real recovery time, and it belongs in the flip record.

### 4. Inspect, before anything is written

The flip script's default mode writes nothing. Run it and read the report
before you run it with `--apply`.

```txt
PATCHPAGE_DB_DRIVER=postgres \
DATABASE_URL=<the production database URL> \
pnpm --filter @patchpage/db db:go-public-flip -- \
  --re-home <teammate-token-id-1>,<teammate-token-id-2>,<teammate-token-id-3>
```

Check the report against the private records before continuing:

- **Schema** reports none pending. A pending migration is a refusal, not a
  warning: deploy the current server first.
- **Bootstrap principal** holds exactly the bootstrap admin token plus the
  operator's two upload tokens plus the three teammate tokens — six in total.
  If a token you do not recognise is on that list, stop and identify it.
- **Pinned drafts** is `none`. Nothing pre-existing is pinned; the welcome
  draft is the first pin, and the flip refuses if that is not true.
- **Anonymous sentinel** reports `0 draft(s)`. This is the assert. A nonzero
  count is not a failure — the flip handles it, see below — but it is a surprise
  worth understanding before you accept it.
- **Live drafts per token** lists the bootstrap admin token with a count like
  any other line. That is the quota uniformity check: there is no exemption
  anywhere, and the ceiling starts applying to every one of these tokens the
  moment the flip lands. Any token already over `PATCHPAGE_LIVE_DRAFTS_PER_TOKEN`
  keeps its drafts and cannot create more, which is the intended retroactive
  effect.

### 5. Apply the surgery

Same command, plus `--apply`. It performs the surgery once and then prints the
same inspection of what it left.

```txt
PATCHPAGE_DB_DRIVER=postgres \
DATABASE_URL=<the production database URL> \
pnpm --filter @patchpage/db db:go-public-flip -- \
  --re-home <teammate-token-id-1>,<teammate-token-id-2>,<teammate-token-id-3> \
  --apply
```

`--apply` is required rather than defaulted because re-arming is the one step
that is not idempotent: a second `--apply` moves every retention anchor forward
again. That is survivable — it grants another 90 days, it does not delete
anything — but it is not what you meant, so do not rerun it casually.

For the same reason `--apply` **refuses when no `--re-home` target is named**.
A command pasted without the token IDs is otherwise a perfectly legal flip that
re-arms every clock, drops the sentinel, and silently re-homes nobody — and the
correcting rerun is the expensive one. If a flip really should re-home nobody,
say `--no-re-home` and it proceeds.

What it does, in one transaction:

1. **Re-homes** each named token onto a fresh principal of its own, exactly the
   1:1 shape a self-service mint produces. The token itself is untouched — same
   secret, same name, same scopes — and its holder keeps publishing with it.
   The new principal carries the self-service provenance mark and a mint record
   names it, so anything keyed on that provenance reaches a re-homed token too.

   **Know the one cost of that mint record.** It carries no source address,
   because no caller asked for the token — and the per-address mint quota
   counts unattributable mints in a single bucket. Three re-homes therefore
   occupy **3 of the 5** slots in that bucket for a rolling 24 hours after the
   flip. In practice it should bind on nothing: with `trust_proxy = null` the
   socket peer is always present, so real mints are attributed and never land
   in that bucket. If proxy attribution is wrong, the next two unattributable
   mints succeed and the third is refused for a day — fail-closed, and a
   symptom worth chasing rather than a hole.
2. **Leaves the operator's tokens alone.** The bootstrap admin token is refused
   as a re-home target outright, and any admin-scoped token is too. The
   operator's two upload tokens stay on the bootstrap principal because you did
   not name them.
3. **Re-arms** every draft **in service** to a full 90-day window from the flip
   moment. Deleted and disabled drafts keep the clock they had, so the sweep
   still reclaims their storage on schedule — re-arming those would hold
   content nobody can reach for another 90 days at exactly the moment cost
   starts mattering. A *disabled* draft is the sharper case: it is a page an
   operator took down, and its clock running out is how the takedown finishes.
   Re-arming it would hand abuse another 90 days of paid storage. Only the
   retention anchor moves; `updated_at` still means "when the content last
   changed".
4. **Asserts and drops** the retired anonymous sentinel. With zero
   sentinel-owned drafts and no version or upload event still naming the
   sentinel token, both rows go. Otherwise the drop is **deferred** and the
   report says which condition held:
   - `retained_drafts_present` — the sentinel owns drafts. They were re-armed
     with the same full window as everything else in service, and their
     top-ups are already frozen: the sentinel token has carried a revocation
     stamp since the day it was seeded. That is the revoked-style treatment
     #106 calls for. Review those drafts, disable or delete what should not be
     public, and drop the rows in a later deliberate step.
   - `retained_history_present` — no drafts, but a version or upload event
     still names the sentinel token. The rows cannot go without breaking that
     history. Nothing is wrong with the instance; resolve it separately.

A refusal writes nothing at all. Every precondition is checked inside the same
transaction, before the first write, so a refused flip leaves the database
exactly as it found it. Resolve the condition the message names and rerun.

**Once step 7 has pinned the welcome draft, this command will not run again.**
The flip refuses on `draft_already_pinned`, because "nothing pre-existing is
pinned" is one of its preconditions and the welcome pin makes that false. This
is deliberate — it is what stops a late rerun from re-arming every clock a
second time — but know that it means **the flip is not rerunnable after step 7
without unpinning the welcome draft first**. If you have to rerun after the
pin, unpin, rerun, and pin again, and understand that the rerun re-arms
everything from the new moment.

Read the post-surgery inspection before moving on. **Earliest anchor** should
be 90 days out from the moment you ran, and **Pinned drafts** should still be
`none`.

### 6. Turn self-service minting on

`PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS` is an OpenTofu-managed Container App
environment variable, so it changes through the reviewed infrastructure flow —
not an ad hoc `az containerapp update`, and not a portal edit. Set
`allow_self_service_tokens = true` in `terraform.tfvars`, then follow
[Plan, review, apply](../infra/azure/README.md#plan-review-apply) with a second
operator reviewing the inventory.

This rolls a new revision, which restarts the process and therefore empties the
in-memory per-minute limiters. The database-backed quotas — the per-address
mint ceiling and the per-token live-draft ceiling — survive it, which is why
they are the ones that matter.

**If the report rate limiter from [the known gaps](#two-known-gaps-that-are-not-this-repositorys-server-code)
is being added, it lands in this same change.**

### 7. Publish and pin the welcome draft

Publish the welcome draft with the bootstrap token, then pin it through the
admin surface. Pinning is admin-only and exempts the draft from expiry; the
clock keeps running underneath the pin, so unpinning later hands the page back
to whatever time it has left.

```txt
curl -sS -X POST "https://<public base URL>/api/drafts/<draft id>/pin" \
  -H "Authorization: Bearer $PATCHPAGE_BOOTSTRAP_API_TOKEN"
```

This is the instance's **first pin**. Confirm it by rerunning the inspection
from step 4: **Pinned drafts** should now name exactly this draft and nothing
else.

### 8. Verify the public path end to end

From a **clean machine** — no PatchPage state directory, no stored token:

- [ ] `npx patchpage status --json` reports the default instance and no stored
      token.
- [ ] `npx patchpage upload <a small valid page>` mints a publishing key,
      announces it without printing the plaintext, and publishes. The returned
      URL serves.
- [ ] A second `upload` of the same file updates the same draft.
- [ ] The served page carries `X-Robots-Tag: noindex`, no cookies, and the
      report link in its footer.
- [ ] The report link acknowledges a submission.
- [ ] Minting six keys from one address in a day is refused on the sixth.
- [ ] The welcome draft serves and is pinned.
- [ ] The acceptable-use page is live on the website and linked from the mint
      response, the draft footer, and the README.

Then, as the operator:

- [ ] A teammate token still authenticates and can publish a **new** draft.
- [ ] That same teammate token is refused an update against one of its
      **pre-flip** drafts. This is the accepted consequence, confirmed working
      as designed — not a bug to file.
- [ ] The bootstrap admin token can still update, disable, delete, and pin.

### 9. Tell the teammates

Three people are about to hit an error they did not cause. Tell them before
they find it:

> Your publishing token still works and everything you publish from now on is
> yours alone. Pages you published before today stayed with the instance
> operator, so updating one will now fail — publish it again with `--new` to get
> a page you control, or ask me to update it if the URL has to stay the same.

### 10. Close the record

Record, privately: the flip timestamp, the inspection reports from before and
after, the three new principal IDs, the sentinel disposition, the kill-switch
drill recovery time, and anything that surprised you. Then the README and docs
flip to public positioning (#126) can follow.

## Rollback posture

**The environment variable is the rollback lever.** Setting
`allow_self_service_tokens = false` through the same reviewed infrastructure
flow closes the instance to new self-service mints immediately. Tokens already
minted keep working and their drafts keep serving — minting is what stops.
That is the intended containment for "we opened too early", and it is the only
step of this runbook with a clean reverse.

**The kill switch is the emergency lever**, not the rollback lever. It takes
serving and uploads down together and restoring is an operator decision. Use it
for cost or abuse, not for "the flip went wrong".

**The data surgery does not roll back**, and does not need to:

- _Re-homing_ is reversible only by hand — move the token's principal back and
  remove the principal and mint record the flip created. There is no scripted
  reverse, deliberately: a scripted un-re-home is a scripted way to take
  somebody's pages away from them.
- _Re-arming_ cannot be undone; the previous anchors are gone. The exposure is
  bounded and one-directional: every draft in service lives 90 days longer than
  it would have. That is cost, not data loss, and the sweep resumes normally
  from the new anchors.
- _The sentinel drop_ cannot be undone. The rows were inert — a principal
  nothing can authenticate as and a token with a revocation stamp from 1970 —
  so nothing depends on them being there.

If the surgery itself must be undone, that is a restore from the recovery point
taken in step 1, and a restore is a separate reviewed operation with its own
second operator. It is not part of this runbook because a database restore that
loses every page published since the flip is almost never the right answer to
anything this runbook can go wrong at.

## Reference

- Spec: issue #106, "Migration at the flip" and "Rollout sequencing".
- Migration decisions: issue #105.
- The flip's rules and what each refusal means: `packages/db/src/go-public-flip.ts`.
- The operator entry point: `packages/db/src/go-public-flip-command.ts`.
- Proof both drivers agree: the go-public flip section of
  `packages/db/src/upload-contract.test.ts`.
- Kill switch, circuit breaker, cost posture, and the infrastructure change
  flow: `infra/azure/README.md`.
