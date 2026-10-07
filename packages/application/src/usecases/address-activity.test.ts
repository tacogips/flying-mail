import {
  createMailAddress,
  MailAddressStatus,
} from "@flying-mail/domain/entities/mail-address";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  createDomainId,
  createMailAddressId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  buildMailPermissions,
  memberViewer,
} from "../test-support/viewer-fixtures";
import { createListAddressActivityUseCase } from "./address-activity";

const NOW = "2026-10-07T00:00:00.000Z";

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

describe("list address activity", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
  });

  test("queries only readable active addresses on active domains", async () => {
    const allowedDomain = activeDomain("dom-allowed", "allowed.example");
    const deniedDomain = activeDomain("dom-denied", "denied.example");
    const pendingDomain = createMailDomain({
      id: createDomainId("dom-pending"),
      name: createDomainName("pending.example"),
      catchAll: false,
      verificationToken: "pending-token",
      createdAt: NOW,
    });
    await fake.deps.mailDomainRepository.save(allowedDomain);
    await fake.deps.mailDomainRepository.save(deniedDomain);
    await fake.deps.mailDomainRepository.save(pendingDomain);
    const allowedMailbox = mailbox(
      "addr-allowed",
      "dom-allowed",
      "allowed.example",
      "a",
    );
    const deniedMailbox = mailbox(
      "addr-denied",
      "dom-denied",
      "denied.example",
      "b",
    );
    const pendingMailbox = mailbox(
      "addr-pending",
      "dom-pending",
      "pending.example",
      "c",
    );
    await fake.deps.mailAddressRepository.save(allowedMailbox);
    await fake.deps.mailAddressRepository.save(deniedMailbox);
    await fake.deps.mailAddressRepository.save(pendingMailbox);
    const viewer = memberViewer(
      "usr-activity",
      buildMailPermissions(createUserId("usr-activity"), [
        {
          effect: "ALLOW",
          domainId: allowedDomain.id,
          addressPattern: "*@allowed.example",
        },
      ]),
    );
    const repositoryCall = vi.spyOn(
      fake.deps.messageRepository,
      "listAddressActivity",
    );
    const domainList = vi.spyOn(fake.deps.mailDomainRepository, "list");
    const mailboxList = vi.spyOn(fake.deps.mailAddressRepository, "list");
    const useCase = createListAddressActivityUseCase(fake.deps);

    expect(await useCase(viewer)).toMatchObject([
      {
        address: allowedMailbox.address,
        domainId: allowedDomain.id,
        lastActivityAt: null,
        unreadCount: 0,
      },
    ]);
    expect(repositoryCall).toHaveBeenCalledWith([
      { address: allowedMailbox.address, domainId: allowedDomain.id },
    ]);
    expect(domainList).toHaveBeenCalledTimes(1);
    expect(mailboxList).toHaveBeenCalledTimes(1);
  });

  test("excludes disabled mailboxes even when their domain is readable", async () => {
    const domain = activeDomain("dom-active", "active.example");
    await fake.deps.mailDomainRepository.save(domain);
    const disabled = {
      ...mailbox("addr-disabled", "dom-active", "active.example", "old"),
      status: MailAddressStatus.Disabled,
    };
    await fake.deps.mailAddressRepository.save(disabled);
    const repositoryCall = vi.spyOn(
      fake.deps.messageRepository,
      "listAddressActivity",
    );
    await createListAddressActivityUseCase(fake.deps)(
      memberViewer(
        "usr-activity",
        buildMailPermissions(createUserId("usr-activity"), [
          {
            effect: "ALLOW",
            domainId: domain.id,
            addressPattern: "*@active.example",
          },
        ]),
      ),
    );
    expect(repositoryCall).toHaveBeenCalledWith([]);
  });
});
