import { buildSchema, Kind, parse, validate } from "graphql";
import { describe, expect, test } from "vitest";
import { documentDepth } from "./depth-limit";

describe("documentDepth", () => {
  test("measures shared fragments relative to every usage depth", () => {
    const document = parse(`
      query Shallow { ...Shared }
      query Deep { viewer { ... on Viewer { ...Shared } } }
      fragment Shared on Viewer { user { id } }
    `);
    expect(documentDepth(document)).toBe(3);
  });

  test("visits shared fragment bodies once rather than expanding every path", () => {
    const fragments = Array.from(
      { length: 12 },
      (_, index) =>
        `fragment F${index} on Query { ...F${index + 1} ...F${index + 1} }`,
    );
    const document = parse(`
      query { ...F0 }
      ${fragments.join("\n")}
      fragment F12 on Query { __typename }
    `);
    let visits = 0;
    for (const definition of document.definitions) {
      if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
      const selectionSet = definition.selectionSet;
      Object.defineProperty(definition, "selectionSet", {
        get() {
          visits += 1;
          return selectionSet;
        },
      });
    }
    expect(documentDepth(document)).toBe(1);
    expect(visits).toBeLessThanOrEqual(13);
  });

  test("does not recurse forever through invalid fragment cycles", () => {
    const document = parse(`
      query { ...A }
      fragment A on Query { ...B }
      fragment B on Query { ...A __typename }
    `);
    expect(documentDepth(document)).toBe(1);
    expect(
      validate(buildSchema("type Query { value: String }"), document).some(
        (error) => error.message.includes("Cannot spread fragment"),
      ),
    ).toBe(true);
  });
});
