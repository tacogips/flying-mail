import type { MessageFilterInput } from "@mailcal/application/usecases/messages";
import type { AttachmentKind } from "@mailcal/domain/entities/attachment";
import type {
  MailStatus,
  MessageDirection,
} from "@mailcal/domain/entities/message";
import type { SystemTagSlug } from "@mailcal/domain/entities/tag";
import {
  createDomainId,
  createMessageId,
  createTagId,
  createThreadId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";
import type { ViewerSource } from "./types";

interface MessageFilterArg {
  readonly domainId?: string | null;
  readonly direction?: MessageDirection | null;
  readonly address?: string | null;
  readonly toAddress?: string | null;
  readonly recipientAddress?: string | null;
  readonly fromAddress?: string | null;
  readonly threadId?: string | null;
  readonly tagIds?: readonly string[] | null;
  readonly systemSlugs?: readonly SystemTagSlug[] | null;
  readonly includeSpam?: boolean | null;
  readonly fetchStatus?: "NOT_FETCHED" | "FETCHED" | null;
  readonly unreadOnly?: boolean | null;
  readonly search?: string | null;
  readonly hasAttachment?: boolean | null;
  readonly attachmentKinds?: readonly AttachmentKind[] | null;
  readonly spamOnly?: boolean | null;
  readonly includeTrashed?: boolean | null;
  readonly statuses?: readonly MailStatus[] | null;
  readonly mailingList?: boolean | null;
  readonly listId?: string | null;
  readonly since?: string | null;
  readonly until?: string | null;
}

/** Drops explicit nulls, which GraphQL uses for "not supplied" on optional
 * input fields but the use case layer -- under
 * `exactOptionalPropertyTypes` -- treats as a real value. */
export function toMessageFilterInput(
  filter: MessageFilterArg | null | undefined,
): MessageFilterInput | undefined {
  if (filter === null || filter === undefined) {
    return undefined;
  }
  return {
    ...(filter.domainId == null
      ? {}
      : { domainId: createDomainId(filter.domainId) }),
    ...(filter.direction == null ? {} : { direction: filter.direction }),
    ...(filter.address == null ? {} : { address: filter.address }),
    ...(filter.toAddress == null ? {} : { toAddress: filter.toAddress }),
    ...(filter.recipientAddress == null
      ? {}
      : { recipientAddress: filter.recipientAddress }),
    ...(filter.fromAddress == null ? {} : { fromAddress: filter.fromAddress }),
    ...(filter.threadId == null
      ? {}
      : { threadId: createThreadId(filter.threadId) }),
    ...(filter.tagIds == null
      ? {}
      : { tagIds: filter.tagIds.map((id) => createTagId(id)) }),
    ...(filter.systemSlugs == null ? {} : { systemSlugs: filter.systemSlugs }),
    ...(filter.includeSpam == null ? {} : { includeSpam: filter.includeSpam }),
    ...(filter.fetchStatus == null ? {} : { fetchStatus: filter.fetchStatus }),
    ...(filter.unreadOnly == null ? {} : { unreadOnly: filter.unreadOnly }),
    ...(filter.search == null ? {} : { search: filter.search }),
    ...(filter.hasAttachment == null
      ? {}
      : { hasAttachment: filter.hasAttachment }),
    ...(filter.attachmentKinds == null
      ? {}
      : { attachmentKinds: filter.attachmentKinds }),
    ...(filter.spamOnly == null ? {} : { spamOnly: filter.spamOnly }),
    ...(filter.includeTrashed == null
      ? {}
      : { includeTrashed: filter.includeTrashed }),
    ...(filter.statuses == null ? {} : { statuses: filter.statuses }),
    ...(filter.mailingList == null ? {} : { mailingList: filter.mailingList }),
    ...(filter.listId == null ? {} : { listId: filter.listId }),
    ...(filter.since == null ? {} : { since: filter.since }),
    ...(filter.until == null ? {} : { until: filter.until }),
  };
}

export const queryResolvers = {
  /** Null rather than an error for an unauthenticated caller: this is how a
   * client asks "am I signed in?", and the web app calls it on every load. */
  viewer(
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ): ViewerSource | null {
    return ctx.viewer === null ? null : { viewer: ctx.viewer };
  },

  async domains(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    return ctx.usecases.listDomains(requireViewerOrThrow(ctx));
  },

  async domain(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.getDomain(
      requireViewerOrThrow(ctx),
      createDomainId(args.id),
    );
  },

  async messages(
    _parent: unknown,
    args: {
      readonly filter?: MessageFilterArg | null;
      readonly first?: number | null;
      readonly after?: string | null;
    },
    ctx: GraphQLContext,
  ) {
    const filter = toMessageFilterInput(args.filter);
    return ctx.usecases.listMessages(requireViewerOrThrow(ctx), {
      ...(filter === undefined ? {} : { filter }),
      ...(args.first == null ? {} : { first: args.first }),
      after: args.after ?? null,
    });
  },

  async message(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.getMessage(
      requireViewerOrThrow(ctx),
      createMessageId(args.id),
    );
  },

  async thread(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.getThread(
      requireViewerOrThrow(ctx),
      createThreadId(args.id),
    );
  },

  async tags(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    return ctx.usecases.listTags(requireViewerOrThrow(ctx));
  },

  async apiKeys(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    return ctx.usecases.listApiKeys(requireViewerOrThrow(ctx));
  },

  async messageEvents(
    _parent: unknown,
    args: {
      readonly dueBefore?: string | null;
      readonly dueAfter?: string | null;
      readonly includeCompleted?: boolean | null;
      readonly limit?: number | null;
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.listMessageEvents(requireViewerOrThrow(ctx), {
      ...(args.dueBefore == null ? {} : { dueBefore: args.dueBefore }),
      ...(args.dueAfter == null ? {} : { dueAfter: args.dueAfter }),
      ...(args.includeCompleted == null
        ? {}
        : { includeCompleted: args.includeCompleted }),
      ...(args.limit == null ? {} : { limit: args.limit }),
    });
  },

  async classificationRules(
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.listClassificationRules(requireViewerOrThrow(ctx));
  },

  async fileLinks(
    _parent: unknown,
    args: { readonly messageId: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.listFileLinks(
      requireViewerOrThrow(ctx),
      createMessageId(args.messageId),
    );
  },

  /** Admin only -- `listUsers` throws for anyone else. Discards the
   * use case's bundled `permissions` in favor of `User.permissions`'s
   * loader, same as `apiKeys`/`ApiKey.scopes`. */
  async users(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    const entries = await ctx.usecases.listUsers(requireViewerOrThrow(ctx));
    return entries.map((entry) => entry.user);
  },

  async user(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    const entry = await ctx.usecases.getUser(
      requireViewerOrThrow(ctx),
      createUserId(args.id),
    );
    return entry === null ? null : entry.user;
  },
};
