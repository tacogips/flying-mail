/** A cheap, conservative static check for regular expressions that can take
 * exponential (or high-polynomial) time on a crafted input.
 *
 * JavaScript's backtracking engine cannot be given a time limit, and
 * classification patterns run against attacker-controlled subjects and
 * senders. This does not try to prove a pattern safe. It rejects the
 * well-known shapes -- nested unbounded quantifiers, overlapping
 * alternatives under a repeat, and adjacent unbounded repeats over
 * overlapping characters -- and accepts everything else, so ordinary
 * patterns (`^\s*(re|fwd):`, `invoice\s+#?\d+`, `.*unsubscribe.*`) keep
 * working. */

interface Quantifier {
  readonly min: number;
  readonly max: number;
}

interface AtomNode {
  readonly kind: "atom";
  /** The atom as written, e.g. `a`, `\w`, `.`, `[a-z]`. */
  readonly source: string;
  readonly quantifier: Quantifier | null;
}

interface GroupNode {
  readonly kind: "group";
  readonly alternatives: readonly (readonly Node[])[];
  /** Source text of each alternative, for the literal-overlap check. */
  readonly alternativeSources: readonly string[];
  readonly quantifier: Quantifier | null;
}

type Node = AtomNode | GroupNode;

function isUnbounded(quantifier: Quantifier | null): boolean {
  return quantifier !== null && quantifier.max === Number.POSITIVE_INFINITY;
}

interface ParseState {
  index: number;
}

function parseQuantifier(source: string, state: ParseState): Quantifier | null {
  const char = source[state.index];
  let quantifier: Quantifier | null = null;
  if (char === "*") {
    quantifier = { min: 0, max: Number.POSITIVE_INFINITY };
    state.index += 1;
  } else if (char === "+") {
    quantifier = { min: 1, max: Number.POSITIVE_INFINITY };
    state.index += 1;
  } else if (char === "?") {
    quantifier = { min: 0, max: 1 };
    state.index += 1;
  } else if (char === "{") {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(state.index));
    if (match !== null) {
      const min = Number(match[1]);
      const max =
        match[2] === undefined
          ? min
          : match[3] === ""
            ? Number.POSITIVE_INFINITY
            : Number(match[3]);
      quantifier = { min, max };
      state.index += match[0].length;
    }
  }
  // A trailing `?` makes the repeat lazy; it does not change its bounds.
  if (quantifier !== null && source[state.index] === "?") {
    state.index += 1;
  }
  return quantifier;
}

/** Index just past the `]` closing the class that opens at `start`. */
function classEnd(source: string, start: number): number {
  let index = start + 1;
  if (source[index] === "^") {
    index += 1;
  }
  while (index < source.length && source[index] !== "]") {
    index += source[index] === "\\" ? 2 : 1;
  }
  return Math.min(index + 1, source.length);
}

/** Skips a group's `(?:`, `(?=`, `(?<name>` ... prefix. */
function skipGroupPrefix(source: string, start: number): number {
  if (source[start] !== "?") {
    return start;
  }
  const next = source[start + 1];
  if (next === ":" || next === "=" || next === "!") {
    return start + 2;
  }
  if (next === "<") {
    const after = source[start + 2];
    if (after === "=" || after === "!") {
      return start + 3;
    }
    const close = source.indexOf(">", start);
    return close === -1 ? source.length : close + 1;
  }
  return start;
}

