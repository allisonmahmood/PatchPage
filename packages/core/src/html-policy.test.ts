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

  it("rejects a document over the size limit without parsing it", () => {
    const result = validateHtml("<div>".repeat(1000), { maxBytes: 1024 });

    expect(result.errors).toEqual(["HTML document is 5000 bytes; maximum is 1024 bytes."]);
  });

  it("bounds how deep a document nests", () => {
    expect(validateHtml("<div>".repeat(500)).ok).toBe(true);
    expect(validateHtml("<div>".repeat(600)).errors).toEqual([
      "HTML nests elements more than 512 deep."
    ]);
  });

  it("bounds the attributes on an element", () => {
    const attributes = (count: number) =>
      Array.from({ length: count }, (_, index) => ` a${index}`).join("");
    const tooMany = ["An element has more than 256 attributes."];

    expect(validateHtml(`<div${attributes(256)}>`).ok).toBe(true);
    expect(validateHtml(`<div${attributes(257)}>`).errors).toEqual(tooMany);
    expect(validateHtml(`</div${attributes(257)}>`).errors).toEqual(tooMany);
    // A repeated <body> tag adds its attributes to the first.
    expect(
      validateHtml(Array.from({ length: 300 }, (_, index) => `<body a${index}>`).join("")).errors
    ).toEqual(tooMany);
  });

  it("bounds the repair of misnested markup", () => {
    const tooMuch = [
      "HTML needs too much repair to check: close elements in the order they were opened, and keep table content inside cells."
    ];

    // Table content outside a cell moves to just before the table, which is cheap.
    expect(validateHtml(`<table>${"stray<br>".repeat(6000)}</table>`).ok).toBe(true);
    // Closing <b> early moves every child of the block it crosses, front first.
    expect(validateHtml(`<b><div>${"<br>".repeat(600)}</b>`).ok).toBe(true);
    expect(validateHtml(`<b><div>${"<br>".repeat(6000)}</b>`).errors).toEqual(tooMuch);
  });

  it("warns when title is missing", () => {
    const result = validateHtml("<main>No title</main>");

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("No <title> found; PatchPage will use a generic title.");
  });
});
