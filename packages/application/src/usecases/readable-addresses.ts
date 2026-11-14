import { Capability } from "@flying-mail/domain/entities/api-key";
import { DomainStatus } from "@flying-mail/domain/entities/mail-domain";
import { MailAddressStatus } from "@flying-mail/domain/entities/mail-address";
import type { AppDependencies } from "../dependencies";
import { authorizesAnyAddress } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";

export function createListReadableAddressesUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly string[]> {
  return async (viewer) => {
    const [domains, addresses] = await Promise.all([
      deps.mailDomainRepository.list(),
      deps.mailAddressRepository.list(),
    ]);
    const activeDomains = new Map(
      domains
        .filter((domain) => domain.status === DomainStatus.Active)
        .map((domain) => [domain.id, domain]),
    );

    return addresses
      .filter((mailbox) => {
        const domain = activeDomains.get(mailbox.domainId);
        return (
          mailbox.status === MailAddressStatus.Active &&
          domain !== undefined &&
          authorizesAnyAddress(viewer, Capability.MailRead, domain.id, [
            mailbox.address,
          ])
        );
      })
      .toSorted((left, right) => {
        const leftDomain = activeDomains.get(left.domainId);
        const rightDomain = activeDomains.get(right.domainId);
        if (leftDomain === undefined || rightDomain === undefined) {
          return 0;
        }
        const domainOrder = String(leftDomain.name).localeCompare(
          String(rightDomain.name),
        );
        return domainOrder !== 0
          ? domainOrder
          : String(left.address).localeCompare(String(right.address));
      })
      .map((mailbox) => String(mailbox.address));
  };
}
