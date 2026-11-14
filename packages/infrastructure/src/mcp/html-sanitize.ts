import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import {
  isDroppedElement,
  MCP_HTML_INPUT_CHARS,
  MCP_HTML_MAX_DEPTH,
} from "./html-text";

export interface SanitizedHtml {
  readonly html: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

type ParsedNode = DefaultTreeAdapterMap["node"];
type ParsedElement = DefaultTreeAdapterMap["element"];

const ALLOWED_ELEMENTS = new Set([
  "p",
  "br",
  "div",
  "span",
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
]);
const VOID_ELEMENTS = new Set(["br", "hr"]);
const SAFE_URL = /^(https?:|mailto:)/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip controls before validating untrusted URL schemes
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function safeAttributes(element: ParsedElement): string {
  const rendered: string[] = [];
  for (const { name, value } of element.attrs) {
    if (element.tagName === "a" && name === "href") {
      const cleaned = value.replace(URL_CONTROL_CHARACTERS, "").trim();
      if (SAFE_URL.test(cleaned))
        rendered.push(` href="${escapeAttribute(cleaned)}"`);
    }
    if (
      (element.tagName === "td" || element.tagName === "th") &&
      (name === "colspan" || name === "rowspan") &&
      /^[0-9]{1,3}$/.test(value)
    ) {
      rendered.push(` ${name}="${escapeAttribute(value)}"`);
    }
  }
  return rendered.join("");
}

function render(node: ParsedNode, depth: number): string {
  if ("value" in node) return escapeText(node.value);
  if (node.nodeName === "#comment" || node.nodeName === "#documentType")
    return "";
  if (node.nodeName === "#document" || node.nodeName === "#document-fragment") {
    return node.childNodes.map((child) => render(child, depth + 1)).join("");
  }
  const element = node as ParsedElement;
  if (depth > MCP_HTML_MAX_DEPTH) return "";
  if (isDroppedElement(element)) return "";
  if (element.tagName === "img")
    return escapeText(
      element.attrs.find((item) => item.name === "alt")?.value ?? "",
    );
  const children = element.childNodes
    .map((child) => render(child, depth + 1))
    .join("");
  if (!ALLOWED_ELEMENTS.has(element.tagName)) return children;
  const open = `<${element.tagName}${safeAttributes(element)}>`;
  return VOID_ELEMENTS.has(element.tagName)
    ? open
    : `${open}${children}</${element.tagName}>`;
}

interface BoundedWriter {
  output: string;
  stopped: boolean;
  readonly limit: number;
}

function append(writer: BoundedWriter, value: string): void {
  if (writer.stopped) return;
  const remaining = Math.max(0, writer.limit - writer.output.length);
  if (value.length <= remaining) {
    writer.output += value;
    return;
  }
  writer.output += value.slice(0, remaining);
  writer.stopped = true;
}

function appendMarkup(writer: BoundedWriter, value: string): void {
  if (writer.stopped) return;
  if (value.length > writer.limit - writer.output.length) {
    writer.stopped = true;
    return;
  }
  writer.output += value;
}

function renderBounded(
  node: ParsedNode,
  writer: BoundedWriter,
  depth: number,
): void {
  if (writer.stopped) return;
  if ("value" in node) {
    append(writer, escapeText(node.value));
    return;
  }
  if (node.nodeName === "#comment" || node.nodeName === "#documentType") return;
  if (node.nodeName === "#document" || node.nodeName === "#document-fragment") {
    for (const child of node.childNodes)
      renderBounded(child, writer, depth + 1);
    return;
  }
  const element = node as ParsedElement;
  if (depth > MCP_HTML_MAX_DEPTH) return;
  if (isDroppedElement(element)) return;
  if (element.tagName === "img") {
    append(
      writer,
      escapeText(
        element.attrs.find((item) => item.name === "alt")?.value ?? "",
      ),
    );
    return;
  }
  if (!ALLOWED_ELEMENTS.has(element.tagName)) {
    for (const child of element.childNodes)
      renderBounded(child, writer, depth + 1);
    return;
  }
  const open = `<${element.tagName}${safeAttributes(element)}>`;
  appendMarkup(writer, open);
  if (writer.stopped) return;
  if (VOID_ELEMENTS.has(element.tagName)) return;
  for (const child of element.childNodes)
    renderBounded(child, writer, depth + 1);
  writer.output += `</${element.tagName}>`;
}

export function sanitizeHtml(html: string, maxChars: number): SanitizedHtml {
  const boundedInput = html.slice(0, MCP_HTML_INPUT_CHARS);
  const document = parseFragment(boundedInput);
  const fullOutput = render(document, 0);
  const inputWasTruncated = html.length > MCP_HTML_INPUT_CHARS;
  const limit = Math.max(0, maxChars);
  if (!inputWasTruncated && fullOutput.length <= limit) {
    return {
      html: fullOutput,
      truncated: false,
      totalChars: fullOutput.length,
    };
  }
  const writer: BoundedWriter = { output: "", stopped: false, limit };
  renderBounded(document, writer, 0);
  return {
    html: `${writer.output}<p>[truncated]</p>`,
    truncated: true,
    totalChars: fullOutput.length,
  };
}
