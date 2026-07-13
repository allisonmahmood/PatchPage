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

```bash
npx patchpage validate ./plan.html
npx patchpage upload ./plan.html
```

Behavior:

- The hosted default is `https://post.patchyhq.com`, the maintainer's private instance,
  which does not offer public token signup.
- Uploads require a PatchPage API token issued by the server operator. To use PatchPage
  yourself, deploy your own server and point the CLI at it with `--api-url` or
  `PATCHPAGE_API_URL`; a self-hosted server mints its own tokens. Self-hosting guide:
  https://github.com/allisonmahmood/PatchPage/blob/main/docs/SELF_HOSTING.md
- Draft view URLs are public and unlisted by default.
- Uploading the same local file updates the known draft unless `--new` is passed.
- CLI state lives under `~/.patchpage`.

Set credentials with:

```bash
npx patchpage auth set
```

The default flow requires a terminal and reads the token from a non-echoing prompt.

For a self-hosted server:

```bash
npx patchpage auth set --api-url https://patchpage.example.com
```

Automation must select redirected input explicitly and keep the token in a secret variable:

```bash
printf '%s' "$TOKEN" | npx patchpage auth set --token-stdin --api-url https://patchpage.example.com
```

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
4. Validate with `npx patchpage validate /path/to/file.html`.
5. Upload with `npx patchpage upload /path/to/file.html` when the user wants a link.
6. Return the URL and state that draft URLs are public/unlisted.

## Pitfalls

- Upload tokens gate publishing and ownership. They do not make draft viewers private.
- Do not publish sensitive or confidential material unless public-link visibility is acceptable.
- Do not tell the user an API token makes drafts private.
- Never put an API token in a positional argument. Use the hidden prompt for a person or
  explicit `--token-stdin` for automation.
- Do not assume PatchPage is a social scheduler. It hosts static HTML drafts.
- Do not paste giant HTML inline into chat when a link or local file is the useful deliverable.
