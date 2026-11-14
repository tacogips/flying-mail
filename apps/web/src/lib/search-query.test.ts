import { describe, expect, test } from "vitest";
import type { TagView } from "../api/schema-types";
import {
  parseSearchQuery,
  searchToFilterVariables,
  tokenizeSearchQuery,
} from "./search-query";

const tag = (id: string, name: string): TagView => ({
  id,
  name,
  color: null,
  kind: "USER",
  systemSlug: null,
  messageCount: 0,
});

describe("tokenizeSearchQuery", () => {
  test("splits on whitespace", () => {
    expect(tokenizeSearchQuery("hello world")).toEqual(["hello", "world"]);
  });

  test("keeps a quoted operator value together", () => {
    expect(tokenizeSearchQuery('tag:"Project Alpha" report')).toEqual([
      'tag:"Project Alpha"',
      "report",
    ]);
  });

  test("keeps quoted free text together", () => {
    expect(tokenizeSearchQuery('"exact phrase" other')).toEqual([
      '"exact phrase"',
      "other",
    ]);
  });

  test("returns nothing for a blank query", () => {
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });
});

describe("parseSearchQuery", () => {
  test("plain text is free text", () => {
    const parsed = parseSearchQuery("quarterly report");
    expect(parsed.text).toBe("quarterly report");
    expect(parsed.from).toBeNull();
    expect(parsed.hasAttachment).toBeNull();
  });

  test("extracts every operator", () => {
    const parsed = parseSearchQuery(
      "from:alice@x.com to:support@y.com cc:copied@y.com has:attachment kind:pdf tag:Invoices is:unread in:spam refund",
    );
    expect(parsed.from).toBe("alice@x.com");
    expect(parsed.toAddress).toBe("support@y.com");
    expect(parsed.recipientAddress).toBe("copied@y.com");
    expect(parsed.hasAttachment).toBe(true);
    expect(parsed.attachmentKinds).toEqual(["PDF"]);
    expect(parsed.tagNames).toEqual(["Invoices"]);
    expect(parsed.unreadOnly).toBe(true);
    expect(parsed.includeSpam).toBe(true);
    expect(parsed.text).toBe("refund");
  });

  test("no:attachment filters for messages without attachments", () => {
    expect(parseSearchQuery("no:attachment").hasAttachment).toBe(false);
  });

  test("kind accepts a comma list and is case-insensitive", () => {
    expect(parseSearchQuery("kind:pdf,IMAGE").attachmentKinds).toEqual([
      "PDF",
      "IMAGE",
    ]);
  });

  test("an unknown kind falls back to free text rather than erroring", () => {
    const parsed = parseSearchQuery("kind:nonsense hello");
    expect(parsed.attachmentKinds).toEqual([]);
    expect(parsed.text).toBe("kind:nonsense hello");
  });

  test("recipient: is an alias for cc:", () => {
    expect(parseSearchQuery("recipient:a@x.com").recipientAddress).toBe(
      "a@x.com",
    );
  });

  test("a quoted tag name keeps its spaces", () => {
    expect(parseSearchQuery('tag:"Project Alpha"').tagNames).toEqual([
      "Project Alpha",
    ]);
  });

  test("ordinary text containing a colon stays searchable", () => {
    // A URL or a time must not be swallowed as an unknown operator.
    const parsed = parseSearchQuery("meeting 10:30 https://example.com/x");
    expect(parsed.text).toContain("10:30");
    expect(parsed.text).toContain("https://example.com/x");
  });
});

describe("searchToFilterVariables", () => {
  const tags = [tag("t1", "Invoices"), tag("t2", "Project Alpha")];

  test("maps a full query onto filter variables", () => {
    const variables = searchToFilterVariables(
      parseSearchQuery(
        "from:alice@x.com cc:copied@y.com has:attachment kind:pdf tag:invoices is:unread refund",
      ),
      tags,
    );
    expect(variables).toEqual({
      search: "refund",
      fromAddress: "alice@x.com",
      recipientAddress: "copied@y.com",
      hasAttachment: true,
      attachmentKinds: ["PDF"],
      tagIds: ["t1"],
      unreadOnly: true,
    });
  });

  test("tag names resolve case-insensitively", () => {
    const variables = searchToFilterVariables(
      parseSearchQuery('tag:"project alpha"'),
      tags,
    );
    expect(variables.tagIds).toEqual(["t2"]);
  });

  test("an unresolved tag name folds back into free text", () => {
    // Filtering on a tag that does not exist would silently return
    // everything or nothing; searching for the name is explainable.
    const variables = searchToFilterVariables(
      parseSearchQuery("tag:nonexistent report"),
      tags,
    );
    expect(variables.tagIds).toBeUndefined();
    expect(variables.search).toBe("report nonexistent");
  });

  test("an empty query maps to no variables", () => {
    expect(searchToFilterVariables(parseSearchQuery(""), tags)).toEqual({});
  });
});
