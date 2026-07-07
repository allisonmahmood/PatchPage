import type { DraftRecord, DraftVersionRecord } from "@patchpage/db";

export function renderHome(options: { publicBaseUrl: string }): string {
  const publicBaseUrl = escapeHtml(options.publicBaseUrl);

  return htmlPage({
    title: "PatchPage",
    body: `
      <main class="wrap">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>PatchPage</span>
            <span class="kicker">Live draft host</span>
          </div>
          <h1>Upload-gated HTML draft hosting.</h1>
          <p class="lede">PatchPage turns one validated static HTML file into a public review link. Publishing is token-gated; viewing is public and unlisted by default.</p>
          <div class="meta">
            <span class="pill pill-progress">Upload auth</span>
            <span class="pill pill-done">Sandboxed view</span>
            <span>Endpoint: <code>${publicBaseUrl}</code></span>
          </div>
        </header>

        <section class="panel">
          <div>
            <h2>Publish a draft</h2>
            <p>Use the CLI to validate and upload a single-file HTML plan, report, or briefing.</p>
          </div>
          <pre><code>npx patchpage validate ./plan.html
npx patchpage upload ./plan.html</code></pre>
        </section>

        <section class="grid">
          <article class="task">
            <h3><span class="num">1</span> Safe artifact <span class="pill pill-done">Validated</span></h3>
            <p>Draft uploads reject scripts, forms, frames, unsafe URL schemes, and other constructs that do not belong in a static review document.</p>
          </article>
          <article class="task">
            <h3><span class="num">2</span> Review link <span class="pill pill-progress">Public</span></h3>
            <p>Anyone with the draft URL can view it. Use PatchPage for material that is acceptable as an unlisted public link.</p>
          </article>
        </section>

        <div class="note note-warn">
          <span class="note-title">Visibility rule</span>
          <p>API tokens control who can publish. They do not make draft viewers private.</p>
        </div>

        <p class="foot">Health check: <a href="/healthz">/healthz</a>. Inspired by Postplan, the static HTML draft publishing pattern created by Theo.</p>
      </main>
    `
  });
}

