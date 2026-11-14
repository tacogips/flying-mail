import { describe, expect, test } from "vitest";
import {
  createPostalMimeParser,
  normalizeMessageId,
  splitReferences,
} from "./postal-mime-parser";

const parser = createPostalMimeParser();

function eml(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\r\n"));
}

describe("normalizeMessageId", () => {
  test.each([
    ["<abc@example.com>", "abc@example.com"],
    ["  <abc@example.com>  ", "abc@example.com"],
    ["abc@example.com", "abc@example.com"],
  ])("strips the brackets from %j", (input, expected) => {
    expect(normalizeMessageId(input)).toBe(expected);
  });

  test.each([undefined, "", "  ", "<>"])("returns null for %j", (input) => {
    expect(normalizeMessageId(input)).toBeNull();
  });
});

describe("splitReferences", () => {
  test("splits a whitespace-separated header", () => {
    expect(splitReferences("<a@x.com> <b@x.com>\r\n <c@x.com>")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });

  test("returns an empty array for an absent header", () => {
    expect(splitReferences(undefined)).toEqual([]);
  });
});

describe("createPostalMimeParser", () => {
  test("parses a plain text message", async () => {
    const parsed = await parser.parse(
      eml([
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.net>",
        "Subject: Hello there",
        "Message-ID: <plain-1@example.com>",
        "Date: Sun, 23 Aug 2026 00:00:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hello, this is the body.",
        "",
      ]),
    );

    expect(parsed.from).toEqual({
      address: "alice@example.com",
      name: "Alice",
    });
    expect(parsed.to).toEqual([{ address: "bob@example.net", name: "Bob" }]);
    expect(parsed.subject).toBe("Hello there");
    expect(parsed.messageId).toBe("plain-1@example.com");
    expect(parsed.text?.trim()).toBe("Hello, this is the body.");
    expect(parsed.attachments).toEqual([]);
  });

  test("parses threading headers with brackets stripped", async () => {
    const parsed = await parser.parse(
      eml([
        "From: alice@example.com",
        "To: bob@example.net",
        "Subject: Re: Hello",
        "Message-ID: <reply-1@example.com>",
        "In-Reply-To: <plain-1@example.com>",
        "References: <root@example.com> <plain-1@example.com>",
        "",
        "A reply.",
        "",
      ]),
    );

    expect(parsed.inReplyTo).toBe("plain-1@example.com");
    expect(parsed.references).toEqual([
      "root@example.com",
      "plain-1@example.com",
    ]);
  });

  test("parses a multipart/alternative message into both bodies", async () => {
    const parsed = await parser.parse(
      eml([
        "From: alice@example.com",
        "To: bob@example.net",
        "Subject: Both bodies",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "plain version",
        "--b1",
        "Content-Type: text/html",
        "",
        "<p>html version</p>",
        "--b1--",
        "",
      ]),
    );

    expect(parsed.text?.trim()).toBe("plain version");
    expect(parsed.html).toContain("html version");
  });

  test("parses an attachment into bytes", async () => {
    const parsed = await parser.parse(
      eml([
        "From: alice@example.com",
        "To: bob@example.net",
        "Subject: With attachment",
        'Content-Type: multipart/mixed; boundary="b2"',
        "",
        "--b2",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b2",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "SGVsbG8=",
        "--b2--",
        "",
      ]),
    );

    expect(parsed.attachments).toHaveLength(1);
    const attachment = parsed.attachments[0];
    expect(attachment?.fileName).toBe("report.pdf");
    expect(attachment?.contentType).toBe("application/pdf");
    expect(attachment?.inline).toBe(false);
    expect(new TextDecoder().decode(attachment?.content)).toBe("Hello");
  });

  test("marks a cid-referenced part as inline", async () => {
    const parsed = await parser.parse(
      eml([
        "From: alice@example.com",
        "To: bob@example.net",
        "Subject: Inline image",
        'Content-Type: multipart/related; boundary="b3"',
        "",
        "--b3",
        "Content-Type: text/html",
        "",
        '<p><img src="cid:logo@example.com"></p>',
        "--b3",
        "Content-Type: image/png",
        "Content-ID: <logo@example.com>",
        "Content-Transfer-Encoding: base64",
        "",
        "iVBORw0KGgo=",
        "--b3--",
        "",
      ]),
    );

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.inline).toBe(true);
    expect(parsed.attachments[0]?.contentId).toBe("logo@example.com");
  });

  test("flattens group address syntax to its members", async () => {
    const parsed = await parser.parse(
      eml([
        "From: alice@example.com",
        "To: Team: bob@example.net, carol@example.net;",
        "Subject: Group",
        "",
        "body",
        "",
      ]),
    );

    expect(parsed.to.map((entry) => entry.address)).toEqual([
      "bob@example.net",
      "carol@example.net",
    ]);
  });

  test("decodes encoded-word and folded headers", async () => {
    const parsed = await parser.parse(
      eml([
        "From: alice@example.com",
        "To: bob@example.net",
        "Subject: =?utf-8?B?44GT44KT44Gr44Gh44Gv?=",
        "X-Long-Header: first part",
        " continued on the next line",
        "",
        "body",
        "",
      ]),
    );

    expect(parsed.subject).toBe("こんにちは");
    expect(parsed.headers.get("x-long-header")).toContain("continued");
  });

  test("lower-cases header keys and joins repeated headers", async () => {
    const parsed = await parser.parse(
      eml([
        "From: alice@example.com",
        "To: bob@example.net",
        "Subject: Repeated",
        "Authentication-Results: mx1; spf=pass",
        "Authentication-Results: mx2; dkim=fail",
        "",
        "body",
        "",
      ]),
    );

    const results = parsed.headers.get("authentication-results");
    expect(results).toContain("spf=pass");
    expect(results).toContain("dkim=fail");
  });

  test("accepts a ReadableStream source", async () => {
    const bytes = eml([
      "From: alice@example.com",
      "To: bob@example.net",
      "Subject: Streamed",
      "",
      "body",
      "",
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const parsed = await parser.parse(stream);
    expect(parsed.subject).toBe("Streamed");
  });

  test("yields nulls rather than throwing for a headerless body", async () => {
    const parsed = await parser.parse(new TextEncoder().encode("just text"));
    expect(parsed.from).toBeNull();
    expect(parsed.messageId).toBeNull();
    expect(parsed.attachments).toEqual([]);
  });
});
