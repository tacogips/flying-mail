import type { MailEventLog } from "../ports/mail-event-log";
import type { MailEventNotifier } from "../ports/mail-event-notifier";
import {
  type MailEventRecord,
  normalizeEventAddresses,
} from "@flying-mail/domain/entities/mail-event";

const FAKE_EPOCH = "0123456789abcdef";

export interface FakeMailEventLog extends MailEventLog {
  records(): readonly MailEventRecord[];
  failNextAppend(): void;
}

export interface FakeMailEventNotifier extends MailEventNotifier {
  readonly notifyCount: number;
}

export function createFakeMailEventLog(): FakeMailEventLog {
  const events: MailEventRecord[] = [];
  let nextSeq = 1;
  let prunedThroughSeq = 0;
  let failAppend = false;

  return {
    async append(inputs, timing) {
      if (failAppend) {
        failAppend = false;
        throw new Error("Fake mail event append failed");
      }
      for (const input of inputs) {
        events.push({
          ...input,
          addresses: normalizeEventAddresses(input.addresses),
          seq: nextSeq,
          occurredAt: timing.occurredAt,
        });
        nextSeq += 1;
      }
      const cutoffSeq = events.reduce(
        (maximum, event) =>
          event.occurredAt < timing.retentionCutoff
            ? Math.max(maximum, event.seq)
            : maximum,
        0,
      );
      prunedThroughSeq = Math.max(prunedThroughSeq, cutoffSeq);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event !== undefined && event.seq <= prunedThroughSeq) {
          events.splice(index, 1);
        }
      }
    },
    async state() {
      return {
        epoch: FAKE_EPOCH,
        prunedThroughSeq,
        headSeq: Math.max(prunedThroughSeq, nextSeq - 1),
      };
    },
    async listAfter(seq, limit) {
      return events.filter((event) => event.seq > seq).slice(0, limit);
    },
    records() {
      return [...events];
    },
    failNextAppend() {
      failAppend = true;
    },
  };
}

export function createFakeMailEventNotifier(): FakeMailEventNotifier {
  let notifyCount = 0;
  return {
    get notifyCount() {
      return notifyCount;
    },
    notify() {
      notifyCount += 1;
    },
  };
}
