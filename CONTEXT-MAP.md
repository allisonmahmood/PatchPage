# Context Map

## Contexts

- [Hosting](./apps/server/CONTEXT.md) — receives uploads and serves published pages; owns `@patchpage/db`, `@patchpage/storage`, `@patchpage/config`
- Publishing — `packages/cli`, the `npx patchpage` package people use to put pages up (no `CONTEXT.md` yet; created when its first term resolves)

## Relationships

- **Publishing → Hosting**: the CLI creates and updates drafts through the hosting HTTP API, authenticated by auth tokens the hosting context mints
- **Shared kernel** (`packages/core`): the safe-HTML policy and ID/crypto primitives both contexts depend on; terms it defines belong to whichever context introduced them
