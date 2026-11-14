import type { TemplateRenderValue } from "@mailcal/domain/entities/template-values";

/** Raised when a template's Eta source cannot be understood, either because
 * it is malformed or because it uses a construct outside the supported
 * grammar (see `design-docs/specs/design-mail-templates.md#template-language-eta`).
 *
 * Always surfaced at *write* time: a template that reaches storage is one
 * that will render, so a send can never fail on a syntax problem an operator
 * introduced weeks earlier. */
export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    /** The template field the offending source came from, e.g. `"subject"`
     * or `"to[1]"`. Populated by the caller that knows the field. */
    readonly field: string,
  ) {
    super(message);
    this.name = "TemplateSyntaxError";
  }
}

/** How an interpolation's value is inserted. `"html"` XML-escapes `<%= %>`
 * (never `<%~ %>`); `"none"` inserts verbatim, which is what a plain-text
 * body and a subject line need -- escaping there would turn a literal `&`
 * into `&amp;` in the delivered mail. */
export type TemplateEscapeMode = "html" | "none";

/** Renders the Eta sources a stored `MailTemplate` holds.
 *
 * Deliberately narrow: the application layer never learns which template
 * engine is behind it, and the port promises no code execution -- the
 * adapter evaluates a restricted expression grammar rather than compiling
 * the template, because the API runs on Cloudflare Workers (no runtime code
 * generation) and because a stored template is user-supplied data. */
export interface TemplateRenderer {
  /** The top-level `it.<key>` names `source` reads. Parses the whole source
   * as a side effect, so it doubles as the write-time syntax check.
   *
   * @throws TemplateSyntaxError
   */
  referencedVariables(source: string, field: string): readonly string[];

  /** Renders `source` against `data`. Only keys present in `data` resolve;
   * anything else reads as an empty string.
   *
   * @throws TemplateSyntaxError
   */
  render(
    source: string,
    data: Readonly<Record<string, TemplateRenderValue>>,
    options: { readonly escape: TemplateEscapeMode },
    field: string,
  ): string;
}
