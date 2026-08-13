# Skill distribution

How the `patchpage` agent skill (`skills/patchpage/SKILL.md`) reaches users. There are
two public channels and one repo-local wiring; they behave very differently.

## Channel 1: the `skills` CLI (GitHub-direct, unversioned)

`npx skills add allisonmahmood/PatchPage` runs the [`skills`](https://www.npmjs.com/package/skills)
npm package by Vercel Labs ([vercel-labs/skills](https://github.com/vercel-labs/skills)).
It does **not** go through any registry:

- The CLI fetches the repo straight from GitHub (`api.github.com` + `codeload.github.com`
  tarball, anonymous by default) and scans for `SKILL.md` files in the canonical layout —
  `skills/<name>/SKILL.md` — which this repo satisfies.
- It installs by symlink or copy into the target agent's skill directory (e.g.
  `.claude/skills/`, `~/.claude/skills/`, `.agents/skills/`) and records the source and a
  content hash in the consumer's `skills-lock.json`. `npx skills update` re-pulls latest.
- **There is no install-time hook** (verified against `skills@1.5.22`: no lifecycle
  scripts, no hook strings in the bundle). Nothing runs after install — any onboarding
  must be triggered by the prompt the user pastes, not by the install itself.
- **This channel is live and unversioned.** Installs read the default branch, so merging
  a change to `skills/patchpage/**` on `main` immediately changes what new installers
  get. There is no release gate. Sequence skill changes accordingly.

### The skills.sh directory listing

[skills.sh](https://skills.sh) is a discovery/leaderboard layer over the same CLI. The
PatchPage listing at <https://skills.sh/allisonmahmood/patchpage> was **not published by
us and cannot be** — there is no submission or publish step. Listings appear
automatically from anonymous install telemetry (`npx skills add` phones home unless
`DISABLE_TELEMETRY=1`). The directory never hosts skill content; it links back to the
repo, and installs always pull from GitHub.

Practical consequences:

- Nothing to maintain on the skills.sh side; the listing tracks the repo automatically.
- We do not control the listing's existence or its install count.
- skills.sh claims to run "routine security audits" of listed skills; treat the listing
  as discovery only, not an endorsement channel.

## Channel 2: the npm package (versioned)

The `patchpage` npm package bundles the skill: `scripts/build-cli-bundle.mjs` copies the
root `skills/` directory into `packages/cli/skills` at build/prepack time, and
`packages/cli/package.json` ships it via the `files` array. This copy is versioned with
npm releases — users get the skill as of the release they installed, not `main`.

## Repo-local wiring

For agents working inside this repo, `.claude/skills/patchpage` →
`.agents/skills/patchpage` → `skills/patchpage` symlinks single-source the skill, and the
checked-in root `skills-lock.json` wires it without a second copy. Note the file plays
two roles: it is the `skills` CLI's lockfile format, used here as the repo's own
self-wiring mechanism.

The operator-only skill at `.agents/skills/patchpage-mint-token` sits outside `skills/`
and carries `metadata.internal`, which keeps it out of both public channels.
