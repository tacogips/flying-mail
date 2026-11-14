import type { ApiKey, ApiKeyScope } from "@mailcal/domain/entities/api-key";
import { Capability } from "@mailcal/domain/entities/api-key";
import type { Attachment } from "@mailcal/domain/entities/attachment";
import { FetchStatus } from "@mailcal/domain/entities/fetch-state";
import type { FileLink } from "@mailcal/domain/entities/file-link";
import type { MailDomain } from "@mailcal/domain/entities/mail-domain";
import type {
  Message,
  MessageRecipient,
} from "@mailcal/domain/entities/message";
import { RecipientKind } from "@mailcal/domain/entities/message";
import type { ClassificationRule } from "@mailcal/domain/entities/classification-rule";
import type { MessageEvent } from "@mailcal/domain/entities/message-event";
import type { SpamMark } from "@mailcal/domain/entities/spam-mark";
import type { Tag } from "@mailcal/domain/entities/tag";
import { isUserActive, type User } from "@mailcal/domain/entities/user";
import type { UserMailPermission } from "@mailcal/domain/entities/user-mail-permission";
import type { GraphQLContext } from "../context";
import { holdsCapability, viewerCapabilities } from "./helpers";

/** Shapes the GraphQL layer returns for the two types that are not domain
 * entities. */
export interface MailboxAddressView {
  readonly address: string;
  readonly name: string | null;
  readonly kind: RecipientKind;
}

export interface ViewerSource {
  readonly viewer: NonNullable<GraphQLContext["viewer"]>;
}

function toMailboxAddress(recipient: MessageRecipient): MailboxAddressView {
  return {
    address: recipient.address,
    name: recipient.name,
    kind: recipient.kind,
  };
}

