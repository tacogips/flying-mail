/** Mirrors GraphQL's `extensions.code` 1:1 (see
 * `design-docs/specs/design-graphql-api.md#errors`), so a use case never has
 * to know about the transport it is being surfaced through. */
export type ApplicationErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_USER_INPUT"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE";

/** Base class for every application-layer error surfaced at the
 * GraphQL/REST boundary. Use cases translate `@mailcal/domain` `DomainError`
 * subtypes into one of the concrete subclasses below -- see
 * `usecases/translate-domain-error.ts`. */
export abstract class ApplicationError extends Error {
  abstract readonly code: ApplicationErrorCode;

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** No credential was presented, or the presented API key / session token did
 * not resolve to a viewer. */
export class UnauthenticatedError extends ApplicationError {
  readonly code = "UNAUTHENTICATED";
}

/** A viewer is authenticated but its scopes do not permit the operation.
 *
 * Note the deliberate asymmetry with reads: a *read* of an entity outside
 * the viewer's scope is reported as `NotFoundError`, never this, so an API
 * key cannot probe for the existence of addresses it cannot see. This error
 * is for writes and for operations whose very attempt is already known to
 * the caller. */
export class ForbiddenError extends ApplicationError {
  readonly code = "FORBIDDEN";
}

/** The requested entity does not exist -- or is outside the viewer's scope,
 * which is deliberately indistinguishable (see {@link ForbiddenError}). */
export class NotFoundError extends ApplicationError {
  readonly code = "NOT_FOUND";

  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
  }
}

/** A single field failed validation. */
export class BadUserInputError extends ApplicationError {
  readonly code = "BAD_USER_INPUT";

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** The operation conflicts with current state: a duplicate name, an invalid
 * lifecycle transition, deleting a domain that still holds mail. */
export class ConflictError extends ApplicationError {
  readonly code = "CONFLICT";
}

/** The server understood the request, but a required downstream capability
 * -- in practice, outbound mail -- is not configured on this deployment.
 * Deliberately distinct from a masked internal error: this is an operator
 * problem the caller can act on, and saying so leaks nothing. */
export class ServiceUnavailableError extends ApplicationError {
  readonly code = "SERVICE_UNAVAILABLE";
}
