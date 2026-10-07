import type { ExternalMailAccount } from "@flying-mail/domain/entities/external-mail-account";
import type { ExternalMessageState } from "@flying-mail/domain/entities/external-message-state";
import type { ExternalAccountId } from "@flying-mail/domain/value-objects/ids";
import type {
  ExternalMailAccountRepository,
  ExternalMessageStateRepository,
  JmapClient,
  JmapCredentials,
  JmapFetchResult,
  Pop3Client,
  Pop3Credentials,
  SmtpCredentials,
  SmtpEnvelope,
  SmtpSubmissionClient,
  TcpDialer,
  TextSocket,
} from "../ports/external-mail";
import type { SqlStatement } from "../ports/sql-database";

export interface FakeExternalMailStores {
  readonly accounts: Map<string, ExternalMailAccount>;
  /** Keyed by `${accountId} ${remoteId}`. */
  readonly states: Map<string, ExternalMessageState>;
}

export function createFakeExternalMailStores(): FakeExternalMailStores {
  return { accounts: new Map(), states: new Map() };
}

function stateKey(accountId: string, remoteId: string): string {
  return `${accountId} ${remoteId}`;
}

export function fakeExternalMailAccountRepository(
  stores: FakeExternalMailStores,
): ExternalMailAccountRepository {
  return {
    async findById(id) {
      return stores.accounts.get(id) ?? null;
    },
    async findByMailAddress(mailAddressId) {
      return (
        [...stores.accounts.values()].find(
          (account) => account.mailAddressId === mailAddressId,
        ) ?? null
      );
    },
    async list() {
      return [...stores.accounts.values()];
    },
    async save(account) {
      stores.accounts.set(account.id, account);
    },
    async delete(id: ExternalAccountId) {
      stores.accounts.delete(id);
      for (const [key, state] of stores.states) {
        if (state.accountId === id) {
          stores.states.delete(key);
        }
      }
    },
  };
}

/** A `SqlStatement` produced by this fake ledger's `buildSaveStatement`,
 * carrying an `apply` callback that `fakeMessageRepository.insertWithRelations`
 * invokes when (and only when) the statement actually rides an
 * `insertWithRelations` batch -- reproducing, for tests, what running it
 * inside the real `db.batch()` call would do. A real adapter builds a plain
 * `{ sql, params }` statement instead; `apply` is fake-only machinery, never
 * part of the port contract. */
export interface FakeLedgerStatement extends SqlStatement {
  readonly apply: () => void;
}

export function fakeExternalMessageStateRepository(
  stores: FakeExternalMailStores,
): ExternalMessageStateRepository {
  return {
    async find(accountId, remoteId) {
      return stores.states.get(stateKey(accountId, remoteId)) ?? null;
    },
    async listRemoteIds(accountId) {
      const ids = new Set<string>();
      for (const state of stores.states.values()) {
        if (state.accountId === accountId) {
          ids.add(state.remoteId);
        }
      }
      return ids;
    },
    async save(state) {
      stores.states.set(stateKey(state.accountId, state.remoteId), state);
    },
    buildSaveStatement(state): FakeLedgerStatement {
      return {
        sql: "-- fake external_message_states upsert",
        params: [
          state.accountId,
          state.remoteId,
          state.messageId,
          state.fetchedAt,
        ],
        apply: () => {
          stores.states.set(stateKey(state.accountId, state.remoteId), state);
        },
      };
    },
  };
}

export interface JmapScript {
  readonly testConnectionError?: Error;
  readonly fetchSinceResult?: JmapFetchResult;
  readonly fetchSinceError?: Error;
}

export interface JmapFetchSinceCall {
  readonly credentials: JmapCredentials;
  readonly knownRemoteIds: ReadonlySet<string>;
  readonly max: number;
}

export interface ScriptedJmapClient extends JmapClient {
  readonly testConnectionCalls: readonly JmapCredentials[];
  readonly fetchSinceCalls: readonly JmapFetchSinceCall[];
}

/** A `JmapClient` driven entirely by a canned script -- no network anywhere
 * in the application test suite. Real JMAP interop is verified against
 * recorded fixtures in the adapter package instead. */
