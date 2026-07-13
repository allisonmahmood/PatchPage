# Self-Hosting PatchPage

PatchPage is a normal Node HTTP service and runs anywhere that supports Node or containers. Azure Container Apps is the maintainer's deployment target, not a requirement — this guide covers the container image contract that release automation will publish and running your own instance from source. The [Azure Terraform](../infra/azure) directory is a worked example you can adapt.

Once your server is running, point the CLI at it and you have a self-hosted PatchPage. Upload access requires a token by default; an operator can opt in to anonymous creation. In either mode, draft viewer URLs are public and unlisted, so anyone with the link can view them.

## Prerequisites

- Docker or another OCI-compatible runtime when using the supported image.
- Node.js 22.13 or newer when running from source (the CLI and server require Node 22+, and pnpm 11 needs at least 22.13). The container image bundles its own Node.
- pnpm when running from source (the repo pins `pnpm@11.5.2` via `packageManager`).
- A PostgreSQL database, if you use the `postgres` metadata driver. The default `json` driver needs no database and is fine for small or single-user instances.
- Git is optional; the CLI records repo/branch metadata with each upload when the file is inside a git repo.

## Supported container image contract

Release automation is configured to publish the supported image as `ghcr.io/allisonmahmood/patchpage-server`. Its tags are published from one verified image:

Reconciliation support begins with `v0.1.1`. The existing `v0.1.0` source tag predates the supported non-root `/data`, label, and license image contract, so scheduled reconciliation deliberately ignores it and never broadens or retags that legacy release.


- A stable semver tag without a `v` prefix, such as `1.2.3`, is intended not to move and is the recommended human-readable deployment tag. Prerelease versions such as `1.2.3-rc.1` are rejected by the release guard before npm or GHCR publication can begin.
- The full commit SHA tag is also intended not to move and identifies the source commit.
- The moving `latest` tag follows the newest release; use it only when automatic movement is intended. During a delayed release, a newer `latest` is left untouched only when its manifest digest and config match the paired release tags named by its stable version and revision labels; missing or mismatched state fails closed.

First-package gate: the workflow does not change package visibility or fabricate the GHCR Public visibility transition, and scheduled reconciliation likewise leaves visibility untouched. After the first authenticated push creates the package, a maintainer must set GHCR Public visibility in GitHub. Release acceptance for issue #17 stays open until the separate anonymous GHCR smoke jobs use fresh Docker configurations without credentials: the release smoke must prove the semver tag and exact digest match the publisher-bound manifest and config before booting that digest, while each reconciliation smoke must prove the semver and full-commit tags plus the digest match the bound manifest and config for every complete supported release, then verify exact `/healthz`. Repaired rows consume the newest exact immutable publisher-result artifact for their version/revision; already-complete rows consume the manifest and config digests captured by the inspect snapshot. Until those gates pass, these docs describe the intended supported image, not proof that a public package is already live.

GHCR publication uses OCI manifest digests as canonical identity. OCI Distribution manifest `PUT` does not provide an ordinary tag-level `If-Match`/`If-None-Match` compare-and-swap contract, so tag pointers are not immutable and this project does not claim they are. For an immutable deployment pin, use the publisher-verified manifest digest (`ghcr.io/allisonmahmood/patchpage-server@sha256:...`). The publisher reads authoritative registry state before and after every tag write, repairs only missing release-tag mates, and fails on post-write divergence, but an external repository writer can still race after the final read or transiently between reads. Repository-writer exclusivity remains a live human gate for releases, and issue #17 stays open until that operating constraint and the anonymous smoke gate are satisfied.

Release and GHCR reconciliation workflows use the shared `release-ghcr-patchpage-server` concurrency group with GitHub Actions `queue: max`. GitHub caps that maximum at 100 pending runs; the workflow relies on the documented `max` keyword rather than numeric queue syntax. Scheduled/manual reconciliation inspects every supported release, repairs a bounded batch of missing or incomplete pairs, and reconciles `latest` whenever at least one supported release is complete. Credentialless acceptance then runs for every complete supported pair, including zero-repair runs: already-complete rows use their digest-bound inspect snapshot, repaired rows use the newest exact immutable publisher-result artifact, and unrelated or stale artifacts from earlier attempts are ignored.

