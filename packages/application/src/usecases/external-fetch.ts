import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  type ExternalMailAccount,
  isExternalAccountActive,
  markExternalMailAccountFetched,
} from "@flying-mail/domain/entities/external-mail-account";
import { createExternalMessageState } from "@flying-mail/domain/entities/external-message-state";
import type { MailAddress } from "@flying-mail/domain/entities/mail-address";
import type { EmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createMessageId,
  type ExternalAccountId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ConflictError, NotFoundError } from "../errors";
import { authorizesAnyAddress } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import { requireCipher } from "./external-accounts";
import type { ReceiveMessageInput, ReceiveMessageResult } from "./ingest";

export const DEFAULT_EXTERNAL_FETCH_MAX = 50;

export interface FetchExternalMailInput {
  readonly max?: number;
}

export interface FetchExternalMailSummary {
  readonly fetched: number;
  readonly skipped: number;
  readonly hasMore: boolean;
}

/** Builds the synthetic `ReceiveMessageInput` for one fetched remote
 * message: the bound managed address is the delivery recipient, and the
 * external account's own address is the envelope-sender fallback `ingest`
 * uses when the raw message's own `From` header is missing or unparsable.
 * Mirrors `buildDevIngestInput`. */
export function buildExternalFetchIngestInput(params: {
  readonly raw: Uint8Array;
  readonly to: EmailAddress;
  readonly from: EmailAddress;
}): ReceiveMessageInput {
  return {
    envelopeFrom: params.from,
    envelopeTo: params.to,
    raw: params.raw,
    rawSize: params.raw.length,
    headers: new Map(),
  };
}

interface AuthorizedAccount {
  readonly account: ExternalMailAccount;
  readonly mailAddress: MailAddress;
}

async function loadAuthorizedAccount(
  deps: AppDependencies,
  viewer: Viewer,
  accountId: ExternalAccountId,
): Promise<AuthorizedAccount> {
  const account = await deps.externalMailAccountRepository.findById(accountId);
  if (account === null) {
    throw new NotFoundError("ExternalMailAccount", accountId);
  }
  const mailAddress = await deps.mailAddressRepository.findById(
    account.mailAddressId,
  );
  // `mailAddress` is guaranteed by the schema's foreign key in a real
  // deployment; treated the same as "not found" defensively rather than
  // throwing an internal error. An unauthorized viewer gets the identical
  // NOT_FOUND, so this reveals nothing about which case applied.
  if (
    mailAddress === null ||
    !authorizesAnyAddress(viewer, Capability.MailRead, mailAddress.domainId, [
      mailAddress.address,
    ])
  ) {
    throw new NotFoundError("ExternalMailAccount", accountId);
  }
  return { account, mailAddress };
}

type IngestOutcome = "FETCHED" | "SKIPPED";