export function renderDraftWrapper(options: {
  draft: DraftRecord;
  version: DraftVersionRecord;
  html: string;
  homeUrl: string;
}): string {
  const title = escapeHtml(options.draft.title || "PatchPage Draft");
  const homeUrl = escapeAttribute(options.homeUrl);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      --paper: #fffdf4;
      --paper-blue: #eaf5ff;
      --white: #fffefa;
      --ink: #12110f;
      --ink-soft: #36332d;
      --muted: #69645a;
      --blue: #1263e6;
      --blue-dark: #093b92;
      --green: #64c83f;
      --yellow: #ffbf35;
      --radius: 8px;
      --radius-pill: 999px;
      --font-sans: system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
    }

    html,
    body {
      height: 100%;
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: var(--font-sans);
    }

    body {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .patchpage-banner {
      position: relative;
      z-index: 2147483647;
      display: flex;
      flex: 0 0 auto;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 14px;
      min-height: 50px;
      padding: 8px 12px;
      box-sizing: border-box;
      border-bottom: 2px solid var(--ink);
      background:
        linear-gradient(rgba(18, 17, 15, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(18, 17, 15, .035) 1px, transparent 1px),
        linear-gradient(180deg, var(--paper-blue), var(--paper));
      background-size: 32px 32px, 32px 32px, auto;
      color: var(--ink);
      font-size: 14px;
      line-height: 1.3;
      box-shadow: 0 4px 0 rgba(18, 17, 15, .10);
    }

    .patchpage-brand {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      color: var(--ink);
      font-weight: 900;
      text-decoration: none;
      white-space: nowrap;
    }

    .patchpage-glyph {
      position: relative;
      width: 26px;
      height: 26px;
      flex: none;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--green);
      box-shadow: 3px 3px 0 var(--ink);
      transform: rotate(-5deg);
    }

    .patchpage-glyph::after {
      content: "";
      position: absolute;
      top: 5px;
      right: 5px;
      width: 9px;
      height: 9px;
      border-top: 2px solid var(--ink);
      border-right: 2px solid var(--ink);
    }

    .patchpage-pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 2px 10px;
      border: 2px solid var(--ink);
      border-radius: var(--radius-pill);
      background: var(--yellow);
      box-shadow: 2px 2px 0 var(--ink);
      color: var(--ink);
      font-size: 12px;
      font-weight: 850;
      letter-spacing: 0;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .patchpage-note {
      color: var(--muted);
      font-weight: 650;
    }

    .patchpage-banner a.patchpage-link {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      margin-left: auto;
      padding: 0 12px;
      border: 2px solid var(--ink);
      border-radius: var(--radius-pill);
      background: var(--white);
      color: var(--blue-dark);
      font-weight: 800;
      text-decoration: none;
      white-space: nowrap;
    }

    .patchpage-banner a.patchpage-link:hover {
      background: var(--blue);
      color: var(--white);
    }

    .draft-frame {
      display: block;
      width: 100%;
      min-height: 0;
      flex: 1 1 auto;
      border: 0;
      background: #ffffff;
    }

    @media (max-width: 640px) {
      .patchpage-banner {
        padding: 8px 10px;
      }

      .patchpage-note {
        width: 100%;
      }

      .patchpage-banner a.patchpage-link {
        margin-left: 0;
      }
    }
  </style>
</head>
<body>
  <header class="patchpage-banner">
    <a class="patchpage-brand" href="${homeUrl}" target="_blank" rel="noreferrer">
      <span class="patchpage-glyph" aria-hidden="true"></span>
      <span>PatchPage</span>
    </a>
    <span class="patchpage-pill">Hosted draft</span>
    <span class="patchpage-note">Public, unlisted review link</span>
    <a class="patchpage-link" href="${homeUrl}" target="_blank" rel="noreferrer">Learn more</a>
  </header>
  <iframe
    class="draft-frame"
    title="${title}"
    sandbox=""
    referrerpolicy="no-referrer"
    srcdoc="${escapeAttribute(options.html)}"></iframe>
  <!-- draft:${escapeHtml(options.draft.id)} version:${Number(options.version.versionNumber)} -->
</body>
</html>`;
}

export function renderNotFound(): string {
  return htmlPage({
    title: "Draft not found",
    body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>PatchPage</span>
            <span class="kicker">Missing draft</span>
          </div>
          <h1>Draft not found.</h1>
          <p class="lede">The requested draft is unavailable. It may have been disabled, deleted, or mistyped.</p>
        </header>
      </main>
    `
  });
}

