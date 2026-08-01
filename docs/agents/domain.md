# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — system-wide decisions. Read ADRs that touch the area you're about to work in.
- **`<context>/docs/adr/`** — context-scoped decisions, alongside that context's `CONTEXT.md`.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Layout

This is a **multi-context** repo — a pnpm workspace whose two halves are the service that hosts pages and the package people run to put pages up.

```
/
├── CONTEXT-MAP.md                     ← the map
├── docs/adr/                          ← system-wide decisions
├── apps/server/
│   ├── CONTEXT.md                     ← hosting context
│   └── docs/adr/
└── packages/
    ├── cli/
    │   ├── CONTEXT.md                 ← publishing context (the npx package)
    │   └── docs/adr/
    └── core/                          ← shared kernel: html-policy, crypto, ids, types
```

### Contexts

- **Hosting** — `apps/server`. Receives uploads and serves published pages. Owns `@patchpage/db`, `@patchpage/storage`, and `@patchpage/config` as supporting packages; treat changes in those as part of this context.
- **Publishing** — `packages/cli`. The `npx patchpage` package people use to put pages up. Its own vocabulary (drafts, uploads, auth tokens) lives here.
- **Shared kernel** — `packages/core`. The safe-HTML policy and the ID/crypto primitives both contexts depend on. It has no `CONTEXT.md` of its own; terms it defines belong to whichever context introduced them. Changes here ripple both ways, so decisions touching it go in the root `docs/adr/`, not a context-scoped one.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

Where a term appears in both contexts with different meanings, say which context you mean rather than collapsing them.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
