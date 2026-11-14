import { TemplateSyntaxError } from "@mailcal/application/ports/template-renderer";

/**
 * The expression half of the Eta subset mailcal supports.
 *
 * ```
 * expression := operand ( ("||" | "??") operand )*
 * operand    := path | literal
 * path       := "it" ( "." identifier | "[" string "]" | "[" integer "]" )*
 * literal    := string | number | "true" | "false" | "null" | "undefined"
 * ```
 *
 * Deliberately not a JavaScript evaluator. Templates are user-supplied data
 * stored on the server; compiling them (which is what Eta itself does) would
 * turn "may write a mail template" into "may run code in the API process",
 * and would not work at all on Cloudflare Workers, where runtime code
 * generation is forbidden.
 */

export type PathSegment = string | number;

export type Operand =
  | { readonly kind: "path"; readonly segments: readonly PathSegment[] }
  | { readonly kind: "literal"; readonly value: unknown };

export interface Expression {
  readonly first: Operand;
  readonly rest: readonly {
    readonly operator: "||" | "??";
    readonly operand: Operand;
  }[];
}

/** The single name a template's data object is bound to, matching Eta's
 * default `varName`. */
const DATA_VAR = "it";

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

type Token =
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "punct"; readonly value: "." | "[" | "]" | "||" | "??" };

function fail(source: string, field: string, detail: string): never {
  throw new TemplateSyntaxError(
    `"<%= ${source.trim()} %>" is not supported: ${detail}`,
    field,
  );
}

function readStringLiteral(
  source: string,
  start: number,
  field: string,
): { readonly value: string; readonly next: number } {
  const quote = source[start];
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) {
        break;
      }
      value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value, next: index + 1 };
    }
    value += char;
    index += 1;
  }
  return fail(source, field, "an unterminated string literal");
}

function tokenize(source: string, field: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const literal = readStringLiteral(source, index, field);
      tokens.push({ kind: "string", value: literal.value });
      index = literal.next;
      continue;
    }
    if (source.startsWith("||", index)) {
      tokens.push({ kind: "punct", value: "||" });
      index += 2;
      continue;
    }
    if (source.startsWith("??", index)) {
      tokens.push({ kind: "punct", value: "??" });
      index += 2;
      continue;
    }
    if (char === "." || char === "[" || char === "]") {
      tokens.push({ kind: "punct", value: char });
      index += 1;
      continue;
    }
    if (DIGIT.test(char)) {
      let end = index;
      while (end < source.length && /[0-9.]/.test(source[end] as string)) {
        end += 1;
      }
      const text = source.slice(index, end);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return fail(source, field, `"${text}" is not a number`);
      }
      tokens.push({ kind: "number", value });
      index = end;
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      let end = index;
      while (
        end < source.length &&
        IDENTIFIER_PART.test(source[end] as string)
      ) {
        end += 1;
      }
      tokens.push({ kind: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    return fail(
      source,
      field,
      `the character "${char}" has no meaning in a template expression`,
    );
  }
  return tokens;
}

const KEYWORD_LITERALS = new Map<string, unknown>([
  ["true", true],
  ["false", false],
  ["null", null],
  ["undefined", undefined],
]);

class Cursor {
  private position = 0;

  constructor(
    private readonly tokens: readonly Token[],
    readonly source: string,
    readonly field: string,
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.position];
  }

  next(): Token | undefined {
    const token = this.tokens[this.position];
    this.position += 1;
    return token;
  }

  atEnd(): boolean {
    return this.position >= this.tokens.length;
  }
}

function parsePathSegments(cursor: Cursor): readonly PathSegment[] {
  const segments: PathSegment[] = [];
  for (;;) {
    const token = cursor.peek();
    if (token === undefined || token.kind !== "punct") {
      return segments;
    }
    if (token.value === ".") {
      cursor.next();
      const name = cursor.next();
      if (name === undefined || name.kind !== "identifier") {
        return fail(
          cursor.source,
          cursor.field,
          "a property name must follow a dot",
        );
      }
      segments.push(name.value);
      continue;
    }
    if (token.value === "[") {
      cursor.next();
      const key = cursor.next();
      if (
        key === undefined ||
        (key.kind !== "string" && key.kind !== "number")
      ) {
        return fail(
          cursor.source,
          cursor.field,
          "only a string or integer index may appear in brackets",
        );
      }
      const closing = cursor.next();
      if (
        closing === undefined ||
        closing.kind !== "punct" ||
        closing.value !== "]"
      ) {
        return fail(cursor.source, cursor.field, "an unclosed bracket");
      }
      segments.push(key.value);
      continue;
    }
    return segments;
  }
}

