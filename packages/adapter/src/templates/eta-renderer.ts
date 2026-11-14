import type {
  TemplateEscapeMode,
  TemplateRenderer,
} from "@mailcal/application/ports/template-renderer";
import { TemplateSyntaxError } from "@mailcal/application/ports/template-renderer";
import { Eta } from "eta";
import {
  evaluateExpression,
  type Expression,
  parseExpression,
  referencedKeys,
} from "./expression";

/**
 * A template renderer built on Eta's *parser* only.
 *
 * Eta's own `compile`/`render` assemble a JavaScript function with
 * `new Function`. mailcal cannot use them:
 *
 * 1. The API runs on Cloudflare Workers, which forbid runtime code
 *    generation -- a compiled template would work locally and throw
 *    `EvalError` in production.
 * 2. Templates are user-supplied data. Compiling them would let anyone
 *    holding `TEMPLATE_CREATE` execute arbitrary JavaScript inside the API.
 *
 * So the tokenizer is genuinely Eta's -- same delimiters, same prefixes,
 * same whitespace-control -- and evaluation is this package's own restricted
 * interpreter over `expression.ts`'s grammar. There is no `eval`, no
 * `new Function`, and no path by which template text becomes code.
 */

/** Eta escapes the literal spans of its AST for embedding in generated
 * JavaScript source: `\` and `'` are backslash-prefixed and newlines become
 * a literal `\n` pair. Since nothing is generated here, that has to be
 * undone to recover the author's text. */
function unescapeLiteral(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index] as string;
    if (char !== "\\") {
      out += char;
      index += 1;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) {
      out += char;
      index += 1;
      continue;
    }
    out += escaped === "n" ? "\n" : escaped;
    index += 2;
  }
  return out;
}

const HTML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (char) => HTML_ESCAPES.get(char) ?? char);
}

/** How an evaluated value becomes text. `null`/`undefined` render as an
 * empty string rather than the words "null"/"undefined": an optional
 * variable nobody filled in should leave a gap, not a bug report. */
function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // The render object only ever holds coerced primitives, so this is
  // unreachable for stored templates; JSON keeps it harmless if it is not.
  return JSON.stringify(value) ?? "";
}

type Instruction =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "interpolate";
      readonly expression: Expression;
      readonly escapable: boolean;
    };

/** Eta's AST node shape. Re-declared rather than imported because the
 * package exports the type only through its instance signature. */
interface EtaAstTag {
  readonly t: string;
  readonly val: string;
}

function isTag(node: unknown): node is EtaAstTag {
  return typeof node === "object" && node !== null && "t" in node;
}

export interface EtaTemplateRenderer extends TemplateRenderer {}

export function createEtaTemplateRenderer(): EtaTemplateRenderer {
  const eta = new Eta();

  /** Parses a source into instructions, rejecting every construct outside
   * the supported subset. Runs at template write time, so a stored template
   * is always renderable. */
  function compileToInstructions(
    source: string,
    field: string,
  ): readonly Instruction[] {
    let ast: readonly unknown[];
    try {
      ast = eta.parse(source);
    } catch (error) {
      throw new TemplateSyntaxError(
        error instanceof Error
          ? `template syntax error: ${error.message}`
          : "template syntax error",
        field,
      );
    }
    return ast.map((node): Instruction => {
      if (!isTag(node)) {
        return { kind: "text", text: unescapeLiteral(String(node)) };
      }
      if (node.t === "e") {
        throw new TemplateSyntaxError(
          `"<% ${node.val.trim()} %>" is not supported: mail templates may only interpolate values (<%= %> and <%~ %>), not run statements`,
          field,
        );
      }
      if (node.t !== "i" && node.t !== "r") {
        throw new TemplateSyntaxError(
          `unsupported template tag "${node.t}"`,
          field,
        );
      }
      return {
        kind: "interpolate",
        expression: parseExpression(node.val, field),
        // `<%~ %>` is Eta's raw interpolation and is never escaped, exactly
        // as it is not in Eta itself.
        escapable: node.t === "i",
      };
    });
  }

  function run(
    instructions: readonly Instruction[],
    data: Readonly<Record<string, unknown>>,
    mode: TemplateEscapeMode,
  ): string {
    let out = "";
    for (const instruction of instructions) {
      if (instruction.kind === "text") {
        out += instruction.text;
        continue;
      }
      const rendered = stringify(
        evaluateExpression(instruction.expression, data),
      );
      out +=
        mode === "html" && instruction.escapable
          ? escapeHtml(rendered)
          : rendered;
    }
    return out;
  }

  return {
    referencedVariables(source, field) {
      const keys: string[] = [];
      for (const instruction of compileToInstructions(source, field)) {
        if (instruction.kind !== "interpolate") {
          continue;
        }
        for (const key of referencedKeys(instruction.expression)) {
          if (!keys.includes(key)) {
            keys.push(key);
          }
        }
      }
      return keys;
    },

    render(source, data, options, field) {
      return run(compileToInstructions(source, field), data, options.escape);
    },
  };
}
