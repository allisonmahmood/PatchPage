# The default-style file (`style.md`)

> **PROTOTYPE — throwaway (wayfinder [#93](https://github.com/allisonmahmood/PatchPage/issues/93)).**
> Shape of the `style.md` the skill writes into the state dir during onboarding and
> consults on every later "make this a patch page". Skill-owned; the CLI never reads it.
> Two filled examples below — one per onboarding answer.

## Design rules

- **Self-contained brief.** A future agent session applies it with no other context: it
  carries everything needed to style a page, not pointers into the skill.
- **Records the choice, not just the values** — so no session re-asks the style question.
- **Prose + tokens, no schema.** It is read by agents, so it is written like
  `patchy-plan-style.md`: a brand read, CSS tokens, a tone note. No YAML contract to
  version.
- **Provenance header**: where it came from and when, so "match my website" can be
  refreshed later and staleness is visible.
- **House style wins.** If the project being published declares its own style, that
  overrides this file. Line one says so.

---

## Example A — user chose the PatchPage look

```markdown
# Default style: the PatchPage look

Captured by onboarding on 2026-08-12. A project's own house style overrides this file.

Use the bundled Patchy plan-doc style (`references/patchy-plan-style.md`) for every
page: warm cream paper, faint engineering grid, near-black ink, 2px borders, hard
offset shadows, pill badges, system fonts. Builder-to-builder copy.

No customizations.
```

The default choice still writes the file — the file existing is what tells every later
session the question was asked and answered.

---

## Example B — captured from the user's website

```markdown
# Default style: matched to greenfieldpottery.com

Captured by onboarding on 2026-08-12 from https://greenfieldpottery.com.
A project's own house style overrides this file. To refresh after a redesign,
say "redo my patchpage setup".

## Brand read

Quiet, earthy, handmade. Deep forest green on warm cream, serif display headings,
generous whitespace, small-caps labels. Copy is plain-spoken and unhurried — no
exclamation marks, no marketing verbs.

## Tokens

    :root {
      --paper: #faf6ee;        /* warm cream page ground */
      --ink: #1e2a20;          /* near-black green ink */
      --accent: #1f3d2b;       /* footer green — user asked for the darker one */
      --accent-soft: #e4ece4;  /* pale green wash for cards */
      --rust: #b4552d;         /* sparse highlight, links only */
      --font-display: Georgia, "Times New Roman", serif;
      --font-body: system-ui, -apple-system, sans-serif;
    }

## Rules

- Serif headings, sans body. Headings never bolder than 700.
- Borders hairline (1px, ink at 20%), corners barely rounded (4px). No hard shadows.
- The rust accent appears at most twice per page.
- Section labels in letterspaced small caps.

## Avoid

- Bright or saturated colors; anything glossy or gradient.
- Dense card grids — this brand breathes.
```

---

## Reaction points

- Is prose-plus-tokens right, or should some slice be structured for tooling later?
- Should Example B inline everything (as here) or lean on the bundled Patchy reference
  for structure and only record deltas? Inline keeps it self-contained after skill
  updates; deltas keep it short.
- One `style.md` total (current decision) vs. per-instance styles — any reason a
  self-hosted work instance and personal use would want different defaults?
