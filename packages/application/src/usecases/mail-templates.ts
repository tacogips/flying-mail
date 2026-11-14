import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailTemplate,
  type MailTemplate,
  type MailTemplateContentInput,
  templateSources,
  updateMailTemplate,
} from "@mailcal/domain/entities/mail-template";
import {
  createMailTemplateId,
  type MailTemplateId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, ConflictError, NotFoundError } from "../errors";
import { requireTemplateCapability } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import { TemplateSyntaxError } from "../ports/template-renderer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Turns the renderer's own error into the transport-level one. Kept here
 * rather than in `translate-domain-error.ts` because a syntax error is not
 * a `DomainError`: the renderer is an adapter, and the application layer is
 * what knows the failure is the caller's fault. */
function asBadInput(error: unknown): never {
  if (error instanceof TemplateSyntaxError) {
    throw new BadUserInputError(error.message, error.field);
  }
  throw error;
}

/** Every top-level `it.<key>` the template's sources read, across subject,
 * bodies and recipient slots. Parsing every source is also the syntax check
 * -- which is why it runs on the write path, not the send path. */
export function collectReferencedVariables(
  deps: AppDependencies,
  content: Pick<
    MailTemplate,
    "subject" | "textBody" | "htmlBody" | "from" | "to" | "cc" | "bcc"
  >,
): readonly string[] {
  const keys: string[] = [];
  try {
    for (const { field, source } of templateSources(content)) {
      for (const key of deps.templateRenderer.referencedVariables(
        source,
        field,
      )) {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
    }
  } catch (error) {
    return asBadInput(error);
  }
  return keys;
}

/** Rejects a template whose source reads a variable it does not declare.
 *
 * The inverse -- a declared variable nothing reads -- is deliberately
 * allowed: an operator may add the variable first and the body second, and
 * failing that edit would be a worse experience than an unused field. */
function assertEveryReferenceDeclared(
  deps: AppDependencies,
  template: MailTemplate,
): void {
  const declared = new Set(template.variables.map((variable) => variable.key));
  const undeclared = collectReferencedVariables(deps, template).filter(
    (key) => !declared.has(key),
  );
  if (undeclared.length > 0) {
    throw new BadUserInputError(
      `the template reads ${undeclared.map((key) => `it.${key}`).join(", ")}, which ${undeclared.length === 1 ? "is not a declared variable" : "are not declared variables"}`,
      "variables",
    );
  }
}

export function createListMailTemplatesUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly MailTemplate[]> {
  return async (viewer) => {
    requireTemplateCapability(viewer, Capability.TemplateRead);
    return deps.mailTemplateRepository.list();
  };
}

export function createGetMailTemplateUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: MailTemplateId) => Promise<MailTemplate | null> {
  return async (viewer, id) => {
    requireTemplateCapability(viewer, Capability.TemplateRead);
    return deps.mailTemplateRepository.findById(id);
  };
}

/** Loads a template for an operation that cannot proceed without it. */
export async function requireTemplate(
  deps: AppDependencies,
  id: MailTemplateId,
): Promise<MailTemplate> {
  const template = await deps.mailTemplateRepository.findById(id);
  if (template === null) {
    throw new NotFoundError("MailTemplate", id);
  }
  return template;
}

async function assertNameAvailable(
  deps: AppDependencies,
  name: string,
  excludingId: MailTemplateId | null,
): Promise<void> {
  const collision = await deps.mailTemplateRepository.findByName(name);
  if (collision !== null && collision.id !== excludingId) {
    throw new ConflictError(`A template named "${name.trim()}" already exists`);
  }
}

export function createCreateMailTemplateUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: MailTemplateContentInput) => Promise<MailTemplate> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTemplateCapability(viewer, Capability.TemplateCreate);
      await assertNameAvailable(deps, input.name, null);
      const template = createMailTemplate({
        ...input,
        id: createMailTemplateId(deps.random.uuid()),
        createdByUserId: viewer.kind === "USER" ? viewer.userId : null,
        createdAt: deps.clock.now().toISOString(),
      });
      assertEveryReferenceDeclared(deps, template);
      await deps.mailTemplateRepository.save(template);
      return template;
    });
}

export function createUpdateMailTemplateUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: MailTemplateId,
  input: MailTemplateContentInput,
) => Promise<MailTemplate> {
  return async (viewer, id, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTemplateCapability(viewer, Capability.TemplateUpdate);
      const existing = await requireTemplate(deps, id);
      await assertNameAvailable(deps, input.name, id);
      const updated = updateMailTemplate(
        existing,
        input,
        deps.clock.now().toISOString(),
      );
      assertEveryReferenceDeclared(deps, updated);
      await deps.mailTemplateRepository.save(updated);
      return updated;
    });
}

export function createDeleteMailTemplateUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: MailTemplateId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      requireTemplateCapability(viewer, Capability.TemplateDelete);
      await requireTemplate(deps, id);
      await deps.mailTemplateRepository.delete(id);
      return true;
    });
}

/** The keys a stored template's sources read. Exposed on the read path so a
 * client can show which declared variables are actually used. */
export function createMailTemplateReferencesUseCase(
  deps: AppDependencies,
): (template: MailTemplate) => readonly string[] {
  return (template) => collectReferencedVariables(deps, template);
}
