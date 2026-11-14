import type { FileLink } from "@mailcal/domain/entities/file-link";
import type { FileLinkId, MessageId } from "@mailcal/domain/value-objects/ids";

export interface FileLinkRepository {
  findById(id: FileLinkId): Promise<FileLink | null>;
  /** The only lookup the download route uses: the presented token is
   * hashed, then matched here. A database read therefore never yields a
   * usable URL. */
  findByTokenHash(tokenHash: string): Promise<FileLink | null>;
  /** Atomically increments the download counter iff the link is usable at
   * `now` -- not revoked, not expired, allowance not exhausted -- and
   * returns the consumed link, or `null` when the guard failed.
   *
   * A single conditional UPDATE rather than read-then-write, because two
   * concurrent downloads racing a `maxDownloads: 1` link must not both
   * pass: D1 has no interactive transactions, so the row's own WHERE
   * clause is the only lock available. */
  consumeByTokenHash(tokenHash: string, now: string): Promise<FileLink | null>;
  listByMessage(messageId: MessageId): Promise<readonly FileLink[]>;
  save(link: FileLink): Promise<void>;
  /** Opportunistic cleanup, run off the request's critical path. */
  deleteExpired(now: string): Promise<number>;
}
