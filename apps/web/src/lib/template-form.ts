import type {
  MailTemplateView,
  TemplateValidationView,
  TemplateValueInput,
} from "../api/schema-types";

/** Pure helpers behind the template send flow and the template editor.
 *
 * Kept out of the components so they can be unit-tested directly -- the web
 * suite tests logic, not rendering. */

/** Splits a comma/semicolon/newline-separated address field the way a mail
 * client's To box does. */
export function splitAddressField(value: string): readonly string[] {
  return value
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Pre-fills each declared variable with its default, so a template whose
 * variables all carry defaults is ready to review immediately. */
export function initialTemplateValues(
  template: Pick<MailTemplateView, "variables">,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const variable of template.variables) {
    values[variable.key] = variable.defaultValue ?? "";
  }
  return values;
}

/** The wire shape the validation/preview/send operations take. */
export function toTemplateValueList(
  values: Readonly<Record<string, string>>,
): readonly TemplateValueInput[] {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

/** What to tell the user is still standing between them and the review
 * step. `null` means nothing is -- the gate is open.
 *
 * Deliberately derived from the *server's* answer rather than re-deriving
 * the rules here: a client-side copy of "is this filled in?" would be one
 * more place for the two to disagree. */
export function describeTemplateGate(
  validation: TemplateValidationView | null,
): string | null {
  if (validation === null || validation.valid) {
    return null;
  }
  if (validation.missing.length > 0) {
    return `Still needed: ${validation.missing.join(", ")}`;
  }
  if (validation.invalid.length > 0) {
    return validation.invalid
      .map((problem) => `${problem.key} ${problem.reason}`)
      .join("; ");
  }
  return "Some values are not valid yet.";
}

/** Declared but read by no source. Not an error -- an operator may be
 * staging a variable ahead of a body edit -- but worth surfacing in the
 * editor so a typo in a body does not sit unnoticed. */
export function unusedVariableKeys(
  template: Pick<MailTemplateView, "variables" | "referencedVariableKeys">,
): readonly string[] {
  return template.variables
    .map((variable) => variable.key)
    .filter((key) => !template.referencedVariableKeys.includes(key));
}

/** Trims a form field, mapping an all-whitespace value to `null` -- which is
 * how the API spells "not set" for every optional template string. */
export function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
