import type {
  ConnectCarddavAccountInput,
  ConnectCarddavAccountResult,
  CreateAddressBookUseCaseInput,
  CreateContactUseCaseInput,
  LinkRemoteAddressBookInput,
  SyncCarddavBookResult,
  UpdateAddressBookUseCaseInput,
  UpdateContactUseCaseInput,
} from "@mailcal/application/usecases/contact-usecases";
import type { AddressBook } from "@mailcal/domain/entities/address-book";
import type { CarddavBookLink } from "@mailcal/domain/entities/carddav-account";
import type {
  Contact,
  ContactEmailInput,
  ContactPhoneInput,
  ContactPostalAddressInput,
} from "@mailcal/domain/entities/contact";
import {
  createAddressBookId,
  createCarddavAccountId,
  createCarddavBookId,
  createContactId,
  createMailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

/** Every contacts mutation. Argument mapping only: authorization, domain
 * validation and persistence all live behind `ctx.usecases`. Optional fields
 * use the `...(x == null ? {} : { x })` null-dropping convention. */

interface CreateAddressBookArg {
  readonly mailAddressId: string;
  readonly name: string;
  readonly description?: string | null;
}

interface UpdateAddressBookArg {
  readonly name?: string | null;
  readonly description?: string | null;
}

interface CreateContactArg {
  readonly mailAddressId?: string | null;
  readonly addressBookId?: string | null;
  readonly displayName: string;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly nickname?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  readonly emails?: readonly ContactEmailInput[] | null;
  readonly phones?: readonly ContactPhoneInput[] | null;
  readonly postalAddresses?: readonly ContactPostalAddressInput[] | null;
  readonly urls?: readonly string[] | null;
  readonly note?: string | null;
  readonly birthday?: string | null;
}

interface UpdateContactArg {
  readonly displayName?: string | null;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly nickname?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  readonly emails?: readonly ContactEmailInput[] | null;
  readonly phones?: readonly ContactPhoneInput[] | null;
  readonly postalAddresses?: readonly ContactPostalAddressInput[] | null;
  readonly urls?: readonly string[] | null;
  readonly note?: string | null;
  readonly birthday?: string | null;
}

/** The field set `CreateContactInput` and `UpdateContactInput` share --
 * everything but `addressBookId`/`mailAddressId` (create-only) and
 * `displayName` (mapped separately since create requires it and update
 * does not). Named explicitly rather than derived via `Omit` from either
 * use-case input type, so the object spread below cannot smuggle a
 * create-only key like `mailAddressId` into an `UpdateContactUseCaseInput`
 * and trip an excess-property check. */
interface ContactFieldEdits {
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly nickname?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  readonly emails?: readonly ContactEmailInput[];
  readonly phones?: readonly ContactPhoneInput[];
  readonly postalAddresses?: readonly ContactPostalAddressInput[];
  readonly urls?: readonly string[];
  readonly note?: string | null;
  readonly birthday?: string | null;
}

function toContactFieldEdits(arg: {
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly nickname?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  readonly emails?: readonly ContactEmailInput[] | null;
  readonly phones?: readonly ContactPhoneInput[] | null;
  readonly postalAddresses?: readonly ContactPostalAddressInput[] | null;
  readonly urls?: readonly string[] | null;
  readonly note?: string | null;
  readonly birthday?: string | null;
}): ContactFieldEdits {
  return {
    ...(arg.givenName == null ? {} : { givenName: arg.givenName }),
    ...(arg.familyName == null ? {} : { familyName: arg.familyName }),
    ...(arg.nickname == null ? {} : { nickname: arg.nickname }),
    ...(arg.organization == null ? {} : { organization: arg.organization }),
    ...(arg.title == null ? {} : { title: arg.title }),
    ...(arg.emails == null ? {} : { emails: arg.emails }),
    ...(arg.phones == null ? {} : { phones: arg.phones }),
    ...(arg.postalAddresses == null
      ? {}
      : { postalAddresses: arg.postalAddresses }),
    ...(arg.urls == null ? {} : { urls: arg.urls }),
    ...(arg.note == null ? {} : { note: arg.note }),
    ...(arg.birthday == null ? {} : { birthday: arg.birthday }),
  };
}

export const contactMutationResolvers = {
  async createAddressBook(
    _parent: unknown,
    args: { readonly input: CreateAddressBookArg },
    ctx: GraphQLContext,
  ): Promise<AddressBook> {
    const input: CreateAddressBookUseCaseInput = {
      mailAddressId: createMailAddressId(args.input.mailAddressId),
      name: args.input.name,
      ...(args.input.description == null
        ? {}
        : { description: args.input.description }),
    };
    return ctx.usecases.createAddressBook(requireViewerOrThrow(ctx), input);
  },

  async updateAddressBook(
    _parent: unknown,
    args: { readonly id: string; readonly input: UpdateAddressBookArg },
    ctx: GraphQLContext,
  ): Promise<AddressBook> {
    const input: UpdateAddressBookUseCaseInput = {
      ...(args.input.name == null ? {} : { name: args.input.name }),
      ...(args.input.description == null
        ? {}
        : { description: args.input.description }),
    };
    return ctx.usecases.updateAddressBook(
      requireViewerOrThrow(ctx),
      createAddressBookId(args.id),
      input,
    );
  },

  async deleteAddressBook(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.deleteAddressBook(
      requireViewerOrThrow(ctx),
      createAddressBookId(args.id),
    );
  },

  async createContact(
    _parent: unknown,
    args: { readonly input: CreateContactArg },
    ctx: GraphQLContext,
  ): Promise<Contact> {
    const input: CreateContactUseCaseInput = {
      displayName: args.input.displayName,
      ...(args.input.mailAddressId == null
        ? {}
        : { mailAddressId: createMailAddressId(args.input.mailAddressId) }),
      ...(args.input.addressBookId == null
        ? {}
        : { addressBookId: createAddressBookId(args.input.addressBookId) }),
      ...toContactFieldEdits(args.input),
    };
    return ctx.usecases.createContact(requireViewerOrThrow(ctx), input);
  },

  async updateContact(
    _parent: unknown,
    args: { readonly id: string; readonly input: UpdateContactArg },
    ctx: GraphQLContext,
  ): Promise<Contact> {
    const input: UpdateContactUseCaseInput = {
      ...(args.input.displayName == null
        ? {}
        : { displayName: args.input.displayName }),
      ...toContactFieldEdits(args.input),
    };
    return ctx.usecases.updateContact(
      requireViewerOrThrow(ctx),
      createContactId(args.id),
      input,
    );
  },

  async deleteContact(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.deleteContact(
      requireViewerOrThrow(ctx),
      createContactId(args.id),
    );
  },

  async connectCarddavAccount(
    _parent: unknown,
    args: { readonly input: ConnectCarddavAccountInput },
    ctx: GraphQLContext,
  ): Promise<ConnectCarddavAccountResult> {
    return ctx.usecases.connectCarddavAccount(requireViewerOrThrow(ctx), {
      serverUrl: args.input.serverUrl,
      username: args.input.username,
      appPassword: args.input.appPassword,
    });
  },

  async disconnectCarddavAccount(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.disconnectCarddavAccount(
      requireViewerOrThrow(ctx),
      createCarddavAccountId(args.id),
    );
  },

  async linkCarddavBook(
    _parent: unknown,
    args: {
      readonly input: {
        readonly accountId: string;
        readonly remoteUrl: string;
        readonly mode: "IMPORT_NEW" | "BIND_EXISTING";
        readonly addressBookId?: string | null;
        readonly mailAddressId?: string | null;
        readonly displayName?: string | null;
      };
    },
    ctx: GraphQLContext,
  ): Promise<CarddavBookLink> {
    const input: LinkRemoteAddressBookInput = {
      accountId: createCarddavAccountId(args.input.accountId),
      remoteUrl: args.input.remoteUrl,
      mode: args.input.mode,
      ...(args.input.addressBookId == null
        ? {}
        : { addressBookId: createAddressBookId(args.input.addressBookId) }),
      ...(args.input.mailAddressId == null
        ? {}
        : { mailAddressId: createMailAddressId(args.input.mailAddressId) }),
      ...(args.input.displayName == null
        ? {}
        : { displayName: args.input.displayName }),
    };
    return ctx.usecases.linkRemoteAddressBook(requireViewerOrThrow(ctx), input);
  },

  async unlinkCarddavBook(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.unlinkRemoteAddressBook(
      requireViewerOrThrow(ctx),
      createCarddavBookId(args.id),
    );
  },

  async syncCarddavBook(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<SyncCarddavBookResult> {
    return ctx.usecases.syncCarddavBook(
      requireViewerOrThrow(ctx),
      createCarddavBookId(args.id),
    );
  },
};
