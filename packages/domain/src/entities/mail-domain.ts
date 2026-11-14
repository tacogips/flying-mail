import { DomainNotVerifiedError, InvalidStateTransitionError } from "../errors";
import type { DomainName } from "../value-objects/domain-name";
import type { DomainId } from "../value-objects/ids";

/** Lifecycle of a managed mail domain.
 *
 * `PENDING` -- added, ownership not yet asserted. Neither receives nor sends.
 * `ACTIVE`  -- verified and in service.
 * `DISABLED` -- retained with its mail history, but neither receives nor
 *               sends; re-enabling does not require re-verification. */
export enum DomainStatus {
  Pending = "PENDING",
  Active = "ACTIVE",
  Disabled = "DISABLED",
}

export interface MailDomain {
  readonly id: DomainId;
  readonly name: DomainName;
  readonly status: DomainStatus;
  /** When true, mail for any local part is accepted. When false, only local
   * parts already known to the deployment are, and everything else is
   * rejected at SMTP time rather than black-holed. */
  readonly catchAll: boolean;
  readonly verificationToken: string;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMailDomainInput {
  readonly id: DomainId;
  readonly name: DomainName;
  readonly catchAll: boolean;
  readonly verificationToken: string;
  readonly createdAt: string;
}

/** A newly added domain always starts unverified and `PENDING`; there is no
 * input that can construct one straight into `ACTIVE`. */
export function createMailDomain(input: CreateMailDomainInput): MailDomain {
  return {
    id: input.id,
    name: input.name,
    status: DomainStatus.Pending,
    catchAll: input.catchAll,
    verificationToken: input.verificationToken,
    verifiedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Records ownership verification and puts the domain in service.
 * Re-verifying an already-verified domain is a no-op that refreshes
 * `updatedAt`, so a retried operator action is not an error. */
export function verifyMailDomain(
  domain: MailDomain,
  verifiedAt: string,
): MailDomain {
  if (domain.verifiedAt !== null) {
    return { ...domain, status: DomainStatus.Active, updatedAt: verifiedAt };
  }
  return {
    ...domain,
    status: DomainStatus.Active,
    verifiedAt,
    updatedAt: verifiedAt,
  };
}

/** Moves the domain between statuses. Activating an unverified domain is
 * rejected: doing so would accept mail for a domain whose ownership nobody
 * has asserted. */
export function setMailDomainStatus(
  domain: MailDomain,
  status: DomainStatus,
  updatedAt: string,
): MailDomain {
  if (status === DomainStatus.Active && domain.verifiedAt === null) {
    throw new InvalidStateTransitionError(
      `Domain ${domain.name} cannot be activated before it is verified`,
      domain.status,
      status,
    );
  }
  return { ...domain, status, updatedAt };
}

/** True when the domain may accept inbound mail. */
export function canReceiveMail(domain: MailDomain): boolean {
  return domain.status === DomainStatus.Active;
}

/** True when the domain may be used as an outbound sender. */
export function canSendMail(domain: MailDomain): boolean {
  return domain.status === DomainStatus.Active && domain.verifiedAt !== null;
}

/** Guard for the send path: throws rather than returning false, so callers
 * that must not proceed cannot forget to check. */
export function assertCanSendMail(domain: MailDomain): void {
  if (!canSendMail(domain)) {
    throw new DomainNotVerifiedError(
      `Domain ${domain.name} is not verified and active for sending`,
      domain.name,
    );
  }
}
