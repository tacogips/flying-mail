import { Capability } from "@mailcal/domain/entities/api-key";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import { ForbiddenError, UnauthenticatedError } from "../errors";
import {
  adminViewer,
  apiKeyViewer,
  buildMailPermissions,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import {
  authorizesAnyAddress,
  authorizesGlobal,
  mailAuthorizationRules,
  mailPermissionListFilter,
  readableAddressPatterns,
  requireAddressCapability,
  requireGlobalCapability,
  requireViewer,
  scopedDomainIds,
} from "./authorization";

const domainA = createDomainId("dom-a");
const domainB = createDomainId("dom-b");
const support = createEmailAddress("support@example.com");
const billing = createEmailAddress("billing@example.com");
const specificB = createEmailAddress("specific@b.example.com");

describe("requireViewer", () => {
  test("throws for a null viewer", () => {
    expect(() => requireViewer(null)).toThrow(UnauthenticatedError);
  });

  test("returns the viewer unchanged", () => {
    const viewer = adminViewer();
    expect(requireViewer(viewer)).toBe(viewer);
  });
});

describe("global capabilities", () => {
  test("an ADMIN user holds them", () => {
    expect(authorizesGlobal(adminViewer(), Capability.DomainAdmin)).toBe(true);
    expect(authorizesGlobal(adminViewer(), Capability.KeyAdmin)).toBe(true);
  });

  test("a MEMBER user never holds them", () => {
    expect(authorizesGlobal(memberViewer(), Capability.DomainAdmin)).toBe(
      false,
    );
    expect(() =>
      requireGlobalCapability(memberViewer(), Capability.KeyAdmin),
    ).toThrow(ForbiddenError);
  });

  test("an api key holds only what its scopes grant, without inheritance", () => {
    const viewer = apiKeyViewer([{ capability: Capability.KeyAdmin }]);
    expect(authorizesGlobal(viewer, Capability.KeyAdmin)).toBe(true);
    expect(authorizesGlobal(viewer, Capability.DomainAdmin)).toBe(false);
  });

  test("an unscoped api key holds nothing", () => {
    const viewer = apiKeyViewer([]);
    expect(authorizesGlobal(viewer, Capability.KeyAdmin)).toBe(false);
  });
});

describe("per-address capabilities", () => {
  const scopedViewer = apiKeyViewer([
    {
      capability: Capability.MailRead,
      domainId: domainA,
      addressPattern: "support@example.com",
    },
  ]);

  test("an ADMIN user may act on mail across every domain with no rules at all", () => {
    const viewer = adminViewer();
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainB, [billing]),
    ).toBe(true);
    expect(
      authorizesAnyAddress(viewer, Capability.MailSend, domainB, [billing]),
    ).toBe(true);
  });

  test("a MEMBER user with no mailbox rules may act on nothing", () => {
    const viewer = memberViewer();
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainB, [billing]),
    ).toBe(false);
    expect(
      authorizesAnyAddress(viewer, Capability.MailSend, domainB, [billing]),
    ).toBe(false);
  });

  test("a scoped key matches only its own address", () => {
    expect(
      authorizesAnyAddress(scopedViewer, Capability.MailRead, domainA, [
        support,
      ]),
    ).toBe(true);
    expect(
      authorizesAnyAddress(scopedViewer, Capability.MailRead, domainA, [
        billing,
      ]),
    ).toBe(false);
  });

  test("a scoped key does not cross domains", () => {
    expect(
      authorizesAnyAddress(scopedViewer, Capability.MailRead, domainB, [
        support,
      ]),
    ).toBe(false);
  });

  test("capabilities do not imply one another", () => {
    expect(
      authorizesAnyAddress(scopedViewer, Capability.MailManage, domainA, [
        support,
      ]),
    ).toBe(false);
  });

  test("any one authorized address in the list is enough", () => {
    expect(
      authorizesAnyAddress(scopedViewer, Capability.MailRead, domainA, [
        billing,
        support,
      ]),
    ).toBe(true);
  });

  test("an empty address list authorizes nothing for a key", () => {
    expect(
      authorizesAnyAddress(scopedViewer, Capability.MailRead, domainA, []),
    ).toBe(false);
  });

  test("requireAddressCapability throws for a denied key", () => {
    expect(() =>
      requireAddressCapability(scopedViewer, Capability.MailRead, domainA, [
        billing,
      ]),
    ).toThrow(ForbiddenError);
  });

  test("a user viewer never passes a global capability through the address check", () => {
    expect(
      authorizesAnyAddress(adminViewer(), Capability.KeyAdmin, domainA, [
        support,
      ]),
    ).toBe(false);
  });
});

