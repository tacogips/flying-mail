import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createDomainId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import {
  adminViewer,
  apiKeyViewer,
  buildMailPermissions,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import { hasAnyMailRead } from "./authorization";

const domainId = createDomainId("dom-read");

describe("hasAnyMailRead", () => {
  test("an ADMIN can read mail", () => {
    expect(hasAnyMailRead(adminViewer())).toBe(true);
  });

  test("a MEMBER without an ALLOW rule cannot read mail", () => {
    expect(hasAnyMailRead(memberViewer())).toBe(false);
  });

  test("a VIEWER with an ALLOW rule can read mail", () => {
    const viewer = viewerViewer(
      "usr-reader",
      buildMailPermissions(createUserId("usr-reader"), [
        { effect: "ALLOW", domainId },
      ]),
    );
    expect(hasAnyMailRead(viewer)).toBe(true);
  });

  test("an API key with only MAIL_SEND cannot read mail", () => {
    expect(
      hasAnyMailRead(apiKeyViewer([{ capability: Capability.MailSend }])),
    ).toBe(false);
  });

  test("an API key with MAIL_READ can read mail", () => {
    expect(
      hasAnyMailRead(apiKeyViewer([{ capability: Capability.MailRead }])),
    ).toBe(true);
  });
});