The image runs as the non-root `node` user (UID/GID 1000). Its supported writable persistence mount is `/data`. With the default `json` metadata and `filesystem` storage drivers, the image sets:

```env
PATCHPAGE_DB_FILE=/data/patchpage-db.json
PATCHPAGE_STORAGE_DIR=/data/drafts
```

After a release has published the image, start an instance with a named volume and a stable release version:

```sh
docker volume create patchpage-data
docker run -d \
  --name patchpage \
  -p 3000:3000 \
  -e PATCHPAGE_PUBLIC_BASE_URL=https://post.example.com \
  -e PATCHPAGE_BOOTSTRAP_API_TOKEN=change-me-to-a-long-random-string \
  -e PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=false \
  -v patchpage-data:/data \
  ghcr.io/allisonmahmood/patchpage-server:1.2.3
```

Named volumes inherit the image's `/data` ownership. If you use a host bind mount instead, make that directory writable by UID/GID 1000 before starting the container. Persist `/data` for the single-instance JSON/filesystem setup; Postgres and Azure Blob deployments keep their durable data in those external services. Every configuration variable below is supported in the image and can be supplied with `-e` or your orchestrator's environment configuration.

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
# Leave unset for a direct deployment. Configure only after verifying the proxy path.
# PATCHPAGE_TRUST_PROXY=1

# Auth
# The bootstrap token becomes a usable admin+upload API token on startup/migration.
# Set it to a long random string and keep it secret.
PATCHPAGE_BOOTSTRAP_API_TOKEN=change-me-to-a-long-random-string
PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=false

# Upload limits
PATCHPAGE_MAX_HTML_BYTES=524288

# Abuse protection
PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE=60
PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE=20
PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE=5

# Metadata store: "postgres" or "json"
# Defaults to "postgres" if DATABASE_URL is set, otherwise "json".
PATCHPAGE_DB_DRIVER=postgres
DATABASE_URL=postgres://user:password@host:5432/patchpage
# Only used by the "json" driver.
# Source default: .local/patchpage-db.json
# Container image default: /data/patchpage-db.json
PATCHPAGE_DB_FILE=.local/patchpage-db.json

# HTML object storage: "filesystem" or "azure-blob"
# Defaults to "filesystem".
PATCHPAGE_STORAGE_DRIVER=filesystem
# Source default: .local/drafts
# Container image default: /data/drafts
PATCHPAGE_STORAGE_DIR=.local/drafts

