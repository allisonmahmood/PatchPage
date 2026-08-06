# Gap analysis: what the repo already supports for anonymous-first hosting

Research findings for [issue #88](https://github.com/allisonmahmood/PatchPage/issues/88),
part of the wayfinder map [#87](https://github.com/allisonmahmood/PatchPage/issues/87).
All claims cite the source files in this repo at the commit this branch forked from.
Terminology follows the publishing context: *drafts*, *uploads*, *auth tokens*,
*anonymous uploads*.

## 1. Anonymous uploads today: create-only, permanently orphaned

### `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS`

- Parsed in `packages/config/src/index.ts` (`strictBoolValue`, lines 49–53 and 277–287):
  strictly `true`/`false` (case-insensitive), **default `false`**, any other value throws
  at startup. Covered by `packages/config/src/index.test.ts`.
- Enforced only inside the server's pre-routing guard
  (`protectedApiPrefixGuard`, `apps/server/src/app.ts` lines 352–435). The anonymous
  branch fires only when **all** of these hold:
  - the request target classifies as `/api/uploads` (the only policy with
    `anonymousCreate: true` — `classifyApiRequestTargetPolicy`, app.ts lines 566–583);
  - the method is `POST`;
  - the `Authorization` header is entirely **absent** (`authState.kind === "missing"`).
    A malformed or unknown bearer token is `"invalid"` and gets a 401 — there is
    deliberately no silent fall-through from bad credentials to anonymous
    (app.ts lines 372–401, 630–640).
- An anonymous create must **omit `draftId` entirely**; even a present-but-null key is
  rejected with 400 `"Anonymous uploads must omit draftId."`
  (app.ts lines 174–181, `hasOwnProperty` check). Anonymous mode is therefore
  **create-only**: no update path exists at the API level.

### Who "owns" an anonymously created draft

- The upload is recorded under a fixed shared principal
  `{ accountId: "acct_anonymous", apiTokenId: "tok_anonymous" }`
  (`packages/db/src/internal-principals.ts`). Both drivers seed that account plus a
  never-authenticatable audit token row whose hash is the sentinel
  `"internal:anonymous:no-bearer-token"` and whose `revokedAt` is the epoch
  (`ensureAnonymousUploadPrincipal`, `packages/db/src/json-db.ts` lines 875–913;
  postgres equivalent in `packages/db/src/postgres-db.ts`).
- Because token lookup excludes revoked rows and matches by `sha256(token)`
  (`findApiTokenByToken`, json-db.ts lines 117–139), **no bearer token can ever
  authenticate as the anonymous account**. Consequences:
  - **Update:** impossible for anyone. `assertUploadTarget` requires
    `existingDraft.accountId === input.accountId` (json-db.ts lines 915–935), and
    nothing can present `acct_anonymous`.
  - **Delete / disable:** only a token with the `admin` scope, via the
    `canModerateAnonymous` moderation escape hatch
    (app.ts lines 260–290; `disableDraft`/`deleteDraft`, json-db.ts lines 264–310).
    Ordinary `upload`-scoped tokens cannot touch anonymous drafts.
- The anonymous create response returns `draftId`, `publicUrl`, `versionNumber`, and
  validation warnings (app.ts lines 251–256) — **no credential or claim capability of
  any kind**. The caller walks away with a URL and nothing else.

### `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE`

- Parsed by `rateLimitPerMinuteValue` (`packages/config/src/index.ts` lines 65–69,
  255–275): decimal integer 1–10 000, **default 5**, invalid values throw.
- Implemented as a fixed 60-second window keyed by **client IP**
  (`apps/server/src/rate-limit.ts`; consumed in app.ts lines 387–392 pre-body and
  439–448 in-route). The limiter caps stored keys at 10 000; when full, requests from
  *new* IPs are rejected until the next bucket expires (rate-limit.ts lines 102–113).
- It stacks on top of the general protected-API limiter
  (`PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE`, default 60/min per IP), which is
  consumed first for every `/api/*` request (app.ts lines 363–367). Authenticated
  uploads instead consume `PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE`
  (default 20/min) keyed by **token id**, not IP (app.ts lines 421–428).
- Client IP derivation honors `PATCHPAGE_TRUST_PROXY` (Fastify `trustProxy`), which the
  config layer validates aggressively — CIDR ranges, hop counts, refusal of
  full-address-family ranges (`packages/config/src/index.ts` lines 95–187).

## 2. Auth tokens end to end

### Server side: minting and checking

- **Bootstrap:** `PATCHPAGE_BOOTSTRAP_API_TOKEN` is upserted at startup
  (`apps/server/src/start.ts` line 20 → `db.initialize`) into a fixed
  `acct_bootstrap`/`tok_bootstrap` pair with scopes `["admin", "upload"]`
  (`ensureBootstrapState`, json-db.ts lines 840–873). Re-running with a new value
  rotates the hash in place and un-revokes the row.
- **Minting:** `POST /api/tokens` requires the `admin` scope (app.ts lines 142–160,
  577–579). The **server** generates the token value — `pp_` + 32 random bytes
  base64url (`randomToken`, `packages/core/src/crypto.ts`) — and returns the plaintext
  exactly once alongside `{ id, name }`. Requested scopes are trimmed/deduped and
  default to `["upload"]` (`normalizeScopes`, app.ts lines 727–731).
- **Storage:** only `sha256(token)` hex is persisted (`createApiToken`, json-db.ts
  lines 141–163; postgres-db.ts line 100). The plaintext is unrecoverable.
- **Checking:** every `/api/*` request passes `protectedApiPrefixGuard`. The
  `Authorization` header is parsed by a strict `Bearer <single-token>` scanner
  (`classifyAuthorizationHeader`, app.ts lines 648–691), the token is hashed and looked
  up among non-revoked rows, and `lastUsedAt` is updated (json-db.ts lines 117–139).
  Scope checks treat `admin` as satisfying everything (`hasScope`, app.ts lines
  590–592).
- **Lifecycle gaps:** there is **no list or revoke endpoint**; revocation is manual row
  surgery, documented in the operator skill
  (`.agents/skills/patchpage-mint-token/SKILL.md`, "Revoking tokens"). There is no
  self-service registration path of any kind — every token chain starts from an
  operator-held admin token.

### CLI side: storage and precedence

Source: `packages/cli/src/index.ts`.

- State dir: `PATCHPAGE_STATE_DIR` or `~/.patchpage` (line 26), created `0700`. Files:
  - `config.json` — `{ apiUrl }` (only written when `auth set --api-url` is passed);
  - `credentials.json` — `{ apiToken, updatedAt }`, written `0600` atomically;
  - `drafts.json` — per-absolute-file cache
    `{ draftId, publicUrl, latestVersionNumber, updatedAt }` used to turn repeat
    uploads of the same file into updates.
- `auth set` (lines 72–109) accepts the token via hidden TTY prompt or
  `--token-stdin`; it never mints — the token must already exist.
- **API URL precedence:** `--api-url` flag → `PATCHPAGE_API_URL` env →
  `config.json` → built-in default `https://post.patchyhq.com` (lines 24, 275–308).
- **Upload credential precedence:** explicit `--anonymous` → `PATCHPAGE_API_TOKEN`
  env (checked with `!== undefined`) → `credentials.json` → **silent anonymous
  fallback** when nothing is configured (`readUploadAuth`, lines 290–308). Auth
  failures never retry anonymously. Anonymous uploads skip the draft cache entirely
  (read and write, lines 187–193, 234–243).
- 401/403 against the default host print a hint that `post.patchyhq.com` is the
  maintainer's **private instance with no public tokens** (`defaultHostHint`,
  lines 343–346) — the current UX actively steers strangers toward self-hosting.

## 3. What `npx patchpage verify` / `validate` actually check

- **There is no `verify` command.** The CLI registers exactly `auth set`, `whoami`,
  `validate`, and `upload` (`packages/cli/src/index.ts`; confirmed by
  `packages/cli/README.md`). The map's standing preference that agents "rely on
  `npx patchpage verify`" refers to a command that does not exist yet; today's closest
  composite is `whoami` (credential/host check) + `validate` (document check).
- `validate <file>` is **purely local** — no network. It runs `validateHtml` from
  `packages/core/src/html-policy.ts`: parse5 parse; blocked tags `script`, `form`,
  `iframe`, `object`, `embed`, `applet`, `base`, `link`; any `on*` attribute; `srcdoc`;
  `javascript:`/`vbscript:`/`file:` in URL attributes (with control-character
  stripping); unsafe inline CSS (`expression(`, `behavior:`, `url(javascript:`); meta
  refresh; 512 KB default size cap; warning when `<title>` is missing. Note the CLI
  calls it without options, so it always checks against the 512 KB default even if the
  target server configured a different `PATCHPAGE_MAX_HTML_BYTES`.
- The **server re-runs the identical validator** on every upload with its configured
  `maxHtmlBytes` and rejects failures with 422 (app.ts lines 188–195), so client-side
  validation is a convenience, not the trust boundary.
- `whoami` calls `GET /api/me` with the stored/env token and prints account, token
  name, and scopes (lines 111–129); it is the only end-to-end credential check.

## 4. What the skill instructs agents to do (first-run behavior)

Source: `skills/patchpage/SKILL.md` (the published skill; the operator-only
`patchpage-mint-token` skill is internal and not shipped).

- The skill has **no first-run or onboarding flow**. Its authenticated workflow assumes
  a pre-existing token delivered out of band via a `PATCHPAGE_SETUP_TOKEN` env var,
  piped to `auth set --token-stdin`, verified with `whoami`, then
  `validate` + `upload` (lines 39–58).
- It explicitly tells agents the hosted default is "the maintainer's private instance"
  with no public token signup, and not to assume it accepts anonymous uploads
  (lines 63–68). Anonymous mode is described as an operator opt-in on self-hosted
  servers, create-only, with no ownership (lines 65–75, 141–143).
- Nothing in the skill mints tokens, captures a user style preference, records a
  deployment choice, or publishes a welcome draft. The style default is a static
  reference (`references/patchy-plan-style.md`) applied per-artifact, not a stored
  local config.

## 5. The gap to the target model

Target: first run against the official instance mints/registers a token that becomes
the **controller** (update + delete rights) of the drafts it creates, with a locally
stored config (token + API URL + default style).

| Target capability | Closest existing mechanism | Gap |
| --- | --- | --- |
| Signup-less token self-mint on first run | `POST /api/tokens` (admin-scope only); bootstrap env token | **No unauthenticated or self-service mint endpoint exists.** Every token today descends from the operator's bootstrap admin token. A new endpoint (or a first-create-returns-credential flow) plus its own abuse guardrails is required. |
| Token controls the drafts it creates | Already true for authenticated uploads: drafts are owned per-account, updates require account match, delete/disable require ownership | Works — but only once a token exists. Note ownership is **account**-scoped, not token-scoped (`assertUploadTarget`, `deleteDraft`); the per-first-run identity model must decide whether each first run is a new account. |
| Anonymous creates get a controller | Anonymous creates land on the shared `acct_anonymous` and are permanently orphaned; only admins can remove them | **Fundamental mismatch.** The current anonymous path can't be upgraded into controllership retroactively; the target flow replaces "anonymous create" with "invisible token mint, then authenticated create". The inert flag and rate limit are still useful as the fallback/abuse posture. |
| Delete rights for the controller | `DELETE /api/drafts/:draftId` exists and is ownership-checked | Works today for owned drafts. (No un-delete; delete is a soft tombstone, json-db.ts lines 289–310.) |
| Local config: token + API URL | `~/.patchpage/config.json` + `credentials.json`, with env-var precedence | Exists. Missing: any notion of **default style** or other onboarding-captured preferences; `config.json` currently holds only `apiUrl`. |
| First-run trigger in the skill | None — skill assumes an operator-provisioned token and warns agents *off* the official instance | Skill needs a first-run branch (detect missing credentials → mint/register → save → welcome draft) and the private-instance warnings/`defaultHostHint` in the CLI need to flip once the instance opens. |
| Agents rely on `npx patchpage verify` | No `verify` command; `whoami` + local `validate` are separate steps | Command must be designed and built (presumably credential + host + document check in one), or the preference re-scoped to `validate`. |
| Token lifecycle (rotation, loss, revoke) | No list/revoke API; manual row deletion | Unbuilt; already flagged in map #87 "Not yet specified". First-run minting makes this more urgent (orphaned tokens/drafts on lost machines). |
| Abuse guardrails for open minting | Per-IP anonymous-create limiter (5/min), per-IP protected-API limiter (60/min), per-token upload limiter (20/min), 512 KB HTML cap, strict HTML policy, `trustProxy` hygiene | Rate limiters are in-memory per-process fixed windows (rate-limit.ts) — no persistence or cross-instance coordination, and nothing rate-limits *token minting* itself since no public mint exists. Guardrail tickets should treat mint-rate and storage-growth limits as new surface. |

### One-paragraph summary

Everything on the **authenticated** side of the target model already exists and is
sound: server-generated `pp_` tokens stored as SHA-256 hashes, account-scoped draft
ownership enforced on update/delete, a CLI that persists token + API URL under
`~/.patchpage` with sane precedence, and identical client/server HTML validation. What
does not exist is any way to *get* a token without the operator: minting is
admin-gated, the anonymous path deliberately produces orphaned, uncontrollable drafts
on a shared account, the skill has no first-run behavior, there is no `verify`
command, no stored style preference, and no token lifecycle API. The anonymous-first
destination is therefore not an extension of `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` but a
new self-service mint flow layered on the existing (already adequate) ownership
machinery, plus guardrails for the mint surface that today's per-process, per-IP
limiters were never designed to cover.
