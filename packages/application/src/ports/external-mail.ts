import type {
  ExternalMailAccount,
  SmtpSecurity,
} from "@mailcal/domain/entities/external-mail-account";
import type { ExternalMessageState } from "@mailcal/domain/entities/external-message-state";
import type {
  ExternalAccountId,
  MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { SqlStatement } from "./sql-database";

export interface ExternalMailAccountRepository {
  findById(id: ExternalAccountId): Promise<ExternalMailAccount | null>;
  findByMailAddress(
    mailAddressId: MailAddressId,
  ): Promise<ExternalMailAccount | null>;
  list(): Promise<readonly ExternalMailAccount[]>;
  save(account: ExternalMailAccount): Promise<void>;
  delete(id: ExternalAccountId): Promise<void>;
}

export interface ExternalMessageStateRepository {
  find(
    accountId: ExternalAccountId,
    remoteId: string,
  ): Promise<ExternalMessageState | null>;
  /** For a POP3 UIDL diff or a JMAP "already ingested" filter without one
   * round trip per id. */
  listRemoteIds(accountId: ExternalAccountId): Promise<ReadonlySet<string>>;
  save(state: ExternalMessageState): Promise<void>;
  /** Builds, without executing, the same upsert `save()` would run -- so
   * `usecases/external-fetch.ts` can append it to `receiveMessage`'s own
   * `db.batch()` call. D1 has no transactions; `batch()` is the atomicity
   * primitive. */
  buildSaveStatement(state: ExternalMessageState): SqlStatement;
}

export type TlsMode = "implicit" | "starttls-ready" | "none";

export interface TcpDialOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: TlsMode;
}

/** Line/chunk read-write socket over one TCP connection. Implementations:
 * `cloudflare-tcp-dialer.ts` (Workers), `node-tcp-dialer.ts` (Bun/Node,
 * used by tests too). */
export interface TextSocket {
  /** `null` on EOF. */
  readLine(): Promise<string | null>;
  readBytes(length: number): Promise<Uint8Array>;
  write(data: string | Uint8Array): Promise<void>;
  /** Upgrades an open plaintext connection (587 EHLO/STARTTLS/EHLO). Throws
   * unless dialed with `tls: "starttls-ready"`. */
  startTls(): Promise<void>;
  close(): Promise<void>;
}

export interface TcpDialer {
  dial(opts: TcpDialOptions): Promise<TextSocket>;
}

export interface JmapCredentials {
  readonly sessionUrl: string;
  readonly username: string;
  readonly password: string;
}

export interface JmapFetchedMessage {
  readonly remoteId: string;
  readonly raw: Uint8Array;
}

export interface JmapFetchResult {
  readonly messages: readonly JmapFetchedMessage[];
  readonly hasMore: boolean;
}

export interface JmapClient {
  testConnection(credentials: JmapCredentials): Promise<void>;
  /** Session -> Mailbox/get(inbox) -> Email/query (ascending receivedAt,
   * bounded by max) -> Email/get + blob download for ids not in
   * `knownRemoteIds`. The returned `messages` are already filtered against
   * `knownRemoteIds`, so a caller need not re-check them itself. */
  fetchSince(
    credentials: JmapCredentials,
    knownRemoteIds: ReadonlySet<string>,
    max: number,
  ): Promise<JmapFetchResult>;
}

export interface Pop3Credentials {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
}

/** `remoteId` is the message's `UIDL`. */
export interface Pop3FetchedMessage {
  readonly remoteId: string;
  readonly raw: Uint8Array;
}

export interface Pop3Client {
  testConnection(credentials: Pop3Credentials): Promise<void>;
  listUidls(credentials: Pop3Credentials): Promise<readonly string[]>;
  /** `RETR` each id in one session; never sends `DELE`. */
  fetchByUidl(
    credentials: Pop3Credentials,
    uidls: readonly string[],
  ): Promise<readonly Pop3FetchedMessage[]>;
}

export interface SmtpCredentials {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly username: string;
  readonly password: string;
}

/** The client dot-stuffs `raw` itself. */
export interface SmtpEnvelope {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
}

export interface SmtpSubmissionClient {
  testConnection(credentials: SmtpCredentials): Promise<void>;
  /** A non-2xx/3xx server reply throws {@link ExternalMailTransportError}. */
  send(credentials: SmtpCredentials, envelope: SmtpEnvelope): Promise<void>;
}

/** A rejected credential maps to `BAD_USER_INPUT`. */
export class ExternalMailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalMailAuthError";
  }
}

/** Unreachable host, malformed reply, or non-2xx response. */
export class ExternalMailTransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExternalMailTransportError";
  }
}
