import { ValidationError } from "../errors";
import type { EmailAddress } from "../value-objects/email-address";
import type { ExternalAccountId, MailAddressId } from "../value-objects/ids";

/** Whether an external account is currently eligible for fetch/send.
 *
 * `DISABLED` is not deletion: the account keeps its stored ciphertext and
 * dedupe ledger, and resumes the moment it is re-enabled. Fetch orchestration
 * refuses a `DISABLED` account outright rather than silently skipping it. */
export enum ExternalAccountStatus {
  Active = "ACTIVE",
  Disabled = "DISABLED",
}

/** How flying-mail reaches the remote mailbox to fetch mail. A discriminated
 * union rather than one config with optional fields, so a `JMAP` account can
 * never carry a stray POP3 port and vice versa.
 *
 * `sessionUrl` must be absolute `https` (`http` allowed for `localhost`
 * only). `port` must
 * be `995`: POP3's only supported dial is implicit TLS, because a
 * STARTTLS-on-110 downgrade is exactly the attack a hostile network wants --
 * see {@link validatePop3Endpoint}. */
export type ExternalFetchConfig =
  | {
      readonly kind: "JMAP";
      readonly sessionUrl: string;
      readonly username: string;
      readonly passwordCiphertext: string;
    }
  | {
      readonly kind: "POP3";
      readonly host: string;
      readonly port: number;
      readonly username: string;
      readonly passwordCiphertext: string;
    };

/** `465` implies implicit TLS from the first byte; `587` implies a
 * plaintext `EHLO` followed by `STARTTLS`. See
 * {@link validateSmtpSubmissionConfig} for the port/security agreement this
 * type does not enforce on its own. */
export type SmtpSecurity = "IMPLICIT_TLS" | "STARTTLS";

/** Outbound submission credentials for sending mail *as* the bound external
 * address. Optional on the account: without it, `sendMessage` falls back to
 * the existing Cloudflare Email Sending path. */
export interface SmtpSubmissionConfig {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly username: string;
  readonly passwordCiphertext: string;
}

/** A user's binding of one provisioned `mail_addresses` row to a remote JMAP
 * or POP3 mailbox for fetch, plus an optional SMTP submission config for
 * send.
 *
 * The entity holds **ciphertext only** for every credential: plaintext
 * passwords exist solely inside the connect/fetch/send use cases, for the
 * duration of one request -- see `CredentialCipher`. */
export interface ExternalMailAccount {
  readonly id: ExternalAccountId;
  readonly mailAddressId: MailAddressId;
  readonly externalAddress: EmailAddress;
  readonly displayName: string | null;
  readonly fetch: ExternalFetchConfig;
  readonly smtp: SmtpSubmissionConfig | null;
  readonly status: ExternalAccountStatus;
  readonly lastFetchedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateExternalMailAccountInput {
  readonly id: ExternalAccountId;
  readonly mailAddressId: MailAddressId;
  readonly externalAddress: EmailAddress;
  readonly displayName?: string | null;
  readonly fetch: ExternalFetchConfig;
  readonly smtp?: SmtpSubmissionConfig | null;
  readonly createdAt: string;
}

/** Rejects anything but an absolute `https` URL. A plain-`http` JMAP session
 * resource would carry the password (via `AUTH PLAIN`/Basic) in clear text
 * on the wire; `http` is allowed only for `localhost`, so integration
 * testing against a local server stays possible without weakening the real
 * rule. */
export function normalizeJmapSessionUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(
      "JMAP session URL must be an absolute URL",
      "sessionUrl",
    );
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ValidationError("JMAP session URL must use https", "sessionUrl");
  }
  return url.toString();
}

const POP3_IMPLICIT_TLS_PORT = 995;

/** POP3 accepts implicit TLS on `995` only. Port `110` (plaintext, optional
 * `STLS` upgrade) is refused unconditionally: a network attacker who can
 * intercept the connection before `STLS` runs can simply strip the upgrade,
 * so there is no safe way to offer it. */
export function validatePop3Endpoint(host: string, port: number): void {
  if (host.trim().length === 0) {
    throw new ValidationError("POP3 host must not be empty", "host");
  }
  if (port !== POP3_IMPLICIT_TLS_PORT) {
    throw new ValidationError(
      `POP3 port must be ${POP3_IMPLICIT_TLS_PORT} (implicit TLS); plaintext port 110 is not supported`,
      "port",
    );
  }
}

const SMTP_PORT_SECURITY: Readonly<Record<number, SmtpSecurity>> = {
  465: "IMPLICIT_TLS",
  587: "STARTTLS",
};

/** Enforces the one dial flying-mail supports per port: `465` must declare
 * `IMPLICIT_TLS`, `587` must declare `STARTTLS`. Any other port is refused
 * outright -- submission only ever happens on these two, and Workers'
 * `cloudflare:sockets` cannot reach port 25 regardless. */
