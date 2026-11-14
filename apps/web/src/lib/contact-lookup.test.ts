import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ContactView } from "../api/contact-types";
import {
  clearContactLookupCache,
  lookupContactByEmail,
  lookupContactsByEmail,
} from "./contact-lookup";

function contact(id: string, displayName: string): ContactView {
  return {
    id,
    addressBook: {
      id: "book-1",
      name: "Contacts",
      mailAddress: { id: "addr-1", address: "support@example.com" },
    },
    uid: `${id}@mailcal`,
    displayName,
    givenName: null,
    familyName: null,
    nickname: null,
    organization: null,
    title: null,
    emails: [{ address: "ada@example.com", label: null }],
    phones: [],
    postalAddresses: [],
    urls: [],
    note: null,
    birthday: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function stubGraphQL(handler: (email: string) => readonly ContactView[]): {
  readonly calls: string[];
} {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      variables?: { email?: string };
    };
    const email = body.variables?.email ?? "";
    calls.push(email);
    return new Response(
      JSON.stringify({ data: { contactsByEmail: handler(email) } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { calls };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearContactLookupCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupContactsByEmail", () => {
  test("normalizes the address before querying", async () => {
    const { calls } = stubGraphQL((email) =>
      email === "ada@example.com" ? [contact("c1", "Ada")] : [],
    );
    const found = await lookupContactsByEmail("  Ada@Example.com  ");
    expect(found).toHaveLength(1);
    expect(calls).toEqual(["ada@example.com"]);
  });

  test("an unknown address resolves to an empty list, not a rejection", async () => {
    stubGraphQL(() => []);
    await expect(lookupContactsByEmail("nobody@example.com")).resolves.toEqual(
      [],
    );
  });

  test("a network failure resolves to an empty list", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    await expect(lookupContactsByEmail("ada@example.com")).resolves.toEqual([]);
  });

  test("a second lookup within the TTL does not re-query", async () => {
    const { calls } = stubGraphQL(() => [contact("c1", "Ada")]);
    await lookupContactsByEmail("ada@example.com");
    await lookupContactsByEmail("ada@example.com");
    expect(calls).toHaveLength(1);
  });

  test("concurrent lookups for the same address share one request", async () => {
    const { calls } = stubGraphQL(() => [contact("c1", "Ada")]);
    const [a, b] = await Promise.all([
      lookupContactsByEmail("ada@example.com"),
      lookupContactsByEmail("ada@example.com"),
    ]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });
});

describe("lookupContactByEmail", () => {
  test("returns the first match", async () => {
    stubGraphQL(() => [contact("c1", "Ada"), contact("c2", "Bea")]);
    const found = await lookupContactByEmail("ada@example.com");
    expect(found?.id).toBe("c1");
  });

  test("returns null on no match", async () => {
    stubGraphQL(() => []);
    expect(await lookupContactByEmail("nobody@example.com")).toBeNull();
  });
});
