import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "p",
  "div",
  "br",
  "span",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "a",
  "blockquote",
  "pre",
  "code",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "img",
];

const ALLOWED_ATTR = [
  "href",
  "title",
  "alt",
  "colspan",
  "rowspan",
  "dir",
  "src",
];
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "TABLE",
  "TR",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

/** Returns whether a link uses a scheme safe for composed mail. */
export function isAllowedLinkUrl(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim());
}

/** Sanitizes composed HTML with a profile independent from received mail. */
export function sanitizeComposeHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ["style"],
    FORBID_ATTR: ["style", "class", "id"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?:|mailto:)|data:image\/)/i,
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");

  for (const element of document.body.querySelectorAll("[src]")) {
    if (element.tagName.toLowerCase() !== "img") element.removeAttribute("src");
  }

  for (const image of document.body.querySelectorAll("img")) {
    const source = image.getAttribute("src") ?? "";
    if (!source.toLowerCase().startsWith("data:image/")) {
      const alt = image.getAttribute("alt");
      image.replaceWith(document.createTextNode(alt ?? ""));
    }
  }

  for (const anchor of document.body.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (href === null || !isAllowedLinkUrl(href)) {
      anchor.replaceWith(...Array.from(anchor.childNodes));
    }
  }

  return document.body.innerHTML;
}

function renderPlainText(node: Node, preformatted: string[]): string {
  if (node.nodeType === Node.TEXT_NODE)
    return (node.nodeValue ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === "pre") {
    const index = preformatted.push(element.textContent ?? "") - 1;
    return `\uE000${index}\uE001`;
  }
  const children = Array.from(element.childNodes)
    .map((child) => renderPlainText(child, preformatted))
    .join("");
  if (tag === "br") return "\n";
  if (tag === "a") {
    const href = element.getAttribute("href") ?? "";
    const text = children.trim();
    return href.length > 0 && text !== href ? `${text} <${href}>` : text;
  }
  if (tag === "li") {
    const list = element.parentElement;
    const siblings = list
      ? Array.from(list.children).filter((child) => child.tagName === "LI")
      : [];
    const index = siblings.indexOf(element) + 1;
    const prefix = list?.tagName === "OL" ? `${index}. ` : "- ";
    return `\n${prefix}${children.trim()}`;
  }
  if (tag === "blockquote") {
    const quoted = children
      .trim()
      .replace(/\n{2,}/g, "\n")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `\n${quoted}\n`;
  }
  if (tag === "ul" || tag === "ol") return children;
  if (BLOCK_TAGS.has(element.tagName)) {
    return `\n${children}\n`;
  }
  return children;
}

/** Converts HTML to readable plain text, retaining block, list, quote, and link structure. */
export function htmlToPlainText(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const preformatted: string[] = [];
  const text = renderPlainText(document.body, preformatted)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\n+/, "")
    .trimEnd();
  return text.replace(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => preformatted[Number(index)] ?? "",
  );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Converts plain text paragraphs and line breaks to escaped HTML. */
export function plainTextToHtml(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map(
      (paragraph) =>
        `<p>${paragraph.split(/\r?\n/).map(escapeHtml).join("<br>")}</p>`,
    )
    .join("");
}
