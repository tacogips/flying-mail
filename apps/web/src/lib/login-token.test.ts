import { describe, expect, test } from "vitest";
import { extractLoginToken } from "./login-token";

describe("extractLoginToken", () => {
  test("reads the token from the fragment", () => {
    expect(
      extractLoginToken({
        pathname: "/auth/verify",
        search: "",
        hash: "#token=abc123",
      }),
    ).toEqual({ token: "abc123", cleanedUrl: "/auth/verify" });
  });

  test("falls back to the legacy query parameter", () => {
    expect(
      extractLoginToken({
        pathname: "/auth/verify",
        search: "?token=old",
        hash: "",
      }),
    ).toEqual({ token: "old", cleanedUrl: "/auth/verify" });
  });

  test("prefers the fragment when both are present", () => {
    expect(
      extractLoginToken({
        pathname: "/auth/verify",
        search: "?token=old",
        hash: "#token=new",
      }).token,
    ).toBe("new");
  });

  test("keeps unrelated query parameters", () => {
    expect(
      extractLoginToken({
        pathname: "/auth/verify",
        search: "?token=old&next=%2Finbox",
        hash: "",
      }).cleanedUrl,
    ).toBe("/auth/verify?next=%2Finbox");
  });

  test("decodes percent-encoded tokens", () => {
    expect(
      extractLoginToken({ pathname: "/", search: "", hash: "#token=a%2Bb" })
        .token,
    ).toBe("a+b");
  });

  test.each([
    ["no token at all", "", ""],
    ["an empty fragment token", "", "#token="],
    ["an unrelated fragment", "", "#other=1"],
    ["an empty query token", "?token=", ""],
  ])("returns null for %s", (_label, search, hash) => {
    expect(
      extractLoginToken({ pathname: "/auth/verify", search, hash }).token,
    ).toBeNull();
  });
});
