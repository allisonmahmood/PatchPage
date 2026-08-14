# The default-style file (`style.md`)

Onboarding writes one `style.md` into the state dir — `stateDir` from `status --json` —
and every later "make this a patch page" consults it. It is skill-owned; the CLI only
checks whether it exists. There is one file, not one per instance.

## Rules for the file

- **Self-contained brief.** A future session applies it with nothing but the skill in
  hand: everything needed to style a page lives in the file. The one exception is
  `references/patchy-plan-style.md`, which ships with the skill and so is always
  available — deferring to it, as Example A does, is still self-contained. Never point at
  anything outside the bundle.
- **Records the choice, not only the values**, so no session re-asks the style question.
  This is why the default answer writes the file too.
- **Prose plus tokens, no schema.** Agents read it, so write it the way
  `patchy-plan-style.md` is written: brand read, CSS tokens, component specs, tone.
- **Provenance header.** Where the look came from and when, so a captured site can be
  refreshed later and staleness is visible.
- **House style wins.** A project that declares its own style overrides this file. Line
  one says so.

## Capturing a website's style

`patchy-plan-style.md` is the detail bar. That is how much a session gets about the
default look, so a captured style needs comparable depth — a thin palette note drifts
off-brand within a page or two. Capture the design *system*:

- **Read the code, and look at the page.** Fetch the HTML and CSS and mine them for
  tokens, fonts, spacing, and repeated class patterns. Then render or screenshot the site
  and study it, if you can see images: layout habits — density, alignment, how much air —
  are easier to see than to parse out of a stylesheet.
- **Capture patterns, not swatches.** If the site boxes everything into cards, the pages
  box things into cards. The recurring structures are the style: how sections divide,
  what a heading block looks like, border/shadow/radius habits, spacing rhythm, list and
  table treatments, signature motifs (dashed frames, small-caps labels, underline
  styles). Write each down as a one- or two-line spec.
- **Capture the voice.** Copy tone is part of the aesthetic — sentence length, formality,
  exclamation marks or none, the vocabulary the site favors.
- **Show, don't only tell.** Declare the palette as CSS custom properties in a `:root`
  block and spec components in concrete CSS, so a writing session lifts them straight
  into a page.
- **Sample more than the front page.** Heroes are unrepresentative; an inner content page
  is usually closer to what a patch page should look like.
- **Play the read back** in one line before saving, and fold in corrections.

## Example A — the user chose the PatchPage look

```markdown
# Default style: the PatchPage look

Captured by onboarding on 2026-08-12. A project's own house style overrides this file.

Use the bundled Patchy plan-doc style (`references/patchy-plan-style.md`) for every
page: warm cream paper, faint engineering grid, near-black ink, 2px borders, hard
offset shadows, pill badges, system fonts. Builder-to-builder copy.

No customizations.
```

Short is correct here: the bundled reference carries the detail, and the file's job is to
record that the question was asked and answered.

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
