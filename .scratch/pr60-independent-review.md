## Independent review — PR #60 (`actions/setup-node` 4 → 7)

### Verdict: **ready to merge**

This is a minimal, correctly lockstepped SHA pin bump. The pinned commit matches `v7.0.0` / `v7`. Verifier digests were updated only for jobs whose YAML actually changed (setup-node coordinate only). No security controls were loosened. The OIDC npm publish path does **not** depend on setup-node registry/auth wiring, so the v5–v7 auth/cache behavioural changes do not break a tagged release on this repo’s actual design.

---

### Independently verified

| Check | Result |
| --- | --- |
| `gh api repos/actions/setup-node/git/ref/tags/v7` | `type: commit`, `sha: 820762786026740c76f36085b0efc47a31fe5020` |
| `gh api .../tags/v7.0.0` | same commit SHA (not an annotated tag; no dereference needed) |
| Latest release | `v7.0.0` (published 2026-07-14) |
| Old pin `v4.4.0` | still resolves to `49933ea5288caeca8642d1e84afbd3f7d6820020` (matches pre-image) |
| YAML comments / `reviewedActions` | all release + reconcile pins use `8207627… # v7.0.0`; map is `{ version: "v7.0.0", sha: "8207627…" }` |
| Job digests recomputed as `sha256(JSON.stringify(job))` | **MATCH** stored values for `prepare-npm`, `verify`, `publish-npm`, `npx-smoke`, reconcile `inspect` |
| Digest delta vs `origin/main` | **only** those five jobs changed; all other release/reconcile job digests unchanged |
| Diff scope | 4 files, +16/−16; only setup-node coordinates + matching verifier pins/digests |

**OIDC / trusted publishing reasoning (critical path):**

- `publish-npm` grants only `id-token: write` and calls `scripts/publish-exact-npm-artifact.mjs`.
- That script performs OIDC itself (`modules.oidc(...)` against `https://registry.npmjs.org/`) and never reads `NODE_AUTH_TOKEN` or a setup-node-written `.npmrc`.
- `publish-npm`’s setup-node step has **only** `node-version: 24.18.0` — no `registry-url`, no auth inputs.
- Upstream v4 only exported the dummy `NODE_AUTH_TOKEN=XXXXX-…` inside `configAuthentication(registryUrl)` when `registry-url` was set. This repo never sets it on setup-node. Removing the dummy export in v7 is therefore a no-op for release publish here.
- `always-auth` removal (v6.1) is also a no-op: no workflow references it.

**`cache: pnpm` reasoning:**

- Root `packageManager` is `pnpm@11.5.2`.
- v5 auto-caching from `packageManager` was later limited in **v6** to **npm only**; yarn/pnpm require explicit `cache`.
- CI and `verify` already pass `cache: pnpm` explicitly and install pnpm via `pnpm/action-setup` first — still the supported v7 pattern.
- Jobs without `cache` (prepare-npm, publish-npm, npx-smoke, min-Node smoke, reconcile inspect) remain uncached, same as under v4 for this config.

**`reviewedNodeVersion`:** still `"24.18.0"`, still matches every exact pin in release/reconcile, still present in `actions/node-versions` (alongside newer `24.18.1`). Truthful as an exact reviewed runtime pin; not drift from this PR.

---

### Commands run

```text
pnpm install --frozen-lockfile                          → exit 0 (already up to date)
pnpm test:public-surfaces                               → PASS
pnpm test:release-workflow                              → PASS
  "Verified 28 pinned Actions, npm@11.18.0, exact release image identity, …"
pnpm test:release-privacy                               → 50 pass, 0 fail
pnpm test:exact-npm-publisher                           → 12 pass, 0 fail
pnpm test:ghcr-oci                                      → 26 pass, 0 fail
pnpm test:docker-save                                   → 11 pass, 0 fail
pnpm lint                                               → exit 0
pnpm typecheck                                          → exit 0
pnpm test                                               → exit 0 (turbo cache hits for packages)
```

**Could not run / limited:**

- **Docker daemon unavailable** (`docker` not installed) — could not exercise real image build/run; `test:docker-save` is pure Node validation of save artifacts and did pass.
- **Postgres unavailable** — local `pnpm test` did not set `PATCHPAGE_REQUIRE_POSTGRES_TESTS`; `@patchpage/db` reported 9 skipped (expected without Postgres). Remote CI `test (22)` / `test (24)` are green with Postgres services.
- **release.yml end-to-end on a real tag** — not exercised here (and not by PR CI). Reasoning above substitutes for that gap.

Independent digest recompute (Node + yaml parse of current workflows) confirmed stored digests.

---

### Blocking

_None._

---

### Non-blocking

_None that survive self-refutation._

Considered and **dropped**:

| Concern | Why dropped |
| --- | --- |
| Dummy `NODE_AUTH_TOKEN` removal breaks OIDC publish | Repo never uses setup-node `registry-url`; publisher owns OIDC |
| v6 stops auto-caching pnpm from `packageManager` | Explicit `cache: pnpm` retained; auto path was never the reviewed release contract |
| Digest updates paper over unrelated YAML edits | Recomputed digests; only setup-node SHA/comment changed in those jobs |
| `reviewedNodeVersion` stale | Still matches YAML; exact pin still exists upstream |

---

### Nits

1. **`ci.yml` floats `actions/setup-node@v7`** while release/reconcile pin full SHAs — same pattern as pre-image `@v4`. Acceptable for CI; not a release-path risk. No change requested.

2. GitHub check **`labelfail`** is red on the PR; unrelated to this dependency bump (label bot). Do not treat as evidence against the pin.

---

### What was checked that *could* have failed

- SHA ≠ tag comment / ≠ `reviewedActions` entry  
- Extra verifier assertion deletions or count relaxations  
- Scope creep outside the four files  
- publish-npm relying on setup-node `.npmrc` / dummy token  
- Silent loss of `cache: pnpm` behaviour without explicit input  
- Digest updates for jobs that did not change  

None of those failures are present.

_Independent review by Grok 4.5 via grok CLI._
