/** Base class for all domain-layer errors. Concrete subtypes are thrown by
 * the validation factories and state-transition guards across
 * `packages/domain/src`. The application layer translates these into
 * `ApplicationError` subtypes (see `usecases/translate-domain-error.ts`)
 * before they reach any transport boundary. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** A single field failed validation (e.g. a blank required string, a
 * malformed mailbox, a negative attachment size). */
export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/** A reserved system tag (`SPAM`, `TRASH`, `ARCHIVED`, `STARRED`) was
 * renamed or deleted. Clients and the ingest pipeline address these tags by
 * their stable `systemSlug`, so mutating them would silently break
 * classification rather than merely relabel it. */
export class SystemTagImmutableError extends DomainError {
  readonly code = "SYSTEM_TAG_IMMUTABLE";

  constructor(
    message: string,
    readonly tagId: string,
  ) {
    super(message);
  }
}

/** An entity was moved between states its lifecycle does not allow -- e.g.
 * activating an unverified domain, or marking an already-sent message
 * sent a second time. */
export class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION";

  constructor(
    message: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(message);
  }
}

/** Mail was sent from, or accepted for, a domain that has not completed
 * ownership verification. */
export class DomainNotVerifiedError extends DomainError {
  readonly code = "DOMAIN_NOT_VERIFIED";

  constructor(
    message: string,
    readonly domainName: string,
  ) {
    super(message);
  }
}
