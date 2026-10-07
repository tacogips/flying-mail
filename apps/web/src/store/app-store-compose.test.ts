import { afterEach, describe, expect, test, vi } from "vitest";
import type { MessageView } from "../api/schema-types";
import { toSaveDraftOutcome } from "./app-store-compose";
import { activeToasts, clearToasts } from "../lib/toast";
import { createAppStore } from "./app-store";

const savedDraft: MessageView = {
  id: "draft-1",
  threadId: "thread-1",
  direction: "OUTBOUND",
  subject: "Forwarded report",
  snippet: "Please see attached",
  from: { address: "me@example.com", name: null, kind: "TO" },
  recipients: [],
  tags: [],
  attachments: [
    {
      id: "attachment-copy-1",
      fileName: "report.pdf",
      contentType: "application/pdf",
      size: 128,
      inline: false,
      kind: "PDF",
      contentId: null,
      url: "/api/attachments/attachment-copy-1",
    },
  ],
  isSpam: false,
  spam: null,
  spamScore: null,
  status: "DRAFT",
  deliveryStatus: "QUEUED",
  listId: null,
  isMailingList: false,
  deliveryError: null,
  readAt: null,
  fetchStatus: "NOT_FETCHED",
  occurredAt: "2026-10-07T00:00:00.000Z",
  domain: { id: "domain-1", name: "example.com" },
};

describe("toSaveDraftOutcome", () => {
  test("maps CONFLICT errors to conflict", () => {
    expect(
      toSaveDraftOutcome(
        {
          ok: false,
          errors: [{ code: "CONFLICT", message: "Draft already sent" }],
        },
        {},
      ),
    ).toEqual({ kind: "conflict" });
  });

  test("returns a saved draft with its attachment ids", () => {
    expect(
      toSaveDraftOutcome(
        {
          ok: true,
          data: { saveDraft: savedDraft },
        },
        {},
      ),
    ).toEqual({ kind: "saved", draft: savedDraft });
  });

  test("maps network errors to an error outcome", () => {
    expect(
      toSaveDraftOutcome(
        {
          ok: false,
          errors: [{ code: "UNKNOWN", message: "Network unavailable" }],
        },
        {},
      ),
    ).toEqual({ kind: "error", message: "Network unavailable" });
  });

  test("maps a missing draft to conflict only when updating a Draft", () => {
    expect(
      toSaveDraftOutcome(
        {
          ok: false,
          errors: [
            {
              code: "NOT_FOUND",
              entity: "Draft",
              message: "Draft not found: draft-1",
            },
          ],
        },
        { draftId: "draft-1" },
      ),
    ).toEqual({ kind: "conflict" });
  });

  test("recognizes the current server Draft not found message", () => {
    expect(
      toSaveDraftOutcome(
        {
          ok: false,
          errors: [
            {
              code: "NOT_FOUND",
              message: "Draft not found: draft-1",
            },
          ],
        },
        { draftId: "draft-1" },
      ),
    ).toEqual({ kind: "conflict" });
  });

  test.each([
    {
      label: "staged upload swept away",
      error: {
        code: "NOT_FOUND" as const,
        entity: "Attachment",
        message: "Attachment not found: attachment-1",
      },
      input: { draftId: "draft-1" },
    },
    {
      label: "forward source purged",
      error: {
        code: "NOT_FOUND" as const,
        entity: "Message",
        message: "Message not found: message-1",
      },
      input: { draftId: "draft-1" },
    },
    {
      label: "draft is not being updated",
      error: {
        code: "NOT_FOUND" as const,
        entity: "Draft",
        message: "Draft not found: draft-1",
      },
      input: {},
    },
  ])(
    "keeps NOT_FOUND for $label as a recoverable error",
    ({ error, input }) => {
      expect(toSaveDraftOutcome({ ok: false, errors: [error] }, input)).toEqual(
        { kind: "error", message: error.message },
      );
    },
  );

  test("maps draftId field metadata to conflict when updating a draft", () => {
    expect(
      toSaveDraftOutcome(
        {
          ok: false,
          errors: [
            {
              code: "NOT_FOUND",
              field: "draftId",
              message: "Draft not found",
            },
          ],
        },
        { draftId: "draft-1" },
      ),
    ).toEqual({ kind: "conflict" });
  });
});

describe("saveDraftDetailed toast behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearToasts();
  });

  test("silent autosave failures are represented without a toast", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "offline", extensions: { code: "UNKNOWN" } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const store = createAppStore();

    const outcome = await store.saveDraftDetailed(
      { from: "me@example.com" },
      { silent: true },
    );

    expect(outcome).toEqual({ kind: "error", message: "offline" });
    expect(activeToasts()).toEqual([]);
  });

  test("non-silent save failures still show an error toast", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "offline", extensions: { code: "UNKNOWN" } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const store = createAppStore();

    await store.saveDraftDetailed({ from: "me@example.com" });

    expect(activeToasts().map((toast) => toast.message)).toEqual(["offline"]);
  });
});
