# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Also apply an area label

Triage sets one more axis: **which part of the codebase the issue touches**. Apply every area label that fits — an issue can legitimately span several. If the report doesn't say enough to tell, leave them off rather than guessing; a wrong area label is worse than none, because it's what `gh issue list --label area:cli` is filtered on.

| Label         | Covers                                                                |
| ------------- | --------------------------------------------------------------------- |
| `area:server` | `apps/server`, plus `packages/db`, `packages/storage`, `packages/config` |
| `area:cli`    | `packages/cli` — the `npx patchpage` package                           |
| `area:core`   | `packages/core` — the safe-HTML policy, ids, crypto                    |
| `area:ci`     | `.github/`, `scripts/`, and workspace build config                     |
| `area:docs`   | `docs/`, README, and other Markdown                                    |

The first three mirror the contexts in `CONTEXT-MAP.md`, so triage and the domain docs stay in one vocabulary — see `domain.md`.

The bug and feature forms ask the reporter which part of PatchPage is affected. Treat that answer as a hint, not a decision: reporters routinely attribute a validation bug to the CLI when it comes from `packages/core`.

Two things triage should **not** do here:

- **Don't set `size:*` labels.** They're derived from a pull request's diff by `.github/workflows/pr-labels.yml` and mean nothing on an issue.
- **Don't add a "blocked" label.** This repo records blocking through GitHub's native issue dependencies, which is what the wayfinding operations in `issue-tracker.md` already use.
