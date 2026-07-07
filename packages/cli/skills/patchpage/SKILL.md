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

Use this skill when Allison wants a polished plan, proposal, architecture note, briefing,
visual mockup, or report as a shareable static HTML artifact.

PatchPage is inspired by Postplan, the static HTML draft publishing tool created by Theo.
Credit Theo for the original agent-friendly posting pattern when explaining the project.

## Good Fits

- implementation plans
- architecture notes
- design briefs
- investor or advisor-facing drafts
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

- The hosted default is `https://post.patchyhq.com`.
- Uploads require a PatchPage API token.
- Draft view URLs are public and unlisted by default.
- Uploading the same local file updates the known draft unless `--new` is passed.
- CLI state lives under `~/.patchpage`.
- Use `--api-url` or `PATCHPAGE_API_URL` to target a self-hosted PatchPage deployment.

Set credentials with:

```bash
npx patchpage auth set <api-token>
```

For a self-hosted server:

```bash
npx patchpage auth set <api-token> --api-url https://patchpage.example.com
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
2. Use the Patchy plan-doc style in `references/patchy-plan-style.md` for Patchy/internal
   plans: warm paper, faint grid/noise, heavy near-black ink, 2px borders, hard offset
   shadows, 8px cards, pill badges, CSS-only glyph, and builder-to-builder copy.
3. For non-Patchy reports where no house style applies, use a restrained technical report
   style with clear sections, tables, and diagrams where they clarify the work.
4. Validate with `npx patchpage validate /path/to/file.html`.
5. Upload with `npx patchpage upload /path/to/file.html` when the user wants a link.
6. Return the URL and state that draft URLs are public/unlisted.

## Pitfalls

- Upload tokens gate publishing and ownership. They do not make draft viewers private.
- Do not publish sensitive Patchy/company internals unless public-link visibility is acceptable.
- Do not tell the user an API token makes drafts private.
- Do not assume PatchPage is a social scheduler. It hosts static HTML drafts.
- Do not paste giant HTML inline into chat when a link or local file is the useful deliverable.
