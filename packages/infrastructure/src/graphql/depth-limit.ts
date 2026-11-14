import type { Plugin } from "graphql-yoga";
import {
  type DefinitionNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  type SelectionSetNode,
} from "graphql";

/** Maximum selection nesting depth. The schema's own deepest legitimate
 * path (`messages -> nodes -> domain -> dnsRecords -> ...`) is well under
 * this, so the limit only ever rejects documents built to be expensive. */
export const DEFAULT_MAX_DEPTH = 12;

function collectFragments(
  document: DocumentNode,
): ReadonlyMap<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  return fragments;
}

function measureDepth(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  depth: number,
  visitedFragments: ReadonlySet<string>,
): number {
  let deepest = depth;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const nested =
        selection.selectionSet === undefined
          ? depth
          : measureDepth(
              selection.selectionSet,
              fragments,
              depth + 1,
              visitedFragments,
            );
      deepest = Math.max(deepest, nested);
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(
        deepest,
        measureDepth(
          selection.selectionSet,
          fragments,
          depth,
          visitedFragments,
        ),
      );
      continue;
    }
    // A fragment spread. Cycles are illegal GraphQL, but a malformed
    // document reaches this plugin before validation runs, so revisiting is
    // guarded against explicitly rather than trusted not to happen.
    const name = selection.name.value;
    if (visitedFragments.has(name)) {
      continue;
    }
    const fragment = fragments.get(name);
    if (fragment === undefined) {
      continue;
    }
    deepest = Math.max(
      deepest,
      measureDepth(
        fragment.selectionSet,
        fragments,
        depth,
        new Set([...visitedFragments, name]),
      ),
    );
  }
  return deepest;
}

/** Depth of the deepest operation in `document`, following fragments. */
export function documentDepth(document: DocumentNode): number {
  const fragments = collectFragments(document);
  let deepest = 0;
  for (const definition of document.definitions as readonly DefinitionNode[]) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      continue;
    }
    deepest = Math.max(
      deepest,
      measureDepth(definition.selectionSet, fragments, 1, new Set()),
    );
  }
  return deepest;
}

/** Rejects over-deep documents before execution. This endpoint is exposed
 * to untrusted agents, and a deeply nested query is the cheapest way to
 * make the server do unbounded work. */
export function useDepthLimit(maxDepth: number = DEFAULT_MAX_DEPTH): Plugin {
  return {
    onParse() {
      return ({ result }) => {
        if (result instanceof Error || result === null) {
          return;
        }
        const document = result as DocumentNode;
        const depth = documentDepth(document);
        if (depth > maxDepth) {
          throw new GraphQLError(
            `Query is too deep: ${depth} exceeds the maximum of ${maxDepth}`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      };
    },
  };
}