# Only used by the "azure-blob" storage driver:
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=
# If a connection string is absent, azure-blob uses managed identity.
AZURE_STORAGE_CONNECTION_STRING=
```

Notes on values:

- `PATCHPAGE_PUBLIC_BASE_URL` is used to build the public draft URLs returned by uploads and rendered in the viewer. Set it to the externally reachable origin (scheme + host, no trailing slash). The Azure Terraform example requires a deployer-owned HTTPS origin; the application itself retains its `http://localhost:3000` default for local development.
- `PATCHPAGE_TRUST_PROXY` controls whether Fastify derives `request.ip` from `X-Forwarded-For`. Leave it undefined unless every route to the server has a verified trust boundary. See [Client IP attribution behind proxies](#client-ip-attribution-behind-proxies).
- `PATCHPAGE_MAX_HTML_BYTES` caps the size of a single HTML document (default 524288 = 512 KiB).
- `PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE`, `PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE`, and `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE` are decimal integers from `1` through `10000`. Defaults are `60`, `20`, and `5`.
- `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS` is a strict `true`/`false` opt-in and defaults to `false`. When `true`, a request with no `Authorization` header may create a new unlisted draft only. Anonymous requests must omit `draftId`; they cannot update, list, disable, or delete drafts. Any present malformed, invalid, revoked, or insufficient credential remains an authentication or authorization failure and never falls back to anonymous access.
- When running from source, the `json` metadata driver and `filesystem` storage driver write under `.local/` by default. The supported image overrides those path defaults to `/data` as shown above. Both modes need no external services and suit a quick or single-instance self-host. For a durable multi-instance deployment, use `postgres` and a shared object store (`azure-blob`).

### Abuse protection and rate limits

PatchPage applies deterministic fixed-window in-memory limits inside each server process:

- Protected `/api` requests are limited to `PATCHPAGE_PROTECTED_API_RATE_LIMIT_PER_MINUTE` attempts per minute per canonical Fastify `request.ip`. That IP follows `PATCHPAGE_TRUST_PROXY`, so configure the proxy boundary before relying on IP-based buckets.
- Authenticated upload requests are limited to `PATCHPAGE_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE` attempts per minute per API token database identity. Rotating the raw bearer secret for the same token record does not create a fresh upload bucket.
- When anonymous uploads are enabled, anonymous create attempts are additionally limited to `PATCHPAGE_ANONYMOUS_CREATE_RATE_LIMIT_PER_MINUTE` attempts per minute per canonical `request.ip`. They consume the protected-IP bucket and this anonymous-create bucket, but never an authenticated token bucket.

When a bucket is exceeded, PatchPage returns HTTP `429` with JSON `{ "ok": false, "code": "rate_limited", ... }` and an integer `Retry-After` header. Each limiter tracks up to `10000` live keys in memory. If all live key slots are occupied, an unseen key receives the same bounded `429` response until the earliest live bucket resets. Live buckets are never evicted to make room for an unseen key, because eviction would let an attacker bypass limits by cycling key values.

Expired buckets are pruned deterministically when the process observes a request at or after their reset boundary. A request exactly at the reset time starts a new fixed window for that key. Public `GET /healthz` and draft viewer routes under `/d/...` do not consume protected API or upload buckets.

These counters are process-local and memory-only. They reset on restart and are not shared across Node processes, containers, or replicas. For multi-instance deployments, treat them as a local safety net and add an ingress, load balancer, CDN, or shared external rate limiter if you need a global limit.

### JSON metadata durability

The `json` driver supports one PatchPage Node process. Within that process, database objects targeting the same backing-directory filesystem identity — including containing-directory bind-mount aliases and case aliases on case-insensitive filesystems — share one mutation serializer, even before the final file exists. Queue identity includes every existing ancestor, so creating a missing parent cannot move a later mutation onto a different queue. Each mutation completes its read, state-shape validation, update, and commit before the next mutation starts. This coordination is strictly process-local; the driver does not provide interprocess locking.

The final `PATCHPAGE_DB_FILE` path may be absent or a singly linked regular file, and every user-configurable parent component must be a real directory rather than a symbolic link (Darwin's fixed `/etc`, `/tmp`, and `/var` compatibility paths are treated as platform roots). Live or dangling parent-directory symlinks, live or dangling final-component symlinks, multiply linked regular files (hard links), FIFOs, directories, sockets, devices, and other special files are unsupported and rejected without changing the path, alias, or target. Existing invalid-UTF-8, malformed, truncated, unreadable, or invalid-shape files are likewise rejected without replacement. Mutated state must be losslessly JSON-representable; unsafe state is rejected before a temporary commit file is created.

For a fresh path, missing parent directories are created incrementally and each new directory entry is flushed through its containing directory where the platform supports directory flushing. On first use in each process, the existing ancestor chain is also re-flushed; if flushing a newly created directory's parent fails, a retry must complete that ancestor flush before any commit can succeed. Each commit acquires the target-directory handle before committing, writes and flushes a uniquely named temporary file in that directory, atomically renames it over the primary file, and flushes the already-open directory handle. A failure before rename leaves the primary uncommitted. If rename succeeds but the directory flush fails, the operation reports an **indeterminate commit outcome**; inspect the database state before retrying. On filesystems that honor same-directory atomic replacement, readers see either the previous complete state or the new complete state, not a partially written primary.

On Linux, do not configure `PATCHPAGE_DB_FILE` as a single-file bind mount. Linux does not permit rename-based replacement of that mount point, so the driver rejects the commit without modifying the mounted file. Mount a writable containing directory instead, then place `PATCHPAGE_DB_FILE` inside it. Crash and power-loss durability still depends on the operating system, filesystem, mount, and storage hardware honoring rename and flush semantics; network, FUSE, overlay/container, and synchronized filesystems may provide weaker guarantees. Keep backups.

Do not share one JSON file between multiple PatchPage processes, workers, or replicas. That setup can lose updates. Use `postgres` and a shared object store for a multi-process or multi-replica deployment.

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

This creates the `accounts`, `api_tokens`, `drafts`, `draft_versions`, and `upload_events` tables (idempotently), initializes the dedicated internal anonymous owner/audit actor without a usable bearer credential, and — when `PATCHPAGE_BOOTSTRAP_API_TOKEN` is set — provisions a bootstrap account and a bootstrap API token with `admin` and `upload` scopes. The `json` driver applies the same initialization automatically on startup, so no separate migration is needed for it.

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

The server listens on `0.0.0.0:$PORT` and exposes a `GET /healthz` endpoint that returns exactly `{"ok":true}` for health checks. To build an image from your checkout instead of pulling the supported release, run `pnpm --filter @patchpage/server docker` (see `apps/server/Dockerfile`).

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

An upload without a draft ID creates a draft with a cryptographically generated server ID. To add a version to a specific draft, use `patchpage upload ./plan.html --draft <draft-id>`. The `--draft` option is update-only: the target must already be active and owned by the authenticated account, and unknown, deleted, disabled, or unowned targets all return the same generic unavailable response without creating a draft. Use `--new` for an explicit create; `--new` and `--draft` cannot be combined.

When neither `PATCHPAGE_API_TOKEN` nor a stored token exists, `patchpage upload` attempts an anonymous create. It ignores cached draft IDs and does not write anonymous results to the update cache. This succeeds only when the target self-hosted server has explicitly set `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=true`; the default is `false`. Pass `--anonymous` to force create-only anonymous mode and bypass available credentials, or combine `--anonymous --new` for an explicit new anonymous draft. `--draft` is incompatible with anonymous mode because all updates require authentication. Authentication failures are returned directly and are never retried anonymously.

`auth set` reads the token from a non-echoing terminal prompt. Automation that needs to persist credentials must explicitly pipe one token to `--token-stdin`:

```sh
printf '%s' "$TOKEN" | patchpage auth set --token-stdin --api-url https://post.example.com
```

Alternatively, CI can set `PATCHPAGE_API_URL` and `PATCHPAGE_API_TOKEN` directly on ordinary authenticated commands such as `whoami` and `upload`, skipping `auth set` entirely. `auth set` does not read `PATCHPAGE_API_TOKEN`.

## Deployment notes

PatchPage serves plain HTTP and does not terminate TLS itself. Put it behind a reverse proxy or platform ingress (nginx, Caddy, a cloud load balancer, Azure Container Apps ingress, etc.) that terminates TLS and forwards to `$PORT`, and set `PATCHPAGE_PUBLIC_BASE_URL` to the public HTTPS origin. Provide `DATABASE_URL` and any storage credentials through your platform's secret management rather than committing them.

### Client IP attribution behind proxies

Fastify's `request.ip` is PatchPage's single attributed client address. Uploads persist that value in the `source_ip` fields of `draft_versions` and `upload_events`; code that needs the attributed client address must consume the same value rather than reparsing forwarding headers.

When `PATCHPAGE_TRUST_PROXY` is absent, Fastify ignores `X-Forwarded-For` and `request.ip` is the direct socket peer. This is the safe setting for a direct deployment. A defined blank or whitespace-only value is an error, not another spelling of "off".

The setting accepts exactly one of these forms:

- A decimal hop count from `1` through `32`, kept as a number for Fastify. Starting at PatchPage, Fastify considers the socket peer first, then the rightmost `X-Forwarded-For` entry, and continues right-to-left. Count `1` trusts the socket peer and selects the rightmost forwarded address. Count `2` also trusts that nearest forwarded hop and selects the next address to its left.
- One or more comma-separated literal IPv4/IPv6 addresses or CIDR networks. Fastify walks from the socket outward while each address belongs to the configured set; the first address outside the set becomes `request.ip`.

Values such as `0`, negative or fractional counts, `true`, `false`, `all`, `*`, empty list entries, malformed addresses, blanket `/0` networks, deprecated `::` plus dotted-IPv4 transitional aliases, IPv4-mapped IPv6 aliases, and CIDR lists whose effective union covers all IPv4 or all IPv6 addresses are rejected. IPv6 entries with dotted IPv4 tails must use canonical decimal octets; ambiguous forms with leading zeroes are rejected so Terraform and the Node.js runtime interpret the same trust boundary. Network entries are syntax-only until you replace them with the proxy addresses actually observed in your environment; for example:

```env
# Documentation addresses only; replace both entries with observed proxy egress ranges.
PATCHPAGE_TRUST_PROXY=192.0.2.10,2001:db8:1234::/48
```

For one nginx proxy, make nginx replace any client-supplied value and use count `1` only if nginx is the sole route to PatchPage:

```nginx
location / {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://patchpage:3000;
}
```

```env
PATCHPAGE_TRUST_PROXY=1
```

nginx also provides `$proxy_add_x_forwarded_for`, which appends its peer address to an existing header. If you use it in a multi-proxy topology, validate the upstream before preserving its header and configure PatchPage for the whole observed chain. See nginx's [`proxy_set_header` and `$proxy_add_x_forwarded_for` documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

For a single Caddy proxy, its normal reverse proxy behavior sets the forwarded headers and disregards client-supplied forwarded values. With no other path to PatchPage, count `1` is appropriate:

```caddyfile
post.example.com {
    reverse_proxy patchpage:3000
}
```

```env
PATCHPAGE_TRUST_PROXY=1
```

If another proxy or CDN precedes Caddy, configure Caddy's own trusted-proxy boundary first and then configure PatchPage for the chain Caddy actually sends. See Caddy's [`reverse_proxy` forwarding-header behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).

For an invariant two-proxy path such as `client -> CDN/load balancer -> nginx/Caddy -> PatchPage`, count `2` selects the address two positions away from the application:

```env
PATCHPAGE_TRUST_PROXY=2
```

Hop counts are safe only when every reachable route has that exact proxy depth and each proxy overwrites or predictably appends forwarding data. A shorter bypass path can turn an attacker-supplied header entry into `request.ip`. Prefer a verified address/CIDR set when path length varies, but do not trust broad private networks shared with untrusted workloads. In either mode, prevent clients from reaching PatchPage around the trusted proxy and test every public hostname with a deliberately spoofed `X-Forwarded-For` value before relying on the attribution for audit.

The [`infra/azure`](../infra/azure) Terraform directory is an Azure-specific worked example for the platform resources: Container Apps and external ingress, a container registry, PostgreSQL, Blob Storage with a private container, managed identity, and server configuration. It intentionally does not provision the deployer's DNS records, Container App custom hostname, Azure managed certificate, or certificate binding. Its [README](../infra/azure/README.md) separates those resources from the complete manual custom-domain and certificate flow.

## Security

Keep `PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=false` unless you intentionally accept public create traffic and have an appropriate external abuse-control layer. Anonymous access is create-only; authenticated owners retain updates, and admin-scoped credentials can disable or delete anonymous drafts. Treat `PATCHPAGE_BOOTSTRAP_API_TOKEN` as a secret, and remember that draft viewer URLs are public and unlisted — anyone with a link can view the rendered HTML unless you add your own viewer access controls.
