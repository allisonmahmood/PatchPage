# PatchPage

Publisher-gated, link-viewable static HTML draft hosting.

PatchPage is intended for agent-generated plans, briefs, architecture notes, reports, and other single-file HTML artifacts. Uploads require an authenticated token. Draft URLs are public/unlisted by default so anyone with the link can review the rendered artifact.

The project is planned as a Turborepo monorepo with separate workspaces for the server, CLI, shared validation/core code, database migrations, storage adapters, Docker image, and Azure deployment templates.

The default hosted endpoint for the Patchy deployment will be:

```sh
https://post.patchyhq.com
```

Self-hosted deployments can point the CLI at their own host.

## Credit

PatchPage is inspired by Postplan, the static HTML draft publishing tool created by Theo. The goal is to preserve that useful agent artifact pattern while building an open-source, self-hostable version with upload-gated publishing.

## Status

Initial implementation in progress.

## Local Quickstart

```sh
pnpm install
PATCHPAGE_BOOTSTRAP_API_TOKEN=dev-token pnpm --filter @patchpage/server dev
```

In another shell:

```sh
pnpm --filter patchpage build
PATCHPAGE_STATE_DIR=.local/cli node packages/cli/dist/index.js auth set dev-token --api-url http://localhost:3000
PATCHPAGE_STATE_DIR=.local/cli node packages/cli/dist/index.js upload examples/plan.html
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for more detail.

## License

MIT
