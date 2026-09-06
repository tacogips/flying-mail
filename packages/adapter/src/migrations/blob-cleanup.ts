import type { BlobStore } from "@mailcal/application/ports/blob-store";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";

interface QueuedBlob {
  readonly attachment_id: string;
  readonly blob_key: string;
}

/** One queue item retained after its object or database deletion failed. */
export interface BlobCleanupFailure {
  readonly attachmentId: string;
  readonly blobKey: string;
  readonly cause: unknown;
}

/** Reports a retryable failure while draining the durable blob cleanup queue. */
export class BlobCleanupError extends Error {
  readonly deleted: number;
  readonly failures: readonly BlobCleanupFailure[];

  constructor(deleted: number, failures: readonly BlobCleanupFailure[]) {
    super(`Failed to delete ${failures.length} queued blob object(s)`);
    this.name = "BlobCleanupError";
    this.deleted = deleted;
    this.failures = failures;
  }
}

const DEFAULT_BATCH_SIZE = 100;

/**
 * Drains blob keys captured by schema migrations.
 *
 * An object is removed before its queue row. If either operation fails, the
 * row remains durable and the next invocation safely retries the same key.
 * The configured BlobStore adapters treat deletion of a missing key as a
 * success, so a retry after object deletion but before row deletion is safe.
 */
export async function drainBlobCleanupQueue(
  db: SqlDatabase,
  blobs: BlobStore,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<{ readonly deleted: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("Blob cleanup batch size must be a positive integer");
  }

  let deleted = 0;
  while (true) {
    const queued = await db.query<QueuedBlob>(
      `SELECT attachment_id, blob_key
       FROM blob_cleanup_queue
       ORDER BY attachment_id
       LIMIT ?`,
      [batchSize],
    );
    if (queued.length === 0) {
      return { deleted };
    }

    const outcomes = await Promise.allSettled(
      queued.map(async (item): Promise<void> => {
        await blobs.delete(item.blob_key);
        await db.execute(
          "DELETE FROM blob_cleanup_queue WHERE attachment_id = ?",
          [item.attachment_id],
        );
      }),
    );
    const failures: BlobCleanupFailure[] = [];
    outcomes.forEach((outcome, index) => {
      const item = queued[index];
      if (outcome.status === "fulfilled") {
        deleted += 1;
      } else if (item !== undefined) {
        failures.push({
          attachmentId: item.attachment_id,
          blobKey: item.blob_key,
          cause: outcome.reason,
        });
      }
    });
    if (failures.length > 0) {
      throw new BlobCleanupError(deleted, failures);
    }
  }
}
