import type { ListContactsInput } from "@flying-mail/application/usecases/contact-usecases";
import type { ContactPage } from "@flying-mail/application/ports/contact-repository";
import type { AddressBook } from "@flying-mail/domain/entities/address-book";
import type {
  CarddavAccount,
  CarddavBookLink,
} from "@flying-mail/domain/entities/carddav-account";
import type { Contact } from "@flying-mail/domain/entities/contact";
import {
  createAddressBookId,
  createCarddavAccountId,
  createContactId,
  createMailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

interface ContactFilterArg {
  readonly mailAddressIds?: readonly string[] | null;
  readonly addressBookIds?: readonly string[] | null;
  readonly query?: string | null;
  readonly email?: string | null;
}

/** Drops explicit nulls: GraphQL spells "not supplied" as `null`, which
 * `exactOptionalPropertyTypes` will not let through as an absent field. */
function toListContactsInput(args: {
  readonly filter?: ContactFilterArg | null;
  readonly first?: number | null;
  readonly after?: string | null;
}): ListContactsInput {
  const filter = args.filter ?? null;
  return {
    ...(filter?.mailAddressIds == null
      ? {}
      : { mailAddressIds: filter.mailAddressIds.map(createMailAddressId) }),
    ...(filter?.addressBookIds == null
      ? {}
      : { addressBookIds: filter.addressBookIds.map(createAddressBookId) }),
    ...(filter?.query == null ? {} : { query: filter.query }),
    ...(filter?.email == null ? {} : { email: filter.email }),
    ...(args.first == null ? {} : { first: args.first }),
    ...(args.after == null ? {} : { after: args.after }),
  };
}

export const contactQueryResolvers = {
  async addressBooks(
    _parent: unknown,
    args: { readonly mailAddressId?: string | null },
    ctx: GraphQLContext,
  ): Promise<readonly AddressBook[]> {
    return ctx.usecases.listAddressBooks(
      requireViewerOrThrow(ctx),
      args.mailAddressId == null
        ? undefined
        : createMailAddressId(args.mailAddressId),
    );
  },

  async contacts(
    _parent: unknown,
    args: {
      readonly filter?: ContactFilterArg | null;
      readonly first?: number | null;
      readonly after?: string | null;
    },
    ctx: GraphQLContext,
  ): Promise<ContactPage> {
    return ctx.usecases.listContacts(
      requireViewerOrThrow(ctx),
      toListContactsInput(args),
    );
  },

  async contact(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<Contact | null> {
    return ctx.usecases.getContact(
      requireViewerOrThrow(ctx),
      createContactId(args.id),
    );
  },

  async contactsByEmail(
    _parent: unknown,
    args: { readonly email: string },
    ctx: GraphQLContext,
  ): Promise<readonly Contact[]> {
    return ctx.usecases.lookupContactsByEmail(
      requireViewerOrThrow(ctx),
      args.email,
    );
  },

  async carddavAccounts(
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly CarddavAccount[]> {
    return ctx.usecases.listCarddavAccounts(requireViewerOrThrow(ctx));
  },

  async carddavRemoteBooks(
    _parent: unknown,
    args: { readonly accountId: string },
    ctx: GraphQLContext,
  ): Promise<readonly CarddavBookLink[]> {
    return ctx.usecases.listRemoteAddressBooks(
      requireViewerOrThrow(ctx),
      createCarddavAccountId(args.accountId),
    );
  },
};
