# PatchPage Development

## Local Mode Without Postgres

The default local mode uses filesystem-backed metadata and filesystem-backed HTML storage:

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

The server stores local state under `.local/` unless configured otherwise.

## Postgres Mode

Set `PATCHPAGE_DB_DRIVER=postgres` and `DATABASE_URL` when a Postgres instance is available:

```sh
PATCHPAGE_DB_DRIVER=postgres \
DATABASE_URL=... \
PATCHPAGE_BOOTSTRAP_API_TOKEN=... \
pnpm db:migrate
```

Do not commit real database URLs or generated tokens.

## Production Storage

Patchy's production Azure deployment should use:

```env
PATCHPAGE_STORAGE_DRIVER=azure-blob
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=
```

The server uses managed identity when `AZURE_STORAGE_CONNECTION_STRING` is absent.
Connection-string auth remains available for local Azure testing and non-Patchy self-hosts.
