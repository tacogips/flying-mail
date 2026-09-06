import { describe, expect, test } from "vitest";
import { resolveHref } from "./url";

describe("resolveHref", () => {
  test.each([
    [
      "https://contacts.example/address-books/work/contact.vcf",
      "https://contacts.example/address-books/work/",
      "https://contacts.example/address-books/work/contact.vcf",
    ],
    [
      "/address-books/work/contact.vcf",
      "https://contacts.example/principal/",
      "https://contacts.example/address-books/work/contact.vcf",
    ],
    [
      "contact.vcf",
      "https://contacts.example/address-books/work/",
      "https://contacts.example/address-books/work/contact.vcf",
    ],
  ])("resolves %s against %s", (href, baseUrl, expected) => {
    expect(resolveHref(href, baseUrl)).toBe(expected);
  });

  test("returns an invalid href unchanged", () => {
    expect(resolveHref("http://[", "not a URL")).toBe("http://[");
  });
});
