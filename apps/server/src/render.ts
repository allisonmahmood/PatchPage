import type { DraftRecord, DraftVersionRecord } from "@patchpage/db";

export function renderHome(options: { publicBaseUrl: string }): string {
  return htmlPage({
    title: "PatchPage",
    body: `
      <main class="home">
        <h1>PatchPage</h1>
        <p>Publisher-gated, link-viewable static HTML draft hosting.</p>
        <pre>npx patchpage upload ./plan.html</pre>
        <p>Hosted endpoint: <code>${escapeHtml(options.publicBaseUrl)}</code></p>
        <p>Health: <a href="/healthz">/healthz</a></p>
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
    html, body {
      height: 100%;
      margin: 0;
      background: #fffefa;
      color: #12110f;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
      align-items: center;
      gap: 12px;
      min-height: 42px;
      padding: 8px 14px;
      box-sizing: border-box;
      background: #12110f;
      color: #fffefa;
      border-bottom: 2px solid #12110f;
      font-size: 14px;
      line-height: 1.3;
      flex: 0 0 auto;
    }

    .patchpage-banner strong {
      font-weight: 800;
    }

    .patchpage-banner span {
      color: #ebe7dc;
    }

    .patchpage-banner a {
      color: #fffefa;
      text-decoration: underline;
      text-underline-offset: 3px;
      margin-left: auto;
      white-space: nowrap;
    }

    .draft-frame {
      display: block;
      width: 100%;
      min-height: 0;
      flex: 1 1 auto;
      border: 0;
      background: #ffffff;
    }
  </style>
</head>
<body>
  <header class="patchpage-banner">
    <strong>PatchPage</strong>
    <span>Hosted draft</span>
    <a href="${homeUrl}" target="_blank" rel="noreferrer">Learn more</a>
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
      <main class="home">
        <h1>Draft not found</h1>
        <p>The requested draft is unavailable.</p>
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
    body {
      margin: 0;
      background: #fffdf4;
      color: #12110f;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .home {
      max-width: 760px;
      margin: 64px auto;
      padding: 0 20px;
    }

    h1 {
      margin: 0 0 12px;
      font-size: 40px;
      line-height: 1.1;
    }

    p {
      color: #36332d;
      font-size: 17px;
      line-height: 1.6;
    }

    pre {
      overflow-x: auto;
      padding: 14px;
      border: 2px solid #12110f;
      background: #fffefa;
      border-radius: 8px;
      box-shadow: 4px 4px 0 #12110f;
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
