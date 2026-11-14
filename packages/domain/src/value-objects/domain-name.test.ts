import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createDomainName, parseDomainName } from "./domain-name";

describe("parseDomainName", () => {
  test("normalizes case and surrounding whitespace", () => {
    expect(parseDomainName("  Example.COM  ")).toBe("example.com");
  });

  test("accepts multi-label and hyphenated names", () => {
    expect(parseDomainName("mail.sub-domain.example.co.jp")).toBe(
      "mail.sub-domain.example.co.jp",
    );
  });

  test("strips a single trailing root dot", () => {
    expect(parseDomainName("example.com.")).toBe("example.com");
  });

  test.each([
    ["empty", ""],
    ["single label", "localhost"],
    ["leading hyphen label", "-bad.example.com"],
    ["trailing hyphen label", "bad-.example.com"],
    ["empty label", "a..example.com"],
    ["underscore", "under_score.example.com"],
    ["space", "exa mple.com"],
  ])("rejects %s", (_name, value) => {
    expect(parseDomainName(value)).toBeNull();
  });

  test("rejects an over-length name", () => {
    const label = "a".repeat(60);
    const tooLong = `${label}.${label}.${label}.${label}.${label}.com`;
    expect(tooLong.length).toBeGreaterThan(253);
    expect(parseDomainName(tooLong)).toBeNull();
  });

  test("rejects an over-length label", () => {
    expect(parseDomainName(`${"a".repeat(64)}.com`)).toBeNull();
  });
});

describe("createDomainName", () => {
  test("returns the normalized name", () => {
    expect(createDomainName("EXAMPLE.com")).toBe("example.com");
  });

  test("throws ValidationError naming the field", () => {
    expect(() => createDomainName("nope", "domainName")).toThrow(
      ValidationError,
    );
    try {
      createDomainName("nope", "domainName");
    } catch (error) {
      expect((error as ValidationError).field).toBe("domainName");
    }
  });
});
