# PatchPage Build Plan

Last updated: 2026-07-07

## Product Contract

PatchPage is a small static HTML draft host:

1. An agent or human writes one complete static HTML document.
2. The CLI validates the file locally.
3. The CLI uploads it with a bearer token.
4. The server validates it again.
5. Metadata and versions are stored in Postgres.
6. Raw HTML versions are stored in object storage.
7. `/d/:draftId` renders the current version in a sandboxed viewer.

V1 is private in the upload sense, not the viewing sense.

- Uploads require an API token.
- View URLs are public/unlisted to anyone with the link.
- No anonymous public upload fallback.
- True access-private drafts can be added later.

## Credit And Positioning

PatchPage is based on the useful pattern established by Postplan, created by Theo. We should credit that inspiration clearly in the README, package metadata, docs, and launch copy.

PatchPage should not present itself as the original source of the idea. The positioning is:

- Postplan showed the pattern: agents publish safe static HTML drafts to reviewable URLs.
- PatchPage is an MIT-licensed, open-source, self-hostable implementation of that pattern.
- PatchPage V1 differs by gating uploads by default while keeping draft links public/unlisted.

## V1 Scope

### Included

- Public open-source repo under MIT.
- Node/TypeScript server.
- CLI published as an npm package.
- Strict static HTML validation shared by CLI and server.
- Token-gated upload/update/delete/disable flows.
- Public/unlisted viewer routes.
- Versioned draft storage.
- Azure production deployment for `post.patchyhq.com`.
- Self-hosting docs and environment configuration.

### Not Included Yet

- Viewer authentication.
- Signed share links.
- Dashboard UI.
- Multi-workspace UI.
- Billing.
- Comments or collaboration.
- JavaScript execution inside uploaded artifacts.

## Architecture

```txt
HTML file
  -> patchpage CLI
  -> local validation
  -> POST /api/uploads with bearer token
  -> server validation
  -> Postgres metadata
  -> object storage HTML blob
  -> /d/:draftId sandboxed viewer
```

### Recommended Stack

- Runtime: Node.js 24 LTS, TypeScript, Express or Fastify.
- Monorepo: Turborepo with pnpm workspaces.
- Database: Postgres.
- Object storage: Azure Blob Storage first, generic adapter interface.
- Production host: Azure Container Apps.
- Production DB: Azure Database for PostgreSQL Flexible Server.
- Production storage: Azure Blob Storage.
- Domain: `post.patchyhq.com`.
- CI: GitHub Actions.

## Repository Layout

```txt
apps/server/              HTTP server, API, viewer rendering, Dockerfile
packages/cli/             npm CLI entrypoint and bin
packages/core/            validation, IDs, shared types
packages/db/              schema, migrations, query helpers
packages/storage/         storage adapter interface and implementations
packages/config/          shared environment parsing
infra/azure/              Azure deployment templates
examples/                 sample HTML drafts and self-host examples
docs/                     plans, self-hosting, operations notes
```

## Monorepo Strategy

PatchPage should be built as a proper Turborepo from the start because the product has several independently useful units: a server Docker image, a public npm CLI, shared validation logic, database migrations, storage adapters, and deployment templates.

Root tooling:

```txt
package.json
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
eslint.config.js
prettier.config.js
```

Workspace package names:

```txt
@patchpage/server
patchpage
@patchpage/core
@patchpage/db
@patchpage/storage
@patchpage/config
```

The public CLI package should be named `patchpage` if available, because users will run:

```sh
npx patchpage upload ./plan.html
```

The internal packages should use the `@patchpage/*` scope so imports stay clear without exposing unnecessary packages publicly.

Turbo tasks:

```txt
build       compile packages and server
dev         run local development processes
test        run unit and integration tests
lint        static checks
typecheck   TypeScript checks
db:migrate  run migrations
docker      build the server image
```

Allowed import direction:

```txt
apps/server
  -> packages/db
  -> packages/storage
  -> packages/config
  -> packages/core

packages/cli
  -> packages/config
  -> packages/core

packages/db
  -> packages/config

packages/storage
  -> packages/config
```

