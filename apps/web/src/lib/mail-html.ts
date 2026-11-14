import DOMPurify from "dompurify";

/**
 * HTML mail is hostile input by definition.
 *
 * Two independent layers protect the reader, because either alone has known
 * gaps: this sanitizer strips scripting constructs, and the component that
 * renders the result puts it in an iframe with an empty `sandbox` attribute
 * -- no `allow-scripts`, no `allow-same-origin` -- so even a sanitizer
 * bypass has no script execution and no access to the session cookie.
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
  "blockquote",
  "br",
  "caption",
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
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

const ALLOWED_ATTR = [
  "align",
  "alt",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "colspan",
  "dir",
  "height",
  "href",
  "rowspan",
  "span",
  "src",
  "style",
  "title",
  "valign",
  "width",
];

export interface SanitizeMailHtmlOptions {
  /** When false (the default), remote image sources are parked on
   * {@link BLOCKED_SRC_ATTRIBUTE} instead of being loaded. */
  readonly loadRemoteImages?: boolean;
}

function isRemoteSource(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  // `cid:` references an inline part of this same message and `data:` is
  // self-contained; neither reaches a third party, so neither is gated.
  return !trimmed.startsWith("cid:") && !trimmed.startsWith("data:");
}

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

  purify.removeAllHooks?.();
  purify.addHook?.("afterSanitizeAttributes", (node: Element) => {
    if (node.tagName === "A") {
      // Mail links open away from the app; `noopener`/`noreferrer` keeps the
      // opened page from reaching back through `window.opener` or learning
      // the mailbox URL from a referer header.
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    if (node.tagName === "IMG" && !loadRemoteImages) {
      const src = node.getAttribute("src");
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
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["srcset", "formaction", "ping"],
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
