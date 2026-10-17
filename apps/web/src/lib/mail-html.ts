import DOMPurify from "dompurify";

/**
 * HTML mail is hostile input by definition.
 *
 * Layers work together, because any one alone has known gaps:
 *
 * 1. This sanitizer strips scripting constructs (`script`, event handlers,
 *    `javascript:` URLs, forms, embeds) and enforces a tag/attribute
 *    allowlist limited to presentation.
 * 2. The component that renders the result puts it in a sandboxed iframe.
 *    The sandbox grants `allow-same-origin` -- solely so the parent can
 *    measure the frame's content height for auto-sizing -- but withholds
 *    `allow-scripts`, so even a sanitizer bypass gets no script execution.
 *    Without script execution the frame content cannot reach the parent
 *    DOM, cookies, or storage, regardless of what origin it runs at.
 * 3. The document itself carries a restrictive CSP
 *    (`default-src 'none'`, a gated `img-src`, `style-src 'unsafe-inline'`).
 *
 * `<style>` elements are allowed through (`FORCE_BODY: true` keeps ones a
 * mail client places in `<head>`, which DOMPurify otherwise discards)
 * because the frame's CSP makes that safe: `style-src 'unsafe-inline'`
 * permits inline rules but lists no host or `'self'`, so it blocks
 * `@import`-ing a remote stylesheet, and any `url()` reference inside a
 * style block is subject to the same gated `img-src` as an `<img src>` --
 * blocked until the reader opts in to remote images, never a script. A
 * style sheet can therefore only affect presentation inside the frame.
 *
 * Remote images are additionally gated, because they are not an XSS problem
 * but a privacy one: loading them on open confirms to a sender that the
 * message was read, which is exactly what tracking pixels are for.
 */

/** Attribute the original remote source is parked on while images are
 * blocked, so "load images" can restore it without re-sanitizing. */
export const BLOCKED_SRC_ATTRIBUTE = "data-mailcal-blocked-src";

const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "code",
  "col",
  "colgroup",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "style",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
];

const ALLOWED_ATTR = [
  "align",
  "alt",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "color",
  "colspan",
  "dir",
  "face",
  "height",
  "href",
  "hspace",
  "lang",
  "nowrap",
  "rowspan",
  "size",
  "span",
  "src",
  "style",
  "title",
  "valign",
  "vspace",
  "width",
];

/** Every allowed attribute except `href` and `src`, which are the two DOMPurify
 * actually needs to run a URI-scheme check against. DOMPurify's attribute
 * validator applies `ALLOWED_URI_REGEXP` to the *value* of any attribute
 * that is not in its internal URI-safe set (not just conventional URI
 * attributes), so an unrelated value like `color="#ff0000"` or `face="Arial"`
 * would otherwise be rejected for not looking like `https:`/`mailto:`/etc.
 * Declaring the rest of the allowlist via `ADD_URI_SAFE_ATTR` opts them out
 * of that check -- it has no bearing on navigation or resource loading. */
const URI_SAFE_ATTR = ALLOWED_ATTR.filter(
  (attr) => attr !== "href" && attr !== "src",
);

export interface SanitizeMailHtmlOptions {
  /** When false (the default), remote image sources are parked on
   * {@link BLOCKED_SRC_ATTRIBUTE} instead of being loaded. */
  readonly loadRemoteImages?: boolean;
  /** Resolved inline (`cid:`) image sources, keyed by
   * {@link normalizeContentId}. An `<img src="cid:...">` whose normalized
   * reference is present here is rewritten to the mapped `data:` URI; one
   * that is absent has its `src` removed rather than left dangling. */
  readonly inlineImages?: ReadonlyMap<string, string>;
}

function isRemoteSource(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  // `cid:` references an inline part of this same message and `data:` is
  // self-contained; neither reaches a third party, so neither is gated.
  return !trimmed.startsWith("cid:") && !trimmed.startsWith("data:");
}

/** Normalizes a MIME Content-ID / `cid:` reference so the two forms a
 * message uses for the same image can be matched against each other:
 * headers usually carry `<abc@example>`, while `<img src>` references it as
 * `cid:abc@example`. Trims whitespace, strips one leading `cid:` prefix
 * (case-insensitive), and strips one surrounding `<...>` pair. */