function parseOperand(cursor: Cursor): Operand {
  const token = cursor.next();
  if (token === undefined) {
    return fail(cursor.source, cursor.field, "the expression is empty");
  }
  if (token.kind === "string" || token.kind === "number") {
    return { kind: "literal", value: token.value };
  }
  if (token.kind !== "identifier") {
    return fail(
      cursor.source,
      cursor.field,
      `"${token.value}" cannot start an expression`,
    );
  }
  if (KEYWORD_LITERALS.has(token.value)) {
    return { kind: "literal", value: KEYWORD_LITERALS.get(token.value) };
  }
  if (token.value !== DATA_VAR) {
    return fail(
      cursor.source,
      cursor.field,
      `only "${DATA_VAR}" may be read; declare "${token.value}" as a variable and write "${DATA_VAR}.${token.value}"`,
    );
  }
  return { kind: "path", segments: parsePathSegments(cursor) };
}

/** Parses one interpolation's expression, or throws `TemplateSyntaxError`
 * naming the field it came from. */
export function parseExpression(source: string, field: string): Expression {
  const cursor = new Cursor(tokenize(source, field), source, field);
  const first = parseOperand(cursor);
  const rest: { operator: "||" | "??"; operand: Operand }[] = [];
  while (!cursor.atEnd()) {
    const token = cursor.next();
    if (
      token === undefined ||
      token.kind !== "punct" ||
      (token.value !== "||" && token.value !== "??")
    ) {
      const shown = token === undefined ? "" : String(token.value);
      return fail(
        source,
        field,
        `"${shown}" is not one of the supported operators (|| and ??)`,
      );
    }
    rest.push({ operator: token.value, operand: parseOperand(cursor) });
  }
  return { first, rest };
}

/** Own-property lookup only. A template must not be able to walk up a
 * prototype chain -- `it.constructor` is not data a template author put
 * there, and reading it is never what a mail body meant. */
function readProperty(target: unknown, segment: PathSegment): unknown {
  if (target === null || target === undefined) {
    return undefined;
  }
  if (typeof target !== "object") {
    return undefined;
  }
  const key = String(segment);
  return Object.hasOwn(target, key)
    ? (target as Record<string, unknown>)[key]
    : undefined;
}

function evaluateOperand(
  operand: Operand,
  data: Readonly<Record<string, unknown>>,
): unknown {
  if (operand.kind === "literal") {
    return operand.value;
  }
  let current: unknown = data;
  for (const segment of operand.segments) {
    current = readProperty(current, segment);
  }
  return current;
}

export function evaluateExpression(
  expression: Expression,
  data: Readonly<Record<string, unknown>>,
): unknown {
  let value = evaluateOperand(expression.first, data);
  for (const step of expression.rest) {
    const shortCircuits =
      step.operator === "||"
        ? Boolean(value)
        : value !== null && value !== undefined;
    if (shortCircuits) {
      continue;
    }
    value = evaluateOperand(step.operand, data);
  }
  return value;
}

/** The top-level `it.<key>` name an expression reads, for each of its
 * operands. A bracket index (`it[0]`) yields nothing: it addresses no
 * declared variable. */
export function referencedKeys(expression: Expression): readonly string[] {
  const operands = [expression.first, ...expression.rest.map((s) => s.operand)];
  const keys: string[] = [];
  for (const operand of operands) {
    if (operand.kind !== "path") {
      continue;
    }
    const first = operand.segments[0];
    if (typeof first === "string" && !keys.includes(first)) {
      keys.push(first);
    }
  }
  return keys;
}