export function validateSmtpSubmissionConfig(
  config: SmtpSubmissionConfig,
): void {
  if (config.host.trim().length === 0) {
    throw new ValidationError("SMTP host must not be empty", "host");
  }
  const expectedSecurity = SMTP_PORT_SECURITY[config.port];
  if (expectedSecurity === undefined) {
    throw new ValidationError(
      "SMTP port must be 465 (implicit TLS) or 587 (STARTTLS)",
      "port",
    );
  }
  if (config.security !== expectedSecurity) {
    throw new ValidationError(
      `SMTP port ${config.port} requires security ${expectedSecurity}`,
      "security",
    );
  }
  if (config.username.trim().length === 0) {
    throw new ValidationError("SMTP username must not be empty", "username");
  }
  if (config.passwordCiphertext.trim().length === 0) {
    throw new ValidationError(
      "SMTP password ciphertext must not be empty",
      "passwordCiphertext",
    );
  }
}

/** Validates and normalizes the `username`/`passwordCiphertext` fields every
 * `ExternalFetchConfig` branch shares, then dispatches to the branch-specific
 * check. */
function normalizeFetchConfig(fetch: ExternalFetchConfig): ExternalFetchConfig {
  const username = fetch.username.trim();
  if (username.length === 0) {
    throw new ValidationError(
      `${fetch.kind} username must not be empty`,
      "username",
    );
  }
  if (fetch.passwordCiphertext.trim().length === 0) {
    throw new ValidationError(
      `${fetch.kind} password ciphertext must not be empty`,
      "passwordCiphertext",
    );
  }
  switch (fetch.kind) {
    case "JMAP":
      return {
        ...fetch,
        username,
        sessionUrl: normalizeJmapSessionUrl(fetch.sessionUrl),
      };
    case "POP3":
      validatePop3Endpoint(fetch.host, fetch.port);
      return { ...fetch, username };
    default: {
      const exhaustive: never = fetch;
      throw new Error(`Unhandled fetch kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function normalizeSmtpConfig(
  config: SmtpSubmissionConfig,
): SmtpSubmissionConfig {
  const normalized: SmtpSubmissionConfig = {
    ...config,
    host: config.host.trim(),
    username: config.username.trim(),
  };
  validateSmtpSubmissionConfig(normalized);
  return normalized;
}

function normalizeDisplayName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function createExternalMailAccount(
  input: CreateExternalMailAccountInput,
): ExternalMailAccount {
  const smtp = input.smtp ?? null;
  return {
    id: input.id,
    mailAddressId: input.mailAddressId,
    externalAddress: input.externalAddress,
    displayName: normalizeDisplayName(input.displayName),
    fetch: normalizeFetchConfig(input.fetch),
    smtp: smtp === null ? null : normalizeSmtpConfig(smtp),
    status: ExternalAccountStatus.Active,
    lastFetchedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Swaps the fetch protocol/credentials wholesale -- e.g. moving a POP3
 * account to JMAP, or rotating a password. There is no partial-field update
 * here: the caller (the `update` use case) merges the new plaintext fields
 * over the old ones and re-enciphers before calling this. */
export function replaceExternalMailAccountFetch(
  account: ExternalMailAccount,
  fetch: ExternalFetchConfig,
  now: string,
): ExternalMailAccount {
  return {
    ...account,
    fetch: normalizeFetchConfig(fetch),
    updatedAt: now,
  };
}

/** Sets or clears the SMTP relay config. `null` clears it, which routes
 * subsequent sends back through the Cloudflare Email Sending fallback. */
export function replaceExternalMailAccountSmtp(
  account: ExternalMailAccount,
  smtp: SmtpSubmissionConfig | null,
  now: string,
): ExternalMailAccount {
  return {
    ...account,
    smtp: smtp === null ? null : normalizeSmtpConfig(smtp),
    updatedAt: now,
  };
}

export function renameExternalMailAccount(
  account: ExternalMailAccount,
  displayName: string | null,
  now: string,
): ExternalMailAccount {
  return {
    ...account,
    displayName: normalizeDisplayName(displayName),
    updatedAt: now,
  };
}

export function setExternalMailAccountStatus(
  account: ExternalMailAccount,
  status: ExternalAccountStatus,
  now: string,
): ExternalMailAccount {
  return account.status === status
    ? account
    : { ...account, status, updatedAt: now };
}

/** Records a completed fetch run. Called once per orchestration run
 * regardless of how many messages it ingested, so `lastFetchedAt` reflects
 * "last time this account was polled", not "last time it found new mail". */
export function markExternalMailAccountFetched(
  account: ExternalMailAccount,
  now: string,
): ExternalMailAccount {
  return { ...account, lastFetchedAt: now, updatedAt: now };
}

export function isExternalAccountActive(account: ExternalMailAccount): boolean {
  return account.status === ExternalAccountStatus.Active;
}
