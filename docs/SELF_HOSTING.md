# Self-Hosting PatchPage

PatchPage is a normal Node HTTP service and runs anywhere that supports Node or containers. Azure Container Apps is the maintainer's deployment target, not a requirement — this guide covers running your own instance from source. The [Azure Terraform](../infra/azure) directory is a worked example you can adapt.

Once your server is running, point the CLI at it and you have a private PatchPage: upload access is token-gated, but the draft URLs it returns are public and unlisted (anyone with the link can view them).

## Prerequisites

- Node.js 22.13 or newer (the CLI and server require Node 22+, and pnpm 11 needs at least 22.13). The Docker image bundles its own Node.
- pnpm (the repo pins `pnpm@11.5.2` via `packageManager`).
- A PostgreSQL database, if you use the `postgres` metadata driver. The default `json` driver needs no database and is fine for small or single-user instances.
- Git is optional; the CLI records repo/branch metadata with each upload when the file is inside a git repo.

## Clone, install, build

```sh
git clone https://github.com/allisonmahmood/PatchPage.git
cd PatchPage
pnpm install
pnpm build
```

## Configuration

PatchPage reads configuration from process environment variables. It does **not** auto-load a `.env` file, so export these in your shell, container, or process manager. The block below documents every variable the server understands; use it as a reference for what to set.

```env
# HTTP
PORT=3000
PATCHPAGE_PUBLIC_BASE_URL=https://post.example.com

# Auth
# The bootstrap token becomes a usable admin+upload API token on startup/migration.
# Set it to a long random string and keep it secret.
PATCHPAGE_BOOTSTRAP_API_TOKEN=change-me-to-a-long-random-string
PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=false

# Upload limits
PATCHPAGE_MAX_HTML_BYTES=524288

# Metadata store: "postgres" or "json"
# Defaults to "postgres" if DATABASE_URL is set, otherwise "json".
PATCHPAGE_DB_DRIVER=postgres
DATABASE_URL=postgres://user:password@host:5432/patchpage
# Only used by the "json" driver:
PATCHPAGE_DB_FILE=.local/patchpage-db.json

# HTML object storage: "filesystem" or "azure-blob"
PATCHPAGE_STORAGE_DRIVER=filesystem
PATCHPAGE_STORAGE_DIR=.local/drafts

# Only used by the "azure-blob" storage driver:
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=
# If a connection string is absent, azure-blob uses managed identity.
AZURE_STORAGE_CONNECTION_STRING=
```

Notes on values:

- `PATCHPAGE_PUBLIC_BASE_URL` is used to build the public draft URLs returned by uploads and rendered in the viewer. Set it to the externally reachable origin (scheme + host, no trailing slash). The Azure Terraform example requires a deployer-owned HTTPS origin; the application itself retains its `http://localhost:3000` default for local development.
- `PATCHPAGE_MAX_HTML_BYTES` caps the size of a single HTML document (default 524288 = 512 KiB).
- `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` is parsed but not currently enforced — the upload endpoint always requires a token with the `upload` scope regardless of this setting. Keep it `false`.
- The `json` metadata driver and `filesystem` storage driver write under `.local/` by default and need no external services — good for a quick self-host or local testing. For a durable multi-instance deployment, use `postgres` and a shared object store (`azure-blob`).

### Storage drivers

- `filesystem` — writes HTML objects to `PATCHPAGE_STORAGE_DIR` on local disk. Simplest option.
- `azure-blob` — Azure Blob Storage, authenticating with a connection string or, when none is set, a managed identity.

## Database migration

If you use the `postgres` driver, create the schema and the bootstrap token before starting the server. The migration reads the same environment variables as the server:

```sh
PATCHPAGE_DB_DRIVER=postgres \
DATABASE_URL=postgres://user:password@host:5432/patchpage \
PATCHPAGE_BOOTSTRAP_API_TOKEN=change-me-to-a-long-random-string \
pnpm db:migrate
```

This creates the `accounts`, `api_tokens`, `drafts`, `draft_versions`, and `upload_events` tables (idempotently), and — when `PATCHPAGE_BOOTSTRAP_API_TOKEN` is set — provisions a bootstrap account and a bootstrap API token with `admin` and `upload` scopes. The `json` driver applies the same bootstrap step automatically on first startup, so no separate migration is needed for it.

## Running the server

Development (auto-reload):

```sh
pnpm --filter @patchpage/server dev
```

Production (from the built output):

```sh
pnpm --filter @patchpage/server build
pnpm --filter @patchpage/server start
```

The server listens on `0.0.0.0:$PORT` and exposes a `GET /healthz` endpoint that returns `{"ok":true}` for health checks. A container image is also available via `pnpm --filter @patchpage/server docker` (see `apps/server/Dockerfile`).

## Minting API tokens

The bootstrap token (`PATCHPAGE_BOOTSTRAP_API_TOKEN`) is itself a valid API token with `admin` and `upload` scopes. You can use it to authenticate the CLI, but the better practice is to use it once to mint scoped, per-client tokens.

`POST /api/tokens` requires a token with the `admin` scope (the bootstrap token has it). The request body accepts an optional `name` and `scopes` array; if `scopes` is omitted it defaults to `["upload"]`. It returns the new token as `token` — this value is shown only in the response, so capture it.

```sh
curl -sS -X POST https://post.example.com/api/tokens \
  -H "Authorization: Bearer $PATCHPAGE_BOOTSTRAP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"laptop","scopes":["upload"]}'
```

Response (HTTP 201):

```json
{
  "ok": true,
  "apiToken": { "id": "tok_...", "name": "laptop" },
  "token": "pp_..."
}
```

You can confirm any token with `GET /api/me` (or `patchpage whoami`), which returns the account, token name, and scopes.

## Pointing the CLI at your instance

Save the minted token and your instance's base URL:

```sh
patchpage auth set --api-url https://post.example.com
patchpage whoami
patchpage upload ./plan.html
```

`auth set` reads the token from a non-echoing terminal prompt. Automation that needs to persist credentials must explicitly pipe one token to `--token-stdin`:

```sh
printf '%s' "$TOKEN" | patchpage auth set --token-stdin --api-url https://post.example.com
```

Alternatively, CI can set `PATCHPAGE_API_URL` and `PATCHPAGE_API_TOKEN` directly on ordinary authenticated commands such as `whoami` and `upload`, skipping `auth set` entirely. `auth set` does not read `PATCHPAGE_API_TOKEN`.

## Deployment notes

PatchPage serves plain HTTP and does not terminate TLS itself. Put it behind a reverse proxy or platform ingress (nginx, Caddy, a cloud load balancer, Azure Container Apps ingress, etc.) that terminates TLS and forwards to `$PORT`, and set `PATCHPAGE_PUBLIC_BASE_URL` to the public HTTPS origin. Provide `DATABASE_URL` and any storage credentials through your platform's secret management rather than committing them.

The [`infra/azure`](../infra/azure) Terraform directory is an Azure-specific worked example for the platform resources: Container Apps and external ingress, a container registry, PostgreSQL, Blob Storage with a private container, managed identity, and server configuration. It intentionally does not provision the deployer's DNS records, Container App custom hostname, Azure managed certificate, or certificate binding. Its [README](../infra/azure/README.md) separates those resources from the complete manual custom-domain and certificate flow.

## Security

Uploads currently always require a token with the `upload` scope. `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` is parsed but not enforced, so keep it `false`, treat `PATCHPAGE_BOOTSTRAP_API_TOKEN` as a secret, and remember that draft view URLs are public and unlisted — anyone with a link can view the rendered HTML unless you add your own viewer access controls.
