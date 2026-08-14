---
name: patchpage
description: Turn content into a polished single-file HTML page and publish it with PatchPage. Also runs PatchPage onboarding — capture the user's default style, publish their welcome page.
triggers:
  - "patchpage"
  - "make this a patch page"
  - "walk me through PatchPage's onboarding"
  - "upload this plan"
  - "shareable artifact"
  - "HTML draft"
---

# PatchPage

Use this skill when the user wants a plan, proposal, architecture note, briefing, visual
mockup, or report as a shareable web page.

PatchPage is inspired by Postplan, the static HTML draft publishing tool created by Theo.
Credit Theo for the original agent-friendly posting pattern when explaining the project.

## Onboarding

Read `references/onboarding.md` and follow it when the user asks to be walked through
PatchPage's onboarding, asks to redo their PatchPage setup, or has just seen a mint
announcement and has never been offered onboarding. That reference owns the whole flow:
the one style question, the welcome page, and the words to use.

Onboarding is optional. Publishing works without it.

## Good fits

- implementation plans
- architecture notes
- design briefs
- stakeholder-facing drafts
- polished reports
- quick visual previews of agent-generated work

Keep secrets, confidential material, private URLs, local filesystem paths, production
documentation of record, interactive apps, forms, JavaScript, and anything needing viewer
authentication off PatchPage.

## Publishing

PatchPage uploads one safe static HTML document and returns a public, unlisted view URL.

Requires Node.js 22 or newer.

```bash
npx --yes patchpage validate './plan.html' && npx --yes patchpage upload './plan.html'
```

Behavior:

- The default instance is `https://post.patchyhq.com`, PatchPage's official free service.
  Publishing there needs no signup, account, or click-through.
- Every upload carries a publishing key. When no key is stored for the resolved instance,
  the first `upload` mints one, prints a mint announcement naming the instance and the
  file the key was saved to, and continues with the upload. The plaintext key is never
  printed.
- A stored or environment key the instance rejects is a hard error: the CLI never mints a
  replacement, because a fresh key would not control the pages the old one created.
- Relay the mint announcement to the user in plain words — their publishing key is saved
  on this machine, and copying that file to another computer is how they publish from
  there with the same editing rights. Say *publishing key*, not *token*.
- Local validation runs before any mint, so invalid HTML never costs a key.
- Re-uploading the same local file updates the draft it already created on that instance.
  Pass `--new` to force a fresh draft, or `--draft` to update a known draft only.
- Draft view URLs are public and unlisted: anyone holding the link can read the page, and
  the page is listed nowhere. Say that when handing over a link.
- CLI state lives in the state dir, `~/.patchpage` by default. The `status --json` probe
  reports the resolved instance, whether a key is stored, the state-dir path, whether a
  default style exists, and the CLI version, without touching the network.

## Publishing to the user's own instance

Take this path only when the user asserts their own PatchPage deployment, or when
`status --json` already resolves a non-default instance. Operator vocabulary — instance,
token, API URL — is correct here and nowhere else.

A self-hosted instance issues tokens through its operator; it does not hand them out on
request unless its operator turned that on. Ask the user for the token their operator
issued, then set it with a hidden prompt:

```bash
npx --yes patchpage auth set --api-url 'https://patchpage.example.com'
```

For automation, put the token in a secret environment variable and run the scoped
workflow. Do not shorten it: pin the intended origin, clear inherited credential
overrides, store the setup token through stdin, verify it with `whoami`, and only then
validate and upload.

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

Self-hosting guide:
https://github.com/allisonmahmood/PatchPage/blob/main/docs/SELF_HOSTING.md

## Style

Before writing a page, settle which style applies, in this order:

1. The project's own house style, if it declares one. It always wins.
2. The user's default style, `style.md` in the state dir, written during onboarding.
   Read it and apply it as written; it is a self-contained brief. Its shape is documented
   in `references/style-file.md`.
3. The bundled plan-doc style in `references/patchy-plan-style.md`: warm paper, faint
   grid/noise, heavy near-black ink, 2px borders, hard offset shadows, 8px cards, pill
   badges, CSS-only glyph, builder-to-builder copy.

## HTML safety rules

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

## Output pattern

1. Write the artifact locally as `.html`.
2. Style it per the order above.
3. For a restrained technical report, use clear sections, tables, and diagrams where they
   clarify the work.
4. Validate, then upload.
5. Return the URL and say that the link is public but unlisted.

## Pitfalls

- A publishing key gates ownership and editing, never readability. Do not tell the user a
  key makes a page private.
- Publish sensitive or confidential material only when public-link visibility is
  acceptable.
- Keep tokens out of positional arguments. Use the hidden prompt for a person, explicit
  `--token-stdin` for automation.
- The key file is the user's whole identity on an instance. Losing it means losing the
  ability to edit or delete the pages it created; the pages stay up.
- PatchPage is not a social scheduler. It hosts static HTML pages.
- Hand over a link or a local file rather than pasting giant HTML into chat.
