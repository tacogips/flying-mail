import { describe, expect, test } from "vitest";
import { DomainNotVerifiedError, InvalidStateTransitionError } from "../errors";
import { createDomainName } from "../value-objects/domain-name";
import { createDomainId } from "../value-objects/ids";
import {
  assertCanSendMail,
  canReceiveMail,
  canSendMail,
  createMailDomain,
  DomainStatus,
  setMailDomainStatus,
  verifyMailDomain,
} from "./mail-domain";

const base = () =>
  createMailDomain({
    id: createDomainId("dom-1"),
    name: createDomainName("example.com"),
    catchAll: true,
    verificationToken: "token-abc",
    createdAt: "2026-08-23T00:00:00.000Z",
  });

describe("createMailDomain", () => {
  test("starts PENDING and unverified", () => {
    const domain = base();
    expect(domain.status).toBe(DomainStatus.Pending);
    expect(domain.verifiedAt).toBeNull();
    expect(domain.updatedAt).toBe(domain.createdAt);
  });

  test("neither receives nor sends while pending", () => {
    const domain = base();
    expect(canReceiveMail(domain)).toBe(false);
    expect(canSendMail(domain)).toBe(false);
  });
});

describe("verifyMailDomain", () => {
  test("activates and records the verification time", () => {
    const domain = verifyMailDomain(base(), "2026-08-23T01:00:00.000Z");
    expect(domain.status).toBe(DomainStatus.Active);
    expect(domain.verifiedAt).toBe("2026-08-23T01:00:00.000Z");
    expect(canReceiveMail(domain)).toBe(true);
    expect(canSendMail(domain)).toBe(true);
  });

  test("re-verifying keeps the original timestamp", () => {
    const first = verifyMailDomain(base(), "2026-08-23T01:00:00.000Z");
    const second = verifyMailDomain(first, "2026-08-24T01:00:00.000Z");
    expect(second.verifiedAt).toBe("2026-08-23T01:00:00.000Z");
    expect(second.updatedAt).toBe("2026-08-24T01:00:00.000Z");
  });
});

describe("setMailDomainStatus", () => {
  test("refuses to activate an unverified domain", () => {
    expect(() =>
      setMailDomainStatus(
        base(),
        DomainStatus.Active,
        "2026-08-23T02:00:00.000Z",
      ),
    ).toThrow(InvalidStateTransitionError);
  });

  test("disables a verified domain and stops receive and send", () => {
    const verified = verifyMailDomain(base(), "2026-08-23T01:00:00.000Z");
    const disabled = setMailDomainStatus(
      verified,
      DomainStatus.Disabled,
      "2026-08-23T02:00:00.000Z",
    );
    expect(disabled.status).toBe(DomainStatus.Disabled);
    expect(canReceiveMail(disabled)).toBe(false);
    expect(canSendMail(disabled)).toBe(false);
  });

  test("re-enabling a verified domain needs no re-verification", () => {
    const verified = verifyMailDomain(base(), "2026-08-23T01:00:00.000Z");
    const disabled = setMailDomainStatus(
      verified,
      DomainStatus.Disabled,
      "2026-08-23T02:00:00.000Z",
    );
    const reenabled = setMailDomainStatus(
      disabled,
      DomainStatus.Active,
      "2026-08-23T03:00:00.000Z",
    );
    expect(canSendMail(reenabled)).toBe(true);
  });
});

describe("assertCanSendMail", () => {
  test("throws for an unverified domain", () => {
    expect(() => assertCanSendMail(base())).toThrow(DomainNotVerifiedError);
  });

  test("passes for a verified active domain", () => {
    const verified = verifyMailDomain(base(), "2026-08-23T01:00:00.000Z");
    expect(() => assertCanSendMail(verified)).not.toThrow();
  });
});
