# PatchPage

PatchPage is an open-source, self-hostable service for publishing static HTML drafts behind unlisted, link-viewable URLs. The default host, https://post.patchyhq.com, is the maintainer's private instance and does not offer public token signup. To use PatchPage yourself, deploy your own server (see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)) and point the CLI at it with `--api-url` or the `PATCHPAGE_API_URL` environment variable.

Upload access is token-gated, but draft URLs are public and unlisted: anyone with the link can view the rendered artifact. PatchPage is intended for agent-generated plans, briefs, architecture notes, reports, and other single-file HTML documents.

## Using the CLI

The CLI is published to npm as [`patchpage`](https://www.npmjs.com/package/patchpage) and can be run with `npx`.

```sh
# Save a token through the non-echoing prompt (and store the self-hosted base URL)
npx patchpage auth set --api-url https://post.example.com

# Validate a file locally without uploading
npx patchpage validate ./plan.html

# Upload (creates a new draft, or updates the last one uploaded from this path)
npx patchpage upload ./plan.html
```

Because the default host is the maintainer's private instance, the token you enter at the hidden `auth set` prompt must come from a PatchPage server you control — that means your own self-hosted deployment. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for deploying a server and minting tokens.

Full command and flag reference: [packages/cli/README.md](packages/cli/README.md).

## Agent skill

PatchPage ships an agent skill that teaches an assistant to produce safe static HTML artifacts and publish them. Install it with:

```sh
npx skills add allisonmahmood/PatchPage
```

The skill source lives at [skills/patchpage/SKILL.md](skills/patchpage/SKILL.md). It also ships inside the `patchpage` npm package, so installing the CLI makes the skill available alongside it.

## Self-hosting

PatchPage is a normal Node HTTP service and runs anywhere that supports Node or containers. It uses Postgres (or a local JSON file) for metadata and filesystem or Azure Blob Storage for HTML objects. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for a full walkthrough: configuration, database migration, running the server, and minting API tokens.

## Repository layout

This is a Turborepo monorepo managed with pnpm.

- `apps/server` — Fastify HTTP server that validates uploads, stores drafts, and renders the sandboxed viewer (`@patchpage/server`).
- `packages/cli` — the `patchpage` npm package: the command-line uploader.
- `packages/core` — shared HTML validation, hashing, and ID helpers (`@patchpage/core`).
- `packages/db` — metadata store with Postgres and JSON-file drivers, plus schema migrations (`@patchpage/db`).
- `packages/storage` — HTML object storage adapters: filesystem and Azure Blob (`@patchpage/storage`).
- `packages/config` — environment-variable parsing and server configuration (`@patchpage/config`).
- `infra/azure` — Terraform for the maintainer's Azure Container Apps deployment (a worked self-hosting example).
- `skills/patchpage` — the bundled agent skill.
- `examples/plan.html` — a Patchy-styled starter draft.

## Local development

The default local mode needs no Postgres: it uses a JSON metadata file and filesystem HTML storage.

```sh
pnpm install
PATCHPAGE_BOOTSTRAP_API_TOKEN=dev-token pnpm --filter @patchpage/server dev
```

In another shell:

```sh
pnpm --filter patchpage build
# Enter the local bootstrap token at the hidden prompt.
PATCHPAGE_STATE_DIR=.local/cli node packages/cli/dist/index.js auth set --api-url http://localhost:3000
PATCHPAGE_STATE_DIR=.local/cli node packages/cli/dist/index.js upload examples/plan.html
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for Postgres mode and production storage notes.

## Credit

PatchPage is inspired by Postplan, the static HTML draft publishing tool created by Theo. The goal is to preserve that useful agent artifact pattern while building an open-source, self-hostable version with upload-gated publishing.

## License

MIT
