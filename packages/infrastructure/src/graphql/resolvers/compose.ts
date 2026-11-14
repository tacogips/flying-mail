import type { ComposeMode } from "@flying-mail/application/usecases/compose-prefill";
import { createMessageId } from "@flying-mail/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";
import type { ViewerSource } from "./types";

export const composeQueryResolvers = {
  composeFromMessage(
    _parent: unknown,
    args: { readonly messageId: string; readonly mode: ComposeMode },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.composeFromMessage(
      requireViewerOrThrow(ctx),
      createMessageId(args.messageId),
      args.mode,
    );
  },

  mailLimits(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    requireViewerOrThrow(ctx);
    return ctx.usecases.getMailLimits();
  },
};

export const composeMutationResolvers = {
  deleteDraft(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteDraft(
      requireViewerOrThrow(ctx),
      createMessageId(args.id),
    );
  },
};

export const composeViewerResolvers = {
  readableAddresses(source: ViewerSource, _args: unknown, ctx: GraphQLContext) {
    return ctx.usecases.listReadableAddresses(source.viewer);
  },
};
