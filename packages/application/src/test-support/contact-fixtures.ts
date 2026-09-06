import { createAddressBook } from "@mailcal/domain/entities/address-book";
import { Capability } from "@mailcal/domain/entities/api-key";
import { createMailAddress } from "@mailcal/domain/entities/mail-address";
import { createMailDomain } from "@mailcal/domain/entities/mail-domain";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import {
  type AddressBookId,
  createAddressBookId,
  createDomainId,
  createMailAddressId,
  type DomainId,
  type MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { Viewer } from "../policies/viewer";
import type { FakeDependencies } from "./fakes";
import { apiKeyViewer } from "./viewer-fixtures";

/** Shared contact seeding for use-case tests: one managed domain, two
 * provisioned mail addresses, and a default address book on the first.
 * Contact authorization derives entirely from `UserMailPermission` rules
 * evaluated against these addresses (see `design-user-mail-permissions.md`).
 * No fixed owner user is needed: any viewer built from `viewer-fixtures.ts`
 * becomes authorized by carrying a matching permission or scope. */

export const NOW = "2026-08-24T00:00:00.000Z";
export const DOMAIN_ID: DomainId = createDomainId("dom-1");
export const SUPPORT_MAIL_ADDRESS_ID: MailAddressId =
  createMailAddressId("addr-support");
export const SUPPORT_ADDRESS = "support@example.com";
export const BILLING_MAIL_ADDRESS_ID: MailAddressId =
  createMailAddressId("addr-billing");
export const BILLING_ADDRESS = "billing@example.com";
export const ADDRESS_BOOK_ID: AddressBookId =
  createAddressBookId("book-support");

export interface ContactFixture {
  readonly domainId: DomainId;
  readonly supportMailAddressId: MailAddressId;
  readonly billingMailAddressId: MailAddressId;
  readonly addressBookId: AddressBookId;
}

export async function seedContactFixture(
  fake: FakeDependencies,
): Promise<ContactFixture> {
  await fake.deps.mailDomainRepository.save(
    createMailDomain({
      id: DOMAIN_ID,
      name: createDomainName("example.com"),
      catchAll: true,
      verificationToken: "tok",
      createdAt: NOW,
    }),
  );
  await fake.deps.mailAddressRepository.save(
    createMailAddress({
      id: SUPPORT_MAIL_ADDRESS_ID,
      domainId: DOMAIN_ID,
      domainName: createDomainName("example.com"),
      localPart: "support",
      createdByUserId: null,
      createdAt: NOW,
    }),
  );
  await fake.deps.mailAddressRepository.save(
    createMailAddress({
      id: BILLING_MAIL_ADDRESS_ID,
      domainId: DOMAIN_ID,
      domainName: createDomainName("example.com"),
      localPart: "billing",
      createdByUserId: null,
      createdAt: NOW,
    }),
  );
  await fake.deps.addressBookRepository.save(
    createAddressBook({
      id: ADDRESS_BOOK_ID,
      mailAddressId: SUPPORT_MAIL_ADDRESS_ID,
      name: "Contacts",
      isDefault: true,
      createdAt: NOW,
    }),
  );

  return {
    domainId: DOMAIN_ID,
    supportMailAddressId: SUPPORT_MAIL_ADDRESS_ID,
    billingMailAddressId: BILLING_MAIL_ADDRESS_ID,
    addressBookId: ADDRESS_BOOK_ID,
  };
}

/** A key scoped to the support address for the given contact capabilities. */
export function contactKeyViewer(
  capabilities: readonly Capability[],
  addressPattern = SUPPORT_ADDRESS,
  domainId: DomainId | null = null,
): Viewer {
  return apiKeyViewer(
    capabilities.map((capability) => ({
      capability,
      domainId,
      addressPattern,
    })),
    "key-contacts",
  );
}

/** A mail-only key: holds no contact capability at all. */
export function mailOnlyKeyViewer(): Viewer {
  return apiKeyViewer(
    [
      {
        capability: Capability.MailRead,
        domainId: DOMAIN_ID,
        addressPattern: SUPPORT_ADDRESS,
      },
    ],
    "key-mail",
  );
}
