import { ValidationError } from "../errors";
import type { MessageId } from "../value-objects/ids";

/** Who decided a message is spam. A system verdict comes from the ingest
 * scorer and carries its score; a user verdict is a hand mark and usually
 * does not. The distinction matters when tuning the scorer: hand marks are
 * the ground truth the automatic ones get compared against. */
export enum SpamMarkedBy {
  System = "SYSTEM",
  User = "USER",
  /** Applied by a classification rule at ingest. */
  Rule = "RULE",
}

/** A spam verdict is a row, not a tag: presence is the verdict, and the
 * metadata (score at marking time, who marked, when) is what a tag row
 * could never carry. Absence of a mark means the message is not spam. */
export interface SpamMark {
  readonly messageId: MessageId;
  /** Score at marking time; null for hand marks. */
  readonly score: number | null;
  readonly markedBy: SpamMarkedBy;
  readonly markedAt: string;
}

export function createSpamMark(input: SpamMark): SpamMark {
  if (
    input.score !== null &&
    (!Number.isFinite(input.score) || input.score < 0 || input.score > 1)
  ) {
    throw new ValidationError("score must be between 0 and 1", "score");
  }
  return { ...input };
}
