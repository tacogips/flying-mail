import { describe, expect, test } from "vitest";
import { getMailLimits } from "./mail-limits";

describe("getMailLimits", () => {
  test("returns the attachment and outbound limits", () => {
    expect(getMailLimits()).toEqual({
      maxAttachmentBytes: 5 * 1024 * 1024,
      maxOutboundTotalBytes: 5 * 1024 * 1024,
      maxAttachmentsPerMessage: 32,
      maxRecipientsPerMessage: 50,
    });
  });
});
