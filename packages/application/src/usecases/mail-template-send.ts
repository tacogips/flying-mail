import { Capability } from "@mailcal/domain/entities/api-key";
import type { MailTemplate } from "@mailcal/domain/entities/mail-template";
import type { Message } from "@mailcal/domain/entities/message";
import {
  buildTemplateRenderData,
  describeTemplateValidation,
  type TemplateValidation,
  type TemplateValueEntry,
  validateTemplateValues,
} from "@mailcal/domain/entities/template-values";
import type {
  AttachmentId,
  MailTemplateId,
  MessageId,
  TagId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError } from "../errors";
import { requireTemplateCapability } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import {
  type TemplateEscapeMode,
  TemplateSyntaxError,
} from "../ports/template-renderer";
import { requireTemplate } from "./mail-templates";
import type { SendMessageHeaderInput, SendMessageInput } from "./send";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Everything {@link renderTemplate} and its helper need from
 * `AppDependencies`. Narrowed so the render path can be unit-tested without
 * constructing a full dependency set. */
export type TemplateRenderDependencies = Pick<
  AppDependencies,
  "templateRenderer"
>;

/** The exact mail a template plus a value set produces. What the web
 * client's review step displays, and what the send path is handed. */
export interface RenderedTemplate {
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly validation: TemplateValidation;
}

export interface SendTemplatedMessageInput {
  readonly templateId: MailTemplateId;
  readonly values: readonly TemplateValueEntry[];
  /** Each override replaces the template's rendered value entirely. An
   * omitted field keeps whatever the template produced. */
  readonly from?: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly inReplyToMessageId?: MessageId;
  readonly attachmentIds?: readonly AttachmentId[];
  readonly headers?: readonly SendMessageHeaderInput[];
  readonly tagIds?: readonly TagId[];
}

/** A rendered recipient slot may name several addresses -- one variable can
 * expand to a whole list -- so each slot is split the way a mail client's
 * address field is. */
function splitAddresses(rendered: string): readonly string[] {
  return rendered
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function renderSlot(
  deps: TemplateRenderDependencies,
  source: string,
  data: Readonly<Record<string, string | number | boolean>>,
  mode: TemplateEscapeMode,
  field: string,
): string {
  try {
    return deps.templateRenderer.render(source, data, { escape: mode }, field);
  } catch (error) {
    if (error instanceof TemplateSyntaxError) {
      // A stored template was validated at write time, so reaching here
      // means the row predates a grammar change or was written around the
      // API. Report it as the caller's problem, naming the field.
      throw new BadUserInputError(error.message, error.field);
    }
    throw error;
  }
}

/** Renders a template without any authorization or send side effect. */
export function renderTemplate(
  deps: TemplateRenderDependencies,
  template: MailTemplate,
  values: readonly TemplateValueEntry[],
): RenderedTemplate {
  const validation = validateTemplateValues(template.variables, values);
  const data = buildTemplateRenderData(template.variables, values);
  const renderList = (
    sources: readonly string[],
    field: string,
  ): readonly string[] =>
    sources.flatMap((source, index) =>
      splitAddresses(
        renderSlot(deps, source, data, "none", `${field}[${index}]`),
      ),
    );

  return {
    subject: renderSlot(deps, template.subject, data, "none", "subject"),
    text:
      template.textBody === null
        ? null
        : renderSlot(deps, template.textBody, data, "none", "textBody"),
    // Only the HTML body escapes interpolations: doing it anywhere else
    // would put `&amp;` into a plain-text mail or a subject line.
    html:
      template.htmlBody === null
        ? null
        : renderSlot(deps, template.htmlBody, data, "html", "htmlBody"),
    from:
      template.from === null
        ? null
        : renderSlot(deps, template.from, data, "none", "from").trim(),
    to: renderList(template.to, "to"),
    cc: renderList(template.cc, "cc"),
    bcc: renderList(template.bcc, "bcc"),
    validation,
  };
}

/** Validation only -- never renders. Cheap enough for the web client to
 * call as the user types, which is how the review step stays gated on a
 * server-side answer rather than a client-side guess. */
export function createValidateMailTemplateValuesUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: MailTemplateId,
  values: readonly TemplateValueEntry[],
) => Promise<TemplateValidation> {
  return async (viewer, id, values) => {
    requireTemplateCapability(viewer, Capability.TemplateRead);
    const template = await requireTemplate(deps, id);
    return validateTemplateValues(template.variables, values);
  };
}

/** The review step. Requires `TEMPLATE_READ` only: rendering touches no
 * mailbox and sends nothing. */
export function createPreviewMailTemplateUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: MailTemplateId,
  values: readonly TemplateValueEntry[],
) => Promise<RenderedTemplate> {
  return async (viewer, id, values) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTemplateCapability(viewer, Capability.TemplateRead);
      const template = await requireTemplate(deps, id);
      const rendered = renderTemplate(deps, template, values);
      if (!rendered.validation.valid) {
        throw new BadUserInputError(
          describeTemplateValidation(rendered.validation),
          "values",
        );
      }
      return rendered;
    });
}

/** Sends from a template.
 *
 * Renders server-side from the stored row rather than trusting anything the
 * client previewed, then hands the result to the ordinary send use case --
 * so the managed-domain check, the `MAIL_SEND` address capability, recipient
 * limits and the header-injection guard all apply unchanged. Reading the
 * template additionally needs `TEMPLATE_READ`; neither capability implies
 * the other. */
export function createSendTemplatedMessageUseCase(
  deps: AppDependencies,
  sendMessage: (viewer: Viewer, input: SendMessageInput) => Promise<Message>,
): (viewer: Viewer, input: SendTemplatedMessageInput) => Promise<Message> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTemplateCapability(viewer, Capability.TemplateRead);
      const template = await requireTemplate(deps, input.templateId);
      const rendered = renderTemplate(deps, template, input.values);
      if (!rendered.validation.valid) {
        throw new BadUserInputError(
          describeTemplateValidation(rendered.validation),
          "values",
        );
      }

      const from = input.from ?? rendered.from;
      if (from === null || from === undefined || from.length === 0) {
        throw new BadUserInputError(
          "this template declares no sender, so the send must supply one",
          "from",
        );
      }
      const to = input.to ?? rendered.to;
      const cc = input.cc ?? rendered.cc;
      const bcc = input.bcc ?? rendered.bcc;

      return sendMessage(viewer, {
        from,
        to,
        subject: rendered.subject,
        ...(cc.length === 0 ? {} : { cc }),
        ...(bcc.length === 0 ? {} : { bcc }),
        ...(rendered.text === null ? {} : { text: rendered.text }),
        ...(rendered.html === null ? {} : { html: rendered.html }),
        ...(input.inReplyToMessageId === undefined
          ? {}
          : { inReplyToMessageId: input.inReplyToMessageId }),
        ...(input.attachmentIds === undefined
          ? {}
          : { attachmentIds: input.attachmentIds }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
      });
    });
}
