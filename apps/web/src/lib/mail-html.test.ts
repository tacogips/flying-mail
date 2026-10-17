import { describe, expect, test } from "vitest";
import {
  BLOCKED_SRC_ATTRIBUTE,
  buildMailFrameDocument,
  hasBlockedImages,
  normalizeContentId,
  sanitizeMailHtml,
} from "./mail-html";

describe("sanitizeMailHtml anchors", () => {
  test.each([
    "https://example.com/a",
    "http://example.com/a",
    "mailto:a@example.com",
    "tel:+15551234",
    "HTTPS://EXAMPLE.COM",
  ])("keeps href %s", (href) => {
    const html = sanitizeMailHtml(`<a href="${href}">x</a>`);
    expect(html).toContain("href=");
  });

  test.each([
    ["cid:", "cid:logo@example"],
    ["data:image", "data:image/png;base64,AAAA"],
    ["javascript:", "javascript:alert(1)"],
    ["a relative path", "/settings"],
    ["a protocol-relative url", "//evil.example/x"],
    ["a fragment", "#top"],
  ])("removes href with %s", (_label, href) => {
    const html = sanitizeMailHtml(`<a href="${href}">x</a>`);
    expect(html).not.toContain("href=");
    expect(html).toContain(">x</a>");
  });

  test("still marks remaining anchors as opening away safely", () => {
    const html = sanitizeMailHtml('<a href="https://example.com">x</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener noreferrer");
  });
});

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
    ["an iframe", '<iframe src="https://evil.com"></iframe><p>ok</p>'],
    ["an object", "<object data=x></object><p>ok</p>"],
    ["an embed", '<embed src="https://evil.com"><p>ok</p>'],
    ["a form", '<form action="https://evil.com"><input></form><p>ok</p>'],
  ])("removes %s", (_label, input) => {
    const html = sanitizeMailHtml(input);
    expect(html).toContain("ok");
    for (const tag of ["<script", "<iframe", "<object", "<embed", "<form"]) {
      expect(html).not.toContain(tag);
    }
  });

  test("preserves a <style> element instead of stripping it", () => {
    const html = sanitizeMailHtml("<style>body{color:red}</style><p>ok</p>");
    expect(html).toContain("<style>body{color:red}</style>");
    expect(html).toContain("<p>ok</p>");
  });

  test("preserves a <style> block placed in <head> of a full document", () => {
    // Mail HTML frequently arrives as a complete document. DOMPurify
    // discards `<head>` content by default; `FORCE_BODY: true` is what
    // keeps this style block alive.
    const html = sanitizeMailHtml(
      "<html><head><style>.promo{color:#f00}</style></head>" +
        '<body><p class="promo">ok</p></body></html>',
    );
    expect(html).toContain("<style>.promo{color:#f00}</style>");
    expect(html).toContain('<p class="promo">ok</p>');
  });

  test("preserves legacy presentational tags and attributes", () => {
    const html = sanitizeMailHtml(
      '<center><font color="#ff0000" face="Arial">hi</font></center>' +
        '<table><tr><td bgcolor="#eeeeee">cell</td></tr></table>',
    );
    expect(html).toContain("<center>");
    expect(html).toContain('color="#ff0000"');
    expect(html).toContain('face="Arial"');
    expect(html).toContain('bgcolor="#eeeeee"');
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

    test("removes an unresolved cid: reference instead of gating it -- it never reaches a third party, but an unresolved reference would just render as a broken-image icon", () => {
      const html = sanitizeMailHtml('<img src="cid:logo@example.com">');
      expect(html).not.toMatch(/(^|\s)src=/);
      expect(html).not.toContain(BLOCKED_SRC_ATTRIBUTE);
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

  describe("inline cid: images", () => {
    test("rewrites a cid: src to the mapped data URI", () => {
      const html = sanitizeMailHtml('<img src="cid:abc@x">', {
        inlineImages: new Map([["abc@x", "data:image/png;base64,AAAA"]]),
      });
      expect(html).toContain('src="data:image/png;base64,AAAA"');
    });

    test("matches case-insensitively on the cid: prefix", () => {
      const html = sanitizeMailHtml('<img src="CID:abc@x">', {
        inlineImages: new Map([["abc@x", "data:image/png;base64,AAAA"]]),
      });
      expect(html).toContain('src="data:image/png;base64,AAAA"');
    });

    test("removes the src when no inline image matches", () => {
      const html = sanitizeMailHtml('<img src="cid:missing@x">', {
        inlineImages: new Map([["abc@x", "data:image/png;base64,AAAA"]]),
      });
      expect(html).not.toMatch(/(^|\s)src=/);
    });

    test("a resolved cid: image is not parked as a blocked remote image", () => {
      const html = sanitizeMailHtml('<img src="cid:abc@x">', {
        inlineImages: new Map([["abc@x", "data:image/png;base64,AAAA"]]),
      });
      expect(hasBlockedImages(html)).toBe(false);
    });
  });

  test("handles an empty body without throwing", () => {
    expect(sanitizeMailHtml("")).toBe("");
  });
});

describe("normalizeContentId", () => {
  test.each([
    ["a bracketed Content-ID header value", "<abc@x>", "abc@x"],
    ["a cid: URI reference", "cid:abc@x", "abc@x"],
    ["a value with surrounding whitespace", " abc@x ", "abc@x"],
    ["an uppercase CID: prefix", "CID:abc@x", "abc@x"],
    ["a bracketed value with a cid: prefix", "cid:<abc@x>", "abc@x"],
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeContentId(input)).toBe(expected);
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
