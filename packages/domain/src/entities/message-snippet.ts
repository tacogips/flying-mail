/** Maximum length of the preview text stored on every message. */
export const SNIPPET_LENGTH = 200;

const BLOCK_LEVEL_TAGS =
  /<\/?(?:p|div|br|li|tr|h[1-6]|blockquote|table|section|article)\b[^>]*>/gi;
const REMOVED_ELEMENTS = /<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ANY_TAG = /<[^>]*>/g;

const HTML_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&nbsp;", " "],
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&apos;", "'"],
]);

function decodeCommonEntities(value: string): string {
  let result = value;
  for (const [entity, replacement] of HTML_ENTITIES) {
    result = result.replaceAll(entity, replacement);
  }
  // Numeric references, decimal and hex. Anything out of range is dropped
  // rather than guessed at -- this is preview text, not a rendering path.
  return result.replace(/&#(x?)([0-9a-f]+);/gi, (match, hex, digits) => {
    const codePoint = Number.parseInt(digits, hex === "" ? 10 : 16);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
      return match;
    }
    return String.fromCodePoint(codePoint);
  });
}

/** Strips markup from an HTML body down to readable text. Deliberately
 * simple: this output is only ever used for the plain-text `snippet`
 * column, never rendered as HTML, so it is not a sanitizer and must not be
 * mistaken for one -- the web client sanitizes bodies separately. */
export function htmlToPlainText(html: string): string {
  const withoutHiddenElements = html.replace(REMOVED_ELEMENTS, " ");
  const withBlockBreaks = withoutHiddenElements.replace(BLOCK_LEVEL_TAGS, " ");
  const withoutTags = withBlockBreaks.replace(ANY_TAG, "");
  return decodeCommonEntities(withoutTags);
}

/** Builds the stored preview: plain text when available, otherwise derived
 * from the HTML body, with whitespace collapsed and truncated to
 * {@link SNIPPET_LENGTH}. */
export function buildSnippet(text: string | null, html: string | null): string {
  const source =
    text !== null && text.trim().length > 0
      ? text
      : html === null
        ? ""
        : htmlToPlainText(html);
  const collapsed = source.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_LENGTH
    ? collapsed.slice(0, SNIPPET_LENGTH)
    : collapsed;
}