describe("mailbox rules: role matrix and deny precedence", () => {
  const userId = createUserId("usr-1");

  test("ADMIN with a DENY rule loses access to the denied address only", () => {
    const permissions = buildMailPermissions(userId, [
      {
        effect: "DENY",
        domainId: domainA,
        addressPattern: "support@example.com",
      },
    ]);
    const viewer = adminViewer("usr-1", permissions);
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainA, [support]),
    ).toBe(false);
    // Baseline access elsewhere on the same domain is unaffected.
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainA, [billing]),
    ).toBe(true);
    // And on another domain entirely.
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainB, [support]),
    ).toBe(true);
  });

  test("MEMBER with an ALLOW rule gets READ/SEND/MANAGE/FILE_LINK on the matching address, nothing outside it", () => {
    const permissions = buildMailPermissions(userId, [
      {
        effect: "ALLOW",
        domainId: domainA,
        addressPattern: "support@example.com",
      },
    ]);
    const viewer = memberViewer("usr-1", permissions);
    for (const capability of [
      Capability.MailRead,
      Capability.MailSend,
      Capability.MailManage,
      Capability.FileLink,
    ]) {
      expect(authorizesAnyAddress(viewer, capability, domainA, [support])).toBe(
        true,
      );
      expect(authorizesAnyAddress(viewer, capability, domainA, [billing])).toBe(
        false,
      );
      expect(authorizesAnyAddress(viewer, capability, domainB, [support])).toBe(
        false,
      );
    }
  });

  test("VIEWER with an ALLOW rule gets READ/FILE_LINK only, never SEND/MANAGE even on the same address", () => {
    const permissions = buildMailPermissions(userId, [
      {
        effect: "ALLOW",
        domainId: domainA,
        addressPattern: "support@example.com",
      },
    ]);
    const viewer = viewerViewer("usr-1", permissions);
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainA, [support]),
    ).toBe(true);
    expect(
      authorizesAnyAddress(viewer, Capability.FileLink, domainA, [support]),
    ).toBe(true);
    expect(
      authorizesAnyAddress(viewer, Capability.MailSend, domainA, [support]),
    ).toBe(false);
    expect(
      authorizesAnyAddress(viewer, Capability.MailManage, domainA, [support]),
    ).toBe(false);
  });

  test("deny wins over an overlapping ALLOW for the same address", () => {
    const permissions = buildMailPermissions(userId, [
      { effect: "ALLOW", domainId: domainA, addressPattern: "*" },
      {
        effect: "DENY",
        domainId: domainA,
        addressPattern: "support@example.com",
      },
    ]);
    const viewer = memberViewer("usr-1", permissions);
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainA, [support]),
    ).toBe(false);
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainA, [billing]),
    ).toBe(true);
  });

  test("a message visible via multiple addresses is not hidden by a deny on only one of them", () => {
    const permissions = buildMailPermissions(userId, [
      {
        effect: "ALLOW",
        domainId: domainA,
        addressPattern: "billing@example.com",
      },
      {
        effect: "DENY",
        domainId: domainA,
        addressPattern: "support@example.com",
      },
    ]);
    const viewer = memberViewer("usr-1", permissions);
    // The message has both a denied and an independently-allowed address.
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainA, [
        support,
        billing,
      ]),
    ).toBe(true);
  });
});

