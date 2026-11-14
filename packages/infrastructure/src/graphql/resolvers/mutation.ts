import type { ApiKeyScopeInput } from "@mailcal/application/usecases/api-keys";
import type { SendMessageInput } from "@mailcal/application/usecases/send";
import type {
  CreateUserInput,
  UserMailPermissionInput,
} from "@mailcal/application/usecases/users";
import type { Capability } from "@mailcal/domain/entities/api-key";
import type { DomainStatus } from "@mailcal/domain/entities/mail-domain";
import type { UserRole } from "@mailcal/domain/entities/user";
import {
  createClassificationRuleId,
  createMessageEventId,
  createApiKeyId,
  createApiKeyScopeId,
  createAttachmentId,
  createDomainId,
  createFileLinkId,
  createMessageId,
  createTagId,
  createUserId,
  createUserMailPermissionId,
} from "@mailcal/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import type {
  RuleAction,
  RuleField,
  RuleMatcher,
} from "@mailcal/domain/entities/classification-rule";
import type { MessageEventKind } from "@mailcal/domain/entities/message-event";
import type { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { requireViewerOrThrow } from "./helpers";
import type { ViewerSource } from "./types";

interface ScopeInputArg {
  readonly capability: Capability;
  readonly domainId?: string | null;
  readonly addressPattern?: string | null;
}

function toScopeInput(scope: ScopeInputArg): ApiKeyScopeInput {
  return {
    capability: scope.capability,
    domainId: scope.domainId == null ? null : createDomainId(scope.domainId),
    addressPattern: scope.addressPattern ?? "*",
  };
}

interface SendMessageArg {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[] | null;
  readonly bcc?: readonly string[] | null;
  readonly subject: string;
  readonly text?: string | null;
  readonly html?: string | null;
  readonly inReplyToMessageId?: string | null;
  readonly attachmentIds?: readonly string[] | null;
  readonly headers?:
    | readonly { readonly name: string; readonly value: string }[]
    | null;
  readonly tagIds?: readonly string[] | null;
}

/** Drops explicit nulls the same way `query.ts`'s filter mapper does. */
function toSendMessageInput(input: SendMessageArg): SendMessageInput {
  return {
    from: input.from,
    to: input.to,
    subject: input.subject,
    ...(input.cc == null ? {} : { cc: input.cc }),
    ...(input.bcc == null ? {} : { bcc: input.bcc }),
    ...(input.text == null ? {} : { text: input.text }),
    ...(input.html == null ? {} : { html: input.html }),
    ...(input.inReplyToMessageId == null
      ? {}
      : { inReplyToMessageId: createMessageId(input.inReplyToMessageId) }),
    ...(input.attachmentIds == null
      ? {}
      : {
          attachmentIds: input.attachmentIds.map((id) =>
            createAttachmentId(id),
          ),
        }),
    ...(input.headers == null ? {} : { headers: input.headers }),
    ...(input.tagIds == null
      ? {}
      : { tagIds: input.tagIds.map((id) => createTagId(id)) }),
  };
}

const domainMutations = {
  async createDomain(
    _parent: unknown,
    args: { readonly name: string; readonly catchAll?: boolean | null },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.createDomain(
      requireViewerOrThrow(ctx),
      args.name,
      args.catchAll ?? true,
    );
  },

  async verifyDomain(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.verifyDomain(
      requireViewerOrThrow(ctx),
      createDomainId(args.id),
    );
  },

  async setDomainStatus(
    _parent: unknown,
    args: { readonly id: string; readonly status: DomainStatus },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.setDomainStatus(
      requireViewerOrThrow(ctx),
      createDomainId(args.id),
      args.status,
    );
  },

  async deleteDomain(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteDomain(
      requireViewerOrThrow(ctx),
      createDomainId(args.id),
    );
  },
};

const apiKeyMutations = {
  async createApiKey(
    _parent: unknown,
    args: {
      readonly input: {
        readonly name: string;
        readonly scopes: readonly ScopeInputArg[];
        readonly expiresAt?: string | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.createApiKey(requireViewerOrThrow(ctx), {
      name: args.input.name,
      scopes: args.input.scopes.map(toScopeInput),
      expiresAt: args.input.expiresAt ?? null,
    });
  },

  async revokeApiKey(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.revokeApiKey(
      requireViewerOrThrow(ctx),
      createApiKeyId(args.id),
    );
  },

  async addApiKeyScope(
    _parent: unknown,
    args: { readonly apiKeyId: string; readonly scope: ScopeInputArg },
    ctx: GraphQLContext,
  ) {
    const viewer = requireViewerOrThrow(ctx);
    const apiKeyId = createApiKeyId(args.apiKeyId);
    await ctx.usecases.addApiKeyScope(
      viewer,
      apiKeyId,
      toScopeInput(args.scope),
    );
    // Returns the key so the client re-reads `scopes` through the loader,
    // rather than the mutation shipping a second, differently-shaped list.
    return ctx.deps.apiKeyRepository.findById(apiKeyId);
  },

  async removeApiKeyScope(
    _parent: unknown,
    args: { readonly scopeId: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.removeApiKeyScope(
      requireViewerOrThrow(ctx),
      createApiKeyScopeId(args.scopeId),
    );
  },
};

interface UserMailPermissionInputArg {
  readonly effect: UserPermissionEffect;
  readonly domainId?: string | null;
  readonly addressPattern?: string | null;
}

function toUserMailPermissionInput(
  input: UserMailPermissionInputArg,
): UserMailPermissionInput {
  return {
    effect: input.effect,
    domainId: input.domainId == null ? null : createDomainId(input.domainId),
    addressPattern: input.addressPattern ?? "*",
  };
}

const userMutations = {
  async createUser(
    _parent: unknown,
    args: { readonly input: CreateUserInput },
    ctx: GraphQLContext,
  ) {
    const result = await ctx.usecases.createUser(
      requireViewerOrThrow(ctx),
      args.input,
    );
    return result.user;
  },

  async setUserRole(
    _parent: unknown,
    args: { readonly id: string; readonly role: UserRole },
    ctx: GraphQLContext,
  ) {
    const result = await ctx.usecases.setUserRole(
      requireViewerOrThrow(ctx),
      createUserId(args.id),
      args.role,
    );
    return result.user;
  },

  async setUserActive(
    _parent: unknown,
    args: { readonly id: string; readonly active: boolean },
    ctx: GraphQLContext,
  ) {
    const result = await ctx.usecases.setUserActive(
      requireViewerOrThrow(ctx),
      createUserId(args.id),
      args.active,
    );
    return result.user;
  },

  async addUserMailPermission(
    _parent: unknown,
    args: {
      readonly userId: string;
      readonly input: UserMailPermissionInputArg;
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.addUserMailPermission(
      requireViewerOrThrow(ctx),
      createUserId(args.userId),
      toUserMailPermissionInput(args.input),
    );
  },

  async removeUserMailPermission(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.removeUserMailPermission(
      requireViewerOrThrow(ctx),
      createUserMailPermissionId(args.id),
    );
  },
};

const mailMutations = {
  async sendMessage(
    _parent: unknown,
    args: { readonly input: SendMessageArg },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.sendMessage(
      requireViewerOrThrow(ctx),
      toSendMessageInput(args.input),
    );
  },

  async retrySend(
    _parent: unknown,
    args: { readonly messageId: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.retrySend(
      requireViewerOrThrow(ctx),
      createMessageId(args.messageId),
    );
  },

  async markMessagesFetched(
    _parent: unknown,
    args: { readonly messageIds: readonly string[] },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.markMessagesFetched(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
    );
  },

  async markMessagesNotFetched(
    _parent: unknown,
    args: { readonly messageIds: readonly string[] },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.markMessagesNotFetched(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
    );
  },

  async markRead(
    _parent: unknown,
    args: { readonly messageIds: readonly string[]; readonly read: boolean },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.markRead(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
      args.read,
    );
  },

  async deleteMessages(
    _parent: unknown,
    args: { readonly messageIds: readonly string[] },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteMessages(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
    );
  },
};

const tagMutations = {
  async createTag(
    _parent: unknown,
    args: { readonly name: string; readonly color?: string | null },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.createTag(
      requireViewerOrThrow(ctx),
      args.name,
      args.color ?? null,
    );
  },

  async renameTag(
    _parent: unknown,
    args: {
      readonly id: string;
      readonly name: string;
      readonly color?: string | null;
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.renameTag(
      requireViewerOrThrow(ctx),
      createTagId(args.id),
      args.name,
      args.color ?? null,
    );
  },

  async deleteTag(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteTag(
      requireViewerOrThrow(ctx),
      createTagId(args.id),
    );
  },

  async tagMessages(
    _parent: unknown,
    args: {
      readonly messageIds: readonly string[];
      readonly tagIds: readonly string[];
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.tagMessages(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
      args.tagIds.map((id) => createTagId(id)),
    );
  },

  async untagMessages(
    _parent: unknown,
    args: {
      readonly messageIds: readonly string[];
      readonly tagIds: readonly string[];
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.untagMessages(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
      args.tagIds.map((id) => createTagId(id)),
    );
  },

  async saveDraft(
    _parent: unknown,
    args: {
      readonly input: {
        readonly draftId?: string | null;
        readonly inReplyToMessageId?: string | null;
        readonly from: string;
        readonly to?: readonly string[] | null;
        readonly cc?: readonly string[] | null;
        readonly bcc?: readonly string[] | null;
        readonly subject?: string | null;
        readonly text?: string | null;
        readonly html?: string | null;
        readonly attachmentIds?: readonly string[] | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    const input = args.input;
    return ctx.usecases.saveDraft(requireViewerOrThrow(ctx), {
      from: input.from,
      ...(input.draftId == null
        ? {}
        : { draftId: createMessageId(input.draftId) }),
      ...(input.inReplyToMessageId == null
        ? {}
        : { inReplyToMessageId: createMessageId(input.inReplyToMessageId) }),
      ...(input.to == null ? {} : { to: input.to }),
      ...(input.cc == null ? {} : { cc: input.cc }),
      ...(input.bcc == null ? {} : { bcc: input.bcc }),
      ...(input.subject == null ? {} : { subject: input.subject }),
      ...(input.text == null ? {} : { text: input.text }),
      ...(input.html == null ? {} : { html: input.html }),
      ...(input.attachmentIds == null
        ? {}
        : {
            attachmentIds: input.attachmentIds.map((id) =>
              createAttachmentId(id),
            ),
          }),
    });
  },

  async sendDraft(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.sendDraft(
      requireViewerOrThrow(ctx),
      createMessageId(args.id),
    );
  },

  async createMessageEvent(
    _parent: unknown,
    args: {
      readonly input: {
        readonly messageId: string;
        readonly kind: MessageEventKind;
        readonly dueAt?: string | null;
        readonly title: string;
        readonly note?: string | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.createMessageEvent(requireViewerOrThrow(ctx), {
      messageId: createMessageId(args.input.messageId),
      kind: args.input.kind,
      dueAt: args.input.dueAt ?? null,
      title: args.input.title,
      note: args.input.note ?? null,
    });
  },

  async updateMessageEvent(
    _parent: unknown,
    args: {
      readonly id: string;
      readonly input: {
        readonly kind?: MessageEventKind | null;
        readonly dueAt?: string | null;
        readonly title?: string | null;
        readonly note?: string | null;
        readonly completed?: boolean | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    const input = args.input;
    return ctx.usecases.updateMessageEvent(
      requireViewerOrThrow(ctx),
      createMessageEventId(args.id),
      {
        ...(input.kind == null ? {} : { kind: input.kind }),
        // dueAt: null is a meaningful "remove the date", so undefined and
        // null must stay distinguishable here.
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.title == null ? {} : { title: input.title }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.completed == null ? {} : { completed: input.completed }),
      },
    );
  },

  async deleteMessageEvent(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteMessageEvent(
      requireViewerOrThrow(ctx),
      createMessageEventId(args.id),
    );
  },

  async createClassificationRule(
    _parent: unknown,
    args: {
      readonly input: {
        readonly domainId?: string | null;
        readonly field: RuleField;
        readonly matcher: RuleMatcher;
        readonly pattern: string;
        readonly action: RuleAction;
        readonly tagId?: string | null;
        readonly description?: string | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    const input = args.input;
    return ctx.usecases.createClassificationRule(requireViewerOrThrow(ctx), {
      domainId: input.domainId == null ? null : createDomainId(input.domainId),
      field: input.field,
      matcher: input.matcher,
      pattern: input.pattern,
      action: input.action,
      tagId: input.tagId == null ? null : createTagId(input.tagId),
      description: input.description ?? null,
    });
  },

  async setClassificationRuleEnabled(
    _parent: unknown,
    args: { readonly id: string; readonly enabled: boolean },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.setClassificationRuleEnabled(
      requireViewerOrThrow(ctx),
      createClassificationRuleId(args.id),
      args.enabled,
    );
  },

  async applyClassificationRule(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.applyClassificationRule(
      requireViewerOrThrow(ctx),
      createClassificationRuleId(args.id),
    );
  },

  async deleteClassificationRule(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteClassificationRule(
      requireViewerOrThrow(ctx),
      createClassificationRuleId(args.id),
    );
  },

  async markSpam(
    _parent: unknown,
    args: { readonly messageIds: readonly string[] },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.markSpam(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
    );
  },

  async markNotSpam(
    _parent: unknown,
    args: { readonly messageIds: readonly string[] },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.markNotSpam(
      requireViewerOrThrow(ctx),
      args.messageIds.map((id) => createMessageId(id)),
    );
  },
};

const fileLinkMutations = {
  async createAttachmentLink(
    _parent: unknown,
    args: {
      readonly attachmentId: string;
      readonly ttlSeconds?: number | null;
      readonly maxDownloads?: number | null;
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.createAttachmentLink(
      requireViewerOrThrow(ctx),
      createAttachmentId(args.attachmentId),
      args.ttlSeconds ?? undefined,
      args.maxDownloads ?? null,
    );
  },

  async createRawMessageLink(
    _parent: unknown,
    args: {
      readonly messageId: string;
      readonly ttlSeconds?: number | null;
      readonly maxDownloads?: number | null;
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.createRawMessageLink(
      requireViewerOrThrow(ctx),
      createMessageId(args.messageId),
      args.ttlSeconds ?? undefined,
      args.maxDownloads ?? null,
    );
  },

  async revokeFileLink(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.revokeFileLink(
      requireViewerOrThrow(ctx),
      createFileLinkId(args.id),
    );
  },
};

const authMutations = {
  /** Deliberately unauthenticated: it is the only way to create the first
   * admin on a deployment with no shell. The use case refuses once any user
   * exists, so the door closes permanently after one successful call. */
  async bootstrapAdmin(
    _parent: unknown,
    args: { readonly email: string; readonly name: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.bootstrapAdmin(args.email, args.name);
  },

  /** Always resolves `true`; see `usecases/email-auth.ts` for why it must
   * not reveal whether the address is known. */
  async requestEmailAuth(
    _parent: unknown,
    args: { readonly email: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.requestEmailAuth(args.email);
  },

  async verifyEmailAuthToken(
    _parent: unknown,
    args: { readonly token: string },
    ctx: GraphQLContext,
  ): Promise<{
    readonly viewer: ViewerSource;
    readonly expiresAt: string;
  }> {
    const result = await ctx.usecases.verifyEmailAuthToken(args.token);
    // The resolver only records the *intent*; `http/app.ts` renders the
    // header, because only it knows whether `Secure` applies.
    ctx.sessionCookies.setSession(
      result.token,
      new Date(result.session.expiresAt),
    );
    // The three rule sets travel together, exactly as
    // `resolveViewerFromToken` loads them: a partially-loaded viewer would
    // under-authorize the very first request after sign-in.
    const [permissions, templatePermissions, calendarPermissions] =
      await Promise.all([
        ctx.deps.userMailPermissionRepository.listByUserId(result.user.id),
        ctx.deps.userTemplatePermissionRepository.listByUserId(result.user.id),
        ctx.deps.userCalendarPermissionRepository.listByUserId(result.user.id),
      ]);
    return {
      viewer: {
        viewer: {
          kind: "USER",
          userId: result.user.id,
          role: result.user.role,
          permissions,
          templatePermissions,
          calendarPermissions,
        },
      },
      expiresAt: result.session.expiresAt,
    };
  },

  async logout(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    ctx.sessionCookies.clearSession();
    return ctx.token === null ? true : ctx.usecases.logout(ctx.token);
  },
};

export const mutationResolvers = {
  ...domainMutations,
  ...apiKeyMutations,
  ...mailMutations,
  ...tagMutations,
  ...fileLinkMutations,
  ...authMutations,
  ...userMutations,
};
