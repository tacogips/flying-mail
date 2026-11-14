import { describe, expect, test } from "vitest";
import type {
  ApiKeyScopeView,
  MailboxAddressView,
  MessageDetailView,
} from "../api/schema-types";
import {
  buildReplyRecipients,
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
  forwardBody,
  forwardSubject,
  quoteBody,
  replySubject,
} from "./quote-reply";
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

describe("buildReplyRecipients", () => {
  const from = mailbox("sender@other.com");
  const recipients = [
    mailbox("support@example.com", null, "ENVELOPE"),
    mailbox("someone@other.com", null, "TO"),
    mailbox("cc@other.com", null, "CC"),
    mailbox("secret@other.com", null, "BCC"),
  ];

  test("a plain reply goes only to the sender", () => {
    expect(
      buildReplyRecipients({
        from,
        recipients,
        replyAll: false,
        selfAddress: "support@example.com",
      }),
    ).toEqual({ to: ["sender@other.com"], cc: [] });
  });

  test("reply-all excludes the reader's own mailbox and any Bcc", () => {
    const result = buildReplyRecipients({
      from,
      recipients,
      replyAll: true,
      selfAddress: "support@example.com",
    });
    expect(result.to).toEqual(["sender@other.com"]);
    expect(result.cc).toEqual(["someone@other.com", "cc@other.com"]);
    expect(result.cc).not.toContain("support@example.com");
    expect(result.cc).not.toContain("secret@other.com");
  });

  test("reply-all never duplicates the sender", () => {
    const result = buildReplyRecipients({
      from,
      recipients: [...recipients, mailbox("sender@other.com", null, "TO")],
      replyAll: true,
      selfAddress: null,
    });
    expect(result.cc).not.toContain("sender@other.com");
  });
});

describe("subjects and quoting", () => {
  test.each([
    ["Hello", "Re: Hello"],
    ["Re: Hello", "Re: Hello"],
    ["re: Hello", "re: Hello"],
    ["  Hello  ", "Re: Hello"],
  ])("replySubject(%j) is %j", (input, expected) => {
    expect(replySubject(input)).toBe(expected);
  });

  test.each([
    ["Hello", "Fwd: Hello"],
    ["Fwd: Hello", "Fwd: Hello"],
    ["Fw: Hello", "Fw: Hello"],
  ])("forwardSubject(%j) is %j", (input, expected) => {
    expect(forwardSubject(input)).toBe(expected);
  });

  test("quoteBody prefixes each line and attributes the sender", () => {
    const message = {
      occurredAt: "2026-08-23T00:00:00.000Z",
      from: mailbox("a@x.com", "Alice"),
      textBody: "line one\nline two",
      snippet: "line one line two",
    } as MessageDetailView;
    const quoted = quoteBody(message);
    expect(quoted).toContain("Alice <a@x.com> wrote:");
    expect(quoted).toContain("> line one");
    expect(quoted).toContain("> line two");
  });

  test("quoteBody falls back to the snippet rather than quoting markup", () => {
    const message = {
      occurredAt: "2026-08-23T00:00:00.000Z",
      from: mailbox("a@x.com"),
      textBody: null,
      snippet: "plain preview",
    } as MessageDetailView;
    expect(quoteBody(message)).toContain("> plain preview");
  });

  test("forwardBody includes the original headers and body", () => {
    const message = {
      occurredAt: "2026-08-23T00:00:00.000Z",
      from: mailbox("a@x.com", "Alice"),
      subject: "Quarterly numbers",
      recipients: [
        mailbox("me@example.com", null, "TO"),
        mailbox("cc@example.com", null, "CC"),
      ],
      textBody: "the full body",
      snippet: "preview",
    } as unknown as MessageDetailView;
    const forwarded = forwardBody(message);
    expect(forwarded).toContain("---------- Forwarded message ----------");
    expect(forwarded).toContain("From: Alice <a@x.com>");
    expect(forwarded).toContain("Subject: Quarterly numbers");
    expect(forwarded).toContain("To: me@example.com, cc@example.com");
    expect(forwarded).toContain("the full body");
  });

  test("forwardBody falls back to the snippet when there is no text body", () => {
    const message = {
      occurredAt: "2026-08-23T00:00:00.000Z",
      from: mailbox("a@x.com"),
      subject: "Hi",
      recipients: [],
      textBody: null,
      snippet: "plain preview",
    } as unknown as MessageDetailView;
    expect(forwardBody(message)).toContain("plain preview");
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
    expect(viewToFilter({ kind: "INBOX" })).toEqual({ direction: "INBOUND" });
    // Sent restricts to dispatched mail so drafts do not appear there.
    expect(viewToFilter({ kind: "SENT" })).toEqual({
      direction: "OUTBOUND",
      statuses: ["SENT"],
    });
  });

  test("the drafts view filters on status", () => {
    expect(viewToFilter({ kind: "DRAFTS" })).toEqual({ statuses: ["DRAFT"] });
  });

  test("the spam view restricts to the verdict table", () => {
    expect(viewToFilter({ kind: "SPAM" })).toEqual({ spamOnly: true });
  });

  test("system tag views filter on their slug", () => {
    expect(viewToFilter({ kind: "STARRED" })).toEqual({
      systemSlugs: ["STARRED"],
    });
  });

  test("address and tag views map to their filters", () => {
    expect(viewToFilter({ kind: "ADDRESS", address: "a@x.com" })).toEqual({
      toAddress: "a@x.com",
    });
    expect(
      viewToFilter({ kind: "TAG", tagId: "tag-1", name: "Invoices" }),
    ).toEqual({ tagIds: ["tag-1"] });
  });

  test("search spans spam too, since a reader searching wants everything", () => {
    expect(viewToFilter({ kind: "SEARCH", query: "invoice" })).toEqual({
      search: "invoice",
      includeSpam: true,
    });
  });

  test("search views parse the operator syntax", () => {
    expect(
      viewToFilter({
        kind: "SEARCH",
        query: "from:a@x.com has:attachment kind:pdf refund",
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
    [{ kind: "INBOX" as const }],
    [{ kind: "SENT" as const }],
    [{ kind: "SPAM" as const }],
    [{ kind: "ADDRESS" as const, address: "a@x.com" }],
    [{ kind: "TAG" as const, tagId: "tag-1", name: "Invoices" }],
    [{ kind: "SEARCH" as const, query: "invoice" }],
  ])("round-trips %o through search params", (view) => {
    expect(searchParamsToView(viewToSearchParams(view))).toEqual(view);
  });

  test("an unrecognized or incomplete param set falls back to the inbox", () => {
    expect(searchParamsToView(new URLSearchParams())).toEqual({
      kind: "INBOX",
    });
    expect(searchParamsToView(new URLSearchParams("view=NONSENSE"))).toEqual({
      kind: "INBOX",
    });
    // `view=TAG` with no tag id would otherwise render an empty list.
    expect(searchParamsToView(new URLSearchParams("view=TAG"))).toEqual({
      kind: "INBOX",
    });
  });

  test("titles are human-readable", () => {
    expect(viewTitle({ kind: "INBOX" })).toBe("Inbox");
    expect(viewTitle({ kind: "SEARCH", query: "invoice" })).toBe(
      "Search: invoice",
    );
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
