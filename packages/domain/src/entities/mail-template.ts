import { ValidationError } from "../errors";
import type { MailTemplateId, UserId } from "../value-objects/ids";

/** The widget the web client renders for a variable, and the coercion the
 * server applies to its submitted string. See
 * `design-docs/specs/design-mail-templates.md#variables`. */
export enum TemplateVariableType {
  Text = "TEXT",
  MultilineText = "MULTILINE_TEXT",
  Number = "NUMBER",
  Boolean = "BOOLEAN",
  Date = "DATE",
  Email = "EMAIL",
}

/** One declared field of the object a template is rendered with. A variable
 * named `customerName` is written `<%= it.customerName %>` in the Eta
 * source. */
export interface TemplateVariable {
  readonly key: string;
  readonly label: string;
  readonly type: TemplateVariableType;
  readonly required: boolean;
  /** Used when the caller supplies no value. A variable with a default is
   * never reported as missing, whatever `required` says. */
  readonly defaultValue: string | null;
  readonly description: string | null;
}

/** A stored, reusable mail body. `subject`, the two bodies and every
 * recipient slot are Eta sources; `variables` declares what may appear in
 * them.
 *
 * Templates are instance-wide: they carry no domain and no mailbox. The
 * mailbox authorization that matters happens at send time, against the
 * resolved `from` address, on the ordinary send path. */
export interface MailTemplate {
  readonly id: MailTemplateId;
  readonly name: string;
  readonly description: string | null;
  readonly subject: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  /** Default sender, as an Eta source. `null` means the send must supply
   * one. */
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly variables: readonly TemplateVariable[];
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TemplateVariableInput {
  readonly key: string;
  readonly label?: string | null;
  readonly type: TemplateVariableType;
  readonly required?: boolean;
  readonly defaultValue?: string | null;
  readonly description?: string | null;
}

export interface MailTemplateContentInput {
  readonly name: string;
  readonly description?: string | null;
  readonly subject: string;
  readonly textBody?: string | null;
  readonly htmlBody?: string | null;
  readonly from?: string | null;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly variables: readonly TemplateVariableInput[];
}

export interface CreateMailTemplateInput extends MailTemplateContentInput {
  readonly id: MailTemplateId;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
}

export const MAX_TEMPLATE_NAME_LENGTH = 128;
export const MAX_TEMPLATE_VARIABLES = 64;
/** Bounds a single Eta source. Generous for real mail, small enough that
 * parsing a stored template can never become the request's cost centre. */
export const MAX_TEMPLATE_SOURCE_LENGTH = 64 * 1024;

/** Variable keys are JavaScript-identifier-shaped because they are read as
 * `it.<key>` in the template. A key that needed bracket syntax would be a
 * trap for the person writing the body. */
const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireText(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(`${field} must not be empty`, field);
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `${field} must be at most ${maxLength} characters`,
      field,
    );
  }
  return trimmed;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Keeps a body only when it has content. An empty-string body would
 * otherwise satisfy the "at least one body" rule while sending blank
 * mail. */
function normalizeBody(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value.length > MAX_TEMPLATE_SOURCE_LENGTH) {
    throw new ValidationError(
      `${field} must be at most ${MAX_TEMPLATE_SOURCE_LENGTH} characters`,
      field,
    );
  }
  return value.trim().length === 0 ? null : value;
}

function normalizeRecipients(
  values: readonly string[] | undefined,
  field: string,
): readonly string[] {
  const entries = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const entry of entries) {
    if (entry.length > MAX_TEMPLATE_SOURCE_LENGTH) {
      throw new ValidationError(
        `${field} entries must be at most ${MAX_TEMPLATE_SOURCE_LENGTH} characters`,
        field,
      );
    }
  }
  return entries;
}

export function normalizeTemplateVariables(
  inputs: readonly TemplateVariableInput[],
): readonly TemplateVariable[] {
  if (inputs.length > MAX_TEMPLATE_VARIABLES) {
    throw new ValidationError(
      `a template may declare at most ${MAX_TEMPLATE_VARIABLES} variables`,
      "variables",
    );
  }
  const seen = new Set<string>();
  return inputs.map((input) => {
    const key = input.key.trim();
    if (!VARIABLE_KEY_PATTERN.test(key)) {
      throw new ValidationError(
        `variable key "${input.key}" must start with a letter or underscore and contain only letters, digits and underscores`,
        "variables",
      );
    }
    if (seen.has(key)) {
      throw new ValidationError(
        `variable key "${key}" is declared more than once`,
        "variables",
      );
    }
    seen.add(key);
    const label = normalizeOptional(input.label);
    return {
      key,
      // An unlabelled variable falls back to its key rather than rendering
      // an empty form label the user cannot identify.
      label: label ?? key,
      type: input.type,
      required: input.required ?? true,
      defaultValue: input.defaultValue ?? null,
      description: normalizeOptional(input.description),
    };
  });
}

function buildContent(
  input: MailTemplateContentInput,
): Omit<MailTemplate, "id" | "createdByUserId" | "createdAt" | "updatedAt"> {
  const textBody = normalizeBody(input.textBody, "textBody");
  const htmlBody = normalizeBody(input.htmlBody, "htmlBody");
  if (textBody === null && htmlBody === null) {
    throw new ValidationError(
      "a template must have a text or html body",
      "textBody",
    );
  }
  return {
    name: requireText(input.name, "name", MAX_TEMPLATE_NAME_LENGTH),
    description: normalizeOptional(input.description),
    subject: requireText(input.subject, "subject", MAX_TEMPLATE_SOURCE_LENGTH),
    textBody,
    htmlBody,
    from: normalizeOptional(input.from),
    to: normalizeRecipients(input.to, "to"),
    cc: normalizeRecipients(input.cc, "cc"),
    bcc: normalizeRecipients(input.bcc, "bcc"),
    variables: normalizeTemplateVariables(input.variables),
  };
}

export function createMailTemplate(
  input: CreateMailTemplateInput,
): MailTemplate {
  return {
    id: input.id,
    ...buildContent(input),
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Replaces a template's whole content, including its variable set. The set
 * is edited as a unit -- a partial variable update would leave the body
 * referencing a key the caller believed it had removed. */
export function updateMailTemplate(
  template: MailTemplate,
  input: MailTemplateContentInput,
  now: string,
): MailTemplate {
  return {
    id: template.id,
    ...buildContent(input),
    createdByUserId: template.createdByUserId,
    createdAt: template.createdAt,
    updatedAt: now,
  };
}

/** Every Eta source a template holds, paired with the field name an error
 * should name. The single place that enumerates them, so a new source field
 * cannot be added without every validator seeing it. */
export function templateSources(
  template: Pick<
    MailTemplate,
    "subject" | "textBody" | "htmlBody" | "from" | "to" | "cc" | "bcc"
  >,
): readonly { readonly field: string; readonly source: string }[] {
  const sources: { field: string; source: string }[] = [
    { field: "subject", source: template.subject },
  ];
  if (template.textBody !== null) {
    sources.push({ field: "textBody", source: template.textBody });
  }
  if (template.htmlBody !== null) {
    sources.push({ field: "htmlBody", source: template.htmlBody });
  }
  if (template.from !== null) {
    sources.push({ field: "from", source: template.from });
  }
  for (const [field, entries] of [
    ["to", template.to],
    ["cc", template.cc],
    ["bcc", template.bcc],
  ] as const) {
    entries.forEach((source, index) => {
      sources.push({ field: `${field}[${index}]`, source });
    });
  }
  return sources;
}
