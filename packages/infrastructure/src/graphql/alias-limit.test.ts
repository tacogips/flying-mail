import { parse } from "graphql";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_ALIASES,
  documentAliasCount,
  useAliasLimit,
} from "./alias-limit";

function aliasedQuery(count: number): string {
  const fields = Array.from(
    { length: count },
    (_value, index) => `a${index}: __typename`,
  );
  return `{ ${fields.join(" ")} }`;
}

describe("documentAliasCount", () => {
  test("counts only aliased fields", () => {
    expect(documentAliasCount(parse("{ viewer { capabilities } }"))).toBe(0);
    expect(documentAliasCount(parse("{ a: viewer { c: capabilities } }"))).toBe(
      2,
    );
  });

  test("counts aliases in nested selections, inline fragments and fragment definitions", () => {
    const document = parse(`
      query { x: viewer { ... on Viewer { y: capabilities } ...F } }
      fragment F on Viewer { z: capabilities }
    `);
    expect(documentAliasCount(document)).toBe(3);
  });

  test("counts every alias across multiple operations", () => {
    const document = parse(`
      query A { a: viewer { id } }
      query B { b: viewer { id } c: viewer { id } }
    `);
    expect(documentAliasCount(document)).toBe(3);
  });
});

describe("useAliasLimit", () => {
  function runPlugin(source: string, max?: number): void {
    const plugin = useAliasLimit(max);
    const onParse = plugin.onParse;
    if (onParse === undefined) {
      throw new Error("plugin has no onParse hook");
    }
    // The hook returns an after-parse callback receiving the parse result.
    const after = (
      onParse as unknown as (
        options: unknown,
      ) => (options: { result: unknown }) => void
    )({});
    after({ result: parse(source) });
  }

  test("defaults to a maximum of 50", () => {
    expect(DEFAULT_MAX_ALIASES).toBe(50);
  });

  test("allows a document at the limit", () => {
    expect(() => runPlugin(aliasedQuery(DEFAULT_MAX_ALIASES))).not.toThrow();
  });

  test("rejects a document over the limit with BAD_USER_INPUT", () => {
    expect(() => runPlugin(aliasedQuery(DEFAULT_MAX_ALIASES + 1))).toThrow(
      /too many aliases: 51 exceeds the maximum of 50/,
    );
  });

  test("honours a custom limit", () => {
    expect(() => runPlugin(aliasedQuery(3), 2)).toThrow(/too many aliases/);
    expect(() => runPlugin(aliasedQuery(2), 2)).not.toThrow();
  });
});
