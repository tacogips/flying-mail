import type { GraphQLClientError } from "../api/graphql-client";

/** Turns a client error list into one sentence for a toast.
 *
 * `SERVICE_UNAVAILABLE` is rewritten: the server's message is accurate but
 * an operator-facing phrasing ("not configured") is confusing to a reader
 * who just wanted to send mail. */
export function describeErrors(errors: readonly GraphQLClientError[]): string {
  const first = errors[0];
  if (first === undefined) {
    return "Something went wrong";
  }
  switch (first.code) {
    case "UNAUTHENTICATED":
      return "Your session has expired. Please sign in again.";
    case "FORBIDDEN":
      return "You do not have permission to do that.";
    case "SERVICE_UNAVAILABLE":
      return "Sending is not configured on this server yet.";
    default:
      return first.message;
  }
}

export function hasCode(
  errors: readonly GraphQLClientError[],
  code: GraphQLClientError["code"],
): boolean {
  return errors.some((error) => error.code === code);
}
