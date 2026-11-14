import type {
  MailEventRecord,
  NewMailEvent,
} from "@flying-mail/domain/entities/mail-event";

export interface MailEventLogState {
  readonly epoch: string;
  readonly prunedThroughSeq: number;
  readonly headSeq: number;
}

export interface MailEventLog {
  append(
    events: readonly NewMailEvent[],
    timing: {
      readonly occurredAt: string;
      readonly retentionCutoff: string;
    },
  ): Promise<void>;
  state(): Promise<MailEventLogState>;
  listAfter(seq: number, limit: number): Promise<readonly MailEventRecord[]>;
}