`packages/core` must not import server, db, or storage code. The HTML policy lives there so the CLI and server always enforce the same rules.

`packages/db` owns migrations and schema setup. The server imports DB helpers, but deployment scripts should be able to run migrations without importing the HTTP server.

`apps/server` owns the container boundary. The Dockerfile should build only what the server needs, while still using Turbo pruning or equivalent workspace-aware install behavior to avoid shipping the whole repo unnecessarily.

## Server API

```txt
GET  /healthz
GET  /api/me
POST /api/tokens
POST /api/uploads
GET  /d/:draftId
GET  /d/:draftId/v/:versionNumber
POST /api/drafts/:draftId/disable
DELETE /api/drafts/:draftId
```

### Auth Rules

- `POST /api/uploads` requires bearer token.
- `GET /api/me` requires bearer token.
- Token creation requires the bootstrap token or an admin token.
- Delete/disable requires owner/admin token.
- Viewer routes are public/unlisted in V1.

## Data Model

```txt
accounts
  id, name, created_at, updated_at

api_tokens
  id, account_id, name, token_hash, scopes, created_at, last_used_at, revoked_at

drafts
  id, account_id, title, visibility, current_version_id,
  repo_org, repo_name, created_at, updated_at, deleted_at, disabled_at,
  disabled_reason

draft_versions
  id, draft_id, version_number, object_key, content_hash, file_size,
  created_by_api_token_id, source_ip, user_agent, cli_version,
  git_branch, git_commit_sha, original_filename, created_at

upload_events
  id, draft_id, draft_version_id, api_token_id, event_type,
  source_ip, user_agent, metadata_json, created_at
```

Keep `visibility` now with default `unlisted`; do not enforce private viewing until that feature is intentionally designed.

## HTML Policy

Allowed:

- Semantic HTML.
- Inline CSS in `<style>` or `style` attributes.
- Normal document metadata.
- HTTPS links.
- HTTPS or data images.

Blocked:

- `<script>`.
- Forms.
- Iframes, embeds, objects, applets.
- Inline event handlers.
- `javascript:`, `vbscript:`, and `file:` URLs.
- `srcdoc`.
- `<base>` and external stylesheets.
- Meta refresh redirects.
- Unsafe CSS patterns such as `expression()` and `url(javascript:...)`.

Default size limit: 512 KB.

## CLI Contract

Brand name: PatchPage.

Npm package and binary name: `patchpage`, unless npm availability forces a scoped package. The user-facing docs should still refer to the tool as PatchPage.

Default hosted API:

```txt
https://post.patchyhq.com
```

Commands:

```sh
npx patchpage auth set <api-token>
npx patchpage auth set <api-token> --api-url https://post.example.com
npx patchpage whoami
npx patchpage validate ./plan.html
npx patchpage upload ./plan.html
npx patchpage upload ./plan.html --new
npx patchpage upload ./plan.html --draft <draft-id>
```

Config precedence:

1. Explicit CLI flags.
2. Environment variables such as `PATCHPAGE_API_URL` and `PATCHPAGE_API_TOKEN`.
3. Local CLI config under `~/.patchpage`.
4. Default `https://post.patchyhq.com`.

## Azure Deployment

Default deployment decision:

- Cloud: Azure.
- Region: East US unless the CLI/account context makes another US East region materially better.
- DNS provider workflow: use Vercel CLI for `patchyhq.com` DNS records.
- Host recommendation: Azure Container Apps.
- Blob authentication recommendation: managed identity from day one.
- Npm publish timing: do not publish until the local vertical slice works.

Resources:

- Azure Container Registry.
- Azure Container Apps environment.
- Azure Container App for the server.
- Azure Database for PostgreSQL Flexible Server.
- Azure Storage Account and private Blob container.
- Managed identity for Blob access if practical.
- Application Insights or Log Analytics.
- Custom domain and TLS for `post.patchyhq.com`.

Production environment variables:

