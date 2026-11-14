import { describe, expect, test } from "vitest";
import {
  findDescendants,
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
      "<multistatus><response><href>/a.ics</href>" +
      '<propstat><prop><getetag>"e"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat>' +
      "<propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat>" +
      "</response></multistatus>";
    const response = parseMultistatus(xml).responses[0];
    if (response === undefined) {
      throw new Error("expected one response");
    }
    expect(response.href).toBe("/a.ics");
    expect(findOkPropText(response, "getetag")).toBe('"e"');
    expect(findOkPropText(response, "getctag")).toBeNull();
  });

  test("reads the collection sync-token but not one nested in a response", () => {
    const xml =
      "<multistatus><response><href>/a.ics</href>" +
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
