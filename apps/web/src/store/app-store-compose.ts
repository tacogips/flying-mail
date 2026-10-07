import type { GraphQLResult } from "../api/graphql-client";
import type { MessageView } from "../api/schema-types";
import { describeErrors, hasCode } from "../lib/mutation-error";

export type SaveDraftOutcome =
  | { readonly kind: "saved"; readonly draft: MessageView }
  | { readonly kind: "conflict" }
  | { readonly kind: "error"; readonly message: string };

export function toSaveDraftOutcome(
  response: GraphQLResult<{ readonly saveDraft: MessageView }>,
  input: { readonly draftId?: string },
): SaveDraftOutcome {
  if (response.ok) {
    return { kind: "saved", draft: response.data.saveDraft };
  }
  if (hasCode(response.errors, "CONFLICT")) {
    return { kind: "conflict" };
  }
  if (
    input.draftId !== undefined &&
    response.errors.some(
      (error) =>
        error.code === "NOT_FOUND" &&
        (((error.entity === "Draft" || error.resource === "Draft") &&
          (error.id === undefined || error.id === input.draftId)) ||
          error.field === "draftId" ||
          error.message === `Draft not found: ${input.draftId}`),
    )
  ) {
    return { kind: "conflict" };
  }
  return { kind: "error", message: describeErrors(response.errors) };
}
