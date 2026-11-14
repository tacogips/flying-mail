import type { MailTemplateContentInput } from "@mailcal/application/usecases";
import type { SendTemplatedMessageInput } from "@mailcal/application/usecases/mail-template-send";
import type { UserCalendarPermissionInput } from "@mailcal/application/usecases/user-calendar-permissions";
import type { UserTemplatePermissionInput } from "@mailcal/application/usecases/user-template-permissions";
import type {
  CalendarCapability,
  TemplateCapability,
} from "@mailcal/domain/entities/api-key";
import type {
  MailTemplate,
  TemplateVariableType,
} from "@mailcal/domain/entities/mail-template";
import type { TemplateValueEntry } from "@mailcal/domain/entities/template-values";
import type { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import {
  createAttachmentId,
  createMailTemplateId,
  createMessageId,
  createTagId,
  createUserId,
  createUserCalendarPermissionId,
  createUserTemplatePermissionId,
} from "@mailcal/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

interface TemplateVariableArg {
  readonly key: string;
  readonly label?: string | null;
  readonly type: TemplateVariableType;
  readonly required?: boolean | null;
  readonly defaultValue?: string | null;
  readonly description?: string | null;
}

interface MailTemplateArg {
  readonly name: string;
  readonly description?: string | null;
  readonly subject: string;
  readonly textBody?: string | null;
  readonly htmlBody?: string | null;
  readonly from?: string | null;
  readonly to?: readonly string[] | null;
  readonly cc?: readonly string[] | null;
  readonly bcc?: readonly string[] | null;
  readonly variables: readonly TemplateVariableArg[];
}

interface TemplateValueArg {
  readonly key: string;
  readonly value: string;
}

/** Drops explicit nulls the same way `query.ts`'s filter mapper does: under
 * `exactOptionalPropertyTypes`, GraphQL's "not supplied" null is not a value
 * the domain factory may see. */
function toTemplateContentInput(
  input: MailTemplateArg,
): MailTemplateContentInput {
  return {
    name: input.name,
    subject: input.subject,
    ...(input.description == null ? {} : { description: input.description }),
    ...(input.textBody == null ? {} : { textBody: input.textBody }),
    ...(input.htmlBody == null ? {} : { htmlBody: input.htmlBody }),
    ...(input.from == null ? {} : { from: input.from }),
    ...(input.to == null ? {} : { to: input.to }),
    ...(input.cc == null ? {} : { cc: input.cc }),
    ...(input.bcc == null ? {} : { bcc: input.bcc }),
    variables: input.variables.map((variable) => ({
      key: variable.key,
      type: variable.type,
      ...(variable.label == null ? {} : { label: variable.label }),
      ...(variable.required == null ? {} : { required: variable.required }),
      ...(variable.defaultValue == null
        ? {}
        : { defaultValue: variable.defaultValue }),
      ...(variable.description == null
        ? {}
        : { description: variable.description }),
    })),
  };
}

function toValues(
  values: readonly TemplateValueArg[],
): readonly TemplateValueEntry[] {
  return values.map((entry) => ({ key: entry.key, value: entry.value }));
}

export const templateQueryResolvers = {
  async mailTemplates(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    return ctx.usecases.listMailTemplates(requireViewerOrThrow(ctx));
  },

  async mailTemplate(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.getMailTemplate(
      requireViewerOrThrow(ctx),
      createMailTemplateId(args.id),
    );
  },

  async mailTemplateValidation(
    _parent: unknown,
    args: {
      readonly id: string;
      readonly values: readonly TemplateValueArg[];
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.validateMailTemplateValues(
      requireViewerOrThrow(ctx),
      createMailTemplateId(args.id),
      toValues(args.values),
    );
  },

  async previewMailTemplate(
    _parent: unknown,
    args: {
      readonly id: string;
      readonly values: readonly TemplateValueArg[];
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.previewMailTemplate(
      requireViewerOrThrow(ctx),
      createMailTemplateId(args.id),
      toValues(args.values),
    );
  },
};

export const templateMutationResolvers = {
  async createMailTemplate(
    _parent: unknown,
    args: { readonly input: MailTemplateArg },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.createMailTemplate(
      requireViewerOrThrow(ctx),
      toTemplateContentInput(args.input),
    );
  },

  async updateMailTemplate(
    _parent: unknown,
    args: { readonly id: string; readonly input: MailTemplateArg },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.updateMailTemplate(
      requireViewerOrThrow(ctx),
      createMailTemplateId(args.id),
      toTemplateContentInput(args.input),
    );
  },

  async deleteMailTemplate(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.deleteMailTemplate(
      requireViewerOrThrow(ctx),
      createMailTemplateId(args.id),
    );
  },

  async sendTemplatedMessage(
    _parent: unknown,
    args: {
      readonly input: {
        readonly templateId: string;
        readonly values: readonly TemplateValueArg[];
        readonly from?: string | null;
        readonly to?: readonly string[] | null;
        readonly cc?: readonly string[] | null;
        readonly bcc?: readonly string[] | null;
        readonly inReplyToMessageId?: string | null;
        readonly attachmentIds?: readonly string[] | null;
        readonly headers?:
          | readonly { readonly name: string; readonly value: string }[]
          | null;
        readonly tagIds?: readonly string[] | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    const input = args.input;
    const mapped: SendTemplatedMessageInput = {
      templateId: createMailTemplateId(input.templateId),
      values: toValues(input.values),
      ...(input.from == null ? {} : { from: input.from }),
      ...(input.to == null ? {} : { to: input.to }),
      ...(input.cc == null ? {} : { cc: input.cc }),
      ...(input.bcc == null ? {} : { bcc: input.bcc }),
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
    return ctx.usecases.sendTemplatedMessage(requireViewerOrThrow(ctx), mapped);
  },

  async addUserTemplatePermission(
    _parent: unknown,
    args: {
      readonly userId: string;
      readonly input: {
        readonly capability: TemplateCapability;
        readonly effect: UserPermissionEffect;
      };
    },
    ctx: GraphQLContext,
  ) {
    const input: UserTemplatePermissionInput = {
      capability: args.input.capability,
      effect: args.input.effect,
    };
    return ctx.usecases.addUserTemplatePermission(
      requireViewerOrThrow(ctx),
      createUserId(args.userId),
      input,
    );
  },

  async removeUserTemplatePermission(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.removeUserTemplatePermission(
      requireViewerOrThrow(ctx),
      createUserTemplatePermissionId(args.id),
    );
  },

  async addUserCalendarPermission(
    _parent: unknown,
    args: {
      readonly userId: string;
      readonly input: {
        readonly capability: CalendarCapability;
        readonly effect: UserPermissionEffect;
        readonly ownerUserId?: string | null;
      };
    },
    ctx: GraphQLContext,
  ) {
    const input: UserCalendarPermissionInput = {
      capability: args.input.capability,
      effect: args.input.effect,
      // An absent owner is the all-owners rule, not "not supplied": the
      // two are the same thing on this input.
      ownerUserId:
        args.input.ownerUserId == null
          ? null
          : createUserId(args.input.ownerUserId),
    };
    return ctx.usecases.addUserCalendarPermission(
      requireViewerOrThrow(ctx),
      createUserId(args.userId),
      input,
    );
  },

  async removeUserCalendarPermission(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.removeUserCalendarPermission(
      requireViewerOrThrow(ctx),
      createUserCalendarPermissionId(args.id),
    );
  },
};

export const mailTemplateResolvers = {
  /** Derived from the stored sources rather than a column, so it can never
   * drift from what the template actually reads. Parsing is in-memory and
   * needs no I/O. */
  referencedVariableKeys(
    template: MailTemplate,
    _args: unknown,
    ctx: GraphQLContext,
  ): readonly string[] {
    return ctx.usecases.mailTemplateReferences(template);
  },
};
