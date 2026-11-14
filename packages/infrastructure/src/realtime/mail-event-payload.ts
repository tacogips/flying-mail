import type { MailEventType } from "@flying-mail/domain/entities/mail-event";

export type MailEventPayloadType = MailEventType | "LIVE";

export interface MailEventPayload {
  readonly cursor: string;
  readonly type: MailEventPayloadType;
  readonly messageId: string | null;
  readonly domainId: string | null;
  readonly addresses: readonly string[];
  readonly occurredAt: string;
}
