---
name: patchpage
description: Create safe static HTML artifacts and publish them with PatchPage.
triggers:
  - "patchpage"
  - "make this a shareable HTML"
  - "upload this plan"
  - "shareable artifact"
  - "HTML draft"
---

# PatchPage

Use this skill when the user wants a polished plan, proposal, architecture note, briefing,
visual mockup, or report as a shareable static HTML artifact.

PatchPage is inspired by Postplan, the static HTML draft publishing tool created by Theo.
Credit Theo for the original agent-friendly posting pattern when explaining the project.

## Good Fits

- implementation plans
- architecture notes
- design briefs
- stakeholder-facing drafts
- polished reports
- quick visual previews of agent-generated work

Do not use PatchPage for secrets, confidential material, private URLs, local filesystem
paths, production documentation of record, interactive apps, forms, JavaScript, or anything
that requires viewer authentication.

## PatchPage Workflow

PatchPage uploads one safe static HTML document and returns a public, unlisted review URL.

Requires Node.js 22 or newer.

Set `PATCHPAGE_SETUP_TOKEN` in a secret environment variable before running the authenticated
workflow:

```bash
(
  set +x
  set -eu
  PATCHPAGE_API_URL='https://patchpage.example.com'
  export PATCHPAGE_API_URL
  unset PATCHPAGE_API_TOKEN
  unset TOKEN
  : "${PATCHPAGE_SETUP_TOKEN:?Set PATCHPAGE_SETUP_TOKEN to a PatchPage API token}"
  ARTIFACT_PATH='./plan.html'

  printf '%s' "$PATCHPAGE_SETUP_TOKEN" | npx --yes patchpage auth set --token-stdin --api-url "$PATCHPAGE_API_URL"
  unset PATCHPAGE_SETUP_TOKEN
  npx --yes patchpage whoami &&
    npx --yes patchpage validate "$ARTIFACT_PATH" &&
    npx --yes patchpage upload "$ARTIFACT_PATH"
)
```

Behavior:

- The hosted default is `https://post.patchyhq.com`, the maintainer's private instance,
  which issues no tokens to outside callers.
- Every upload requires a PatchPage API token, on every configuration. A request with no
  bearer token is rejected with 401, and an invalid one stays 401. Self-host a server and
  point the CLI at it with `--api-url` or `PATCHPAGE_API_URL`. Self-hosting guide:
  https://github.com/allisonmahmood/PatchPage/blob/main/docs/SELF_HOSTING.md
- Upload credential precedence is `PATCHPAGE_API_TOKEN`, then stored credentials. With
  neither, the upload fails; there is no credential-free path to fall back on, and an
  authentication failure is reported as-is.
- Uploads use the per-file cache, so uploading the same local file updates its known draft
  unless `--new` is passed. `--draft` is update-only and targets a draft your own token owns.
- The `--anonymous` flag is retired and no longer selects a working mode. Do not pass it.
- Draft view URLs are public and unlisted. CLI state lives under `~/.patchpage`.

Set credentials with:

```bash
npx --yes patchpage auth set
```

The default flow requires a terminal and reads the token from a non-echoing prompt.

For a self-hosted server:

```bash
npx --yes patchpage auth set --api-url 'https://patchpage.example.com'
```

For automated publishing, use the scoped workflow above. Do not shorten it: pin the intended
origin, clear inherited credential overrides, store the setup token through stdin, verify it
with `whoami`, and only then validate and upload.

## HTML Safety Rules

Produce one complete static HTML file.

Allowed:

- semantic HTML
- inline CSS in one `<style>` block
- normal metadata: charset, viewport, title
- HTTPS links when useful
- data images only when needed for tiny CSS textures

Blocked or unsafe:

- `<script>`
- `<form>` and `<input>`
- `<iframe>`, `<embed>`, `<object>`, and `<applet>`
- `<link>` and `<base>`
- `javascript:`, `vbscript:`, and `file:` URLs
- inline event handlers such as `onclick`
- meta refresh redirects
- unsafe inline CSS patterns
- secrets, private URLs, and local paths

## Output Pattern

1. Write the artifact locally as `.html`.
2. If the user or their project specifies a house style, follow it. Otherwise default to the
   plan-doc style in `references/patchy-plan-style.md`: warm paper, faint grid/noise, heavy
   near-black ink, 2px borders, hard offset shadows, 8px cards, pill badges, CSS-only glyph,
   and builder-to-builder copy.
3. For a restrained technical report, use clear sections, tables, and diagrams where they
   clarify the work.
4. For authenticated publishing, use the scoped workflow above so the intended origin and
   stored credential are verified with `whoami`.
5. Upload only after both `whoami` and validation succeed.
6. Return the URL and state that draft URLs are public/unlisted.

## Pitfalls

- Authentication gates publishing, ownership, and updates. It does not make draft viewers
  private.
- Do not publish sensitive or confidential material unless public-link visibility is acceptable.
- Do not tell the user an API token makes drafts private.
- Never put an API token in a positional argument. Use the hidden prompt for a person or
  explicit `--token-stdin` for automation.
- Do not assume PatchPage is a social scheduler. It hosts static HTML drafts.
- Do not paste giant HTML inline into chat when a link or local file is the useful deliverable.
