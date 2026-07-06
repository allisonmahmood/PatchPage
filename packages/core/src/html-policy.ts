import * as parse5 from "parse5";
import type { HtmlValidationResult } from "./types.js";

const BLOCKED_TAGS = new Set([
  "script",
  "form",
  "iframe",
  "object",
  "embed",
  "applet",
  "base",
  "link"
]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "srcdoc",
  "xlink:href"
]);

const BLOCKED_PROTOCOLS = ["javascript:", "vbscript:", "file:"];

export interface ValidateHtmlOptions {
  maxBytes?: number;
}

export function validateHtml(html: string, options: ValidateHtmlOptions = {}): HtmlValidationResult {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof html !== "string" || html.trim() === "") {
    errors.push("HTML document is empty.");
    return { ok: false, errors, warnings, title: null };
  }

  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > maxBytes) {
    errors.push(`HTML document is ${byteLength} bytes; maximum is ${maxBytes} bytes.`);
  }

  let document: parse5.DefaultTreeAdapterMap["document"];
  try {
    document = parse5.parse(html);
  } catch {
    errors.push("HTML document could not be parsed.");
    return { ok: false, errors, warnings, title: null };
  }

  let title: string | null = null;

  function walk(node: parse5.DefaultTreeAdapterMap["node"]): void {
    if ("tagName" in node && node.tagName) {
      const tagName = node.tagName.toLowerCase();

      if (BLOCKED_TAGS.has(tagName)) {
        errors.push(`Blocked <${tagName}> tag found.`);
      }

      for (const attr of node.attrs || []) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "").trim();

        if (name.startsWith("on")) {
          errors.push(`Blocked inline event handler attribute "${name}" found.`);
        }

        if (name === "srcdoc") {
          errors.push('Blocked "srcdoc" attribute found.');
        }

        if (URL_ATTRS.has(name)) {
          const normalized = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
          if (BLOCKED_PROTOCOLS.some((protocol) => normalized.startsWith(protocol))) {
            errors.push(`Blocked unsafe URL in "${name}" attribute.`);
          }
        }

        if (name === "style" && /expression\s*\(|behavior\s*:|url\s*\(\s*javascript:/i.test(value)) {
          errors.push("Blocked unsafe inline CSS.");
        }
      }

      if (tagName === "meta") {
        const httpEquiv = (node.attrs || []).find(
          (attr) => attr.name.toLowerCase() === "http-equiv"
        );
        if (httpEquiv && httpEquiv.value.trim().toLowerCase() === "refresh") {
          errors.push("Blocked meta refresh tag found.");
        }
      }
    }

    if ("tagName" in node && node.tagName === "title" && !title) {
      title = collectText(node).trim().slice(0, 140) || null;
    }

    if ("childNodes" in node) {
      for (const child of node.childNodes || []) {
        walk(child);
      }
    }
  }

  walk(document);

  if (!title) {
    warnings.push("No <title> found; PatchPage will use a generic title.");
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    title
  };
}

function collectText(node: parse5.DefaultTreeAdapterMap["node"]): string {
  let value = "";
  if ("childNodes" in node) {
    for (const child of node.childNodes || []) {
      if (child.nodeName === "#text" && "value" in child) {
        value += child.value || "";
      }
      value += collectText(child);
    }
  }
  return value;
}
