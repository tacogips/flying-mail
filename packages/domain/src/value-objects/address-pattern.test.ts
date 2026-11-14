import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createEmailAddress } from "./email-address";
import {
  addressPatternToLikeExpression,
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
  matchAddressPattern,
  parseAddressPattern,
} from "./address-pattern";

describe("parseAddressPattern", () => {
  test.each([
    ["match-all", "*", "*"],
    ["domain wildcard", "*@Example.com", "*@example.com"],
    ["exact mailbox", "Support@Example.com", "support@example.com"],
    ["prefix wildcard", "support-*@example.com", "support-*@example.com"],
    ["suffix wildcard", "*-noreply@example.com", "*-noreply@example.com"],
  ])("accepts %s", (_name, input, expected) => {
    expect(parseAddressPattern(input)).toBe(expected);
  });

  test.each([
    ["empty", ""],
    ["two wildcards", "a*b*c@example.com"],
    ["wildcard in domain", "user@*.example.com"],
    ["domain is only a wildcard", "user@*"],
    ["no at sign and not match-all", "support"],
    ["empty local part", "@example.com"],
    ["empty domain", "user@"],
    ["invalid domain", "user@localhost"],
    ["invalid literal local part", "us..er@example.com"],
  ])("rejects %s", (_name, value) => {
    expect(parseAddressPattern(value)).toBeNull();
  });
});

describe("createAddressPattern", () => {
  test("throws ValidationError naming the field", () => {
    try {
      createAddressPattern("a*b*c@example.com", "scope.addressPattern");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe("scope.addressPattern");
    }
  });
});

describe("matchAddressPattern", () => {
  const support = createEmailAddress("support@example.com");
  const supportEu = createEmailAddress("support-eu@example.com");
  const billing = createEmailAddress("billing@example.com");
  const otherDomain = createEmailAddress("support@other.com");
  const noreply = createEmailAddress("team-noreply@example.com");

  test("match-all matches every address", () => {
    for (const address of [support, billing, otherDomain]) {
      expect(matchAddressPattern(MATCH_ALL_ADDRESSES, address)).toBe(true);
    }
  });

  test("domain wildcard matches only that domain", () => {
    const pattern = createAddressPattern("*@example.com");
    expect(matchAddressPattern(pattern, support)).toBe(true);
    expect(matchAddressPattern(pattern, billing)).toBe(true);
    expect(matchAddressPattern(pattern, otherDomain)).toBe(false);
  });

  test("exact mailbox matches only itself", () => {
    const pattern = createAddressPattern("support@example.com");
    expect(matchAddressPattern(pattern, support)).toBe(true);
    expect(matchAddressPattern(pattern, supportEu)).toBe(false);
    expect(matchAddressPattern(pattern, otherDomain)).toBe(false);
  });

  test("prefix wildcard matches the local-part prefix", () => {
    const pattern = createAddressPattern("support-*@example.com");
    expect(matchAddressPattern(pattern, supportEu)).toBe(true);
    expect(matchAddressPattern(pattern, support)).toBe(false);
    expect(matchAddressPattern(pattern, billing)).toBe(false);
  });

  test("suffix wildcard matches the local-part suffix", () => {
    const pattern = createAddressPattern("*-noreply@example.com");
    expect(matchAddressPattern(pattern, noreply)).toBe(true);
    expect(matchAddressPattern(pattern, support)).toBe(false);
  });

  test("a wildcard does not match across the prefix/suffix overlap", () => {
    const pattern = createAddressPattern("ab*ab@example.com");
    expect(
      matchAddressPattern(pattern, createEmailAddress("ab@example.com")),
    ).toBe(false);
    expect(
      matchAddressPattern(pattern, createEmailAddress("abxab@example.com")),
    ).toBe(true);
  });
});

describe("addressPatternToLikeExpression", () => {
  test("returns null for match-all", () => {
    expect(addressPatternToLikeExpression(MATCH_ALL_ADDRESSES)).toBeNull();
  });

  test("converts the wildcard and escapes LIKE metacharacters", () => {
    expect(
      addressPatternToLikeExpression(createAddressPattern("*@example.com")),
    ).toBe("%@example.com");
    expect(
      addressPatternToLikeExpression(
        createAddressPattern("a_b%c-*@example.com"),
      ),
    ).toBe("a\\_b\\%c-%@example.com");
  });
});
