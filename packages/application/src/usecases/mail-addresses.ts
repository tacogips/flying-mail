import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailAddress,
  type MailAddress,
  MailAddressStatus,
  renameMailAddress,
  setMailAddressStatus,
} from "@mailcal/domain/entities/mail-address";
import {
  createMailAddressId,
  type DomainId,
  type MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ConflictError, NotFoundError } from "../errors";
import { requireGlobalCapability } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Mailbox provisioning is domain administration: an address belongs to a
 * domain, and the credential that may add a domain is the one that may say
 * which mailboxes exist on it. No separate capability -- that would be a
 * knob with no distinct threat model behind it. */
function requireDomainAdmin(viewer: Viewer): void {
  requireGlobalCapability(viewer, Capability.DomainAdmin);
}

export interface CreateMailAddressUseCaseInput {
  readonly domainId: DomainId;
  readonly localPart: string;
  readonly displayName?: string | null;
}

async function requireDomain(deps: AppDependencies, domainId: DomainId) {
  const domain = await deps.mailDomainRepository.findById(domainId);
  if (domain === null) {
    throw new NotFoundError("MailDomain", domainId);
  }
  return domain;
}

export async function requireMailAddress(
  deps: AppDependencies,
  id: MailAddressId,
): Promise<MailAddress> {
  const address = await deps.mailAddressRepository.findById(id);
  if (address === null) {
    throw new NotFoundError("MailAddress", id);
  }
  return address;
}

export function createListMailAddressesUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  domainId: DomainId | null,
) => Promise<readonly MailAddress[]> {
  return async (viewer, domainId) => {
    requireDomainAdmin(viewer);
    return domainId === null
      ? deps.mailAddressRepository.list()
      : deps.mailAddressRepository.listByDomain(domainId);
  };
}

export function createCreateMailAddressUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: CreateMailAddressUseCaseInput,
) => Promise<MailAddress> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireDomainAdmin(viewer);
      const domain = await requireDomain(deps, input.domainId);
      const address = createMailAddress({
        id: createMailAddressId(deps.random.uuid()),
        domainId: domain.id,
        domainName: domain.name,
        localPart: input.localPart,
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName }),
        createdByUserId: viewer.kind === "USER" ? viewer.userId : null,
        createdAt: deps.clock.now().toISOString(),
      });
      // Checked against the normalized address the entity produced, so
      // "Support" and "support" collide the way they will in real mail.
      const existing = await deps.mailAddressRepository.findByAddress(
        address.address,
      );
      if (existing !== null) {
        throw new ConflictError(`${address.address} already exists`);
      }
      await deps.mailAddressRepository.save(address);
      return address;
    });
}

export function createRenameMailAddressUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: MailAddressId,
  displayName: string | null,
) => Promise<MailAddress> {
  return async (viewer, id, displayName) =>
    withAsyncDomainErrorTranslation(async () => {
      requireDomainAdmin(viewer);
      const existing = await requireMailAddress(deps, id);
      const renamed = renameMailAddress(
        existing,
        displayName,
        deps.clock.now().toISOString(),
      );
      await deps.mailAddressRepository.save(renamed);
      return renamed;
    });
}

export function createSetMailAddressStatusUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: MailAddressId,
  status: MailAddressStatus,
) => Promise<MailAddress> {
  return async (viewer, id, status) =>
    withAsyncDomainErrorTranslation(async () => {
      requireDomainAdmin(viewer);
      const existing = await requireMailAddress(deps, id);
      const updated = setMailAddressStatus(
        existing,
        status,
        deps.clock.now().toISOString(),
      );
      await deps.mailAddressRepository.save(updated);
      return updated;
    });
}

/** Deletes a mailbox that has never carried mail.
 *
 * Refuses once messages exist, mirroring `deleteDomain`: dropping the row
 * would leave stored mail addressed to a mailbox the instance no longer
 * admits exists. Disabling is the reversible way to close an address that
 * has history. */
export function createDeleteMailAddressUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: MailAddressId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      requireDomainAdmin(viewer);
      const existing = await requireMailAddress(deps, id);
      const messages = await deps.mailAddressRepository.countMessages(id);
      if (messages > 0) {
        throw new ConflictError(
          `${existing.address} still has ${messages} message(s); disable it instead of deleting it`,
        );
      }
      await deps.mailAddressRepository.delete(id);
      return true;
    });
}

export { MailAddressStatus };