/** Ingests one fetched remote message through the existing pipeline. */
async function ingestFetchedMessage(
  deps: AppDependencies,
  receiveMessage: (input: ReceiveMessageInput) => Promise<ReceiveMessageResult>,
  account: ExternalMailAccount,
  mailAddress: MailAddress,
  remoteId: string,
  raw: Uint8Array,
  now: string,
): Promise<IngestOutcome> {
  const alreadyFetched = await deps.externalMessageStateRepository.find(
    account.id,
    remoteId,
  );
  if (alreadyFetched !== null) {
    return "SKIPPED";
  }

  // Pre-generated so the ledger row built below can name the exact id
  // `receiveMessage` will assign the stored message -- required for that
  // ledger `SqlStatement` to ride the *same* `insertWithRelations` batch as
  // the message insert, rather than a write that follows it.
  const messageId = createMessageId(deps.random.uuid());
  const state = createExternalMessageState({
    accountId: account.id,
    remoteId,
    messageId,
    fetchedAt: now,
  });

  const result = await receiveMessage({
    ...buildExternalFetchIngestInput({
      raw,
      to: mailAddress.address,
      from: account.externalAddress,
    }),
    messageId,
    extraStatements: [
      deps.externalMessageStateRepository.buildSaveStatement(state),
    ],
  });

  switch (result.kind) {
    case "STORED":
      // The ledger row above already rode the batch that inserted the
      // message; nothing further to persist.
      return "FETCHED";
    case "DUPLICATE": {
      // `receiveMessage`'s own `rfc_message_id` dedupe fired: no
      // `insertWithRelations` call happened, so there was no batch for the
      // statement above to join. The pre-generated id was never used;
      // record the ledger row against the message that actually exists.
      await deps.externalMessageStateRepository.save(
        createExternalMessageState({
          accountId: account.id,
          remoteId,
          messageId: result.message.id,
          fetchedAt: now,
        }),
      );
      return "FETCHED";
    }
    case "REJECTED":
      // Not expected in practice -- the envelope is always the bound,
      // active managed address -- but one malformed remote message must not
      // abort the rest of the run.
      return "SKIPPED";
    default: {
      const exhaustive: never = result;
      throw new Error(
        `Unhandled receiveMessage result: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Fetch orchestration over an existing `ExternalMailAccount`: JMAP or POP3,
 * deduped against the ledger, capped per run. Gated on `MAIL_READ` for the
 * bound address rather than `DomainAdmin` -- any authorized reader may poll
 * -- so `fetchExternalMail` deliberately does not call `requireCipher`
 * before authorization the way the admin CRUD use cases do; it is called
 * once the account is loaded, immediately before the first decrypt. */
export function createFetchExternalMailUseCase(
  deps: AppDependencies,
  receiveMessage: (input: ReceiveMessageInput) => Promise<ReceiveMessageResult>,
): (
  viewer: Viewer,
  accountId: ExternalAccountId,
  input?: FetchExternalMailInput,
) => Promise<FetchExternalMailSummary> {
  return async (viewer, accountId, input) => {
    const { account, mailAddress } = await loadAuthorizedAccount(
      deps,
      viewer,
      accountId,
    );
    if (!isExternalAccountActive(account)) {
      throw new ConflictError(
        `External account ${accountId} is disabled; enable it before fetching`,
      );
    }
    requireCipher(deps);

    const max = input?.max ?? DEFAULT_EXTERNAL_FETCH_MAX;
    const now = deps.clock.now().toISOString();
    const password = await deps.credentialCipher.decrypt(
      account.fetch.passwordCiphertext,
    );

    let fetched = 0;
    let skipped = 0;
    let hasMore = false;

    const recordOutcome = (outcome: IngestOutcome): void => {
      if (outcome === "FETCHED") {
        fetched += 1;
      } else {
        skipped += 1;
      }
    };

    if (account.fetch.kind === "JMAP") {
      const known = await deps.externalMessageStateRepository.listRemoteIds(
        account.id,
      );
      const result = await deps.jmapClient.fetchSince(
        {
          sessionUrl: account.fetch.sessionUrl,
          username: account.fetch.username,
          password,
        },
        known,
        max,
      );
      hasMore = result.hasMore;
      for (const message of result.messages) {
        recordOutcome(
          await ingestFetchedMessage(
            deps,
            receiveMessage,
            account,
            mailAddress,
            message.remoteId,
            message.raw,
            now,
          ),
        );
      }
    } else {
      const credentials = {
        host: account.fetch.host,
        port: account.fetch.port,
        username: account.fetch.username,
        password,
      };
      const uidls = await deps.pop3Client.listUidls(credentials);
      const known = await deps.externalMessageStateRepository.listRemoteIds(
        account.id,
      );
      const newUidls = uidls.filter((uidl) => !known.has(uidl));
      const capped = newUidls.slice(0, max);
      hasMore = capped.length < newUidls.length;
      const messages = await deps.pop3Client.fetchByUidl(credentials, capped);
      for (const message of messages) {
        recordOutcome(
          await ingestFetchedMessage(
            deps,
            receiveMessage,
            account,
            mailAddress,
            message.remoteId,
            message.raw,
            now,
          ),
        );
      }
    }

    await deps.externalMailAccountRepository.save(
      markExternalMailAccountFetched(account, now),
    );

    return { fetched, skipped, hasMore };
  };
}