function htmlPage(options: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root {
      --paper: #fffdf4;
      --paper-blue: #eaf5ff;
      --paper-green: #eff9e8;
      --paper-amber: #fff7e4;
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
      --shadow-hard: 4px 4px 0 var(--ink);
      --shadow-soft: 0 18px 50px rgba(18, 17, 15, .08);
      --radius: 8px;
      --radius-pill: 999px;
      --font-sans: system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
      --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }

    * {
      box-sizing: border-box;
    }

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
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
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

    ::selection {
      background: rgba(255, 191, 53, .6);
      color: var(--ink);
    }

    :focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 3px;
      border-radius: 6px;
    }

    .wrap {
      width: min(980px, calc(100% - 40px));
      margin: 0 auto;
      padding: 42px 0 96px;
    }

    .wrap.compact {
      max-width: 760px;
    }

    .doc-head {
      margin-bottom: 2.5rem;
      padding-bottom: 1.5rem;
      border-bottom: 2px solid var(--line-strong);
    }

    .head-line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 18px 36px;
      margin-bottom: 2.5rem;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-size: 1.05rem;
      font-weight: 900;
    }

    .glyph {
      position: relative;
      width: 30px;
      height: 30px;
      flex: none;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--green);
      box-shadow: 3px 3px 0 var(--ink);
      transform: rotate(-5deg);
    }

    .glyph::after {
      content: "";
      position: absolute;
      top: 6px;
      right: 5px;
      width: 10px;
      height: 10px;
      border-top: 2px solid var(--ink);
      border-right: 2px solid var(--ink);
    }

    .kicker,
    .pill {
      display: inline-flex;
      align-items: center;
      border: 2px solid var(--ink);
      border-radius: var(--radius-pill);
      color: var(--ink);
      font-weight: 850;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: 0;
      white-space: nowrap;
    }

    .kicker {
      min-height: 30px;
      padding: 5px 18px;
      background: var(--yellow);
      box-shadow: 3px 3px 0 var(--ink);
      font-size: .78rem;
    }

    .pill {
      gap: 6px;
      min-height: 28px;
      padding: 3px 11px;
      font-size: .76rem;
    }

    .pill::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
    }

    .pill-progress {
      background: var(--paper-blue);
      color: var(--blue-dark);
    }

    .pill-done {
      background: var(--paper-green);
      color: var(--green-ink);
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
      max-width: 12ch;
      font-size: 3.35rem;
      font-weight: 900;
      line-height: .98;
    }

    h2 {
      margin: 0;
      font-size: 1.6rem;
    }

    h3 {
      margin-top: 1.6rem;
      font-size: 1.2rem;
    }

    p {
      max-width: 70ch;
      margin: 0 0 1rem;
    }

    a {
      color: var(--blue-dark);
      font-weight: 750;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    code,
    pre {
      font-family: var(--font-mono);
    }

    code {
      padding: .12em .4em;
      border-radius: 5px;
      background: rgba(18, 17, 15, .06);
      font-size: .9em;
    }

    pre {
      margin: 0;
      padding: 16px 18px;
      overflow-x: auto;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: #fffdf7;
      box-shadow: var(--shadow-hard);
      color: var(--ink);
      font-size: .88rem;
      line-height: 1.55;
    }

    pre code {
      padding: 0;
      background: none;
      font-size: inherit;
    }

    .lede {
      max-width: 64ch;
      color: var(--ink-soft);
      font-size: 1.08rem;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-top: .95rem;
      color: var(--muted);
      font-size: .92rem;
      font-weight: 650;
    }

    .panel {
      display: grid;
      grid-template-columns: minmax(0, .8fr) minmax(0, 1fr);
      gap: 20px;
      align-items: start;
      margin: 0 0 16px;
      padding: 22px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--white);
      box-shadow: var(--shadow-hard);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin: 16px 0;
    }

    .task {
      padding: 20px 22px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--white);
      box-shadow: var(--shadow-hard);
    }

    .task > h3 {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin: 0 0 .5rem;
    }

    .num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      flex: none;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--yellow);
      box-shadow: 2px 2px 0 var(--ink);
      color: var(--ink);
      font-size: .95rem;
      font-weight: 900;
      transform: rotate(-3deg);
    }

    .note {
      margin: 1.25rem 0;
      padding: 14px 16px 14px 18px;
      border: 1.5px solid var(--line-strong);
      border-left-width: 6px;
      border-radius: var(--radius);
      background: var(--white);
    }

    .note-title {
      display: block;
      margin-bottom: .25rem;
      color: var(--ink);
      font-weight: 800;
    }

    .note-warn {
      border-left-color: var(--yellow);
      background: var(--paper-amber);
    }

    .foot {
      color: var(--muted);
      font-size: .92rem;
      font-weight: 650;
    }

    @media (max-width: 760px) {
      .wrap {
        width: min(100% - 28px, 980px);
        padding-top: 28px;
      }

      h1 {
        max-width: 13ch;
        font-size: 2.45rem;
      }

      .head-line {
        margin-bottom: 1.8rem;
      }

      .panel,
      .grid {
        grid-template-columns: 1fr;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      html {
        scroll-behavior: auto;
      }
    }
  </style>
</head>
<body>${options.body}</body>
</html>`;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
