import { describe, expect, test } from "vitest";
import {
  decodeXmlEntities,
  findDescendants,
  MAX_XML_DEPTH,
  findOkPropText,
  parseMultistatus,
  parseXml,
} from "./xml";

describe("parseXml", () => {
  test("strips namespace prefixes so any spelling matches", () => {
    const withPrefix = parseXml("<D:multistatus><D:response/></D:multistatus>");
    const withoutPrefix = parseXml("<multistatus><response/></multistatus>");
    const lowerPrefix = parseXml(
      "<d:multistatus><d:response/></d:multistatus>",
    );
    for (const root of [withPrefix, withoutPrefix, lowerPrefix]) {
      if (root === null) {
        throw new Error("expected a parsed root element");
      }
      expect(root.name).toBe("multistatus");
      expect(findDescendants(root, "response")).toHaveLength(1);
    }
  });

  test("decodes entities, CDATA and numeric references", () => {
    const root = parseXml(
      "<prop><a>Work &amp; Life</a><b><![CDATA[raw <notatag>]]></b>" +
        "<c>&#65;&#x42;</c></prop>",
    );
    expect(root?.children.map((child) => child.text)).toEqual([
      "Work & Life",
      "raw <notatag>",
      "AB",
    ]);
  });

  test("reads attributes and self-closing elements", () => {
    const root = parseXml(
      '<set><comp name="VEVENT"/><comp name="VTODO"/></set>',
    );
    expect(root?.children.map((child) => child.attributes.get("name"))).toEqual(
      ["VEVENT", "VTODO"],
    );
  });

  test("returns null for a non-XML body", () => {
    expect(parseXml("not xml at all")).toBeNull();
  });
});

describe("parseMultistatus", () => {
  test("ignores properties reported in a 404 propstat", () => {
    const xml =
      "<multistatus><response><href>/a.vcf</href>" +
      '<propstat><prop><getetag>"e"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat>' +
      "<propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat>" +
      "</response></multistatus>";
    const response = parseMultistatus(xml).responses[0];
    if (response === undefined) {
      throw new Error("expected one response");
    }
    expect(response.href).toBe("/a.vcf");
    expect(findOkPropText(response, "getetag")).toBe('"e"');
    expect(findOkPropText(response, "getctag")).toBeNull();
  });

  test("reads the collection sync-token but not one nested in a response", () => {
    const xml =
      "<multistatus><response><href>/a.vcf</href>" +
      "<propstat><prop><sync-token>inner</sync-token></prop>" +
      "<status>HTTP/1.1 200 OK</status></propstat></response>" +
      "<sync-token>outer</sync-token></multistatus>";
    expect(parseMultistatus(xml).syncToken).toBe("outer");
  });

  test("yields no responses for an HTML error page", () => {
    expect(parseMultistatus("<html><body>oops</body></html>")).toEqual({
      responses: [],
      syncToken: null,
    });
  });
});

describe("decodeXmlEntities", () => {
  test.each([
    ["&#x110000;", "\uFFFD"],
    ["&#1114112;", "\uFFFD"],
    ["&#xD800;", "\uFFFD"],
    ["&#xDFFF;", "\uFFFD"],
    ["&#0;", "\uFFFD"],
    [`&#x${"F".repeat(400)};`, "\uFFFD"],
    ["&#x10FFFF;", "\u{10FFFF}"],
    ["&#x1F600;", "\u{1F600}"],
    ["&#65;&#x42;", "AB"],
    ["&amp;&lt;&unknown;", "&<&unknown;"],
  ])("decodes %j without throwing", (input, expected) => {
    expect(decodeXmlEntities(input)).toBe(expected);
  });
});

describe("parseXml bounds", () => {
  function nested(depth: number): string {
    return `${"<a>".repeat(depth)}x${"</a>".repeat(depth)}`;
  }

  test("an invalid numeric entity in a document does not throw", () => {
    const root = parseXml("<a>&#x110000;</a>");
    expect(root?.text).toBe("\uFFFD");
  });

  test("parses nesting up to the depth limit", () => {
    const root = parseXml(nested(MAX_XML_DEPTH));
    expect(root).not.toBeNull();
    expect(findDescendants(root as NonNullable<typeof root>, "a")).toHaveLength(
      MAX_XML_DEPTH - 1,
    );
  });

  test("returns null past the depth limit", () => {
    expect(parseXml(nested(MAX_XML_DEPTH + 1))).toBeNull();
  });

  test("a hostile, very deep document fails cleanly instead of overflowing the stack", () => {
    expect(parseXml(nested(200_000))).toBeNull();
    expect(parseMultistatus(nested(200_000))).toEqual({
      responses: [],
      syncToken: null,
    });
  });

  test("findDescendants returns matches in document order", () => {
    const root = parseXml(
      "<r><a><b>1</b><b>2</b></a><b>3</b><c><b>4</b></c></r>",
    );
    expect(
      findDescendants(root as NonNullable<typeof root>, "b").map(
        (node) => node.text,
      ),
    ).toEqual(["1", "2", "3", "4"]);
  });
});
