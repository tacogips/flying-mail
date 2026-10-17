import type { Plugin } from "graphql-yoga";
import {
  type DocumentNode,
  GraphQLError,
  Kind,
  type SelectionSetNode,
} from "graphql";

/** Maximum aliased fields across a document.
 *
 * Aliases are the cheap way to multiply work inside a single request: one
 * document can ask for the same expensive field hundreds of times under
 * different names while staying shallow and well under the selection cap. */
export const DEFAULT_MAX_ALIASES = 50;

function countAliases(selectionSet: SelectionSetNode): number {
  let total = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD && selection.alias !== undefined) {
      total += 1;
    }
    if (
      (selection.kind === Kind.FIELD ||
        selection.kind === Kind.INLINE_FRAGMENT) &&
      selection.selectionSet !== undefined
    ) {
      total += countAliases(selection.selectionSet);
    }
  }
  return total;
}

/** Total aliased fields across every definition in `document`. Fragment
 * definitions are counted where they are declared, mirroring
 * `documentSelectionCount`. */
export function documentAliasCount(document: DocumentNode): number {
  let total = 0;
  for (const definition of document.definitions) {
    if (
      definition.kind === Kind.OPERATION_DEFINITION ||
      definition.kind === Kind.FRAGMENT_DEFINITION
    ) {
      total += countAliases(definition.selectionSet);
    }
  }
  return total;
}

/** Rejects documents that use more than `maxAliases` aliased fields, before
 * execution. */
export function useAliasLimit(
  maxAliases: number = DEFAULT_MAX_ALIASES,
): Plugin {
  return {
    onParse() {
      return ({ result }) => {
        if (result instanceof Error || result === null) {
          return;
        }
        const count = documentAliasCount(result as DocumentNode);
        if (count > maxAliases) {
          throw new GraphQLError(
            `Query has too many aliases: ${count} exceeds the maximum of ${maxAliases}`,
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
      };
    },
  };
}
