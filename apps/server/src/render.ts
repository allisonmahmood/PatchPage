import { ACCEPTABLE_USE_URL } from "@patchpage/config";
import type { DraftRecord, DraftVersionRecord } from "@patchpage/db";
import { getDraftPublicUrl, getDraftReportPath } from "./public-url.js";

export function renderHome(options: { publicBaseUrl: string }): string {
  const publicBaseUrl = escapeHtml(options.publicBaseUrl);
  const shellPublicBaseUrl = escapeHtml(quoteShellArgument(options.publicBaseUrl));

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
          <p class="lede">PatchPage turns one validated static HTML file into a public review link. Publishing is authenticated by default; viewing is public and unlisted.</p>
          <div class="meta">
            <span class="pill pill-progress">Upload auth</span>
            <span class="pill pill-done">Sandboxed view</span>
            <span>Endpoint: <code>${publicBaseUrl}</code></span>
          </div>
        </header>

        <section class="panel">
          <div>
            <h2>Publish a draft</h2>
            <p>Requires Node.js 22 or newer.</p>
            <p>Provide <code>PATCHPAGE_SETUP_TOKEN</code> through a secret environment. This scoped workflow pins this endpoint, clears inherited credential overrides, and verifies the stored token before validation or upload.</p>
          </div>
          <pre><code data-patchpage-quick-start>(
  set +x
  set -eu
  PATCHPAGE_API_URL=${shellPublicBaseUrl}
  export PATCHPAGE_API_URL
  unset PATCHPAGE_API_TOKEN
  unset TOKEN
  : "\${PATCHPAGE_SETUP_TOKEN:?Set PATCHPAGE_SETUP_TOKEN to a PatchPage API token}"
  ARTIFACT_PATH='./plan.html'

  printf '%s' "$PATCHPAGE_SETUP_TOKEN" | npx --yes patchpage auth set --token-stdin --api-url "$PATCHPAGE_API_URL"
  unset PATCHPAGE_SETUP_TOKEN
  npx --yes patchpage whoami &amp;&amp;
    npx --yes patchpage validate "$ARTIFACT_PATH" &amp;&amp;
    npx --yes patchpage upload "$ARTIFACT_PATH"
)</code></pre>
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
          <p>Upload controls govern publishing; they do not make draft viewers private.</p>
        </div>

        <p class="foot">Health check: <a href="/healthz">/healthz</a>. Inspired by Postplan, the static HTML draft publishing pattern created by Theo.</p>
      </main>
    `
  });
}

/**
 * The served-draft page: the uploaded document in a sandboxed frame, plus the
 * one strip of first-party chrome every served draft carries.
 *
 * The footer is the reader's only channel to the operator, so it has to work
 * under the draft's own locked CSP: no script anywhere, and `form-action 'none'`
 * ruling out a form here. Both are plain links — one navigation to a report page
 * that carries the form under its own headers, one to the acceptable use policy.
 * With JavaScript disabled this footer is unchanged, because there is no
 * JavaScript in it to disable.
 */
export function renderDraftWrapper(options: {
  draft: DraftRecord;
  version: DraftVersionRecord;
  html: string;
  homeUrl: string;
}): string {
  const title = escapeHtml(options.draft.title || "PatchPage Draft");
  const homeUrl = escapeHtml(options.homeUrl || "/");
  const reportPath = escapeHtml(getDraftReportPath(options.draft.id));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    html,
    body {
      height: 100%;
      margin: 0;
      background: #ffffff;
    }

    body {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .draft-frame {
      display: block;
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      border: 0;
      background: #ffffff;
    }

    .draft-footer {
      display: flex;
      flex: none;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 12px;
      padding: 7px 14px;
      border-top: 1px solid rgba(18, 17, 15, .14);
      background: #fffdf4;
      color: #69645a;
      font-family: system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      font-size: 12px;
      line-height: 1.5;
    }

    .draft-footer a {
      color: #093b92;
      font-weight: 650;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .draft-footer .sep {
      color: rgba(18, 17, 15, .30);
    }
  </style>
</head>
<body>
  <iframe
    class="draft-frame"
    title="${title}"
    sandbox=""
    referrerpolicy="no-referrer"
    srcdoc="${escapeAttribute(options.html)}"></iframe>
  <footer class="draft-footer">
    <a href="${homeUrl}">Published with PatchPage</a>
    <span class="sep" aria-hidden="true">&middot;</span>
    <a href="${escapeHtml(ACCEPTABLE_USE_URL)}">Acceptable use</a>
    <span class="sep" aria-hidden="true">&middot;</span>
    <a href="${reportPath}">Report this page</a>
  </footer>
  <!-- draft:${escapeHtml(options.draft.id)} version:${Number(options.version.versionNumber)} -->
</body>
</html>`;
}

