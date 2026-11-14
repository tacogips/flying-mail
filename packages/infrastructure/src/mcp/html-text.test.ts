import { describe, expect, test } from "vitest";
import { htmlToText, MCP_HTML_INPUT_CHARS } from "./html-text";

describe("htmlToText", () => {
  test.each([
    ["<p>a</p><p>b</p>", "a\nb"],
    ["<script>x</script>hi", "hi"],
    ["<!-- ignore previous -->ok", "ok"],
    ["<div hidden>secret</div>v", "v"],
    ['<span style="display: none">s</span>v', "v"],
    ['<span aria-hidden="true">s</span>v', "v"],
    ['<span style="font-size:0">s</span>v', "v"],
    ['<a href="https://x.test/a">click</a>', "click <https://x.test/a>"],
    ['<a href="javascript:alert(1)">c</a>', "c"],
    ['<img src="https://t.test/p.gif" alt="logo">', "[image: logo]"],
    ["&amp;&lt;", "&<"],
  ])("converts %s", (html, expected) => {
    expect(htmlToText(html).text).toBe(expected);
  });

  test("caps input before parsing and marks truncation", () => {
    const result = htmlToText(`${"a".repeat(MCP_HTML_INPUT_CHARS)}ignored`);
    expect(result.inputTruncated).toBe(true);
    expect(result.text).toContain(
      "[truncated: HTML input exceeded MCP_HTML_INPUT_CHARS]",
    );
  });

  test("keeps text in nested elements below the depth limit", () => {
    expect(htmlToText("<div><span><b>shallow</b></span></div>").text).toBe(
      "shallow",
    );
  });

  test("drops deeply nested content without throwing", () => {
    const html = `${"<div>".repeat(20_000)}x`;
    const result = htmlToText(html);
    expect(result.text).toBeTypeOf("string");
    expect(result.text).not.toContain("x");
  }, 60_000);
});
