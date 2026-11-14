import type { CreateMailAddressUseCaseInput } from "@mailcal/application/usecases";
import type {
  MailAddress,
  MailAddressStatus,
} from "@mailcal/domain/entities/mail-address";
import type { MailDomain } from "@mailcal/domain/entities/mail-domain";
import {
  createDomainId,
  createMailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

export const mailAddressQueryResolvers = {
  async mailAddresses(
    _parent: unknown,
    args: { readonly domainId?: string | null },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.listMailAddresses(
      requireViewerOrThrow(ctx),
      args.domainId == null ? null : createDomainId(args.domainId),
    );
  },
};

export const mailAddressMutationResolvers = {
  async createMailAddress(
    _parent: unknown,
    args: {
      readonly input: {
        readonly domainId: string;
        readonly localPart: string;
        readonly displayName?: string | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    const input: CreateMailAddressUseCaseInput = {
      domainId: createDomainId(args.input.domainId),
      localPart: args.input.localPart,
      // An absent display name and an explicit null both mean "no label",
      // so unlike most optional inputs this one does not need the
      // drop-the-key dance.
      displayName: args.input.displayName ?? null,
    };
    return ctx.usecases.createMailAddress(requireViewerOrThrow(ctx), input);
  },

  async renameMailAddress(
    _parent: unknown,
    args: { readonly id: string; readonly displayName?: string | null },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.renameMailAddress(
      requireViewerOrThrow(ctx),
      createMailAddressId(args.id),
      args.displayName ?? null,
    );
  },

  async setMailAddressStatus(
    _parent: unknown,
    args: { readonly id: string; readonly status: MailAddressStatus },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.setMailAddressStatus(
      requireViewerOrThrow(ctx),
      createMailAddressId(args.id),
      args.status,
    );
  },

  async deleteMailAddress(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteMailAddress(
      requireViewerOrThrow(ctx),
      createMailAddressId(args.id),
    );
  },
};

export const mailAddressResolvers = {
  /** Loader-based, so listing every mailbox on an instance stays one domain
   * query rather than one per row. */
  async domain(
    address: MailAddress,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<MailDomain | null> {
    return ctx.loaders.domainById.load(address.domainId);
  },
};
