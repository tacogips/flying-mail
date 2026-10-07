import { describe, expect, test } from "vitest";
import {
  fullSearchParamsForView,
  searchParamsToView,
  viewToFilter,
  viewToSearchParams,
  viewTitle,
} from "./filter-params";

describe("mailbox folder and scope filters", () => {
  test("applies a domain scope to inbox", () => {
    expect(
      viewToFilter({ folder: { kind: "INBOX" }, scope: { domainId: "d1" } }),
    ).toEqual({ direction: "INBOUND", domainId: "d1" });
  });

  test("maps an inbox mailbox scope to toAddress", () => {
    expect(
      viewToFilter({ folder: { kind: "INBOX" }, scope: { address: "a@T" } })
        .toAddress,
    ).toBe("a@T");
  });

  test("maps sent mailbox scope to fromAddress and excludes drafts", () => {
    expect(
      viewToFilter({ folder: { kind: "SENT" }, scope: { address: "a@T" } }),
    ).toEqual({
      direction: "OUTBOUND",
      statuses: ["SENT"],
      fromAddress: "a@T",
    });
  });

  test("keeps drafts filtered by their status", () => {
    expect(viewToFilter({ folder: { kind: "DRAFTS" }, scope: {} })).toEqual({
      statuses: ["DRAFT"],
    });
  });

  test("combines the trash system tag with a domain scope", () => {
    expect(
      viewToFilter({ folder: { kind: "TRASH" }, scope: { domainId: "d1" } }),
    ).toEqual({ systemSlugs: ["TRASH"], domainId: "d1" });
  });
});

describe("mailbox folder and scope URLs", () => {
  test("clears mailbox scope keys when moving from a domain to all mail", () => {
    expect(
      fullSearchParamsForView({ folder: { kind: "INBOX" }, scope: {} }),
    ).toEqual({
      view: "INBOX",
      domain: undefined,
      address: undefined,
      tag: undefined,
      name: undefined,
      q: undefined,
    });
  });

  test("clears an address when moving from a mailbox to its domain", () => {
    expect(
      fullSearchParamsForView({
        folder: { kind: "INBOX" },
        scope: { domainId: "d1" },
      }),
    ).toEqual({
      view: "INBOX",
      domain: "d1",
      address: undefined,
      tag: undefined,
      name: undefined,
      q: undefined,
    });
  });

  test("treats empty domain and address URL values as absent", () => {
    expect(
      searchParamsToView(new URLSearchParams("view=INBOX&domain=&address=")),
    ).toEqual({ folder: { kind: "INBOX" }, scope: {} });
  });
  test("round-trips tag folders with domain and address scopes", () => {
    const view = {
      folder: { kind: "TAG", tagId: "tag-1", name: "Invoices" },
      scope: { domainId: "d1", address: "billing@example.com" },
    } as const;
    expect(searchParamsToView(viewToSearchParams(view))).toEqual(view);
  });

  test("converts a legacy address view to an inbox mailbox scope", () => {
    expect(
      searchParamsToView(new URLSearchParams("view=ADDRESS&address=x")),
    ).toEqual({ folder: { kind: "INBOX" }, scope: { address: "x" } });
  });

  test("uses a known domain name when a scope has no mailbox address", () => {
    expect(
      viewTitle({ folder: { kind: "INBOX" }, scope: { domainId: "d1" } }, [
        {
          id: "d1",
          name: "example.com",
          status: "ACTIVE",
          inboundMx: "READY",
          catchAll: false,
          verificationToken: null,
          verifiedAt: null,
          messageCount: 0,
          dnsRecords: [],
        },
      ]),
    ).toBe("Inbox - example.com");
  });
});
