import { parseEmailAddress } from "../value-objects/email-address";
import { type TemplateVariable, TemplateVariableType } from "./mail-template";

/** One supplied variable value, as it crosses the API: always a string, so
 * the wire format does not need a union scalar and every type gets the same
 * single coercion path. */
export interface TemplateValueEntry {
  readonly key: string;
  readonly value: string;
}

export interface TemplateValueProblem {
  readonly key: string;
  readonly reason: string;
}

/** The answer to "can this template be rendered with these values yet?".
 * Data rather than an exception, so the web client can mark the offending
 * fields instead of showing one opaque message. */
export interface TemplateValidation {
  readonly valid: boolean;
  /** Required, unsupplied, and with no default to fall back on. */
  readonly missing: readonly string[];
  readonly invalid: readonly TemplateValueProblem[];
  /** Supplied but not declared. Never reaches the render object. */
  readonly unknown: readonly string[];
}

export type TemplateRenderValue = string | number | boolean;

const BOOLEAN_TRUE = new Set(["true", "1", "yes", "on"]);
const BOOLEAN_FALSE = new Set(["false", "0", "no", "off"]);
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type CoercionResult =
  | { readonly ok: true; readonly value: TemplateRenderValue }
  | { readonly ok: false; readonly reason: string };

/** Turns one submitted string into the value the template will interpolate.
 * Never throws: a bad value is a caller mistake to report alongside every
 * other bad value, not a reason to abandon the whole validation pass. */
export function coerceTemplateValue(
  type: TemplateVariableType,
  raw: string,
): CoercionResult {
  switch (type) {
    case TemplateVariableType.Text:
    case TemplateVariableType.MultilineText:
      return { ok: true, value: raw };
    case TemplateVariableType.Number: {
      const trimmed = raw.trim();
      const parsed = Number(trimmed);
      if (trimmed.length === 0 || !Number.isFinite(parsed)) {
        return { ok: false, reason: "must be a finite number" };
      }
      return { ok: true, value: parsed };
    }
    case TemplateVariableType.Boolean: {
      const normalized = raw.trim().toLowerCase();
      if (BOOLEAN_TRUE.has(normalized)) {
        return { ok: true, value: true };
      }
      if (BOOLEAN_FALSE.has(normalized)) {
        return { ok: true, value: false };
      }
      return { ok: false, reason: "must be true or false" };
    }
    case TemplateVariableType.Date: {
      const trimmed = raw.trim();
      if (DATE_ONLY_PATTERN.test(trimmed)) {
        // `Date.parse` accepts "2026-02-31"; re-rendering the parsed date
        // and comparing rejects a day that does not exist in its month.
        const parsed = new Date(`${trimmed}T00:00:00.000Z`);
        if (
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== trimmed
        ) {
          return { ok: false, reason: "must be a real calendar date" };
        }
        return { ok: true, value: trimmed };
      }
      const parsed = new Date(trimmed);
      if (trimmed.length === 0 || Number.isNaN(parsed.getTime())) {
        return {
          ok: false,
          reason: "must be YYYY-MM-DD or an ISO 8601 timestamp",
        };
      }
      return { ok: true, value: parsed.toISOString() };
    }
    case TemplateVariableType.Email: {
      const address = parseEmailAddress(raw);
      if (address === null) {
        return { ok: false, reason: "must be a valid email address" };
      }
      return { ok: true, value: address as string };
    }
    default: {
      const exhaustive: never = type;
      throw new Error(
        `Unhandled template variable type: ${String(exhaustive)}`,
      );
    }
  }
}

/** Indexes supplied entries by key. A repeated key keeps the last entry, so
 * a form that submits a field twice behaves like the browser does. */
function indexValues(
  values: readonly TemplateValueEntry[],
): ReadonlyMap<string, string> {
  const byKey = new Map<string, string>();
  for (const entry of values) {
    byKey.set(entry.key, entry.value);
  }
  return byKey;
}

/** Whether a supplied string counts as "filled". A `MULTILINE_TEXT` keeps
 * its whitespace, but a field holding nothing but spaces is not an answer
 * to a required question. */
function isSupplied(raw: string | undefined): raw is string {
  return raw !== undefined && raw.trim().length > 0;
}

/** Checks a value set against a variable set without rendering anything.
 * This is the "are all the variables filled in?" gate: the web client calls
 * it as the user types, and `previewMailTemplate` / `sendTemplatedMessage`
 * both run it again server-side, so a client cannot skip it. */
export function validateTemplateValues(
  variables: readonly TemplateVariable[],
  values: readonly TemplateValueEntry[],
): TemplateValidation {
  const supplied = indexValues(values);
  const declared = new Set(variables.map((variable) => variable.key));
  const missing: string[] = [];
  const invalid: TemplateValueProblem[] = [];

  for (const variable of variables) {
    const raw = supplied.get(variable.key);
    if (!isSupplied(raw)) {
      if (variable.required && variable.defaultValue === null) {
        missing.push(variable.key);
        continue;
      }
      // An unsupplied optional variable still has to have a *usable*
      // default, or the render would fail later on a value nobody typed.
      if (variable.defaultValue !== null) {
        const coerced = coerceTemplateValue(
          variable.type,
          variable.defaultValue,
        );
        if (!coerced.ok) {
          invalid.push({
            key: variable.key,
            reason: `default value ${coerced.reason}`,
          });
        }
      }
      continue;
    }
    const coerced = coerceTemplateValue(variable.type, raw);
    if (!coerced.ok) {
      invalid.push({ key: variable.key, reason: coerced.reason });
    }
  }

  const unknown = [...supplied.keys()].filter((key) => !declared.has(key));

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
    // `unknown` keys are reported so a typo is visible, but they never make
    // the set invalid: they are simply dropped from the render object.
    unknown,
  };
}

/** The object a template is rendered with, built from declared variables
 * only. An undeclared key cannot enter it, so a caller can neither inject
 * content into a template that does not reference it nor shadow a declared
 * variable. Call only after {@link validateTemplateValues} passes. */
export function buildTemplateRenderData(
  variables: readonly TemplateVariable[],
  values: readonly TemplateValueEntry[],
): Readonly<Record<string, TemplateRenderValue>> {
  const supplied = indexValues(values);
  const data: Record<string, TemplateRenderValue> = {};
  for (const variable of variables) {
    const raw = supplied.get(variable.key);
    const source = isSupplied(raw) ? raw : variable.defaultValue;
    if (source === null || source === undefined) {
      // An optional variable with neither a value nor a default renders as
      // the empty string rather than "undefined".
      data[variable.key] = "";
      continue;
    }
    const coerced = coerceTemplateValue(variable.type, source);
    data[variable.key] = coerced.ok ? coerced.value : "";
  }
  return data;
}

/** One-line summary of a failed validation, for the error message a send or
 * preview raises when a caller ignored the validation query. */
export function describeTemplateValidation(
  validation: TemplateValidation,
): string {
  const parts: string[] = [];
  if (validation.missing.length > 0) {
    parts.push(`missing values for ${validation.missing.join(", ")}`);
  }
  for (const problem of validation.invalid) {
    parts.push(`${problem.key} ${problem.reason}`);
  }
  return parts.length === 0
    ? "template values are not valid"
    : `template values are not valid: ${parts.join("; ")}`;
}
