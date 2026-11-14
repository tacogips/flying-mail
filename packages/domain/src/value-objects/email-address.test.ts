import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import {
  createEmailAddress,
  emailDomainName,
  emailLocalPart,
  parseEmailAddress,
} from "./email-address";

describe("parseEmailAddress", () => {
  test("normalizes case and surrounding whitespace", () => {
    expect(parseEmailAddress("  Support@Example.COM ")).toBe(
      "support@example.com",
    );
  });

  test("accepts the RFC-permitted local part specials", () => {
    expect(
      parseEmailAddress("a.b!c#d$e%f&g'h*i+j/k=l?m^n_o`p{q|r}s~t@x.com"),
    ).toBe("a.b!c#d$e%f&g'h*i+j/k=l?m^n_o`p{q|r}s~t@x.com");
  });

  test.each([
    ["no at sign", "nobody"],
    ["two at signs", "a@b@example.com"],
    ["empty local part", "@example.com"],
    ["empty domain", "user@"],
    ["leading dot", ".user@example.com"],
    ["trailing dot", "user.@example.com"],
    ["double dot", "us..er@example.com"],
    ["invalid domain", "user@localhost"],
    ["display name syntax", "Name <user@example.com>"],
    ["address list", "a@example.com, b@example.com"],
    ["non-ascii", "üser@example.com"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(parseEmailAddress(value)).toBeNull();
  });

  test("rejects an over-length local part", () => {
    expect(parseEmailAddress(`${"a".repeat(65)}@example.com`)).toBeNull();
  });

  test("rejects an over-length address", () => {
    const local = "a".repeat(64);
    const domain = `${"b".repeat(61)}.${"c".repeat(61)}.${"d".repeat(61)}.${"e".repeat(45)}.com`;
    const value = `${local}@${domain}`;
    expect(value.length).toBeGreaterThan(254);
    expect(parseEmailAddress(value)).toBeNull();
  });
});

describe("createEmailAddress", () => {
  test("returns the normalized address", () => {
    expect(createEmailAddress("USER@Example.com")).toBe("user@example.com");
  });

  test("throws ValidationError naming the field", () => {
    try {
      createEmailAddress("bogus", "from");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe("from");
    }
  });
});

describe("accessors", () => {
  test("split the normalized address", () => {
    const address = createEmailAddress("support+tag@mail.example.com");
    expect(emailLocalPart(address)).toBe("support+tag");
    expect(emailDomainName(address)).toBe("mail.example.com");
  });
});
