import type { Plugin } from "graphql-yoga";
import {
  type DocumentNode,
  GraphQLError,
  Kind,
  type SelectionSetNode,
} from "graphql";

/** Maximum total selections across a document. Complements the depth limit:
 * a flat but enormous document is just as expensive as a deep one. */
export const DEFAULT_MAX_SELECTIONS = 2000;

function countSelections(selectionSet: SelectionSetNode): number {
  let total = 0;
  for (const selection of selectionSet.selections) {
    total += 1;
    if (
      (selection.kind === Kind.FIELD ||
        selection.kind === Kind.INLINE_FRAGMENT) &&
      selection.selectionSet !== undefined
    ) {
      total += countSelections(selection.selectionSet);
    }
  }
  return total;
}

/** Total selections across every definition in `document`. Fragment
 * definitions are counted where they are declared rather than per spread,
 * which is cheaper and cannot be inflated by repeated spreads. */
export function documentSelectionCount(document: DocumentNode): number {
  let total = 0;
  for (const definition of document.definitions) {
    if (
      definition.kind === Kind.OPERATION_DEFINITION ||
      definition.kind === Kind.FRAGMENT_DEFINITION
    ) {
      total += countSelections(definition.selectionSet);
    }
  }
  return total;
}

export function useSelectionLimit(
  maxSelections: number = DEFAULT_MAX_SELECTIONS,
): Plugin {
  return {
    onParse() {
      return ({ result }) => {
        if (result instanceof Error || result === null) {
          return;
        }
        const count = documentSelectionCount(result as DocumentNode);
        if (count > maxSelections) {
          throw new GraphQLError(
            `Query has too many selections: ${count} exceeds the maximum of ${maxSelections}`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      };
    },
  };
}
