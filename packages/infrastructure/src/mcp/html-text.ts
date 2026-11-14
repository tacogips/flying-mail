import { parse, type DefaultTreeAdapterMap } from "parse5";

export const MCP_HTML_INPUT_CHARS = 524_288;
export const MCP_HTML_MAX_DEPTH = 256;
export const HTML_INPUT_TRUNCATION_MARKER =
  "\n[truncated: HTML input exceeded MCP_HTML_INPUT_CHARS]";

export interface HtmlTextResult {
  readonly text: string;
  readonly inputTruncated: boolean;
}

export type ParsedElement = DefaultTreeAdapterMap["element"];
type ParsedNode = DefaultTreeAdapterMap["node"];

const DROPPED_ELEMENTS = new Set([
  "script",
  "style",
  "head",
  "title",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "select",
  "textarea",
  "button",
  "input",
]);
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "br",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "table",
  "section",
  "article",
  "ul",
  "ol",
  "hr",
]);

export function isDroppedElement(element: ParsedElement): boolean {
  if (DROPPED_ELEMENTS.has(element.tagName)) return true;
  const attributes = new Map(
    element.attrs.map(({ name, value }) => [name, value]),
  );
  if (
    attributes.has("hidden") ||
    attributes.get("aria-hidden")?.toLowerCase() === "true"
  ) {
    return true;
  }
  const style = (attributes.get("style") ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  return (
    style.includes("display:none") ||
    style.includes("visibility:hidden") ||
    style.includes("font-size:0")
  );
}

function attribute(element: ParsedElement, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function normalizeText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function visit(node: ParsedNode, depth: number): string {
  if ("value" in node) return node.value;
  if (node.nodeName === "#comment" || node.nodeName === "#documentType")
    return "";
  if (node.nodeName === "#document" || node.nodeName === "#document-fragment") {
    return node.childNodes.map((child) => visit(child, depth + 1)).join("");
  }
  const element = node as ParsedElement;
  if (depth > MCP_HTML_MAX_DEPTH) return "";
  if (isDroppedElement(element)) return "";
  if (element.tagName === "img") {
    const alt = attribute(element, "alt")?.trim();
    return alt ? `[image: ${alt}]` : "";
  }
  const startsBlock = BLOCK_ELEMENTS.has(element.tagName);
  const prefix = element.tagName === "li" ? "- " : "";
  let content = `${startsBlock ? "\n" : ""}${prefix}${element.childNodes.map((child) => visit(child, depth + 1)).join("")}`;
  if (element.tagName === "a") {
    const href = attribute(element, "href")?.trim() ?? "";
    if (/^(https?:|mailto:)/i.test(href) && href !== content.trim()) {
      content += ` <${href}>`;
    }
  }
  if (startsBlock) content += "\n";
  return content;
}

export function htmlToText(html: string): HtmlTextResult {
  const inputTruncated = html.length > MCP_HTML_INPUT_CHARS;
  const boundedHtml = inputTruncated
    ? html.slice(0, MCP_HTML_INPUT_CHARS)
    : html;
  const text = normalizeText(visit(parse(boundedHtml), 0));
  return {
    text: inputTruncated ? `${text}${HTML_INPUT_TRUNCATION_MARKER}` : text,
    inputTruncated,
  };
}
