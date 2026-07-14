# Patchy Plan-Doc Style System

Use this reference when creating standalone static HTML implementation plans, reports, or
briefings for PatchPage.

## Hard Constraints

- One complete HTML document.
- All CSS in a single embedded `<style>` in `<head>`.
- No `<script>`, `<form>`, `<input>`, `<iframe>`, external CSS, external JS, external fonts,
  or external design assets.
- System fonts only.
- Pure CSS imagery unless the user supplies assets.
- The document must remain readable with CSS stripped.
- Upload access requires authentication by default and may be configured for anonymous creation; draft viewer URLs are public/unlisted.

## Brand Read

Patchy reads warm, hand-built, friendly on the surface, serious underneath. It is not a dark
generic AI dashboard.

Use:

- warm cream paper with pale blue/green washes
- a faint 32px engineering grid and subtle noise
- near-black ink: `#12110f`
- 2px ink borders
- hard offset shadows: `4px 4px 0 var(--ink)`
- 8px cards and `999px` pills
- heavy headings with system fonts
- flat blue, green, yellow, and red accents
- CSS-only glyphs or dashed frames for craft cues

Avoid:

- dark dashboards
- glassy gradients or glows
- external font/image dependencies
- oversized marketing hero treatment
- rounded card-heavy SaaS clutter

## Tokens

```css
:root {
  --paper: #fffdf4;
  --paper-blue: #eaf5ff;
  --paper-green: #eff9e8;
  --paper-amber: #fff7e4;
  --paper-red: #fdece8;
  --white: #fffefa;
  --ink: #12110f;
  --ink-soft: #36332d;
  --muted: #69645a;
  --line: rgba(18, 17, 15, .14);
  --line-strong: rgba(18, 17, 15, .30);
  --blue: #1263e6;
  --blue-dark: #093b92;
  --green: #64c83f;
  --green-ink: #2f6a17;
  --yellow: #ffbf35;
  --amber-ink: #8a5a00;
  --red: #e94b35;
  --red-ink: #b4220f;
  --shadow-hard: 4px 4px 0 var(--ink);
  --shadow-soft: 0 18px 50px rgba(18, 17, 15, .08);
  --radius: 8px;
  --radius-pill: 999px;
  --font-sans: system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
```

## Baseline CSS

```css
* { box-sizing: border-box; }

html {
  background: var(--paper-blue);
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background:
    linear-gradient(rgba(18, 17, 15, .035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(18, 17, 15, .035) 1px, transparent 1px),
    linear-gradient(180deg, var(--paper-blue) 0%, var(--paper) 34%, var(--paper-green) 78%, #fef7ef 100%);
  background-size: 32px 32px, 32px 32px, auto;
  color: var(--ink-soft);
  font-family: var(--font-sans);
  font-size: 17px;
  font-weight: 450;
  line-height: 1.65;
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: .22;
  mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 160 160' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.95' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.36'/%3E%3C/svg%3E");
}

.wrap {
  width: min(900px, calc(100% - 40px));
  margin: 0 auto;
  padding: 42px 0 96px;
}

h1,
h2,
h3 {
  margin: 0 0 .5em;
  color: var(--ink);
  font-weight: 850;
  line-height: 1.04;
  letter-spacing: 0;
  text-wrap: balance;
}

h1 {
  font-size: 3.35rem;
  font-weight: 900;
  line-height: .98;
}

h2 { font-size: 2rem; margin-top: 2.4rem; }
h3 { font-size: 1.28rem; margin-top: 1.6rem; }
p { max-width: 70ch; margin: 0 0 1rem; }
a { color: var(--blue-dark); font-weight: 750; text-decoration: underline; text-underline-offset: 2px; }
```

Use media queries for smaller screens. Do not scale type directly with viewport width.

## Components

- `.doc-head`: page header with `.head-line`, `.brand`, `.glyph`, `.kicker`, title, and `.meta`.
- `.toc`: pill-list section anchors.
- `.task`: 2px bordered card with hard shadow, `.num`, status `.pill`, checklist, and metadata.
- `.tbl`: bordered table with ink header row and zebra rows.
- `.note`: callout with a 6px colored left border.
- `pre`/`code`: cream code blocks with ink border and hard shadow, not dark terminal panels.
- `.check`: CSS-drawn checkboxes using pseudo-elements, not `<input>`.
- `.flow`: dashed container with pill nodes joined by text or entity arrows.

## Copy Tone

Write builder-to-builder. Short sentences, concrete nouns, honest status.

Name owner, risk, and rollback on consequential steps. Use product language such as patch,
workflow, object, field, view, queue, owner, permission, preview, review path, rollback,
guardrail, and audit trail.

Avoid hype, emoji, "seamless", "revolutionary", and vague AI-dashboard language.

## Skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{TITLE}}</title>
  <style>
    /* Insert tokens, baseline CSS, and only the components used by this draft. */
  </style>
</head>
<body>
  <main class="wrap">
    <header class="doc-head">
      <div class="head-line">
        <span class="brand"><span class="glyph" aria-hidden="true"></span>PatchPage</span>
        <span class="kicker">{{STATUS}}</span>
      </div>
      <h1>{{TITLE}}</h1>
      <p>{{ONE_OR_TWO_SENTENCE_FRAMING}}</p>
      <div class="meta">
        <span class="pill pill-progress">In progress</span>
        <span>Owner: {{OWNER}}</span>
      </div>
    </header>

    <ul class="toc">
      <li><a href="#overview">Overview</a></li>
      <li><a href="#plan">Plan</a></li>
      <li><a href="#risks">Risks</a></li>
    </ul>

    <section id="overview">
      <h2>Overview</h2>
      <p>{{OVERVIEW}}</p>
    </section>
  </main>
</body>
</html>
```
