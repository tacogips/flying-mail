import type { BuildMimeInput } from "@mailcal/application/ports/mime";
import { describe, expect, test } from "vitest";
import { createMimeTextBuilder, HeaderInjectionError } from "./mime-builder";

const builder = createMimeTextBuilder();

function baseInput(overrides: Partial<BuildMimeInput> = {}): BuildMimeInput {
  return {
    from: { address: "support@example.com", name: "Support" },
    to: [{ address: "customer@other.com", name: null }],
    subject: "Re: your ticket",
    text: "Thanks for reaching out.",
    messageId: "msg-1@example.com",
    date: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("createMimeTextBuilder", () => {
  test("emits the core headers and a text body", () => {
    const raw = builder.build(baseInput());
    expect(raw).toContain("support@example.com");
    expect(raw).toContain("customer@other.com");
    expect(raw).toContain("Message-ID: <msg-1@example.com>");
    expect(raw).toContain("Date: ");
    expect(raw).toContain("Thanks for reaching out.");
  });

  test("includes both bodies when html is supplied", () => {
    const raw = builder.build(
      baseInput({ text: "plain", html: "<p>rich</p>" }),
    );
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");
  });

  test("emits threading headers when supplied", () => {
    const raw = builder.build(
      baseInput({
        inReplyTo: "parent@example.com",
        references: ["root@example.com", "parent@example.com"],
      }),
    );
    expect(raw).toContain("In-Reply-To: <parent@example.com>");
    expect(raw).toContain(
      "References: <root@example.com> <parent@example.com>",
    );
  });

  test("omits threading headers when absent", () => {
    const raw = builder.build(baseInput());
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).not.toContain("References");
  });

  test("includes cc recipients", () => {
    const raw = builder.build(
      baseInput({ cc: [{ address: "cc@other.com", name: null }] }),
    );
    expect(raw).toContain("cc@other.com");
  });

  test("emits a custom X- header", () => {
    const raw = builder.build(
      baseInput({ headers: new Map([["X-Campaign-Id", "abc-123"]]) }),
    );
    expect(raw).toContain("X-Campaign-Id: abc-123");
  });

  test.each([
    ["CR", "value\rBcc: attacker@evil.com"],
    ["LF", "value\nBcc: attacker@evil.com"],
    ["CRLF", "value\r\nBcc: attacker@evil.com"],
  ])("rejects a header value containing %s", (_label, value) => {
    // The builder is the last line of defence against header injection, so
    // it refuses even if a caller skipped the use-case-level validation.
    expect(() =>
      builder.build(baseInput({ headers: new Map([["X-Note", value]]) })),
    ).toThrow(HeaderInjectionError);
  });

  test("rejects a header name containing CRLF", () => {
    expect(() =>
      builder.build(
        baseInput({ headers: new Map([["X-Bad\r\nBcc", "value"]]) }),
      ),
    ).toThrow(HeaderInjectionError);
  });

  test("encodes an attachment as base64", () => {
    const raw = builder.build(
      baseInput({
        attachments: [
          {
            fileName: "report.txt",
            contentType: "text/plain",
            content: new TextEncoder().encode("Hello"),
            contentId: null,
            inline: false,
          },
        ],
      }),
    );
    expect(raw).toContain("report.txt");
    expect(raw).toContain("base64");
    expect(raw).toContain("SGVsbG8=");
  });

  test("marks an inline attachment with its Content-ID", () => {
    const raw = builder.build(
      baseInput({
        html: '<img src="cid:logo@example.com">',
        attachments: [
          {
            fileName: "logo.png",
            contentType: "image/png",
            content: new Uint8Array([1, 2, 3]),
            contentId: "logo@example.com",
            inline: true,
          },
        ],
      }),
    );
    expect(raw).toContain("logo@example.com");
  });
});