export const messageResolvers = {
  async domain(message: Message, _args: unknown, ctx: GraphQLContext) {
    return ctx.loaders.domainById.load(message.domainId);
  },

  from(message: Message): MailboxAddressView {
    // Modelled as a `MailboxAddress` for symmetry with `recipients`, using
    // the `TO` kind since a sender has no envelope/cc distinction.
    return {
      address: message.fromAddress,
      name: message.fromName,
      kind: RecipientKind.To,
    };
  },

  async recipients(
    message: Message,
    args: { readonly kind?: RecipientKind | null },
    ctx: GraphQLContext,
  ): Promise<readonly MailboxAddressView[]> {
    const recipients = await ctx.loaders.recipientsByMessage.load(message.id);
    const filtered =
      args.kind === undefined || args.kind === null
        ? recipients
        : recipients.filter((recipient) => recipient.kind === args.kind);
    return filtered.map(toMailboxAddress);
  },

  async attachments(
    message: Message,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly Attachment[]> {
    return ctx.loaders.attachmentsByMessage.load(message.id);
  },

  async tags(
    message: Message,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly Tag[]> {
    return ctx.loaders.tagsByMessage.load(message.id);
  },

  async isSpam(
    message: Message,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return (await ctx.loaders.spamMarkByMessage.load(message.id)) !== null;
  },

  async spam(
    message: Message,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<SpamMark | null> {
    return ctx.loaders.spamMarkByMessage.load(message.id);
  },

  async events(
    message: Message,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly MessageEvent[]> {
    return ctx.loaders.eventsByMessage.load(message.id);
  },

  /** Per-consumer. A user session has no fetch state of its own, so it
   * always reads `FETCHED` -- reporting `NOT_FETCHED` to the browser would
   * make an agent's queue look permanently unconsumed in the UI. */
  async fetchStatus(
    message: Message,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<FetchStatus> {
    if (ctx.viewer?.kind !== "API_KEY") {
      return FetchStatus.Fetched;
    }
    const state = await ctx.loaders.fetchStateByMessage.load(message.id);
    return state?.status ?? FetchStatus.NotFetched;
  },

  async fetchedAt(
    message: Message,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<string | null> {
    if (ctx.viewer?.kind !== "API_KEY") {
      return null;
    }
    return (
      (await ctx.loaders.fetchStateByMessage.load(message.id))?.fetchedAt ??
      null
    );
  },
};

export const mailDomainResolvers = {
  /** Hidden from anyone who cannot administer domains: the token proves
   * ownership, so exposing it to every reader would let a member (or a
   * narrowly scoped key) publish DNS for a domain they do not control. */
  verificationToken(
    domain: MailDomain,
    _args: unknown,
    ctx: GraphQLContext,
  ): string | null {
    if (
      ctx.viewer === null ||
      !holdsCapability(ctx.viewer, Capability.DomainAdmin)
    ) {
      return null;
    }
    return domain.verificationToken;
  },

  dnsRecords(domain: MailDomain, _args: unknown, ctx: GraphQLContext) {
    return ctx.usecases.domainDnsRecords(domain);
  },

  async messageCount(
    domain: MailDomain,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<number> {
    return ctx.deps.mailDomainRepository.countMessages(domain.id);
  },
};

export const tagResolvers = {
  async messageCount(
    tag: Tag,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<number> {
    return ctx.loaders.messageCountByTag.load(tag.id);
  },
};

export const attachmentResolvers = {
  url(attachment: Attachment): string {
    return `/api/attachments/${attachment.id}`;
  },
};

export const apiKeyResolvers = {
  async scopes(
    apiKey: ApiKey,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly ApiKeyScope[]> {
    return ctx.loaders.scopesByApiKey.load(apiKey.id);
  },
};

export const apiKeyScopeResolvers = {
  async domain(scope: ApiKeyScope, _args: unknown, ctx: GraphQLContext) {
    return scope.domainId === null
      ? null
      : ctx.loaders.domainById.load(scope.domainId);
  },
};

export const fileLinkResolvers = {
  async attachment(
    link: FileLink,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<Attachment | null> {
    return link.attachmentId === null
      ? null
      : ctx.deps.messageRepository.findAttachmentById(link.attachmentId);
  },

  async message(
    link: FileLink,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<Message | null> {
    return link.messageId === null
      ? null
      : ctx.deps.messageRepository.findById(link.messageId);
  },

  /** The stored row holds only a hash, so a link's URL cannot be
   * reconstructed after minting. Clients keep the URL returned by the
   * mutation; this field exists so the type is still queryable, and reports
   * the path shape without a usable token. */
  url(link: FileLink): string {
    return `/files/<token>#${link.id}`;
  },
};

export const messageEventResolvers = {
  /** Loads the annotated mail. The event was only reachable through a
   * scope-filtered path (Message.events or the scoped agenda query), so
   * this lookup does not widen visibility. */
  async message(
    event: MessageEvent,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<Message | null> {
    return ctx.deps.messageRepository.findById(event.messageId);
  },
};

export const classificationRuleResolvers = {
  async domain(rule: ClassificationRule, _args: unknown, ctx: GraphQLContext) {
    return rule.domainId === null
      ? null
      : ctx.loaders.domainById.load(rule.domainId);
  },

  async tag(rule: ClassificationRule, _args: unknown, ctx: GraphQLContext) {
    if (rule.tagId === null) {
      return null;
    }
    const tags = await ctx.deps.tagRepository.findByIds([rule.tagId]);
    return tags[0] ?? null;
  },
};

export const threadResolvers = {
  messageCount(thread: { readonly messages: readonly Message[] }): number {
    return thread.messages.length;
  },

  async participants(
    thread: { readonly messages: readonly Message[] },
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly MailboxAddressView[]> {
    const byAddress = new Map<string, MailboxAddressView>();
    for (const message of thread.messages) {
      byAddress.set(message.fromAddress, {
        address: message.fromAddress,
        name: message.fromName,
        kind: RecipientKind.To,
      });
    }
    const recipientLists = await ctx.loaders.recipientsByMessage.loadMany(
      thread.messages.map((message) => message.id),
    );
    for (const recipients of recipientLists) {
      for (const recipient of recipients) {
        if (!byAddress.has(recipient.address)) {
          byAddress.set(recipient.address, toMailboxAddress(recipient));
        }
      }
    }
    return [...byAddress.values()];
  },
};

export const viewerResolvers = {
  async user(source: ViewerSource, _args: unknown, ctx: GraphQLContext) {
    return ctx.usecases.getViewerUser(source.viewer);
  },

  async apiKey(
    source: ViewerSource,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<ApiKey | null> {
    return source.viewer.kind === "API_KEY"
      ? ctx.deps.apiKeyRepository.findById(source.viewer.apiKeyId)
      : null;
  },

  capabilities(source: ViewerSource): readonly Capability[] {
    return viewerCapabilities(source.viewer);
  },

  async sendableAddresses(
    source: ViewerSource,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly string[]> {
    return ctx.usecases.listSendableAddresses(source.viewer);
  },
};

export const userResolvers = {
  active(user: User): boolean {
    return isUserActive(user);
  },

  /** Loader-based, like `ApiKey.scopes` -- the use cases that return a
   * `User` do not bundle its permissions, so this always re-fetches rather
   * than trusting a caller-supplied shape. */
  async permissions(
    user: User,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly UserMailPermission[]> {
    return ctx.loaders.permissionsByUser.load(user.id);
  },

  async templatePermissions(user: User, _args: unknown, ctx: GraphQLContext) {
    return ctx.loaders.templatePermissionsByUser.load(user.id);
  },

  async calendarPermissions(user: User, _args: unknown, ctx: GraphQLContext) {
    return ctx.loaders.calendarPermissionsByUser.load(user.id);
  },
};

export const userMailPermissionResolvers = {
  async domain(
    permission: UserMailPermission,
    _args: unknown,
    ctx: GraphQLContext,
  ) {
    return permission.domainId === null
      ? null
      : ctx.loaders.domainById.load(permission.domainId);
  },
};

export const apiKeyWithSecretResolvers = {
  apiKey(source: { readonly apiKey: ApiKey }): ApiKey {
    return source.apiKey;
  },
  /** Passed through from the mutation result; never re-read from storage,
   * which holds only the hash. */
  secret(source: { readonly secret: string }): string {
    return source.secret;
  },
};
