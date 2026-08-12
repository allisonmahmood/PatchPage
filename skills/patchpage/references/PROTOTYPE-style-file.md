# The default-style file (`style.md`)

> **PROTOTYPE — throwaway (wayfinder [#93](https://github.com/allisonmahmood/PatchPage/issues/93)).**
> Shape of the `style.md` the skill writes into the state dir during onboarding and
> consults on every later "make this a patch page". Skill-owned; the CLI never reads it.
> Two filled examples below — one per onboarding answer.

## Design rules for the file

- **Self-contained brief.** A future agent session applies it with no other context: it
  carries everything needed to style a page, not pointers into the skill.
- **Records the choice, not just the values** — so no session re-asks the style question.
- **Prose + tokens, no schema.** It is read by agents, so it is written like
  `patchy-plan-style.md`: brand read, CSS tokens, component specs, tone. No YAML
  contract to version.
- **Provenance header**: where it came from and when, so "match my website" can be
  refreshed later and staleness is visible.
- **House style wins.** If the project being published declares its own style, that
  overrides this file. Line one says so.

## How to capture a website's style

The bar is the bundled `patchy-plan-style.md`: that is how much context every session
gets about the default look, so a captured style needs comparable detail — a thin
palette note will drift off-brand within a page or two. Capture the **design system**,
not just the colors:

- **Read the code, and look at the page.** Fetch the HTML and CSS and mine them for
  tokens, fonts, spacing, and repeated class patterns. If you can view images, also
  render or screenshot the site and study it visually — layout habits (density,
  alignment, how much air) are easier to see than to parse out of stylesheets.
- **Capture patterns, not swatches.** If the site boxes everything into cards, the
  pages should box things into cards. Recurring structures are the style: how sections
  divide, what a heading block looks like, border/shadow/radius habits, spacing
  rhythm, list and table treatments, any signature motif (dashed frames, small-caps
  labels, underline styles). Write each one down as a one-or-two-line spec.
- **Capture the voice too.** Copy tone is part of the aesthetic — sentence length,
  formality, exclamation marks or none, vocabulary the site favors.
- **Show, don't only tell.** Declare the palette as CSS custom properties in a `:root`
  block (as below) and spec components in concrete CSS terms, so the writing session
  can lift them straight into a page.
- **Sample more than the front page** when there is more than one — heroes are often
  unrepresentative; an inner content page is usually closer to what a patch page
  should look like.
- **Play the read back** in one line before saving, and fold in corrections (see the
  onboarding reference).

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
generous whitespace, small-caps labels. Feels like a printed catalogue, not a web
app: unboxed prose with air around it, hairline rules instead of heavy borders.
Copy is plain-spoken and unhurried — no exclamation marks, no marketing verbs.

Read from https://greenfieldpottery.com (home, /workshops, /about) — code plus
rendered screenshots.

## Tokens

    :root {
      --paper: #faf6ee;        /* warm cream page ground */
      --ink: #1e2a20;          /* near-black green ink */
      --accent: #1f3d2b;       /* footer green — user asked for the darker one */
      --accent-soft: #e4ece4;  /* pale green wash, card backgrounds */
      --rust: #b4552d;         /* sparse highlight, links only */
      --line: rgba(30, 42, 32, .2);  /* hairline rules */
      --font-display: Georgia, "Times New Roman", serif;
      --font-body: system-ui, -apple-system, sans-serif;
    }

## Type

- Serif display headings, sans body. Headings never bolder than 700; the site gets
  weight from size and space, not boldness.
- H1 large and unhurried (~3rem, line-height 1.1); body 17px/1.7, max ~65ch.
- Section labels: 12px letterspaced small caps (`letter-spacing: .14em;
  text-transform: uppercase`) in --accent, sitting above the serif heading.

## Layout & components

- **Sections, not cards.** Long unboxed prose divided by generous space (~90px
  between sections) and a centered 40px hairline rule (`--line`). The site almost
  never boxes body content — patch pages shouldn't either.
- **The one box it does use**: offers/workshops sit in `--accent-soft` panels — flat
  fill, no border, no shadow, 4px radius, 28px padding, serif heading inside. Use
  this shape for callouts and key takeaways.
- **Tables** are open: no cell borders, a single 2px --accent rule under the header
  row, roomy 12px cell padding.
- **Footer band**: solid --accent with cream text — end pages with the same band.
- **Links**: --rust, underlined, no hover tricks. At most a couple per screen.
- **Imagery**: photography only on the site; with no user assets, use flat
  --accent-soft washes — never illustrations or icons.

## Copy tone

Short declarative sentences. Warm but never salesy: "Classes run Tuesdays" not
"Join our amazing classes!". Numbers written plainly. No emoji, no exclamation
marks.

## Avoid

- Bright or saturated colors; anything glossy, gradient, or hard-shadowed.
- Dense card grids and dashboard density — this brand breathes.
- Bold-heavy hierarchy; icon clutter.
```

---

## Remaining reaction point

- One `style.md` total (current decision) vs. per-instance styles — any reason a
  self-hosted work instance and personal use would want different defaults?