describe("mailAuthorizationRules / mailPermissionListFilter: no cross-product", () => {
  const userId = createUserId("usr-1");

  test("each rule keeps its own domainId/addressPattern pairing", () => {
    const permissions = buildMailPermissions(userId, [
      { effect: "ALLOW", domainId: domainA, addressPattern: "*" },
      {
        effect: "ALLOW",
        domainId: domainB,
        addressPattern: "specific@b.example.com",
      },
    ]);
    const viewer = memberViewer("usr-1", permissions);
    const rules = mailAuthorizationRules(viewer, Capability.MailRead);
    expect(rules).toEqual([
      { effect: "ALLOW", domainId: domainA, addressPattern: "*" },
      {
        effect: "ALLOW",
        domainId: domainB,
        addressPattern: "specific@b.example.com",
      },
    ]);
    // The exact address from domain B's rule must not match in domain A --
    // only domain A's own (wildcard) rule may authorize domain A.
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainA, [specificB]),
    ).toBe(true); // matches domain A's own "*" rule, not domain B's pattern
    expect(
      authorizesAnyAddress(viewer, Capability.MailRead, domainB, [support]),
    ).toBe(false); // domain B's rule only matches its own exact pattern
  });

  test("mailPermissionListFilter returns null for API-key viewers and global capabilities", () => {
    const apiViewer = apiKeyViewer([{ capability: Capability.MailRead }]);
    expect(mailPermissionListFilter(apiViewer, Capability.MailRead)).toBeNull();
    expect(
      mailPermissionListFilter(adminViewer(), Capability.DomainAdmin),
    ).toBeNull();
  });

  test("mailPermissionListFilter carries baseline and rules for a USER viewer", () => {
    const permissions = buildMailPermissions(userId, [
      {
        effect: "DENY",
        domainId: domainA,
        addressPattern: "support@example.com",
      },
    ]);
    expect(
      mailPermissionListFilter(
        adminViewer("usr-1", permissions),
        Capability.MailRead,
      ),
    ).toEqual({
      baseline: true,
      rules: [
        {
          effect: "DENY",
          domainId: domainA,
          addressPattern: "support@example.com",
        },
      ],
    });
    expect(
      mailPermissionListFilter(
        memberViewer("usr-1", permissions),
        Capability.MailRead,
      ),
    ).toEqual({
      baseline: false,
      rules: [
        {
          effect: "DENY",
          domainId: domainA,
          addressPattern: "support@example.com",
        },
      ],
    });
  });
});

describe("readableAddressPatterns", () => {
  test("is null (unrestricted) for user viewers", () => {
    expect(
      readableAddressPatterns(adminViewer(), Capability.MailRead),
    ).toBeNull();
    expect(
      readableAddressPatterns(memberViewer(), Capability.MailRead),
    ).toBeNull();
  });

  test("collects the patterns of matching scopes only", () => {
    const viewer = apiKeyViewer([
      {
        capability: Capability.MailRead,
        domainId: domainA,
        addressPattern: "support@example.com",
      },
      {
        capability: Capability.MailRead,
        domainId: domainA,
        addressPattern: "*@other.com",
      },
      {
        capability: Capability.MailSend,
        domainId: domainA,
        addressPattern: "noreply@example.com",
      },
    ]);
    expect(readableAddressPatterns(viewer, Capability.MailRead)).toEqual([
      "support@example.com",
      "*@other.com",
    ]);
  });

  test("is an empty array (match nothing) when the key holds no such scope", () => {
    const viewer = apiKeyViewer([{ capability: Capability.MailSend }]);
    expect(readableAddressPatterns(viewer, Capability.MailRead)).toEqual([]);
  });
});

describe("scopedDomainIds", () => {
  test("is null for user viewers", () => {
    expect(scopedDomainIds(adminViewer(), Capability.MailRead)).toBeNull();
  });

  test("is null when any scope is a domain wildcard", () => {
    const viewer = apiKeyViewer([
      { capability: Capability.MailRead, domainId: domainA },
      { capability: Capability.MailRead, domainId: null },
    ]);
    expect(scopedDomainIds(viewer, Capability.MailRead)).toBeNull();
  });

  test("deduplicates the concrete domain ids", () => {
    const viewer = apiKeyViewer([
      { capability: Capability.MailRead, domainId: domainA },
      { capability: Capability.MailRead, domainId: domainA },
      { capability: Capability.MailRead, domainId: domainB },
    ]);
    expect(scopedDomainIds(viewer, Capability.MailRead)).toEqual([
      domainA,
      domainB,
    ]);
  });

  test("is an empty array when the key holds no such scope", () => {
    const viewer = apiKeyViewer([{ capability: Capability.MailSend }]);
    expect(scopedDomainIds(viewer, Capability.MailRead)).toEqual([]);
  });
});
