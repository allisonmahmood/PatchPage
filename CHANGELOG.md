# Changelog

All notable changes to PatchPage are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-08-14

### Changed

- The hint the CLI appends to a 401/403 from the default instance no longer claims the
  instance "does not issue public tokens". Like `whoami`, the copy is now
  posture-neutral: a rejected request means the publishing key that was sent is bad,
  so the hint names the next action (`patchpage auth set`, or pointing the CLI at your
  own instance) without asserting the instance's minting policy. This clears the last
  hard gate in `docs/GO_PUBLIC_FLIP.md` before the go-public flip.

## [0.2.0] - 2026-08-14

### Added

- The CLI now auto-mints a publishing token on first upload. When `upload` resolves an
  instance with no stored token and no `PATCHPAGE_API_TOKEN` in the environment, it
  requests one from that instance's self-service endpoint, saves it before announcing it,
  and prints the mint announcement: which instance, where the token was saved
  (`credentials.json` in the state dir, `~/.patchpage` unless `PATCHPAGE_STATE_DIR` says
  otherwise), and how to reuse an existing identity from another machine instead. Auto-mint is never silent and never fires while any token is
  configured — a rejected token is an error, not a reason to mint again — and only the
  resolved instance is ever asked. Each refusal (self-service disabled, per-network mint
  quota exhausted, rate-limited) produces a plain-language error naming the cause and the
  next action.
- `patchpage status --json`, the local-only onboarding probe. It reports what publishing
  state this machine already holds for the resolved instance — keys `instanceUrl`,
  `instanceSource` (`flag` | `env` | `config` | `default`), `hasToken`, `tokenSource`
  (`mint` | `auth-set` | null), `stateDir`, `hasDefaultStyle`, `cliVersion` — without ever
  touching the network, and exits 0 in every configured and unconfigured state: it
  answers rather than passing or failing.
- Added the go-public flip: the one-shot data surgery that turns the maintainer's private
  instance into the free public service, plus the operator runbook that choreographs it
  (`docs/GO_PUBLIC_FLIP.md`). The surgery re-homes named teammate tokens onto fresh 1:1
  principals — they keep their tokens and, deliberately, lose edit rights over their
  pre-flip drafts — re-arms every draft in service to a full 90-day window from the flip
  moment, and assert-and-drops the retired `acct_anonymous`/`tok_anonymous` sentinel rows.
  It is deliberately **not** a schema migration: nothing here runs on a self-hosted
  database, `pnpm db:migrate` does not reach it, and the server never calls it. The
  operator entry point is `pnpm --filter @patchpage/db db:go-public-flip`, which inspects
  and writes nothing by default and performs the surgery only with `--apply`.

### Changed

- Admin moderation of drafts is no longer keyed on the retired anonymous sentinel. The old
  carve-out let an `admin`-scoped credential disable or delete a draft only when that draft
  was owned by `acct_anonymous`; it is replaced by a general capability, so `admin` now
  reaches any principal's draft. Ordinary tokens are unchanged and still reach only the
  drafts they own.
- **Breaking:** CLI state is now host-keyed. `credentials.json` stores one token per
  instance and `drafts.json` caches drafts per instance, so switching `--api-url` (or
  `PATCHPAGE_API_URL`) can no longer send one instance's token to another or update the
  wrong instance's draft. The retired single-instance format is not migrated and there is
  no compatibility shim: commands that would spend a token stop on the old file with
  instructions (copy the token out if still needed, delete the file, re-save with
  `patchpage auth set`), and the old draft cache is likewise rejected with instructions
  to delete it — already-published drafts are unaffected.
- **Breaking, deliberate:** `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` and
  `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE` are retired. Setting either one now
  **fails startup** with an error naming its successor, rather than being silently ignored,
  so a self-hoster's deliberate security posture is never quietly reinterpreted. Replace
  them with `PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS` (strict `true`/`false`, default `false`)
  and `PATCHPAGE_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE` (decimal integer `1` through
  `10000`, default `5`). An empty or whitespace-only value still reads as unset. The two new
  settings parse and validate today but gate nothing yet: they configure the self-service
  token minting that lands in a later change, and neither ever admits a tokenless upload.
  The matching OpenTofu variables are renamed `allow_anonymous_uploads` ->
  `allow_self_service_tokens` and `anonymous_create_rate_limit_per_minute` ->
  `self_service_mint_rate_limit_per_minute`, and the Container App environment map is
  updated in the same change so a deploy of this commit boots.
