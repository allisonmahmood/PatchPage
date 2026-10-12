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

/**
 * Bounds on the work a document can ask of the parser. Steps of the HTML
 * parsing algorithm cost time in proportion to how deep the document nests,
 * how many attributes an element carries, and how many nodes error recovery
 * moves, so a document under the size limit could otherwise hold the server
 * for most of a minute. Each bound is far beyond what a page needs; Chromium's
 * parser stops nesting at the same depth.
 */
const MAX_DEPTH = 512;
const MAX_ATTRIBUTES = 256;
/** Counted in the siblings error recovery passes as it moves nodes; see `locate`. */
const MAX_REPAIR_WORK = 1 << 24;

const TOO_DEEP = `HTML nests elements more than ${MAX_DEPTH} deep.`;
const TOO_MANY_ATTRIBUTES = `An element has more than ${MAX_ATTRIBUTES} attributes.`;
const TOO_MUCH_REPAIR =
  "HTML needs too much repair to check: close elements in the order they were opened, and keep table content inside cells.";

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
    return { ok: false, errors, warnings, title: null };
  }

  let document: parse5.DefaultTreeAdapterMap["document"];
  try {
    document = BoundedParser.parse(html, { treeAdapter: boundedTreeAdapter() });
  } catch (error) {
    errors.push(
      error instanceof ParseLimitExceeded ? error.message : "HTML document could not be parsed."
    );
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

/** Thrown mid-parse when a document crosses one of the bounds. */
class ParseLimitExceeded extends Error {}

/**
 * Stops an element's attributes at the bound. The tokenizer checks each new
 * attribute against every earlier one on the same element, so an element costs
 * the square of its attribute count.
 */
class BoundedTokenizer extends parse5.Tokenizer {
  protected override _createAttr(attrNameFirstCh: string): void {
    const token = this.currentToken;
    if (token && "attrs" in token && token.attrs.length >= MAX_ATTRIBUTES) {
      throw new ParseLimitExceeded(TOO_MANY_ATTRIBUTES);
    }
    super._createAttr(attrNameFirstCh);
  }
}

/** parse5's parser, reading through the bounded tokenizer. */
class BoundedParser extends parse5.Parser<parse5.DefaultTreeAdapterMap> {
  constructor(options: parse5.ParserOptions<parse5.DefaultTreeAdapterMap>) {
    super(options);
    this.tokenizer = new BoundedTokenizer(this.options, this);
  }
}

/**
 * parse5's default tree, built under the depth, attribute, and repair bounds.
 * Most tags scan the stack of open elements, so the stack is what depth counts.
 */
function boundedTreeAdapter(): parse5.TreeAdapter<parse5.DefaultTreeAdapterMap> {
  const tree = parse5.defaultTreeAdapter;
  let depth = 0;
  let repairWork = 0;

  /**
   * Finds a node among its siblings for error recovery to move it, searching
   * from the end and paying for every sibling after it, each of which the
   * search passes and the move shifts. Misplaced table content goes just
   * before the open table, its parent's last child, so it costs next to
   * nothing; the children of an element closed out of order leave from the
   * front, and pay for the whole list each time.
   */
  const locate = (
    siblings: parse5.DefaultTreeAdapterMap["childNode"][],
    node: parse5.DefaultTreeAdapterMap["childNode"]
  ) => {
    const index = siblings.lastIndexOf(node);
    repairWork += siblings.length - index;
    if (repairWork > MAX_REPAIR_WORK) throw new ParseLimitExceeded(TOO_MUCH_REPAIR);
    return index;
  };

  return {
    ...tree,
    onItemPush() {
      depth += 1;
      if (depth > MAX_DEPTH) throw new ParseLimitExceeded(TOO_DEEP);
    },
    onItemPop() {
      depth -= 1;
    },
    // A repeated <html> or <body> tag adds its attributes to the first one.
    adoptAttributes(recipient, attrs) {
      tree.adoptAttributes(recipient, attrs);
      if (recipient.attrs.length > MAX_ATTRIBUTES) {
        throw new ParseLimitExceeded(TOO_MANY_ATTRIBUTES);
      }
    },
    // These three replace the default tree's, which search from the front.
    insertBefore(parent, node, reference) {
      parent.childNodes.splice(locate(parent.childNodes, reference), 0, node);
      node.parentNode = parent;
    },
    insertTextBefore(parent, text, reference) {
      const index = locate(parent.childNodes, reference);
      const previous = parent.childNodes[index - 1];
      if (previous && tree.isTextNode(previous)) {
        previous.value += text;
        return;
      }
      const node = tree.createTextNode(text);
      parent.childNodes.splice(index, 0, node);
      node.parentNode = parent;
    },
    detachNode(node) {
      const parent = node.parentNode;
      if (!parent) return;
      parent.childNodes.splice(locate(parent.childNodes, node), 1);
      node.parentNode = null;
    }
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
