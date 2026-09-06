import { Capability } from "@mailcal/domain/entities/api-key";
import {
  type ExternalFetchConfig,
  type ExternalMailAccount,
  ExternalAccountStatus,
  createExternalMailAccount,
  renameExternalMailAccount,
  replaceExternalMailAccountFetch,
  replaceExternalMailAccountSmtp,
  setExternalMailAccountStatus,
  type SmtpSecurity,
  type SmtpSubmissionConfig,
} from "@mailcal/domain/entities/external-mail-account";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createExternalAccountId,
  type ExternalAccountId,
  type MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import {
  BadUserInputError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import { requireGlobalCapability } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import {
  ExternalMailAuthError,
  ExternalMailTransportError,
} from "../ports/external-mail";
import { requireMailAddress } from "./mail-addresses";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export type ExternalFetchInput =
  | {
      readonly kind: "JMAP";
      readonly sessionUrl: string;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly kind: "POP3";
      readonly host: string;
      readonly port?: number;
      readonly username: string;
      readonly password: string;
    };

/** A partial update of one `ExternalFetchInput` branch: every field but
 * `kind` is optional, and an omitted `password` keeps the stored ciphertext.
 * A plain `Partial<ExternalFetchInput>` cannot express this -- `keyof` a
 * union type is the *intersection* of its members' keys, so it would silently
 * drop `sessionUrl`/`host`/`port`. */
export type UpdateExternalFetchInput =
  | {
      readonly kind: "JMAP";
      readonly sessionUrl?: string;
      readonly username?: string;
      readonly password?: string;
    }
  | {
      readonly kind: "POP3";
      readonly host?: string;
      readonly port?: number;
      readonly username?: string;
      readonly password?: string;
    };

export interface SmtpSubmissionInput {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly username: string;
  readonly password: string;
}

export interface CreateExternalAccountInput {
  readonly mailAddressId: MailAddressId;
  readonly externalAddress: string;
  readonly displayName?: string | null;
  readonly fetch: ExternalFetchInput;
  readonly smtp?: SmtpSubmissionInput | null;
}

/** An omitted `password` re-uses the stored ciphertext; `smtp: null` clears
 * the relay config. */
export interface UpdateExternalAccountInput {
  readonly displayName?: string | null;
  readonly fetch?: UpdateExternalFetchInput;
  readonly smtp?:
    | (Partial<SmtpSubmissionInput> & {
        readonly host: string;
        readonly port: number;
        readonly security: SmtpSecurity;
      })
    | null;
  readonly status?: ExternalAccountStatus;
}

export interface ExternalAccountTestResult {
  readonly fetchOk: boolean;
  readonly fetchError: string | null;
  /** `null` when the account has no SMTP relay configured. */
  readonly smtpOk: boolean | null;
  readonly smtpError: string | null;
}

/** Every external-mail entry point starts here: without a configured
 * `MAILCAL_CREDENTIAL_KEY` there is nowhere safe to put a password, so the
 * feature reports itself unavailable instead of storing plaintext. */
export function requireCipher(deps: AppDependencies): void {
  if (!deps.credentialCipher.available) {
    throw new ServiceUnavailableError(
      "External mail accounts are not configured on this deployment: MAILCAL_CREDENTIAL_KEY is unset",
    );
  }
}

async function encipherFetchConfig(
  deps: AppDependencies,
  input: ExternalFetchInput,
): Promise<ExternalFetchConfig> {
  const passwordCiphertext = await deps.credentialCipher.encrypt(
    input.password,
  );
  if (input.kind === "JMAP") {
    return {
      kind: "JMAP",
      sessionUrl: input.sessionUrl,
      username: input.username,
      passwordCiphertext,
    };
  }
  return {
    kind: "POP3",
    host: input.host,
    port: input.port ?? 995,
    username: input.username,
    passwordCiphertext,
  };
}

async function encipherSmtpConfig(
  deps: AppDependencies,
  input: SmtpSubmissionInput,
): Promise<SmtpSubmissionConfig> {
  return {
    host: input.host,
    port: input.port,
    security: input.security,
    username: input.username,
    passwordCiphertext: await deps.credentialCipher.encrypt(input.password),
  };
}

/** Merges a partial fetch-config update over the stored config: an omitted
 * field (including `password`) keeps the previous value, so rotating only
 * the password -- or only the host -- never requires resending the rest. */
async function mergeFetchConfig(
  deps: AppDependencies,
  current: ExternalFetchConfig,
  patch: UpdateExternalFetchInput,
): Promise<ExternalFetchConfig> {
  const passwordCiphertext =
    patch.password === undefined
      ? current.passwordCiphertext
      : await deps.credentialCipher.encrypt(patch.password);
  if (patch.kind === "JMAP") {
    const base = current.kind === "JMAP" ? current : null;
    return {
      kind: "JMAP",
      sessionUrl: patch.sessionUrl ?? base?.sessionUrl ?? "",
      username: patch.username ?? base?.username ?? "",
      passwordCiphertext,
    };
  }
  const base = current.kind === "POP3" ? current : null;
  return {
    kind: "POP3",
    host: patch.host ?? base?.host ?? "",
    port: patch.port ?? base?.port ?? 995,
    username: patch.username ?? base?.username ?? "",
    passwordCiphertext,
  };
}

/** Merges a partial SMTP update over the stored config, or builds a fresh
 * one when SMTP was previously unconfigured -- in which case `password` is
 * required, since there is no prior ciphertext to fall back to. */
async function mergeSmtpConfig(
  deps: AppDependencies,
  current: SmtpSubmissionConfig | null,
  patch: Exclude<UpdateExternalAccountInput["smtp"], null | undefined>,
): Promise<SmtpSubmissionConfig> {
  let passwordCiphertext: string;
  if (patch.password !== undefined) {
    passwordCiphertext = await deps.credentialCipher.encrypt(patch.password);
  } else if (current !== null) {
    passwordCiphertext = current.passwordCiphertext;
  } else {
    throw new BadUserInputError(
      "password is required when configuring SMTP for the first time",
      "smtp.password",
    );
  }
  return {
    host: patch.host,
    port: patch.port,
    security: patch.security,
    username: patch.username ?? current?.username ?? "",
    passwordCiphertext,
  };
}

function describeTestError(error: unknown): string {
  if (error instanceof ExternalMailAuthError) {
    return error.message;
  }
  if (error instanceof ExternalMailTransportError) {
    return error.message;
  }
  return error instanceof Error ? error.message : "Unknown connection failure";
}

async function requireExternalAccount(
  deps: AppDependencies,
  id: ExternalAccountId,
): Promise<ExternalMailAccount> {
  const account = await deps.externalMailAccountRepository.findById(id);
  if (account === null) {
    throw new NotFoundError("ExternalMailAccount", id);
  }
  return account;
}

export function createListExternalAccountsUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly ExternalMailAccount[]> {
  return async (viewer) => {
    requireGlobalCapability(viewer, Capability.DomainAdmin);
    requireCipher(deps);
    return deps.externalMailAccountRepository.list();
  };
}

export function createCreateExternalAccountUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: CreateExternalAccountInput,
) => Promise<ExternalMailAccount> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.DomainAdmin);
      requireCipher(deps);
      await requireMailAddress(deps, input.mailAddressId);

      const existing =
        await deps.externalMailAccountRepository.findByMailAddress(
          input.mailAddressId,
        );
      if (existing !== null) {
        throw new ConflictError(
          "This mail address already has an external account",
        );
      }

      const fetch = await encipherFetchConfig(deps, input.fetch);
      const smtp =
        input.smtp == null ? null : await encipherSmtpConfig(deps, input.smtp);

      const account = createExternalMailAccount({
        id: createExternalAccountId(deps.random.uuid()),
        mailAddressId: input.mailAddressId,
        externalAddress: createEmailAddress(
          input.externalAddress,
          "externalAddress",
        ),
        ...(input.displayName === undefined
          ? {}
          : { displayName: input.displayName }),
        fetch,
        smtp,
        createdAt: deps.clock.now().toISOString(),
      });
      await deps.externalMailAccountRepository.save(account);
      return account;
    });
}