- The Azure self-hosting example now uses [OpenTofu](https://opentofu.org) instead of
  Terraform. CI pins OpenTofu 1.12.5; the runbooks call `tofu`; install it with
  `brew install opentofu`. There is no state migration: the state format is compatible and
  the backend is unchanged, so an existing environment picks it up on its next
  infrastructure change, when the flow runs `tofu init` against the same `azurerm` backend
  and state key. The first `init` rewrites the provider registry addresses and hashes in
  `.terraform.lock.hcl`, preserving provider versions; the checked-in lock file is already
  in that form. Moving back to Terraform reads the same state back unchanged, but it needs a
  plain `terraform init` to regenerate the lock file, because `-lockfile=readonly` rejects the
  OpenTofu-form addresses; that regeneration re-resolves the version constraints, so provider
  versions float unless they are pinned exactly first. Either direction stays possible only
  until this directory adopts an OpenTofu-only feature such as state encryption, which it
  deliberately has not.
- Azure workload Blob Storage now defaults to geo-redundant replication (`GRS`). Existing
  environments that still use `LRS` will see an in-place Storage account update on the first
  infrastructure apply after upgrade; review cost and replication behavior before approving.
  PostgreSQL flexible-server backups remain platform-local by default; configure independent
  geo-capable database backups if regional recovery is required.
- Azure PostgreSQL now defaults to 35-day backup retention (`postgres_backup_retention_days`).
  Existing environments left on the platform default (about 7 days) will see an in-place
  flexible-server update on the first infrastructure apply after upgrade; review the added
  backup storage cost before approving.

### Deprecated

- `upload --anonymous` is deprecated and ignored. Tokenless upload no longer exists
  anywhere (see Removed), so the flag prints a warning and the upload proceeds with a
  publishing token as always — minted automatically if none is stored. The flag will be
  removed in a later release.

### Removed

- Tokenless ("anonymous") upload is removed everywhere. No instance accepts an upload
  without a bearer token, on any configuration: a tokenless request to the upload endpoint
  is `401`, and a present-but-invalid bearer stays `401` rather than being downgraded. The
  anonymous branch of the API guard, its per-IP anonymous-create limiter, and the internal
  `acct_anonymous`/`tok_anonymous` sentinel principals and their seed code are all gone.
  The rationale is recorded in `docs/adr/ADR-0001-trust-model-no-tokenless-upload.md`.

## [0.1.1] - 2026-07-14

### Added

- Bundled the `patchpage-mint-token` operator skill for minting API tokens and safely
  bootstrapping CLI credentials.
- Added bounded trusted-proxy configuration for canonical client IP attribution, with safe
  direct-connection defaults and guidance for verified reverse-proxy topologies.
- Added opt-in anonymous draft creation for self-hosted servers and the CLI. It remains
  disabled by default, create-only, independently rate limited, and recorded under a
  non-authenticating audit principal.
- Configured tag-driven npm and GHCR release automation to verify exact artifacts before
  publication; build a non-root image with `/data` persistence; bind immutable SemVer and
  revision tags, plus `latest`, to one image digest; permit only bounded reconciliation; and
  require an anonymous, digest-pinned boot smoke test before declaring availability.

### Changed

- The `patchpage` CLI and server now require Node.js 22 or newer. Node 20 reached end of life
  in April 2026 and is no longer supported.
- `patchpage auth set` now reads tokens from a hidden interactive prompt or explicit
  `--token-stdin`, never a positional argument, and rejects empty, multiline, ambiguous, or
  non-interactive prompt input.
- Public quick starts now pin the intended API URL, clear inherited token overrides,
  authenticate through standard input, verify identity, validate content, and stop on any
  failure before upload.
- Azure deployment guidance and verification now cover domain-safe custom hostname and TLS
  setup, exact HTTP-to-HTTPS `301` redirects, and fail-closed detection of resource drift,
  unsafe ingress, DNS or certificate mismatches, and incorrect health, upload, or fetch
  responses.
- Release checks now install and exercise the packed npm CLI artifact end to end, so
  verification covers the package prepared for publication rather than workspace sources.

### Fixed

- JSON metadata now remains intact after interrupted writes, preserves concurrent updates
  within a process, and leaves already-corrupt data untouched.
- CLI token entry now restores terminal settings after success, end of input, interruption,
  or stream and save failures.
- Corrected the Azure Container Registry build context and Dockerfile path used by the
  deployment workflow.

### Security

- Upload handling now enforces authorization, independent authenticated and anonymous rate
  limits, and request size and shape checks before creating drafts with server-generated IDs.
- On Unix, saved CLI credential files are repaired to mode `0600`. Token bootstrap files now
  reject unsafe permissions, symbolic links, and ACL-bearing files, while credential
  workflows keep secrets out of command arguments and shell traces.
- Documented the private vulnerability-reporting process.
- Pre-release privacy checks now run before artifact output or publication and fail closed
  across approved commit and package identity, tracked names and content, npm pack metadata,
  and raw and effective gzip/tar metadata and content. Failures report only opaque categories
  and locations rather than matched private values.

## [0.1.0] - 2026-07-08

Initial public release.

### Added

- `patchpage` CLI with `auth set`, `whoami`, `validate`, and `upload` commands for publishing
  static HTML drafts to a PatchPage server.
- Bundled `patchpage` agent skill for creating safe static HTML artifacts in the Patchy visual
  style and publishing them.
- Self-hosting documentation ([docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)) covering
  configuration, database migration, running the server, and minting API tokens.
