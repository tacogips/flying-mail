import type { AddressBook } from "@flying-mail/domain/entities/address-book";
import type { Contact } from "@flying-mail/domain/entities/contact";
import type { MailAddress } from "@flying-mail/domain/entities/mail-address";
import type { GraphQLContext } from "../context";

/** Field resolvers for the contacts types.
 *
 * `AddressBook.mailAddress` and `Contact.addressBook` cross an ownership
 * edge that has no dedicated "get one by id" use case in `ContactUseCases`
 * (only `listAddressBooks`, scoped by mail address). Both fields therefore go
 * through request-scoped loaders that read the repository, exactly like
 * `mailAddressResolvers.domain` ->
 * `ctx.loaders.domainById`: the parent object (`AddressBook`/`Contact`) was
 * already returned by an authorized use case, so re-deriving that same
 * authorization decision here would be redundant, not a safety gap. Every
 * other field is plain property access -- no resolver here reaches past
 * `ctx.loaders`. */

export const addressBookResolvers = {
  async mailAddress(
    book: AddressBook,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<MailAddress | null> {
    return ctx.loaders.mailAddressById.load(book.mailAddressId);
  },
  async contactCount(
    book: AddressBook,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<number> {
    return ctx.loaders.contactCountByAddressBook.load(book.id);
  },
};

export const contactResolvers = {
  async addressBook(
    contact: Contact,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<AddressBook | null> {
    return ctx.loaders.addressBookById.load(contact.addressBookId);
  },
};