function parseAlternatives(
  source: string,
  state: ParseState,
  inGroup: boolean,
): { alternatives: Node[][]; alternativeSources: string[] } {
  const alternatives: Node[][] = [[]];
  const alternativeSources: string[] = [];
  let altStart = state.index;

  const current = (): Node[] => alternatives[alternatives.length - 1] ?? [];

  while (state.index < source.length) {
    const char = source[state.index];
    if (char === "|") {
      alternativeSources.push(source.slice(altStart, state.index));
      alternatives.push([]);
      state.index += 1;
      altStart = state.index;
      continue;
    }
    if (char === ")") {
      if (inGroup) {
        break;
      }
      state.index += 1;
      continue;
    }
    if (char === "(") {
      state.index = skipGroupPrefix(source, state.index + 1);
      const inner = parseAlternatives(source, state, true);
      if (source[state.index] === ")") {
        state.index += 1;
      }
      current().push({
        kind: "group",
        alternatives: inner.alternatives,
        alternativeSources: inner.alternativeSources,
        quantifier: parseQuantifier(source, state),
      });
      continue;
    }
    if (char === "^" || char === "$") {
      state.index += 1;
      continue;
    }
    if (char === "*" || char === "+" || char === "?") {
      // A quantifier with nothing to repeat: not a valid pattern anyway.
      state.index += 1;
      continue;
    }
    let atomSource: string;
    if (char === "[") {
      const end = classEnd(source, state.index);
      atomSource = source.slice(state.index, end);
      state.index = end;
    } else if (char === "\\") {
      atomSource = source.slice(state.index, state.index + 2);
      state.index += 2;
    } else {
      atomSource = char ?? "";
      state.index += 1;
    }
    current().push({
      kind: "atom",
      source: atomSource,
      quantifier: parseQuantifier(source, state),
    });
  }
  alternativeSources.push(source.slice(altStart, state.index));
  return { alternatives, alternativeSources };
}

function containsUnbounded(node: GroupNode): boolean {
  return node.alternatives.some((alternative) =>
    alternative.some(
      (child) =>
        isUnbounded(child.quantifier) ||
        (child.kind === "group" && containsUnbounded(child)),
    ),
  );
}

const PLAIN_LITERAL = /^[A-Za-z0-9 _@.,:;'"#%&=~`<>/-]+$/;

/** True when two alternatives are plain text and one is a prefix of the other
 * (or they are equal), e.g. `a|a` or `a|aa`: under a repeat the same input
 * can then be split in many ways. */
function hasOverlappingLiteralAlternatives(
  sources: readonly string[],
): boolean {
  const literals = sources.filter(
    (text) => text.length > 0 && PLAIN_LITERAL.test(text),
  );
  for (let i = 0; i < literals.length; i += 1) {
    for (let j = 0; j < literals.length; j += 1) {
      const a = literals[i];
      const b = literals[j];
      if (i !== j && a !== undefined && b !== undefined && a.startsWith(b)) {
        return true;
      }
    }
  }
  return false;
}

const SAMPLE_CHARACTERS: readonly string[] = [
  ...Array.from({ length: 5 }, (_, i) => String.fromCharCode(9 + i)),
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  "é",
  " ",
  "日",
];

function atomMatcher(source: string): RegExp | null {
  try {
    return new RegExp(`^(?:${source})$`, "i");
  } catch {
    return null;
  }
}

/** Whether some character is matched by both atoms, judged on a sample of
 * ASCII plus a few non-ASCII characters. */
function atomsOverlap(first: AtomNode, second: AtomNode): boolean {
  const a = atomMatcher(first.source);
  const b = atomMatcher(second.source);
  if (a === null || b === null) {
    return false;
  }
  return SAMPLE_CHARACTERS.some((char) => a.test(char) && b.test(char));
}

/** Searches the tree for a risky shape; returns a description of the first
 * one found. */
function findHazardIn(
  alternatives: readonly (readonly Node[])[],
): string | null {
  for (const sequence of alternatives) {
    for (let index = 0; index < sequence.length; index += 1) {
      const node = sequence[index];
      if (node === undefined) {
        continue;
      }
      if (node.kind === "group") {
        if (isUnbounded(node.quantifier)) {
          if (containsUnbounded(node)) {
            return "a repeated group contains another unbounded repetition (nested quantifiers)";
          }
          if (hasOverlappingLiteralAlternatives(node.alternativeSources)) {
            return "a repeated group has overlapping alternatives";
          }
        }
        const inner = findHazardIn(node.alternatives);
        if (inner !== null) {
          return inner;
        }
        continue;
      }
      const previous = sequence[index - 1];
      if (
        previous !== undefined &&
        previous.kind === "atom" &&
        isUnbounded(previous.quantifier) &&
        isUnbounded(node.quantifier) &&
        atomsOverlap(previous, node)
      ) {
        return "adjacent unbounded repetitions match overlapping characters";
      }
    }
  }
  return null;
}

/** Returns why `pattern` could backtrack catastrophically, or `null` when no
 * known risky shape is present. Never throws. */
export function findRegexHazard(pattern: string): string | null {
  const parsed = parseAlternatives(pattern, { index: 0 }, false);
  return findHazardIn(parsed.alternatives);
}
