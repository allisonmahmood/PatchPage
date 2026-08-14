# PatchPage

PatchPage is an open-source, self-hostable service for publishing static HTML drafts behind unlisted, link-viewable URLs. The default host, https://post.patchyhq.com, is the maintainer's private instance and issues no tokens to outside callers. To use PatchPage yourself, deploy your own server (see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)) and point the CLI at it with `--api-url` or the `PATCHPAGE_API_URL` environment variable.

Every upload requires a bearer API token, on every configuration. A request with no `Authorization` header is rejected with 401, and a present but invalid credential is never downgraded to an unauthenticated upload. Draft viewer URLs are public and unlisted: anyone with the link can view the rendered artifact. PatchPage is intended for agent-generated plans, briefs, architecture notes, reports, and other single-file HTML documents.

## Using the CLI

The CLI is published to npm as [`patchpage`](https://www.npmjs.com/package/patchpage) and can be run with `npx`.

Requires Node.js 22 or newer.

Set `PATCHPAGE_SETUP_TOKEN` in a secret environment variable, then run this self-hosted workflow:

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

The example origin and setup token must come from a PatchPage server you control. The workflow pins that origin, clears inherited credential overrides, and verifies the stored token before validation or upload. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for deploying a server and minting tokens.

There is no tokenless upload path and no server setting that restores one. The CLI still accepts a `--anonymous` flag, but it is retired and no longer selects a working mode: the credential-free request it produces is rejected with 401. Self-hosters configure `PATCHPAGE_ALLOW_SELF_SERVICE_TOKENS` (default `false`); the retired `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` and `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE` variables now fail server startup instead of being ignored.

Full command and flag reference: [packages/cli/README.md](packages/cli/README.md).

## Agent skill

PatchPage ships an agent skill that teaches an assistant to produce safe static HTML artifacts and publish them. Install it with:

```sh
npx skills add allisonmahmood/PatchPage
```

The skill source lives at [skills/patchpage/SKILL.md](skills/patchpage/SKILL.md). It also ships inside the `patchpage` npm package, so installing the CLI makes the skill available alongside it.

## Self-hosting

Release automation is configured to publish the supported container image as `ghcr.io/allisonmahmood/patchpage-server`. The first GHCR package still requires a maintainer to set Public visibility in GitHub; availability is accepted only after the anonymous GHCR smoke job proves the semver tag and exact digest match the publisher-bound manifest and config without credentials, then boots that digest. This is not a claim that the first package is already public.
Scheduled/manual reconciliation begins with `v0.1.1`, repairs supported tag pairs in bounded batches, reconciles `latest` whenever at least one supported release is complete, and then accepts every complete supported pair without credentials—even on a zero-repair run. Repaired rows are bound through the newest exact immutable publisher-result artifact for that version/revision; already-complete rows use the manifest and config digests captured by the registry inspection snapshot, and unrelated artifacts from earlier attempts are ignored. The legacy `v0.1.0` source tag predates the supported image contract and is deliberately ignored.

The image runs as a non-root user and uses `/data` as the writable persistence mount for the default JSON metadata and filesystem storage drivers. PatchPage can also run directly on Node with Postgres or JSON metadata and filesystem or Azure Blob Storage. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for image tags, container and source setup, configuration, database migration, and minting API tokens.

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