```env
NODE_ENV=production
PORT=3000
PATCHPAGE_PUBLIC_BASE_URL=https://post.patchyhq.com
PATCHPAGE_BOOTSTRAP_API_TOKEN=
PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=false
PATCHPAGE_MAX_HTML_BYTES=524288
DATABASE_URL=
PATCHPAGE_STORAGE_DRIVER=azure-blob
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=patchpage-drafts
```

Do not commit real values.

### Host Options

PatchPage needs a long-running HTTP service with custom domain support, a Docker image, database connectivity, and clean deployment automation.

Recommended: Azure Container Apps.

- Good fit for a containerized Turborepo server app.
- Supports custom domains and TLS.
- Can scale to zero while traffic is low.
- Keeps the Docker image as the production artifact, which also helps self-hosters.
- Slightly more moving parts than App Service, but better aligned with an OSS self-hostable image.

Alternative: Azure App Service.

- Simpler mental model for a Node web app.
- Good custom domain and managed certificate story.
- Can run Node directly or from a container.
- Less aligned with the "ship a Docker image others can run" path unless we use containerized App Service.

Alternative: Azure Functions.

- Strong for small serverless endpoints.
- Less natural for a full viewer app plus CLI API plus migrations.
- Cold starts and function packaging add complexity without much benefit for this product.

Decision: use Azure Container Apps unless local testing reveals a concrete blocker.

### Blob Auth Options

Recommended: managed identity.

- The Container App gets an Azure-managed identity.
- Azure grants that identity access to the private Blob container.
- The app uses `DefaultAzureCredential` in production.
- No storage account key or connection string needs to exist in app settings, GitHub secrets, or docs.
- Setup requires Azure role assignment plumbing, but that is the right tradeoff for a public OSS repo.

Fallback: storage connection string or account key.

- Faster to wire up.
- Easier for local one-off testing.
- Higher secret-handling risk because a long-lived credential has to be stored somewhere.
- Should remain a local/dev fallback, not the default production path.

Decision: design the storage adapter to support both, but provision Patchy's Azure deployment with managed identity first.

## OSS Hygiene

- MIT license.
- No real Azure subscription IDs, tenant IDs, secrets, tokens, account keys, connection strings, or DNS provider values.
- `.env.example` only contains placeholders.
- Production docs use generic values unless a value is already intentionally public, such as `https://post.patchyhq.com`.
- Blob containers should be private; public viewing goes through the app.
- Server logs must avoid storing uploaded HTML bodies.

## Milestones

### Milestone 1: Local vertical slice

- Create pnpm workspace and Turborepo root config.
- Add workspace boundaries for server, CLI, core, db, storage, and config.
- Implement shared HTML validator with tests.
- Implement server with local filesystem storage adapter.
- Implement Postgres schema and migrations.
- Implement token-gated upload.
- Implement sandboxed viewer.
- Implement CLI `validate`, `auth set`, `whoami`, and `upload`.

Done when a local HTML file can be uploaded and viewed through `http://localhost:3000/d/:id`, and unauthenticated upload returns `401`.

### Milestone 2: Azure storage and deploy

- Add Azure Blob storage adapter.
- Add workspace-aware Dockerfile for `apps/server`.
- Add Azure infrastructure templates.
- Add GitHub Actions build/test workflow.
- Deploy to Azure Container Apps.
- Bind `post.patchyhq.com`.

Done when `npx patchpage upload ./plan.html` returns a working `https://post.patchyhq.com/d/:id` URL.

### Milestone 3: OSS polish

- Add self-hosting guide.
- Add API docs.
- Add package publish workflow.
- Add security notes.
- Add examples.
- Publish first npm prerelease only after local upload/view/update works end to end.

## Execution Inputs

- Repo name and ownership: `allisonmahmood/PatchPage`, public.
- Npm package name: `patchpage`.
- Azure access: available through local Azure CLI. Do not commit Azure account, subscription, tenant, resource IDs, or generated secrets.
- Azure region: East US by default.
- DNS access: available through Vercel CLI for `patchyhq.com`. Do not commit provider-specific verification values unless they are intentionally public DNS records.
- Host: Azure Container Apps unless a blocker appears.
- Blob auth: managed identity for production; secret-based auth only as local/dev fallback.
- Npm publish: wait until the local system works end to end.
