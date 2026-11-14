import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createAttachmentId, createMessageId } from "../value-objects/ids";
import {
  AttachmentKind,
  buildAttachmentBlobKey,
  buildRawMessageBlobKey,
  classifyAttachmentKind,
  createAttachment,
  sanitizeFileName,
} from "./attachment";

describe("sanitizeFileName", () => {
  test.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32", "system32"],
    ["report.pdf", "report.pdf"],
    ["  spaced.txt  ", "spaced.txt"],
    [".hidden", "hidden"],
    ["a/b/c.txt", "c.txt"],
    ["with:colon*and?glob.txt", "with_colon_and_glob.txt"],
    ["", "attachment"],
    ["...", "attachment"],
    ["///", "attachment"],
  ])("sanitizes %j to %j", (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  test("strips control characters", () => {
    expect(sanitizeFileName(`bad${String.fromCharCode(1)}name.txt`)).toBe(
      "bad_name.txt",
    );
  });

  test("truncates an over-long name", () => {
    expect(sanitizeFileName("a".repeat(400))).toHaveLength(255);
  });
});

describe("blob keys", () => {
  test("attachment key embeds the id and a sanitized name", () => {
    expect(
      buildAttachmentBlobKey(createAttachmentId("att-1"), "../secret.txt"),
    ).toBe("att/att-1/secret.txt");
  });

  test("raw message key", () => {
    expect(buildRawMessageBlobKey(createMessageId("msg-1"))).toBe(
      "raw/msg-1.eml",
    );
  });
});

describe("createAttachment", () => {
  const input = {
    id: createAttachmentId("att-1"),
    messageId: createMessageId("msg-1"),
    fileName: "../evil.pdf",
    contentType: "application/pdf",
    size: 1024,
    blobKey: "att/att-1/evil.pdf",
    contentId: null,
    inline: false,
    createdAt: "2026-08-23T00:00:00.000Z",
  };

  test("stores the sanitized file name", () => {
    expect(createAttachment(input).fileName).toBe("evil.pdf");
  });

  test.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s size", (_name, size) => {
    expect(() => createAttachment({ ...input, size })).toThrow(ValidationError);
  });

  test("rejects a blank content type", () => {
    expect(() => createAttachment({ ...input, contentType: "  " })).toThrow(
      ValidationError,
    );
  });
});

describe("classifyAttachmentKind", () => {
  test.each([
    // Content type decides when it is specific.
    ["image/png", "photo.png", "IMAGE"],
    ["image/svg+xml", "logo.svg", "IMAGE"],
    ["video/mp4", "clip.mp4", "VIDEO"],
    ["audio/mpeg", "song.mp3", "AUDIO"],
    ["application/pdf", "report.pdf", "PDF"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "doc.docx",
      "DOCUMENT",
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "sheet.xlsx",
      "SPREADSHEET",
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "slides.pptx",
      "PRESENTATION",
    ],
    ["application/zip", "bundle.zip", "ARCHIVE"],
    ["text/calendar", "invite.ics", "CALENDAR"],
    ["text/plain", "notes.txt", "TEXT"],
    // A charset parameter must not defeat the exact-type match.
    ["text/csv; charset=utf-8", "data.csv", "SPREADSHEET"],
  ])("classifies %s / %s as %s", (contentType, fileName, expected) => {
    expect(classifyAttachmentKind(contentType, fileName)).toBe(expected);
  });

  test.each([
    // The depressingly common octet-stream label: extension decides.
    ["application/octet-stream", "photo.jpeg", "IMAGE"],
    ["application/octet-stream", "report.pdf", "PDF"],
    ["application/octet-stream", "archive.7z", "ARCHIVE"],
    ["application/octet-stream", "notes.md", "TEXT"],
    ["", "clip.mov", "VIDEO"],
  ])(
    "falls back to the extension for %s / %s -> %s",
    (contentType, fileName, expected) => {
      expect(classifyAttachmentKind(contentType, fileName)).toBe(expected);
    },
  );

  test("a csv served as text/plain still lands in SPREADSHEET", () => {
    expect(classifyAttachmentKind("text/plain", "report.csv")).toBe(
      "SPREADSHEET",
    );
  });

  test.each([
    ["application/octet-stream", null],
    ["application/octet-stream", "no-extension"],
    ["application/octet-stream", "trailing-dot."],
    ["application/x-something-odd", "mystery.xyz"],
  ])("gives up to OTHER for %s / %s", (contentType, fileName) => {
    expect(classifyAttachmentKind(contentType, fileName)).toBe("OTHER");
  });

  test("createAttachment derives the kind at construction", () => {
    const attachment = createAttachment({
      id: createAttachmentId("att-k"),
      messageId: createMessageId("msg-1"),
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      size: 10,
      blobKey: "att/att-k/invoice.pdf",
      contentId: null,
      inline: false,
      createdAt: "2026-08-23T00:00:00.000Z",
    });
    expect(attachment.kind).toBe("PDF");
  });

  test("an explicitly stored kind wins over re-derivation", () => {
    // Round-tripping a row from the database must preserve the kind that
    // was decided at receive time, even if the rules have since changed.
    const attachment = createAttachment({
      id: createAttachmentId("att-k2"),
      messageId: createMessageId("msg-1"),
      fileName: "invoice.pdf",
      contentType: "application/pdf",
      size: 10,
      blobKey: "att/att-k2/invoice.pdf",
      contentId: null,
      inline: false,
      kind: AttachmentKind.Other,
      createdAt: "2026-08-23T00:00:00.000Z",
    });
    expect(attachment.kind).toBe("OTHER");
  });
});
