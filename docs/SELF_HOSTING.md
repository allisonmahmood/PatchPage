# Self-Hosting PatchPage

PatchPage is designed to be portable. Azure Container Apps is Patchy's deployment target, not a requirement for self-hosters.

The server is a normal Node HTTP service and can run anywhere that supports containers or Node.

## Storage Choices

- `filesystem`: simplest local/dev mode.
- `s3`: planned generic object-storage adapter.
- `azure-blob`: Azure Blob Storage, using managed identity or a connection string.

## Minimal Environment

```env
PORT=3000
PATCHPAGE_PUBLIC_BASE_URL=https://post.example.com
PATCHPAGE_BOOTSTRAP_API_TOKEN=
PATCHPAGE_ALLOW_ANONYMOUS_UPLOADS=false
PATCHPAGE_MAX_HTML_BYTES=524288
PATCHPAGE_DB_DRIVER=postgres
DATABASE_URL=
PATCHPAGE_STORAGE_DRIVER=filesystem
PATCHPAGE_STORAGE_DIR=.local/drafts
```

Do not expose `POST /api/uploads` without tokens unless you intentionally want a public upload service.
