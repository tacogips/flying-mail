import { Capability } from "@flying-mail/domain/entities/api-key";
import { DomainStatus } from "@flying-mail/domain/entities/mail-domain";
import { MailAddressStatus } from "@flying-mail/domain/entities/mail-address";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import type { AppDependencies } from "../dependencies";
import type { AddressActivity } from "../ports/message-repository";
import { authorizesAnyAddress } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";

export type { AddressActivity } from "../ports/message-repository";

export function createListAddressActivityUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly AddressActivity[]> {
  return async (viewer) => {
    const [domains, mailboxes] = await Promise.all([
      deps.mailDomainRepository.list(),
      deps.mailAddressRepository.list(),
    ]);
    const activeDomainIds = new Set(
      domains
        .filter((domain) => domain.status === DomainStatus.Active)
        .map((domain) => domain.id),
    );
    const candidates = mailboxes
      .filter(
        (mailbox) =>
          mailbox.status === MailAddressStatus.Active &&
          activeDomainIds.has(mailbox.domainId) &&
          authorizesAnyAddress(viewer, Capability.MailRead, mailbox.domainId, [
            mailbox.address,
          ]),
      )
      .map((mailbox) => ({
        address: createEmailAddress(mailbox.address),
        domainId: mailbox.domainId,
      }));
    return deps.messageRepository.listAddressActivity(candidates);
  };
}
