import { describe, expect, test } from "vitest";
import type { ApiKeyScopeView, MailboxAddressView } from "../api/schema-types";
import {
  formatMailbox,
  formatRecipients,
  shortMailbox,
} from "./address-format";
import { avatarClass, avatarInitial } from "./avatar";
import {
  searchParamsToView,
  viewTitle,
  viewToFilter,
  viewToSearchParams,
} from "./filter-params";
import { describeErrors, hasCode } from "./mutation-error";
import {
  formatAbsoluteTime,
  formatBytes,
  formatListTime,
  formatRelativeTime,
} from "./relative-time";
import {
  formatScope,
  isGlobalCapability,
  isValidAddressPattern,
} from "./scope-format";

const mailbox = (
  address: string,
  name: string | null = null,
  kind: MailboxAddressView["kind"] = "TO",
): MailboxAddressView => ({ address, name, kind });

describe("address formatting", () => {
  test("formatMailbox includes the display name when present", () => {
    expect(formatMailbox(mailbox("a@x.com", "Alice"))).toBe("Alice <a@x.com>");
    expect(formatMailbox(mailbox("a@x.com"))).toBe("a@x.com");
    expect(formatMailbox(mailbox("a@x.com", ""))).toBe("a@x.com");
  });

  test("shortMailbox prefers the name, else the local part", () => {
    expect(shortMailbox(mailbox("a@x.com", "Alice"))).toBe("Alice");
    expect(shortMailbox(mailbox("alice@x.com"))).toBe("alice");
    expect(shortMailbox(mailbox("broken"))).toBe("broken");
  });

  test("formatRecipients truncates a long list", () => {
    const many = ["a", "b", "c", "d", "e"].map((letter) =>
      mailbox(`${letter}@x.com`),
    );
    expect(formatRecipients(many, 2)).toBe("a@x.com, b@x.com +3 more");
    expect(formatRecipients([])).toBe("");
  });
});