export function normalizeContentId(value: string): string {
  let normalized = value.trim();
  if (normalized.toLowerCase().startsWith("cid:")) {
    normalized = normalized.slice(4).trim();
  }
  if (
    normalized.length >= 2 &&
    normalized.startsWith("<") &&
    normalized.endsWith(">")
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

/** Schemes an `<a href>` may keep after sanitizing. */
const ANCHOR_HREF_PATTERN = /^(https?:|mailto:|tel:)/i;

/** Sanitizes an HTML mail body.
 *
 * `ADD_ATTR` is not used to widen the allowlist: every attribute here is
 * presentational. `href` values are re-checked after sanitizing because a
 * scheme allowlist is the one thing worth being explicit about. */
export function sanitizeMailHtml(
  html: string,
  options: SanitizeMailHtmlOptions = {},
): string {
  const purify = DOMPurify as unknown as {
    sanitize: (input: string, config: Record<string, unknown>) => string;
    addHook?: (name: string, cb: (node: Element) => void) => void;
    removeAllHooks?: () => void;
  };

  const loadRemoteImages = options.loadRemoteImages === true;
  const inlineImages = options.inlineImages ?? new Map<string, string>();

  purify.removeAllHooks?.();
  purify.addHook?.("afterSanitizeAttributes", (node: Element) => {
    if (node.tagName === "A") {
      // Mail links open away from the app; `noopener`/`noreferrer` keeps the
      // opened page from reaching back through `window.opener` or learning
      // the mailbox URL from a referer header.
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
      // `cid:` and `data:image/` pass the shared URI allowlist because
      // images need them, but as a link target they are navigations the
      // reader never asked for. Anchors get the narrower set.
      const href = node.getAttribute("href");
      if (href !== null && !ANCHOR_HREF_PATTERN.test(href.trim())) {
        node.removeAttribute("href");
      }
    }
    if (node.tagName === "IMG") {
      const cidSrc = node.getAttribute("src");
      if (cidSrc?.trim().toLowerCase().startsWith("cid:")) {
        const resolved = inlineImages.get(normalizeContentId(cidSrc));
        if (resolved !== undefined) {
          node.setAttribute("src", resolved);
        } else {
          // An unresolvable `cid:` would otherwise render as a broken-image
          // icon; dropping `src` leaves just the alt text.
          node.removeAttribute("src");
        }
      }
    }
    if (node.tagName === "IMG" && !loadRemoteImages) {
      const src = node.getAttribute("src");
      // A `cid:` source resolved above is now a `data:` URI (or removed),
      // so `isRemoteSource` already treats it as non-remote here.
      if (src !== null && isRemoteSource(src)) {
        node.setAttribute(BLOCKED_SRC_ATTRIBUTE, src);
        node.removeAttribute("src");
      }
    }
  });

  const sanitized = purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: loadRemoteImages
      ? ALLOWED_ATTR
      : [...ALLOWED_ATTR, BLOCKED_SRC_ATTRIBUTE],
    // `javascript:` and friends never survive; `cid:` must, since it
    // references this message's own inline parts.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|data:image\/)/i,
    ADD_URI_SAFE_ATTR: URI_SAFE_ATTR,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["srcset", "formaction", "ping"],
    // Mail HTML often wraps its body in a full document, with `<style>`
    // blocks living in `<head>`. DOMPurify normally discards head content;
    // forcing everything through as body content keeps those style blocks.
    FORCE_BODY: true,
  });

  purify.removeAllHooks?.();
  return sanitized;
}

/** True when the sanitized body still holds at least one gated image, so
 * the reader can be offered a "load images" control only when it would do
 * something. */
export function hasBlockedImages(sanitizedHtml: string): boolean {
  return sanitizedHtml.includes(BLOCKED_SRC_ATTRIBUTE);
}

/** Wraps a sanitized body in a minimal document for the sandboxed iframe.
 *
 * The `Content-Security-Policy` meta tag is a third layer on top of the
 * sanitizer and the sandbox: it stops any surviving reference from reaching
 * the network, which matters most for the images-blocked case. */
export function buildMailFrameDocument(
  sanitizedHtml: string,
  loadRemoteImages: boolean,
): string {
  const imgSrc = loadRemoteImages ? "https: data:" : "data:";
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:">`,
    "<style>",
    "html,body{margin:0;padding:12px;font:14px/1.5 system-ui,sans-serif;color:#111;word-break:break-word}",
    "img{max-width:100%;height:auto}",
    "table{max-width:100%}",
    "blockquote{margin:0 0 0 12px;padding-left:12px;border-left:3px solid #ddd;color:#555}",
    "</style>",
    "</head><body>",
    sanitizedHtml,
    "</body></html>",
  ].join("");
}
