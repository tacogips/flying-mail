import {
  createMailAddress,
  MailAddressStatus,
  setMailAddressStatus,
} from "@flying-mail/domain/entities/mail-address";
import {
  createMailDomain,
  DomainStatus,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  createDomainId,
  createMailAddressId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  buildMailPermissions,
  memberViewer,
} from "../test-support/viewer-fixtures";
import { createListReadableAddressesUseCase } from "./readable-addresses";

const NOW = "2026-08-23T00:00:00.000Z";

function activeDomain(id: string, name: string) {
  return verifyMailDomain(
    createMailDomain({
      id: createDomainId(id),
      name: createDomainName(name),
      catchAll: false,
      verificationToken: `verify-${id}`,
      createdAt: NOW,
    }),
    NOW,
  );
}

function mailbox(
  id: string,
  domainId: string,
  domainName: string,
  localPart: string,
) {
  return createMailAddress({
    id: createMailAddressId(id),
    domainId: createDomainId(domainId),
    domainName: createDomainName(domainName),
    localPart,
    createdByUserId: null,
    createdAt: NOW,
  });
}

describe("createListReadableAddressesUseCase", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
  });

  test("returns active mailboxes allowed by MAIL_READ in domain and address order", async () => {
    const first = activeDomain("dom-a", "a.example");
    const second = activeDomain("dom-b", "b.example");
    await fake.deps.mailDomainRepository.save(first);
    await fake.deps.mailDomainRepository.save(second);
    await fake.deps.mailAddressRepository.save(
      mailbox("mail-b", "dom-b", "b.example", "z"),
    );
    await fake.deps.mailAddressRepository.save(
      mailbox("mail-a2", "dom-a", "a.example", "z"),
    );
    await fake.deps.mailAddressRepository.save(
      mailbox("mail-a1", "dom-a", "a.example", "a"),
    );
    const member = memberViewer(
      "usr-member",
      buildMailPermissions(createUserId("usr-member"), [
        { effect: "ALLOW", domainId: first.id, addressPattern: "*@a.example" },
      ]),
    );

    const list = createListReadableAddressesUseCase(fake.deps);
    expect(await list(member)).toEqual(["a@a.example", "z@a.example"]);
  });

  test("excludes disabled mailboxes and addresses on inactive domains", async () => {
    const active = activeDomain("dom-active", "active.example");
    const pending = createMailDomain({
      id: createDomainId("dom-pending"),
      name: createDomainName("pending.example"),
      catchAll: false,
      verificationToken: "pending-token",
      createdAt: NOW,
    });
    await fake.deps.mailDomainRepository.save(active);
    await fake.deps.mailDomainRepository.save(pending);
    const enabledAddress = mailbox(
      "mail-enabled",
      "dom-active",
      "active.example",
      "enabled",
    );
    const disabledAddress = setMailAddressStatus(
      mailbox("mail-disabled", "dom-active", "active.example", "disabled"),
      MailAddressStatus.Disabled,
      NOW,
    );
    await fake.deps.mailAddressRepository.save(enabledAddress);
    await fake.deps.mailAddressRepository.save(disabledAddress);
    await fake.deps.mailAddressRepository.save(
      mailbox("mail-pending", "dom-pending", "pending.example", "pending"),
    );
    const allActive = memberViewer(
      "usr-all",
      buildMailPermissions(createUserId("usr-all"), [
        { effect: "ALLOW", domainId: null, addressPattern: "*" },
      ]),
    );

    const list = createListReadableAddressesUseCase(fake.deps);
    expect(await list(allActive)).toEqual(["enabled@active.example"]);
    expect(disabledAddress.status).toBe(MailAddressStatus.Disabled);
    expect(pending.status).toBe(DomainStatus.Pending);
  });
});