describe("time and size formatting", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");

  test.each([
    ["2026-08-23T11:59:30.000Z", "just now"],
    ["2026-08-23T11:30:00.000Z", "30m ago"],
    ["2026-08-23T06:00:00.000Z", "6h ago"],
    ["2026-08-21T12:00:00.000Z", "2d ago"],
    ["2026-08-01T12:00:00.000Z", "2026-08-01"],
  ])("formatRelativeTime(%j) is %j", (iso, expected) => {
    expect(formatRelativeTime(iso, now)).toBe(expected);
  });

  test("an unparseable timestamp yields an empty label", () => {
    expect(formatRelativeTime("nonsense", now)).toBe("");
  });

  test("formatAbsoluteTime passes an unparseable value through", () => {
    expect(formatAbsoluteTime("nonsense")).toBe("nonsense");
  });

  test.each([
    [0, "0 B"],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [-1, ""],
  ])("formatBytes(%i) is %j", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  test("formatListTime renders a bare time for the same calendar day", () => {
    const then = new Date("2026-08-23T09:00:00.000Z");
    expect(formatListTime(then.toISOString(), now)).toBe(
      then.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  test("formatListTime says Yesterday for the previous calendar day", () => {
    const then = new Date("2026-08-22T12:00:00.000Z");
    expect(formatListTime(then.toISOString(), now)).toBe("Yesterday");
  });

  test("formatListTime omits the year within the current year", () => {
    const then = new Date("2026-01-01T12:00:00.000Z");
    expect(formatListTime(then.toISOString(), now)).toBe(
      then.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });

  test("formatListTime includes the year across a year boundary", () => {
    const then = new Date("2020-01-01T12:00:00.000Z");
    expect(formatListTime(then.toISOString(), now)).toBe(
      then.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    );
  });

  test("formatListTime yields an empty label for an unparseable timestamp", () => {
    expect(formatListTime("nonsense", now)).toBe("");
  });
});

describe("avatar helpers", () => {
  test("avatarInitial uppercases the first code point", () => {
    expect(avatarInitial("alice")).toBe("A");
    expect(avatarInitial("  bob")).toBe("B");
  });

  test("avatarInitial keeps a non-ASCII character whole", () => {
    expect(avatarInitial("たろう")).toBe("た");
  });

  test("avatarInitial falls back to a placeholder for an empty label", () => {
    expect(avatarInitial("")).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
  });

  test("avatarClass is deterministic for the same seed", () => {
    expect(avatarClass("alice@example.com")).toBe(
      avatarClass("alice@example.com"),
    );
  });

  test("avatarClass handles a non-ASCII seed", () => {
    expect(avatarClass("たろう@example.com")).toMatch(/^avatar-c[0-7]$/);
  });
});

describe("mailbox views", () => {
  test("inbox and sent filter by direction", () => {
    expect(viewToFilter({ folder: { kind: "INBOX" }, scope: {} })).toEqual({
      direction: "INBOUND",
    });
    // Sent restricts to dispatched mail so drafts do not appear there.
    expect(viewToFilter({ folder: { kind: "SENT" }, scope: {} })).toEqual({
      direction: "OUTBOUND",
      statuses: ["SENT"],
    });
  });

  test("the drafts view filters on status", () => {
    expect(viewToFilter({ folder: { kind: "DRAFTS" }, scope: {} })).toEqual({
      statuses: ["DRAFT"],
    });
  });

  test("the spam view restricts to the verdict table", () => {
    expect(viewToFilter({ folder: { kind: "SPAM" }, scope: {} })).toEqual({
      spamOnly: true,
    });
  });

  test("system tag views filter on their slug", () => {
    expect(viewToFilter({ folder: { kind: "STARRED" }, scope: {} })).toEqual({
      systemSlugs: ["STARRED"],
    });
  });

  test("tag views map to their filters", () => {
    expect(
      viewToFilter({
        folder: { kind: "TAG", tagId: "tag-1", name: "Invoices" },
        scope: {},
      }),
    ).toEqual({ tagIds: ["tag-1"] });
  });

  test("search spans spam too, since a reader searching wants everything", () => {
    expect(
      viewToFilter({ folder: { kind: "SEARCH", query: "invoice" }, scope: {} }),
    ).toEqual({ search: "invoice", includeSpam: true });
  });

  test("search views parse the operator syntax", () => {
    expect(
      viewToFilter({
        folder: {
          kind: "SEARCH",
          query: "from:a@x.com has:attachment kind:pdf refund",
        },
        scope: {},
      }),
    ).toEqual({
      includeSpam: true,
      search: "refund",
      fromAddress: "a@x.com",
      hasAttachment: true,
      attachmentKinds: ["PDF"],
    });
  });

  test.each([
    [{ folder: { kind: "INBOX" as const }, scope: {} }],
    [{ folder: { kind: "SENT" as const }, scope: { domainId: "d1" } }],
    [{ folder: { kind: "SPAM" as const }, scope: { address: "a@x.com" } }],
    [
      {
        folder: { kind: "TAG" as const, tagId: "tag-1", name: "Invoices" },
        scope: { domainId: "d1", address: "a@x.com" },
      },
    ],
    [{ folder: { kind: "SEARCH" as const, query: "invoice" }, scope: {} }],
  ])("round-trips %o through search params", (view) => {
    expect(searchParamsToView(viewToSearchParams(view))).toEqual(view);
  });

  test("an unrecognized or incomplete param set falls back to the inbox", () => {
    expect(searchParamsToView(new URLSearchParams())).toEqual({
      folder: { kind: "INBOX" },
      scope: {},
    });
    expect(searchParamsToView(new URLSearchParams("view=NONSENSE"))).toEqual({
      folder: { kind: "INBOX" },
      scope: {},
    });
    // `view=TAG` with no tag id would otherwise render an empty list.
    expect(searchParamsToView(new URLSearchParams("view=TAG"))).toEqual({
      folder: { kind: "INBOX" },
      scope: {},
    });
    expect(
      searchParamsToView(new URLSearchParams("view=ADDRESS&address=x")),
    ).toEqual({ folder: { kind: "INBOX" }, scope: { address: "x" } });
  });

  test("titles are human-readable", () => {
    expect(viewTitle({ folder: { kind: "INBOX" }, scope: {} })).toBe("Inbox");
    expect(
      viewTitle({ folder: { kind: "SEARCH", query: "invoice" }, scope: {} }),
    ).toBe("Search: invoice");
  });
});

describe("scope formatting", () => {
  const scope = (
    overrides: Partial<ApiKeyScopeView> = {},
  ): ApiKeyScopeView => ({
    id: "scope-1",
    capability: "MAIL_READ",
    domain: { id: "dom-1", name: "example.com" },
    addressPattern: "support@example.com",
    ...overrides,
  });

  test("describes a per-address scope", () => {
    expect(formatScope(scope())).toBe(
      "Read mail on example.com, addresses matching support@example.com",
    );
  });

  test("describes a wildcard scope", () => {
    expect(formatScope(scope({ domain: null, addressPattern: "*" }))).toBe(
      "Read mail on every managed domain, every address",
    );
  });

  test("describes a global capability without domain noise", () => {
    expect(formatScope(scope({ capability: "KEY_ADMIN" }))).toContain(
      "instance-wide",
    );
  });

  test("identifies global capabilities", () => {
    expect(isGlobalCapability("KEY_ADMIN")).toBe(true);
    expect(isGlobalCapability("DOMAIN_ADMIN")).toBe(true);
    expect(isGlobalCapability("MAIL_READ")).toBe(false);
  });
});

describe("isValidAddressPattern", () => {
  test.each([
    "*",
    "*@example.com",
    "support@example.com",
    "support-*@example.com",
    "*-noreply@example.com",
  ])("accepts %j", (value) => {
    expect(isValidAddressPattern(value)).toBe(true);
  });

  test.each([
    "",
    "   ",
    "support",
    "a*b*c@example.com",
    "user@*.example.com",
    "user@*",
    "@example.com",
    "user@",
    "user@localhost",
  ])("rejects %j", (value) => {
    expect(isValidAddressPattern(value)).toBe(false);
  });
});

describe("describeErrors", () => {
  test.each([
    [
      "UNAUTHENTICATED" as const,
      "Your session has expired. Please sign in again.",
    ],
    ["FORBIDDEN" as const, "You do not have permission to do that."],
    [
      "SERVICE_UNAVAILABLE" as const,
      "Sending is not configured on this server yet.",
    ],
  ])("rewrites %s into reader-facing wording", (code, expected) => {
    expect(describeErrors([{ message: "raw", code }])).toBe(expected);
  });

  test("passes through an ordinary message", () => {
    expect(
      describeErrors([
        { message: "Subject is required", code: "BAD_USER_INPUT" },
      ]),
    ).toBe("Subject is required");
  });

  test("has a fallback for an empty list", () => {
    expect(describeErrors([])).toBe("Something went wrong");
  });

  test("hasCode finds a specific code", () => {
    const errors = [{ message: "x", code: "CONFLICT" as const }];
    expect(hasCode(errors, "CONFLICT")).toBe(true);
    expect(hasCode(errors, "NOT_FOUND")).toBe(false);
  });
});
