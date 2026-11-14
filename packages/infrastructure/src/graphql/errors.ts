import {
  ApplicationError,
  type ApplicationErrorCode,
  BadUserInputError,
} from "@flying-mail/application/errors";
import { DomainError, ValidationError } from "@flying-mail/domain/errors";
import { GraphQLError } from "graphql";

/** GraphQL `extensions.code` values, 1:1 with `ApplicationErrorCode` plus
 * the masked catch-all. */
export type ErrorCode = ApplicationErrorCode | "INTERNAL_SERVER_ERROR";

export interface ClassifiedError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly field?: string;
}

function graphQLErrorWithCode(
  message: string,
  code: ErrorCode,
  extra?: Record<string, unknown>,
): GraphQLError {
  return new GraphQLError(message, {
    extensions: extra === undefined ? { code } : { code, ...extra },
  });
}

export function unauthenticatedError(
  message = "Authentication required",
): GraphQLError {
  return graphQLErrorWithCode(message, "UNAUTHENTICATED");
}

export function forbiddenError(
  message = "You do not have permission to perform this action",
): GraphQLError {
  return graphQLErrorWithCode(message, "FORBIDDEN");
}

export function notFoundError(entity: string, id: string): GraphQLError {
  return graphQLErrorWithCode(`${entity} not found: ${id}`, "NOT_FOUND", {
    entity,
    id,
  });
}

export function badUserInputError(
  message: string,
  field?: string,
): GraphQLError {
  return graphQLErrorWithCode(
    message,
    "BAD_USER_INPUT",
    field === undefined ? undefined : { field },
  );
}

export function conflictError(message: string): GraphQLError {
  return graphQLErrorWithCode(message, "CONFLICT");
}

export function serviceUnavailableError(
  message = "This capability is not configured on this server",
): GraphQLError {
  return graphQLErrorWithCode(message, "SERVICE_UNAVAILABLE");
}

/** Structural check for "is a `GraphQLError`", used instead of `instanceof`
 * because that can spuriously fail: the execution engine
 * (`@graphql-tools/executor`, pulled in transitively by graphql-yoga) may
 * resolve a different copy of the `graphql` module than this file imports,
 * making its errors a different class identity. `@envelop/core` uses the
 * same `.name` check for the same reason. */
function isGraphQLErrorLike(value: unknown): value is GraphQLError {
  return value instanceof Error && value.name === "GraphQLError";
}

/** Same structural rationale as {@link isGraphQLErrorLike}: matches
 * `@flying-mail/adapter`'s `MailDeliveryError` by `.name`, since this package has
 * no compile-time dependency on that class. */
function isMailDeliveryErrorLike(value: unknown): value is Error {
  return value instanceof Error && value.name === "MailDeliveryError";
}

/** Maps any thrown value onto a `GraphQLError` carrying the right
 * `extensions.code`.
 *
 * - A bare `GraphQLError` (thrown by a factory above) passes through.
 * - A `GraphQLError` *wrapping* another via `.originalError` -- graphql-js's
 *   `locatedError` does this to every resolver throw to attach
 *   `path`/`locations`, and drops `extensions` doing so -- is unwrapped to
 *   its root cause, mapped, then re-wrapped so the client still gets
 *   accurate positions.
 * - `ApplicationError` subtypes map 1:1 via `.code`, preserving
 *   `BadUserInputError.field`.
 * - `DomainError`s that escaped translation are handled defensively as
 *   `BAD_USER_INPUT` rather than being masked.
 * - `MailDeliveryError` becomes `SERVICE_UNAVAILABLE`: an operator problem
 *   the caller can act on, distinguishable from "something broke".
 * - Everything else is masked as `INTERNAL_SERVER_ERROR` with its message
 *   dropped, so internal detail never reaches a client. */
export function toGraphQLError(err: unknown): GraphQLError {
  if (isGraphQLErrorLike(err)) {
    if (err.originalError === undefined) {
      return err;
    }
    const mapped = toGraphQLError(err.originalError);
    return new GraphQLError(mapped.message, {
      nodes: err.nodes,
      source: err.source,
      positions: err.positions,
      path: err.path,
      originalError: mapped,
      extensions: mapped.extensions,
    });
  }
  const classified = classifyError(err);
  return graphQLErrorWithCode(
    classified.message,
    classified.code,
    classified.field === undefined ? undefined : { field: classified.field },
  );
}

/** Classifies non-GraphQLError causes using GraphQL's established ordering.
 * This is shared with MCP so its domain codes and messages stay identical. */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof BadUserInputError) {
    return err.field === undefined
      ? { code: "BAD_USER_INPUT", message: err.message }
      : { code: "BAD_USER_INPUT", message: err.message, field: err.field };
  }
  if (err instanceof ApplicationError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof ValidationError) {
    return err.field === undefined
      ? { code: "BAD_USER_INPUT", message: err.message }
      : { code: "BAD_USER_INPUT", message: err.message, field: err.field };
  }
  if (err instanceof DomainError) {
    return { code: "BAD_USER_INPUT", message: err.message };
  }
  if (isMailDeliveryErrorLike(err)) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "Email delivery is not configured on this server",
    };
  }
  return { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" };
}
