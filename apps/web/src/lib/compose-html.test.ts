import { describe, expect, it } from "vitest";
import {
  htmlToPlainText,
  isAllowedLinkUrl,
  plainTextToHtml,
  sanitizeComposeHtml,
} from "./compose-html";

describe("compose HTML utilities", () => {
  it("keeps only the compose allowlist and removes presentation and events", () => {
    expect(
      sanitizeComposeHtml(
        '<p style="color:red" class="x" onclick="a()">Hi</p>',
      ),
    ).toBe("<p>Hi</p>");
    expect(sanitizeComposeHtml("<style>body{}</style><b>x</b>")).toBe(
      "<b>x</b>",
    );
    expect(
      sanitizeComposeHtml('<p src="data:image/png;base64,AA==">text</p>'),
    ).toBe("<p>text</p>");
    expect(sanitizeComposeHtml("<script>alert(1)</script>ok")).toBe("ok");
  });

  it("drops remote and cid images while retaining data images", () => {
    expect(
      sanitizeComposeHtml(
        '<img src="https://t/p.gif" alt="logo"><img src="cid:abc">',
      ),
    ).toBe("logo");
    expect(
      sanitizeComposeHtml('<img src="data:image/png;base64,AA==" alt="pixel">'),
    ).toContain('src="data:image/png;base64,AA=="');
  });

  it("unwraps unsafe links and keeps permitted links", () => {
    expect(sanitizeComposeHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      "x",
    );
    expect(sanitizeComposeHtml('<a href="https://e.com">e</a>')).toBe(
      '<a href="https://e.com">e</a>',
    );
    expect(isAllowedLinkUrl(" MAILTO:x@y ")).toBe(true);
    expect(isAllowedLinkUrl("data:text/html,x")).toBe(false);
  });

  it("formats lists, links, and quoted lines as plain text", () => {
    expect(htmlToPlainText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
    expect(htmlToPlainText("<ol><li>a</li></ol>")).toBe("1. a");
    expect(htmlToPlainText("<blockquote><p>q</p><p>r</p></blockquote>")).toBe(
      "> q\n> r",
    );
    expect(htmlToPlainText('<a href="https://e.com">site</a>')).toBe(
      "site <https://e.com>",
    );
    expect(htmlToPlainText('<a href="https://e.com">https://e.com</a>')).toBe(
      "https://e.com",
    );
    expect(htmlToPlainText("<p>A &amp; B</p>")).toBe("A & B");
  });

  it("collapses whitespace outside preformatted blocks and preserves pre text", () => {
    expect(htmlToPlainText("<p>one   two\n three</p>")).toBe("one two three");
    expect(htmlToPlainText("<pre>  first\n    second  </pre>")).toBe(
      "  first\n    second  ",
    );
    expect(
      htmlToPlainText("<p>  outside\n    text</p><pre>  code\n    line</pre>"),
    ).toBe("outside text\n  code\n    line");
  });

  it("escapes text and preserves paragraph and line-break structure", () => {
    expect(plainTextToHtml("a<&\n\nb\"c'")).toBe(
      "<p>a&lt;&amp;</p><p>b&quot;c&#39;</p>",
    );
    expect(plainTextToHtml("a\nb")).toBe("<p>a<br>b</p>");
  });
});
