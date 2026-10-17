import { describe, expect, test } from "vitest";
import { sanitizeHtml } from "./html-sanitize";

describe("sanitizeHtml", () => {
  test("rebuilds allowed markup and strips unsafe attributes", () => {
    expect(
      sanitizeHtml('<p onclick="x" style="color:red" class="c">t</p>', 100)
        .html,
    ).toBe("<p>t</p>");
    expect(sanitizeHtml('<a href=" JavaScript:alert(1)">x</a>', 100).html).toBe(
      "<a>x</a>",
    );
    expect(sanitizeHtml('<a href="https://ok.test">x</a>', 100).html).toBe(
      '<a href="https://ok.test">x</a>',
    );
    expect(
      sanitizeHtml('<a href="java&#10;script:alert(1)">x</a>', 100).html,
    ).toBe("<a>x</a>");
    expect(
      sanitizeHtml('<img src="https://t.test/a.png" alt="A">', 100).html,
    ).toBe("A");
    expect(
      sanitizeHtml(
        "<script>secret</script><style>secret</style><svg><a>secret</a></svg>",
        100,
      ).html,
    ).toBe("");
    expect(sanitizeHtml("<custom><b>k</b></custom>", 100).html).toBe(
      "<b>k</b>",
    );
    expect(sanitizeHtml('<td colspan="2x">x</td>', 100).html).toBe(
      "<td>x</td>",
    );
    expect(sanitizeHtml("&lt;b&gt;", 100).html).toBe("&lt;b&gt;");
  });

  test("bounds output, reports full rebuilt length and closes open tags", () => {
    const result = sanitizeHtml(`<p>${"x".repeat(100)}</p>`, 50);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(107);
    expect(result.html.endsWith("</p><p>[truncated]</p>")).toBe(true);
    expect(result.html).not.toContain(
      "<p>xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</p>",
    );
  });

  test("bounds traversal for deeply nested source elements", () => {
    const html = `${"<div>".repeat(20_000)}x`;
    const rendered = sanitizeHtml(html, 200_000);
    expect(rendered.html).toBeTypeOf("string");
    expect(rendered.html.length).toBeLessThan(10_000);
    expect(rendered.html).not.toContain("<script");

    const bounded = sanitizeHtml(html, 10);
    expect(bounded.truncated).toBe(true);
    expect(bounded.html.endsWith("<p>[truncated]</p>")).toBe(true);
    expect(bounded.html.length).toBeLessThan(10_000);
  }, 60_000);
});