/**
 * The report page the footer link leads to. Its whole reason for existing is
 * that it is *not* the draft: it is served under its own CSP, so it may carry a
 * form, and the draft's policy stays exactly as locked as it was.
 *
 * No JavaScript, no cookie, no token — a form and a button.
 */
export function renderDraftReportForm(options: {
  draft: DraftRecord;
  publicBaseUrl: string;
}): string {
  const title = escapeHtml(options.draft.title || "PatchPage Draft");
  const reportPath = escapeHtml(getDraftReportPath(options.draft.id));
  const draftUrl = escapeHtml(
    getDraftPublicUrl({ draftId: options.draft.id, publicBaseUrl: options.publicBaseUrl })
  );

  return htmlPage({
    title: "Report this page",
    body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>PatchPage</span>
            <span class="kicker">Report</span>
          </div>
          <h1>Report this page.</h1>
          <p class="lede">You are reporting <strong>${title}</strong> for an operator to review. No account, and nothing to sign in to.</p>
        </header>

        <form class="panel panel-form" method="post" action="${reportPath}">
          <div>
            <h2>What's wrong with it?</h2>
            <p>Optional, and short is fine — a sentence is more useful than nothing.</p>
          </div>
          <div>
            <label class="field-label" for="reason">Reason</label>
            <textarea id="reason" name="reason" rows="4" maxlength="255"
              placeholder="What should the operator look at?"></textarea>
            <button type="submit">Send report</button>
          </div>
        </form>

        <div class="note note-warn">
          <span class="note-title">What filing this does</span>
          <p>It stores your report — the page, the time, the address this request came from, and anything you wrote — for a person to read. It does nothing to the page on its own: taking a page down is always an operator's decision, so no number of reports can remove one.</p>
        </div>

        <p class="foot">Back to <a href="${draftUrl}">the page</a>. Read the <a href="${escapeHtml(ACCEPTABLE_USE_URL)}">acceptable use policy</a>.</p>
      </main>
    `
  });
}

/** The acknowledgement a reader gets the moment their report is stored. */
export function renderDraftReportAcknowledgement(options: {
  draft: DraftRecord;
  publicBaseUrl: string;
}): string {
  const draftUrl = escapeHtml(
    getDraftPublicUrl({ draftId: options.draft.id, publicBaseUrl: options.publicBaseUrl })
  );

  return htmlPage({
    title: "Report received",
    body: `
      <main class="wrap compact">
        <header class="doc-head">
          <div class="head-line">
            <span class="brand"><span class="glyph" aria-hidden="true"></span>PatchPage</span>
            <span class="kicker">Report received</span>
          </div>
          <h1>Report received.</h1>
          <p class="lede">Thank you. Your report is stored and an operator will read it. Nothing about the page changes automatically, and there is nothing further for you to do.</p>
        </header>

        <p class="foot">Back to <a href="${draftUrl}">the page</a>. Read the <a href="${escapeHtml(ACCEPTABLE_USE_URL)}">acceptable use policy</a>.</p>
      </main>
    `
  });
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

    .panel-form {
      margin-bottom: 24px;
    }

    .field-label {
      display: block;
      margin-bottom: .35rem;
      color: var(--ink);
      font-size: .82rem;
      font-weight: 850;
      text-transform: uppercase;
    }

    textarea {
      display: block;
      width: 100%;
      padding: 10px 12px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: #fffdf7;
      color: var(--ink);
      font-family: inherit;
      font-size: 1rem;
      line-height: 1.5;
      resize: vertical;
    }

    button[type="submit"] {
      margin-top: 14px;
      padding: 10px 22px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--yellow);
      box-shadow: var(--shadow-hard);
      color: var(--ink);
      font-family: inherit;
      font-size: .95rem;
      font-weight: 900;
      cursor: pointer;
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

function quoteShellArgument(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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
