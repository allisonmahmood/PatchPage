# PatchPage

Publish a polished, single-file HTML page behind an unlisted link — free, no signup, no card. Tell your agent **"make this a PatchPage"** and share the URL it hands back.

PatchPage is open-source and self-hostable; if you don't want to host, use ours. The official instance at https://post.patchyhq.com is the CLI's default: the first `upload` mints a publishing key for you automatically and saves it on your machine, and publishing accepts the [acceptable use policy](https://patchyhq.com/acceptable-use). What the service records — and what it deliberately never records about readers — is in the [privacy notice](https://patchyhq.com/patchpage/privacy).

## Quick setup

Paste this to your agent, once:

> Set up PatchPage for me:
>
> 1. Install the skill by running: npx skills add allisonmahmood/PatchPage
> 2. Then walk me through PatchPage's onboarding: set up how my pages should look and publish my welcome page.
> 3. From now on, when I say "make this a PatchPage", turn the content into a polished single-file HTML page, publish it with the PatchPage skill, and send me the link.

The skill teaches the assistant to produce safe static HTML and publish it. Its source lives at [skills/patchpage/SKILL.md](skills/patchpage/SKILL.md), and it also ships inside the `patchpage` npm package.

## Using the CLI directly

The CLI is published to npm as [`patchpage`](https://www.npmjs.com/package/patchpage). Requires Node.js 22 or newer.

```sh
npx --yes patchpage upload ./plan.html
# Minted a new publishing token for https://post.patchyhq.com; saved to ~/.patchpage/credentials.json.
# URL: https://post.patchyhq.com/d/k7f2m9x1a3b8
```

Uploading the same file again updates the same draft, so the link you shared keeps working. The saved credentials file is the only key to your pages — copy it to another machine to publish from there with the same editing rights. Full command and flag reference: [packages/cli/README.md](packages/cli/README.md).

Every upload requires a bearer publishing key, on every configuration; there is no tokenless upload path and no server setting that restores one. A request with no `Authorization` header is rejected with 401, and an invalid credential is never downgraded to an unauthenticated upload.

## Fair use, and how long pages stay up

The hosted instance is free for everyone, which only works with limits: up to **512 KiB** per page, **5 new publishing keys** per network address per day, **1,000 live pages** per key, and **10 new pages per minute**. A page stays up for at least **90 days** after it was last published or updated, and every visit keeps it alive for at least another **30 days**; a page nobody reads for months eventually expires and is permanently deleted. Republishing before then resets the clock. The [acceptable use policy](https://patchyhq.com/acceptable-use) carries the current numbers and the rules.

**Unlisted, not private.** Draft viewer URLs are public and unlisted: long, unguessable, never listed by the service, and served `noindex` — but anyone with the link can open or reshare it. Don't publish secrets, credentials, or anything you would not hand to a stranger holding the link.

## Self-hosting

Deploy your own server and point the CLI at it with `--api-url` or the `PATCHPAGE_API_URL` environment variable. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for image tags, container and source setup, configuration, database migration, and minting API tokens; a self-hosted instance issues tokens through its operator unless you enable self-service minting (`PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS`, default `false`).

For CI and other automation against a server you control, use this fail-closed workflow — it pins the origin, clears inherited credential overrides, and verifies the stored token before validation or upload:

```sh
(
  set +x
  set -eu
  PATCHPAGE_API_URL='https://post.example.com'
  export PATCHPAGE_API_URL
  unset PATCHPAGE_API_TOKEN
  unset TOKEN
  : "${PATCHPAGE_SETUP_TOKEN:?Set PATCHPAGE_SETUP_TOKEN to a PatchPage API token}"
  ARTIFACT_PATH='./plan.html'

  printf '%s' "$PATCHPAGE_SETUP_TOKEN" | npx --yes patchpage auth set --token-stdin --api-url "$PATCHPAGE_API_URL"
  unset PATCHPAGE_SETUP_TOKEN
  npx --yes patchpage whoami &&
    npx --yes patchpage validate "$ARTIFACT_PATH" &&
    npx --yes patchpage upload "$ARTIFACT_PATH"
)
```

The CLI still accepts a `--anonymous` flag, but it is retired and ignored: uploads always use a publishing key. The retired `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` and `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE` variables fail server startup instead of being ignored.

Release automation is configured to publish the supported container image as `ghcr.io/allisonmahmood/patchpage-server`. The first GHCR package still requires a maintainer to set Public visibility in GitHub; availability is accepted only after the anonymous GHCR smoke job proves the semver tag and exact digest match the publisher-bound manifest and config without credentials, then boots that digest. This is not a claim that the first package is already public.
Scheduled/manual reconciliation begins with `v0.1.1`, repairs supported tag pairs in bounded batches, reconciles `latest` whenever at least one supported release is complete, and then accepts every complete supported pair without credentials—even on a zero-repair run. Repaired rows are bound through the newest exact immutable publisher-result artifact for that version/revision; already-complete rows use the manifest and config digests captured by the registry inspection snapshot, and unrelated artifacts from earlier attempts are ignored. The legacy `v0.1.0` source tag predates the supported image contract and is deliberately ignored.

The image runs as a non-root user and uses `/data` as the writable persistence mount for the default JSON metadata and filesystem storage drivers. PatchPage can also run directly on Node with Postgres or JSON metadata and filesystem or Azure Blob Storage.

## The website

The policies above render on [patchyhq.com](https://patchyhq.com) — the acceptable use policy at `/acceptable-use` and the PatchPage privacy notice at `/patchpage/privacy`. That site lives in its own repository and is synced manually by the operator; changing a policy means changing it there and in this repo's `docs/` together.

## Repository layout

This is a Turborepo monorepo managed with pnpm.

- `apps/server` — Fastify HTTP server that validates uploads, stores drafts, and renders the sandboxed viewer (`@patchpage/server`).
- `packages/cli` — the `patchpage` npm package: the command-line uploader.
- `packages/core` — shared HTML validation, hashing, and ID helpers (`@patchpage/core`).
- `packages/db` — metadata store with Postgres and JSON-file drivers, plus schema migrations (`@patchpage/db`).
- `packages/storage` — HTML object storage adapters: filesystem and Azure Blob (`@patchpage/storage`).
- `packages/config` — environment-variable parsing and server configuration (`@patchpage/config`).
- `infra/azure` — OpenTofu for a worked Azure Container Apps self-hosting deployment.
- `skills/patchpage` — the bundled agent skill.
- `examples/plan.html` — a Patchy-styled starter draft.

## Local development

The default local mode needs no Postgres: it uses a JSON metadata file and filesystem HTML storage.

```sh
pnpm install &&
  PATCHPAGE_BOOTSTRAP_API_TOKEN=dev-token pnpm --filter @patchpage/server dev
```

In another shell, use the local bootstrap token in the same pinned workflow:

```sh
pnpm --filter patchpage build &&
(
  set +x
  set -eu
  PATCHPAGE_API_URL='http://localhost:3000'
  export PATCHPAGE_API_URL
  unset PATCHPAGE_API_TOKEN
  unset TOKEN
  PATCHPAGE_SETUP_TOKEN='dev-token'
  ARTIFACT_PATH='examples/plan.html'

  printf '%s' "$PATCHPAGE_SETUP_TOKEN" | PATCHPAGE_STATE_DIR='.local/cli' node packages/cli/dist/index.js auth set --token-stdin --api-url "$PATCHPAGE_API_URL"
  unset PATCHPAGE_SETUP_TOKEN
  PATCHPAGE_STATE_DIR='.local/cli' node packages/cli/dist/index.js whoami &&
    PATCHPAGE_STATE_DIR='.local/cli' node packages/cli/dist/index.js validate "$ARTIFACT_PATH" &&
    PATCHPAGE_STATE_DIR='.local/cli' node packages/cli/dist/index.js upload "$ARTIFACT_PATH"
)
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for Postgres mode and production storage notes.

## Credit

PatchPage is inspired by Postplan, the static HTML draft publishing tool created by Theo. The goal is to preserve that useful agent artifact pattern while building an open-source, self-hostable version with upload-gated publishing.

## Security

Report vulnerabilities privately by following the [security policy](SECURITY.md).

## License

MIT