export function scriptedJmapClient(
  script: JmapScript = {},
): ScriptedJmapClient {
  const testConnectionCalls: JmapCredentials[] = [];
  const fetchSinceCalls: JmapFetchSinceCall[] = [];
  return {
    testConnectionCalls,
    fetchSinceCalls,
    async testConnection(credentials) {
      testConnectionCalls.push(credentials);
      if (script.testConnectionError !== undefined) {
        throw script.testConnectionError;
      }
    },
    async fetchSince(credentials, knownRemoteIds, max) {
      fetchSinceCalls.push({ credentials, knownRemoteIds, max });
      if (script.fetchSinceError !== undefined) {
        throw script.fetchSinceError;
      }
      return script.fetchSinceResult ?? { messages: [], hasMore: false };
    },
  };
}

export interface Pop3Script {
  readonly testConnectionError?: Error;
  readonly uidls?: readonly string[];
  readonly listUidlsError?: Error;
  /** Raw bytes returned by `fetchByUidl` for a given UIDL; an id with no
   * entry falls back to an empty message. */
  readonly messagesByUidl?: ReadonlyMap<string, Uint8Array>;
  readonly fetchByUidlError?: Error;
}

export interface ScriptedPop3Client extends Pop3Client {
  readonly testConnectionCalls: number;
  readonly listUidlsCalls: readonly Pop3Credentials[];
  readonly fetchByUidlCalls: readonly (readonly string[])[];
}

/** A `Pop3Client` driven entirely by a canned script. */
export function scriptedPop3Client(
  script: Pop3Script = {},
): ScriptedPop3Client {
  const listUidlsCalls: Pop3Credentials[] = [];
  const fetchByUidlCalls: (readonly string[])[] = [];
  let testConnectionCalls = 0;
  return {
    get testConnectionCalls() {
      return testConnectionCalls;
    },
    listUidlsCalls,
    fetchByUidlCalls,
    async testConnection() {
      testConnectionCalls += 1;
      if (script.testConnectionError !== undefined) {
        throw script.testConnectionError;
      }
    },
    async listUidls(credentials) {
      listUidlsCalls.push(credentials);
      if (script.listUidlsError !== undefined) {
        throw script.listUidlsError;
      }
      return script.uidls ?? [];
    },
    async fetchByUidl(_credentials, uidls) {
      fetchByUidlCalls.push(uidls);
      if (script.fetchByUidlError !== undefined) {
        throw script.fetchByUidlError;
      }
      const byUidl = script.messagesByUidl ?? new Map<string, Uint8Array>();
      return uidls.map((remoteId) => ({
        remoteId,
        raw: byUidl.get(remoteId) ?? new Uint8Array(),
      }));
    },
  };
}

export interface SmtpScript {
  readonly testConnectionError?: Error;
  readonly sendError?: Error;
}

export interface SmtpSendCall {
  readonly credentials: SmtpCredentials;
  readonly envelope: SmtpEnvelope;
}

export interface ScriptedSmtpSubmissionClient extends SmtpSubmissionClient {
  readonly sendCalls: readonly SmtpSendCall[];
}

/** An `SmtpSubmissionClient` driven entirely by a canned script. */
export function scriptedSmtpSubmissionClient(
  script: SmtpScript = {},
): ScriptedSmtpSubmissionClient {
  const sendCalls: SmtpSendCall[] = [];
  return {
    sendCalls,
    async testConnection() {
      if (script.testConnectionError !== undefined) {
        throw script.testConnectionError;
      }
    },
    async send(credentials, envelope) {
      sendCalls.push({ credentials, envelope });
      if (script.sendError !== undefined) {
        throw script.sendError;
      }
    },
  };
}

/** Satisfies `AppDependencies["tcpDialer"]` for tests that never exercise a
 * real socket -- every application-layer external-mail test drives the
 * scripted protocol clients directly instead. Scripted `TextSocket` fixtures
 * for protocol-client tests belong to `@flying-mail/adapter`. */
export function recordingTcpDialer(): TcpDialer {
  return {
    async dial(): Promise<TextSocket> {
      throw new Error(
        "the fake TcpDialer was called: protocol-client tests belong to @flying-mail/adapter",
      );
    },
  };
}
