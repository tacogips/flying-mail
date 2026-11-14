import { describe, expect, test } from "vitest";
import {
  BLOCKED_SRC_ATTRIBUTE,
  buildMailFrameDocument,
  hasBlockedImages,
  sanitizeMailHtml,
} from "./mail-html";

describe("sanitizeMailHtml", () => {
  test("keeps ordinary formatting", () => {
    const html = sanitizeMailHtml(
      "<p>Hello <strong>world</strong></p><ul><li>one</li></ul>",
    );
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>one</li>");
  });

  test.each([
    ["a script element", "<p>ok</p><script>alert(1)</script>"],
    ["an inline style element", "<style>body{display:none}</style><p>ok</p>"],
    ["an iframe", '<iframe src="https://evil.com"></iframe><p>ok</p>'],
    ["an object", "<object data=x></object><p>ok</p>"],
    ["a form", '<form action="https://evil.com"><input></form><p>ok</p>'],
  ])("removes %s", (_label, input) => {
    const html = sanitizeMailHtml(input);
    expect(html).toContain("ok");
    for (const tag of ["<script", "<style", "<iframe", "<object", "<form"]) {
      expect(html).not.toContain(tag);
    }
  });

  test.each([
    ["onerror", '<img src="x" onerror="alert(1)">'],
    ["onclick", '<p onclick="alert(1)">text</p>'],
    ["onload", '<body onload="alert(1)"><p>text</p></body>'],
  ])("strips the %s handler", (_label, input) => {
    const html = sanitizeMailHtml(input, { loadRemoteImages: true });
    expect(html.toLowerCase()).not.toContain("alert(1)");
    expect(html.toLowerCase()).not.toMatch(/on\w+=/);
  });

  test.each([
    ["javascript:", '<a href="javascript:alert(1)">click</a>'],
    ["vbscript:", '<a href="vbscript:msgbox(1)">click</a>'],
    [
      "a data: document",
      '<a href="data:text/html,<script>x</script>">click</a>',
    ],
  ])("removes a %s href", (_label, input) => {
    const html = sanitizeMailHtml(input);
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("vbscript:");
    expect(html.toLowerCase()).not.toContain("data:text/html");
  });

  test("keeps safe link schemes and hardens the target", () => {
    const html = sanitizeMailHtml('<a href="https://example.com">visit</a>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  test("keeps a mailto link", () => {
    expect(
      sanitizeMailHtml('<a href="mailto:a@example.com">mail</a>'),
    ).toContain("mailto:a@example.com");
  });

  describe("remote image gating", () => {
    test("parks a remote src instead of loading it", () => {
      const html = sanitizeMailHtml(
        '<img src="https://tracker.example/p.gif">',
      );
      // Matched on an attribute boundary: `data-mailcal-blocked-src="..."`
      // ends in `-src="..."`, so a plain substring check would pass even if
      // the real `src` had survived.
      expect(html).not.toMatch(/(^|\s)src=/);
      expect(html).toContain(BLOCKED_SRC_ATTRIBUTE);
      expect(hasBlockedImages(html)).toBe(true);
    });

    test("restores it when images are allowed", () => {
      const html = sanitizeMailHtml(
        '<img src="https://cdn.example/logo.png">',
        {
          loadRemoteImages: true,
        },
      );
      expect(html).toMatch(/(^|\s)src="https:\/\/cdn\.example\/logo\.png"/);
      expect(hasBlockedImages(html)).toBe(false);
    });

    test("leaves a cid: reference alone -- it never reaches a third party", () => {
      const html = sanitizeMailHtml('<img src="cid:logo@example.com">');
      expect(html).toContain('src="cid:logo@example.com"');
      expect(hasBlockedImages(html)).toBe(false);
    });

    test("leaves an inline data: image alone", () => {
      const html = sanitizeMailHtml(
        '<img src="data:image/png;base64,iVBORw0KGgo=">',
      );
      expect(html).toContain("data:image/png");
      expect(hasBlockedImages(html)).toBe(false);
    });

    test("drops srcset, which would bypass the src gate", () => {
      const html = sanitizeMailHtml(
        '<img src="cid:a" srcset="https://tracker.example/p.gif 1x">',
      );
      expect(html).not.toContain("srcset");
    });
  });

  test("handles an empty body without throwing", () => {
    expect(sanitizeMailHtml("")).toBe("");
  });
});

describe("buildMailFrameDocument", () => {
  test("carries a restrictive CSP that blocks remote images by default", () => {
    const doc = buildMailFrameDocument("<p>hi</p>", false);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src data:");
    expect(doc).not.toContain("img-src https:");
    expect(doc).toContain("<p>hi</p>");
  });

  test("widens img-src only once the reader opts in", () => {
    const doc = buildMailFrameDocument("<p>hi</p>", true);
    expect(doc).toContain("img-src https: data:");
  });

  test("never permits script execution", () => {
    for (const allowImages of [false, true]) {
      expect(buildMailFrameDocument("<p>hi</p>", allowImages)).not.toContain(
        "script-src",
      );
    }
  });
});
