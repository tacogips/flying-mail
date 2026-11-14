import {
  DomainError,
  DomainNotVerifiedError,
  InvalidStateTransitionError,
  SystemTagImmutableError,
  ValidationError,
} from "@mailcal/domain/errors";
import { ApplicationError, BadUserInputError, ConflictError } from "../errors";

/** Re-throws a `@mailcal/domain` error as the matching `ApplicationError`.
 * Anything that is not a `DomainError` -- including an `ApplicationError`
 * a use case raised deliberately -- is re-thrown untouched, so this can be
 * wrapped around a whole operation without swallowing intent. */
export function translateDomainError(error: unknown): never {
  if (error instanceof ApplicationError) {
    throw error;
  }
  if (error instanceof ValidationError) {
    throw new BadUserInputError(error.message, error.field);
  }
  if (error instanceof SystemTagImmutableError) {
    throw new ConflictError(error.message, error);
  }
  if (error instanceof InvalidStateTransitionError) {
    throw new ConflictError(error.message, error);
  }
  if (error instanceof DomainNotVerifiedError) {
    throw new ConflictError(error.message, error);
  }
  if (error instanceof DomainError) {
    // A DomainError subtype added later without a case here still surfaces
    // as a client-visible 4xx rather than being masked as a 500.
    throw new BadUserInputError(error.message);
  }
  throw error;
}

/** Runs `fn`, translating any `DomainError` it throws. */
export function withDomainErrorTranslation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    return translateDomainError(error);
  }
}

/** Async form of {@link withDomainErrorTranslation}. */
export async function withAsyncDomainErrorTranslation<T>(
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return translateDomainError(error);
  }
}
