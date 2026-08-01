# What changed

<!-- One or two sentences. What does this do, and why now? -->

Closes #

## How it was verified

<!-- Tests added or run, manual checks, anything a reviewer should reproduce. -->

- [ ] `pnpm test` passes locally
- [ ] Added or updated tests covering this change

## Release impact

<!--
Area and size labels are applied automatically. This section is the part no
automation can decide: whether the change breaks anyone already depending on
PatchPage, which is what drives the version bump and the changelog entry.
-->

Tick exactly one.

- [ ] **Breaking** — requires action from existing users
- [ ] **Not breaking** — no action required

<!--
"Breaking" means a change to the CLI's public behaviour, the API contract, the
database schema, or the configuration format that existing users must react to.

If breaking, describe the break and the upgrade path below. If not breaking,
say briefly why -- "lockfile only", "dev dependency", "internal refactor".
Leaving both boxes unticked is not an answer; it reads as "not filled in".
-->
