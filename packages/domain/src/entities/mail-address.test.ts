import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createDomainName } from "../value-objects/domain-name";
import {
  createDomainId,
  createMailAddressId,
  createUserId,
} from "../value-objects/ids";
import {
  createMailAddress,
  isMailAddressActive,
  MAX_LOCAL_PART_LENGTH,
  MailAddressStatus,
  renameMailAddress,
  setMailAddressStatus,
} from "./mail-address";

const NOW = "2026-08-24T00:00:00.000Z";
const LATER = "2026-08-25T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const domainName = createDomainName("example.com");

function mint(localPart: string, displayName: string | null = null) {
  return createMailAddress({
    id: createMailAddressId("addr-1"),
    domainId,
    domainName,
    localPart,
    displayName,
    createdByUserId: createUserId("usr-1"),
    createdAt: NOW,
  });
}

describe("createMailAddress", () => {
  test("derives the full address and starts active", () => {
    const address = mint("support");
    expect(address.localPart).toBe("support");
    expect(address.address).toBe("support@example.com");
    expect(address.status).toBe(MailAddressStatus.Active);
    expect(isMailAddressActive(address)).toBe(true);
    expect(address.createdAt).toBe(NOW);
    expect(address.updatedAt).toBe(NOW);
  });

  test("normalizes case and surrounding whitespace", () => {
    expect(mint("  SupPort  ").localPart).toBe("support");
    expect(mint("  SupPort  ").address).toBe("support@example.com");
  });

  test("accepts the documented punctuation", () => {
    for (const local of ["a", "a1", "first.last", "a_b", "a+tag", "a-b"]) {
      expect(mint(local).localPart).toBe(local);
    }
  });

  test("rejects a blank local part", () => {
    expect(() => mint("   ")).toThrow(ValidationError);
    expect(() => mint("")).toThrow(/must not be empty/);
  });

  test("rejects punctuation at either end and doubled dots", () => {
    for (const local of [".a", "a.", "-a", "a-", "_a", "a_", "a..b"]) {
      expect(() => mint(local)).toThrow(ValidationError);
    }
  });

  test("rejects characters that would need quoting", () => {
    for (const local of ["a b", "a@b", 'a"b', "a/b", "a!b", "aあ"]) {
      expect(() => mint(local)).toThrow(ValidationError);
    }
  });

  test("rejects an overlong local part", () => {
    expect(() => mint("a".repeat(MAX_LOCAL_PART_LENGTH + 1))).toThrow(
      /at most/,
    );
    expect(mint("a".repeat(MAX_LOCAL_PART_LENGTH)).localPart).toHaveLength(
      MAX_LOCAL_PART_LENGTH,
    );
  });

  test("treats a blank display name as absent", () => {
    expect(mint("support", "   ").displayName).toBeNull();
    expect(mint("support", "Support desk").displayName).toBe("Support desk");
  });

  test("rejects an overlong display name", () => {
    expect(() => mint("support", "x".repeat(129))).toThrow(/at most/);
  });
});

describe("renameMailAddress", () => {
  test("changes the label and stamps updatedAt, leaving the address alone", () => {
    const renamed = renameMailAddress(mint("support"), "Help desk", LATER);
    expect(renamed.displayName).toBe("Help desk");
    expect(renamed.address).toBe("support@example.com");
    expect(renamed.localPart).toBe("support");
    expect(renamed.createdAt).toBe(NOW);
    expect(renamed.updatedAt).toBe(LATER);
  });

  test("can clear the label", () => {
    const renamed = renameMailAddress(mint("support", "Old"), null, LATER);
    expect(renamed.displayName).toBeNull();
  });
});

describe("setMailAddressStatus", () => {
  test("disables and re-enables", () => {
    const disabled = setMailAddressStatus(
      mint("support"),
      MailAddressStatus.Disabled,
      LATER,
    );
    expect(disabled.status).toBe(MailAddressStatus.Disabled);
    expect(isMailAddressActive(disabled)).toBe(false);
    expect(disabled.updatedAt).toBe(LATER);

    const reEnabled = setMailAddressStatus(
      disabled,
      MailAddressStatus.Active,
      "2026-08-26T00:00:00.000Z",
    );
    expect(isMailAddressActive(reEnabled)).toBe(true);
  });

  test("setting the status it already has is a no-op, timestamp included", () => {
    const address = mint("support");
    expect(setMailAddressStatus(address, MailAddressStatus.Active, LATER)).toBe(
      address,
    );
  });
});
