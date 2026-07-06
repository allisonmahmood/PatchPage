import { describe, expect, it } from "vitest";
import { validateHtml } from "./html-policy.js";

describe("validateHtml", () => {
  it("accepts a static document with inline styles", () => {
    const result = validateHtml(`<!doctype html>
      <html>
        <head><title>Safe Draft</title><style>body{color:#111}</style></head>
        <body><main><h1>Hello</h1><a href="https://example.com">link</a></main></body>
      </html>`);

    expect(result.ok).toBe(true);
    expect(result.title).toBe("Safe Draft");
  });

  it("blocks active and embedded content", () => {
    const result = validateHtml(`<html><head><title>x</title></head><body>
      <script>alert(1)</script>
      <iframe src="https://example.com"></iframe>
      <button onclick="alert(1)">bad</button>
    </body></html>`);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Blocked <script> tag found.");
    expect(result.errors).toContain("Blocked <iframe> tag found.");
    expect(result.errors).toContain('Blocked inline event handler attribute "onclick" found.');
  });

  it("blocks unsafe URL protocols", () => {
    const result = validateHtml(`<a href=" java
      script:alert(1)">bad</a>`);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Blocked unsafe URL in "href" attribute.');
  });

  it("warns when title is missing", () => {
    const result = validateHtml("<main>No title</main>");

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("No <title> found; PatchPage will use a generic title.");
  });
});