export function createUpdateExternalAccountUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: ExternalAccountId,
  input: UpdateExternalAccountInput,
) => Promise<ExternalMailAccount> {
  return async (viewer, id, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.DomainAdmin);
      requireCipher(deps);
      let account = await requireExternalAccount(deps, id);
      const now = deps.clock.now().toISOString();

      if (input.displayName !== undefined) {
        account = renameExternalMailAccount(account, input.displayName, now);
      }
      if (input.fetch !== undefined) {
        account = replaceExternalMailAccountFetch(
          account,
          await mergeFetchConfig(deps, account.fetch, input.fetch),
          now,
        );
      }
      if (input.smtp !== undefined) {
        account = replaceExternalMailAccountSmtp(
          account,
          input.smtp === null
            ? null
            : await mergeSmtpConfig(deps, account.smtp, input.smtp),
          now,
        );
      }
      if (input.status !== undefined) {
        account = setExternalMailAccountStatus(account, input.status, now);
      }

      await deps.externalMailAccountRepository.save(account);
      return account;
    });
}

export function createDeleteExternalAccountUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: ExternalAccountId) => Promise<boolean> {
  return async (viewer, id) => {
    requireGlobalCapability(viewer, Capability.DomainAdmin);
    requireCipher(deps);
    await requireExternalAccount(deps, id);
    await deps.externalMailAccountRepository.delete(id);
    return true;
  };
}

/** Connect + authenticate only (each leg's own `testConnection`), no fetch
 * or send -- so misconfiguration is debuggable without waiting for a real
 * fetch run. Each leg's failure is caught independently, so a broken SMTP
 * relay never masks a working fetch leg or vice versa. */
export function createTestExternalAccountUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: ExternalAccountId,
) => Promise<ExternalAccountTestResult> {
  return async (viewer, id) => {
    requireGlobalCapability(viewer, Capability.DomainAdmin);
    requireCipher(deps);
    const account = await requireExternalAccount(deps, id);

    let fetchOk = false;
    let fetchError: string | null = null;
    try {
      const password = await deps.credentialCipher.decrypt(
        account.fetch.passwordCiphertext,
      );
      if (account.fetch.kind === "JMAP") {
        await deps.jmapClient.testConnection({
          sessionUrl: account.fetch.sessionUrl,
          username: account.fetch.username,
          password,
        });
      } else {
        await deps.pop3Client.testConnection({
          host: account.fetch.host,
          port: account.fetch.port,
          username: account.fetch.username,
          password,
        });
      }
      fetchOk = true;
    } catch (error) {
      fetchError = describeTestError(error);
    }

    let smtpOk: boolean | null = null;
    let smtpError: string | null = null;
    if (account.smtp !== null) {
      const smtp = account.smtp;
      try {
        const password = await deps.credentialCipher.decrypt(
          smtp.passwordCiphertext,
        );
        await deps.smtpSubmissionClient.testConnection({
          host: smtp.host,
          port: smtp.port,
          security: smtp.security,
          username: smtp.username,
          password,
        });
        smtpOk = true;
      } catch (error) {
        smtpOk = false;
        smtpError = describeTestError(error);
      }
    }

    return { fetchOk, fetchError, smtpOk, smtpError };
  };
}

export { ExternalAccountStatus };
